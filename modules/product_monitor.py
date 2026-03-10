"""
modules/product_monitor.py
──────────────────────────
Polls Shopee's flash-sale API to track product availability and capture
the exact item/model metadata needed for checkout.

Responsibilities
────────────────
• Periodic polling until the item becomes available (stock > 0).
• Extracting checkout-critical fields: item_id, model_id, price, promotionid.
• Notifying listeners (asyncio.Event) the moment stock is detected.
• Respecting rate limits via configurable poll interval.
"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional

from config.settings import PRODUCT_INFO_URL, MONITOR_POLL_INTERVAL
from modules.logger import get_logger
from modules.session_manager import SessionManager

log = get_logger(__name__)


@dataclass
class ProductSnapshot:
    """Immutable snapshot of a product at a point in time."""
    item_id          : int
    shop_id          : int
    model_id         : int
    name             : str
    price            : int          # in cents (Shopee uses integer price * 100000)
    stock            : int
    promotion_id     : int
    flash_sale_stock : int
    fetched_at       : float = field(default_factory=time.time)

    @property
    def is_available(self) -> bool:
        return self.stock > 0 or self.flash_sale_stock > 0

    @property
    def price_display(self) -> str:
        return f"{self.price / 100_000:.2f}"

    def __str__(self) -> str:
        return (
            f"[{self.name}] "
            f"price={self.price_display} "
            f"stock={self.stock} "
            f"flash_stock={self.flash_sale_stock} "
            f"available={self.is_available}"
        )


class ProductMonitor:
    """
    Continuously monitors a target flash-sale product.

    Usage
    ─────
        monitor = ProductMonitor(session, shop_id=123, item_id=456, model_id=789)
        task    = asyncio.create_task(monitor.start_polling())

        # Block until in-stock
        snapshot = await monitor.wait_until_available()
        task.cancel()
    """

    def __init__(
        self,
        session        : SessionManager,
        shop_id        : int,
        item_id        : int,
        model_id       : int,
        poll_interval  : float = MONITOR_POLL_INTERVAL,
    ):
        self._session       = session
        self._shop_id       = shop_id
        self._item_id       = item_id
        self._model_id      = model_id
        self._poll_interval = poll_interval

        self._latest        : Optional[ProductSnapshot] = None
        self._available_evt : asyncio.Event             = asyncio.Event()
        self._poll_count    : int                       = 0
        self._running       : bool                      = False

    # ── Public API ─────────────────────────────────────────────────────────────

    @property
    def latest_snapshot(self) -> Optional[ProductSnapshot]:
        return self._latest

    @property
    def is_available(self) -> bool:
        return self._available_evt.is_set()

    async def fetch_once(self) -> Optional[ProductSnapshot]:
        """Single fetch — useful for pre-flight checks."""
        snapshot = await self._fetch_product()
        if snapshot:
            self._update(snapshot)
        return snapshot

    async def start_polling(self) -> None:
        """
        Continuous polling loop.  Run as an asyncio Task.
        Stops automatically when the item becomes available, or when
        the Task is cancelled.
        """
        self._running = True
        log.info(
            "Monitor started — item_id=%d shop_id=%d model_id=%d  interval=%.2fs",
            self._item_id, self._shop_id, self._model_id, self._poll_interval,
        )
        try:
            while self._running:
                snapshot = await self._fetch_product()
                if snapshot:
                    self._update(snapshot)
                    if snapshot.is_available:
                        log.info("✅ Product available: %s", snapshot)
                        self._available_evt.set()
                        break   # stop polling once available
                    else:
                        log.debug("Poll #%d — not yet available: %s", self._poll_count, snapshot)

                await asyncio.sleep(self._poll_interval)
        except asyncio.CancelledError:
            log.info("Monitor polling cancelled after %d polls", self._poll_count)
        finally:
            self._running = False

    async def wait_until_available(self, timeout: Optional[float] = None) -> Optional[ProductSnapshot]:
        """
        Async-block until the item is in stock (or timeout elapses).
        Returns the latest ProductSnapshot, or None on timeout.
        """
        try:
            await asyncio.wait_for(self._available_evt.wait(), timeout=timeout)
            return self._latest
        except asyncio.TimeoutError:
            log.warning("wait_until_available timed out after %.1fs", timeout)
            return None

    # ── Private helpers ────────────────────────────────────────────────────────

    async def _fetch_product(self) -> Optional[ProductSnapshot]:
        """
        Call the flash-sale batch endpoint and parse the response into a
        ProductSnapshot for our target item.
        """
        params = {
            "itemid"     : self._item_id,
            "shopid"     : self._shop_id,
            "need_detail": 1,
        }
        try:
            data = await self._session.get(PRODUCT_INFO_URL, params=params)
            self._poll_count += 1
            return self._parse_response(data)
        except Exception as exc:
            log.warning("Fetch failed on poll #%d: %s", self._poll_count, exc)
            return None

    def _parse_response(self, data: dict) -> Optional[ProductSnapshot]:
        """
        Extract fields from the Shopee flash-sale API response.

        Shopee's response shape (simplified):
        {
          "error": 0,
          "data": {
            "items": [{
              "itemid": ..., "shopid": ..., "name": ...,
              "price": ..., "stock": ...,
              "flash_sale": {"stock": ..., "promotionid": ...},
              "models": [{"modelid": ..., "stock": ...}]
            }]
          }
        }
        """
        try:
            items = (data.get("data") or {}).get("items") or []
            if not items:
                log.debug("No items in response: %s", data)
                return None

            item = items[0]   # we requested a single item

            # Find stock for our specific model (variant)
            model_stock = 0
            models = item.get("models") or []
            for m in models:
                if m.get("modelid") == self._model_id:
                    model_stock = m.get("stock", 0)
                    break

            flash = item.get("flash_sale") or {}

            return ProductSnapshot(
                item_id          = item.get("itemid", self._item_id),
                shop_id          = item.get("shopid", self._shop_id),
                model_id         = self._model_id,
                name             = item.get("name", "Unknown"),
                price            = item.get("price", 0),
                stock            = model_stock or item.get("stock", 0),
                promotion_id     = flash.get("promotionid", 0),
                flash_sale_stock = flash.get("stock", 0),
            )
        except Exception as exc:
            log.error("Failed to parse product response: %s | data=%s", exc, data)
            return None

    def _update(self, snapshot: ProductSnapshot) -> None:
        self._latest = snapshot
