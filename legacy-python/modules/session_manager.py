"""
modules/session_manager.py
──────────────────────────
Manages a single shared aiohttp.ClientSession for the entire bot lifetime.

Features
────────
• Persistent cookie jar (authentication cookies survive across calls).
• Pre-configured default headers (browser fingerprint).
• Exponential backoff + jitter retry wrapper for transient HTTP errors.
• Context-manager compatible so the session is cleanly closed on exit.
"""

import asyncio
import random
import time
from typing import Any, Dict, Optional

import aiohttp

from config.settings import (
    DEFAULT_HEADERS,
    REQUEST_TIMEOUT,
    CONNECT_TIMEOUT,
    MAX_RETRIES,
    BACKOFF_BASE,
    BACKOFF_MAX,
    JITTER_RANGE,
)
from modules.logger import get_logger

log = get_logger(__name__)


class SessionManager:
    """
    Singleton-style async HTTP session with retry logic.

    Usage
    ─────
        async with SessionManager(extra_headers) as sm:
            data = await sm.get("https://...")
            data = await sm.post("https://...", json={...})
    """

    def __init__(self, extra_headers: Optional[Dict[str, str]] = None):
        self._extra_headers = extra_headers or {}
        self._session: Optional[aiohttp.ClientSession] = None

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def __aenter__(self) -> "SessionManager":
        await self.open()
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def open(self) -> None:
        if self._session and not self._session.closed:
            return
        headers = {**DEFAULT_HEADERS, **self._extra_headers}
        connector = aiohttp.TCPConnector(
            limit=50,
            ttl_dns_cache=300,
            enable_cleanup_closed=True,
        )
        timeout = aiohttp.ClientTimeout(
            total=REQUEST_TIMEOUT,
            connect=CONNECT_TIMEOUT,
        )
        self._session = aiohttp.ClientSession(
            headers=headers,
            connector=connector,
            timeout=timeout,
            cookie_jar=aiohttp.CookieJar(),
        )
        log.info("HTTP session opened")

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            log.info("HTTP session closed")

    # ── Public request helpers ─────────────────────────────────────────────────

    async def get(
        self,
        url: str,
        params: Optional[Dict] = None,
        **kwargs: Any,
    ) -> Dict:
        return await self._request("GET", url, params=params, **kwargs)

    async def post(
        self,
        url: str,
        json: Optional[Dict] = None,
        **kwargs: Any,
    ) -> Dict:
        return await self._request("POST", url, json=json, **kwargs)

    # ── Core request with retry ────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        url: str,
        *,
        retries: int = MAX_RETRIES,
        **kwargs: Any,
    ) -> Dict:
        """
        Execute an HTTP request, retrying on transient failures with
        exponential backoff + random jitter.

        Retryable conditions
        ────────────────────
        • aiohttp connection errors / timeouts
        • HTTP 429 (rate-limited)
        • HTTP 5xx (server errors)

        Non-retryable
        ─────────────
        • HTTP 4xx (except 429) — surface immediately
        """
        assert self._session, "Session not opened. Use 'async with SessionManager()'"

        for attempt in range(retries + 1):
            try:
                t0 = time.perf_counter()
                async with self._session.request(method, url, **kwargs) as resp:
                    elapsed_ms = (time.perf_counter() - t0) * 1000
                    body = await resp.json(content_type=None)

                    log.debug(
                        "%s %s → %d  (%.1f ms)  attempt=%d",
                        method, url, resp.status, elapsed_ms, attempt + 1,
                    )

                    if resp.status == 200:
                        return body

                    if resp.status == 429 or resp.status >= 500:
                        raise aiohttp.ClientResponseError(
                            resp.request_info,
                            resp.history,
                            status=resp.status,
                            message=f"Retryable HTTP {resp.status}",
                        )

                    # 4xx — not worth retrying
                    log.error("Non-retryable HTTP %d for %s: %s", resp.status, url, body)
                    return body

            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                if attempt == retries:
                    log.error(
                        "All %d retries exhausted for %s %s — %s",
                        retries, method, url, exc,
                    )
                    raise

                delay = min(BACKOFF_BASE * (2 ** attempt), BACKOFF_MAX)
                jitter = random.uniform(-JITTER_RANGE, JITTER_RANGE)
                wait   = max(0.0, delay + jitter)

                log.warning(
                    "Attempt %d/%d failed (%s). Retrying in %.3fs …",
                    attempt + 1, retries, exc, wait,
                )
                await asyncio.sleep(wait)

        # Should never reach here
        raise RuntimeError("_request exited retry loop unexpectedly")

    # ── Cookie helpers ─────────────────────────────────────────────────────────

    def inject_cookies(self, cookies: Dict[str, str]) -> None:
        """Manually inject cookies (e.g., from a browser export)."""
        if not self._session:
            raise RuntimeError("Session is not open")
        for name, value in cookies.items():
            self._session.cookie_jar.update_cookies({name: value})
        log.debug("Injected %d cookies", len(cookies))

    def get_cookies(self) -> Dict[str, str]:
        """Dump current cookies as a plain dict."""
        if not self._session:
            return {}
        return {
            c.key: c.value
            for c in self._session.cookie_jar
        }
