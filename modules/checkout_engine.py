"""
modules/checkout_engine.py
──────────────────────────
Concurrent checkout execution engine — the hot path of the bot.

Strategy
────────
At T=0 (flash-sale open time), we launch CONCURRENT_CHECKOUT_ATTEMPTS
coroutines simultaneously, each firing the pre-built checkout payload.
The first success wins; all others are cancelled.

This approach dramatically raises the probability of securing a slot
despite high server load and network jitter.

Retry inside each attempt
─────────────────────────
Each attempt also retries internally with exponential backoff on:
  • Network errors / timeouts
  • HTTP 5xx (server overload)
  • Shopee error codes that indicate "try again" (e.g., too_many_requests)

Non-retryable outcomes:
  • "out_of_stock" → stop all attempts immediately
  • "success"      → stop all attempts, record order id
"""

import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Dict, Any

from config.settings import (
    CHECKOUT_URL,
    CONCURRENT_CHECKOUT_ATTEMPTS,
    MAX_RETRIES,
    BACKOFF_BASE,
    BACKOFF_MAX,
    JITTER_RANGE,
)
from modules.logger import get_logger
from modules.session_manager import SessionManager
from modules.cart import CartManager

import random

log = get_logger(__name__)


class CheckoutStatus(Enum):
    SUCCESS          = "success"
    OUT_OF_STOCK     = "out_of_stock"
    RATE_LIMITED     = "rate_limited"
    AUTH_FAILURE     = "auth_failure"
    NETWORK_ERROR    = "network_error"
    UNKNOWN_FAILURE  = "unknown_failure"


# Shopee error codes that are worth retrying
_RETRYABLE_CODES = {
    -1,   # generic transient
    11,   # rate limited / flood
    100,  # server busy
}

# Shopee error codes that signal "item gone" — no point retrying
_TERMINAL_CODES = {
    2,    # out of stock
    9,    # flash sale ended
    110,  # item not available
}


@dataclass
class CheckoutResult:
    status      : CheckoutStatus
    order_id    : Optional[str]  = None
    attempt_no  : int            = 0
    latency_ms  : float          = 0.0
    raw_response: Optional[dict] = None
    error       : Optional[str]  = None

    @property
    def succeeded(self) -> bool:
        return self.status == CheckoutStatus.SUCCESS


class CheckoutEngine:
    """
    Fires concurrent checkout requests at T=0.

    Usage
    ─────
        engine = CheckoutEngine(session, cart)
        result = await engine.execute()
        if result.succeeded:
            print("Order placed:", result.order_id)
    """

    def __init__(
        self,
        session     : SessionManager,
        cart        : CartManager,
        concurrency : int = CONCURRENT_CHECKOUT_ATTEMPTS,
    ):
        self._session     = session
        self._cart        = cart
        self._concurrency = concurrency
        self._winner      : Optional[CheckoutResult] = None

    # ── Public API ─────────────────────────────────────────────────────────────

    async def execute(self) -> CheckoutResult:
        """
        Launch `concurrency` checkout coroutines in parallel.
        Returns the first successful result, or the last failure.
        """
        if not self._cart.is_ready:
            raise RuntimeError("Cart payload not built — call cart.build_checkout_payload() first")

        log.info(
            "🚀 Launching %d concurrent checkout attempts …",
            self._concurrency,
        )

        # Shared cancellation flag — set when any attempt succeeds or stock is gone
        stop_event = asyncio.Event()

        tasks = [
            asyncio.create_task(
                self._attempt(attempt_no=i + 1, stop_event=stop_event),
                name=f"checkout-{i+1}",
            )
            for i in range(self._concurrency)
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Collect non-exception results
        valid_results = [r for r in results if isinstance(r, CheckoutResult)]

        if not valid_results:
            exc_results = [r for r in results if isinstance(r, Exception)]
            log.error("All checkout attempts raised exceptions: %s", exc_results)
            return CheckoutResult(
                status=CheckoutStatus.NETWORK_ERROR,
                error=str(exc_results[0]) if exc_results else "No valid results",
            )

        # Prefer SUCCESS, then OUT_OF_STOCK, then anything else
        for status_prio in (CheckoutStatus.SUCCESS, CheckoutStatus.OUT_OF_STOCK):
            for r in valid_results:
                if r.status == status_prio:
                    return r

        return valid_results[0]   # return whatever we have

    # ── Per-attempt coroutine ──────────────────────────────────────────────────

    async def _attempt(
        self,
        attempt_no : int,
        stop_event : asyncio.Event,
    ) -> CheckoutResult:
        """
        Single checkout attempt with internal retry logic.
        Watches stop_event and aborts early if another attempt already won.
        """
        # Tiny stagger to avoid all requests hitting the server at exactly the
        # same millisecond (helps avoid duplicate-order rejections on some regions).
        stagger_ms = (attempt_no - 1) * 20
        if stagger_ms:
            await asyncio.sleep(stagger_ms / 1000)

        for retry in range(MAX_RETRIES + 1):
            if stop_event.is_set():
                log.debug("Attempt #%d aborting (stop_event set)", attempt_no)
                return CheckoutResult(
                    status    = CheckoutStatus.UNKNOWN_FAILURE,
                    attempt_no= attempt_no,
                    error     = "Aborted by stop_event",
                )

            result = await self._fire(attempt_no=attempt_no, retry=retry)

            if result.succeeded:
                log.info(
                    "✅ Attempt #%d succeeded — order_id=%s  latency=%.1f ms",
                    attempt_no, result.order_id, result.latency_ms,
                )
                stop_event.set()
                return result

            if result.status == CheckoutStatus.OUT_OF_STOCK:
                log.warning("Attempt #%d: OUT OF STOCK — stopping all attempts", attempt_no)
                stop_event.set()
                return result

            if retry == MAX_RETRIES:
                log.error(
                    "Attempt #%d exhausted %d retries — final status=%s",
                    attempt_no, MAX_RETRIES, result.status.value,
                )
                return result

            # Exponential backoff before next retry
            delay = min(BACKOFF_BASE * (2 ** retry), BACKOFF_MAX)
            jitter = random.uniform(-JITTER_RANGE, JITTER_RANGE)
            wait = max(0.0, delay + jitter)
            log.debug(
                "Attempt #%d retry %d/%d in %.3fs (status=%s)",
                attempt_no, retry + 1, MAX_RETRIES, wait, result.status.value,
            )
            await asyncio.sleep(wait)

        # Unreachable, but satisfies type checker
        return CheckoutResult(status=CheckoutStatus.UNKNOWN_FAILURE, attempt_no=attempt_no)

    async def _fire(self, attempt_no: int, retry: int) -> CheckoutResult:
        """Single HTTP POST to the checkout endpoint."""
        # Always refresh the timestamp nonce just before firing
        self._cart.refresh_timestamp()
        payload = self._cart.checkout_payload

        t0 = time.perf_counter()
        try:
            data = await self._session.post(CHECKOUT_URL, json=payload)
            latency_ms = (time.perf_counter() - t0) * 1000
        except Exception as exc:
            latency_ms = (time.perf_counter() - t0) * 1000
            log.warning(
                "Attempt #%d retry=%d network error (%.1f ms): %s",
                attempt_no, retry, latency_ms, exc,
            )
            return CheckoutResult(
                status     = CheckoutStatus.NETWORK_ERROR,
                attempt_no = attempt_no,
                latency_ms = latency_ms,
                error      = str(exc),
            )

        return self._parse_response(data, attempt_no, latency_ms)

    def _parse_response(
        self,
        data       : Dict[str, Any],
        attempt_no : int,
        latency_ms : float,
    ) -> CheckoutResult:
        """Interpret the Shopee place-order response."""
        error_code = data.get("error", -1)
        inner      = data.get("data") or {}

        # ── Success ────────────────────────────────────────────────────────────
        if error_code == 0:
            order_id = (
                inner.get("order_id")
                or inner.get("ordersn")
                or str(inner.get("checkout_id", ""))
            )
            return CheckoutResult(
                status       = CheckoutStatus.SUCCESS,
                order_id     = order_id,
                attempt_no   = attempt_no,
                latency_ms   = latency_ms,
                raw_response = data,
            )

        # ── Terminal failures ──────────────────────────────────────────────────
        if error_code in _TERMINAL_CODES:
            return CheckoutResult(
                status       = CheckoutStatus.OUT_OF_STOCK,
                attempt_no   = attempt_no,
                latency_ms   = latency_ms,
                raw_response = data,
                error        = data.get("error_msg"),
            )

        if error_code in (4, 401):
            return CheckoutResult(
                status       = CheckoutStatus.AUTH_FAILURE,
                attempt_no   = attempt_no,
                latency_ms   = latency_ms,
                raw_response = data,
                error        = "Authentication failure",
            )

        # ── Retryable ──────────────────────────────────────────────────────────
        if error_code in _RETRYABLE_CODES:
            return CheckoutResult(
                status       = CheckoutStatus.RATE_LIMITED,
                attempt_no   = attempt_no,
                latency_ms   = latency_ms,
                raw_response = data,
                error        = data.get("error_msg"),
            )

        # ── Unknown ────────────────────────────────────────────────────────────
        log.warning(
            "Unknown checkout response (attempt #%d, code=%d): %s",
            attempt_no, error_code, data,
        )
        return CheckoutResult(
            status       = CheckoutStatus.UNKNOWN_FAILURE,
            attempt_no   = attempt_no,
            latency_ms   = latency_ms,
            raw_response = data,
            error        = data.get("error_msg"),
        )
