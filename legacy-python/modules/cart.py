"""
modules/cart.py
───────────────
Cart preparation module — builds the checkout payload ahead of time so the
checkout engine can fire it instantly at T=0 without any extra processing.

Responsibilities
────────────────
• Add the target item to the Shopee cart via the API.
• Pre-build the full checkout payload (items, address, payment, etc.).
• Cache the payload so checkout_engine can reuse it across retries.
"""

import time
from typing import Optional, Dict, Any

from config.settings import CART_ADD_URL
from modules.logger import get_logger
from modules.product_monitor import ProductSnapshot
from modules.session_manager import SessionManager

log = get_logger(__name__)


class CartError(Exception):
    """Raised when an add-to-cart attempt fails fatally."""


class CartManager:
    """
    Prepares the cart and pre-builds checkout payloads.

    Usage
    ─────
        cart = CartManager(session, address_id=111, payment_channel_id=222)
        await cart.add_item(snapshot, quantity=1)
        payload = cart.build_checkout_payload()
    """

    def __init__(
        self,
        session            : SessionManager,
        address_id         : Optional[int] = None,
        payment_channel_id : Optional[int] = None,
    ):
        self._session             = session
        self._address_id          = address_id
        self._payment_channel_id  = payment_channel_id

        self._cart_items          : list[dict]              = []
        self._checkout_payload    : Optional[Dict[str, Any]] = None
        self._snapshot            : Optional[ProductSnapshot] = None

    # ── Public API ─────────────────────────────────────────────────────────────

    @property
    def is_ready(self) -> bool:
        """True when the checkout payload has been pre-built."""
        return self._checkout_payload is not None

    @property
    def checkout_payload(self) -> Optional[Dict[str, Any]]:
        return self._checkout_payload

    async def add_item(
        self,
        snapshot : ProductSnapshot,
        quantity : int = 1,
    ) -> bool:
        """
        POST the item to the Shopee cart endpoint.
        Returns True on success.
        """
        self._snapshot = snapshot

        payload = {
            "shopid"      : snapshot.shop_id,
            "itemid"      : snapshot.item_id,
            "modelid"     : snapshot.model_id,
            "quantity"    : quantity,
            "checkout"    : True,
            "source"      : "flash_sale",
        }

        log.info(
            "Adding to cart — item_id=%d model_id=%d qty=%d",
            snapshot.item_id, snapshot.model_id, quantity,
        )

        try:
            data = await self._session.post(CART_ADD_URL, json=payload)
        except Exception as exc:
            raise CartError(f"Add-to-cart request failed: {exc}") from exc

        if data.get("error", -1) != 0:
            msg = data.get("error_msg") or data.get("message") or str(data)
            log.error("Add-to-cart rejected: %s", msg)
            # Some rejection codes are transient; let the caller decide to retry
            return False

        # Parse back the cart item id Shopee returns
        cart_item = (data.get("data") or {}).get("cart_item") or {}
        cart_item_id = cart_item.get("cart_item_id")

        self._cart_items.append({
            "cart_item_id"  : cart_item_id,
            "item_id"       : snapshot.item_id,
            "shop_id"       : snapshot.shop_id,
            "model_id"      : snapshot.model_id,
            "quantity"      : quantity,
            "price"         : snapshot.price,
            "promotion_id"  : snapshot.promotion_id,
        })

        log.info("✅ Cart item added — cart_item_id=%s", cart_item_id)
        return True

    def build_checkout_payload(self) -> Dict[str, Any]:
        """
        Construct the full place-order payload.

        Call this BEFORE the flash sale starts so there is zero computation
        overhead at T=0.  The checkout engine will POST this directly.
        """
        if not self._cart_items:
            raise CartError("Cart is empty — call add_item() first")

        if not self._snapshot:
            raise CartError("No product snapshot — call add_item() first")

        snap = self._snapshot

        orders = [
            {
                "shopid"     : snap.shop_id,
                "shop_order_ids": [
                    {
                        "cart_item_id": ci["cart_item_id"],
                        "itemid"      : ci["item_id"],
                        "modelid"     : ci["model_id"],
                        "qty"         : ci["quantity"],
                        "item_price"  : ci["price"],
                        "promotionid" : ci["promotion_id"],
                        "promotion_type": 1,   # flash sale type
                    }
                    for ci in self._cart_items
                ],
            }
        ]

        payload: Dict[str, Any] = {
            "orders"         : orders,
            "selected_payment_channel_data": self._payment_channel_payload(),
            "address_id"     : self._address_id,
            "timestamp"      : int(time.time()),
            "client_id"      : 4,
            "cart_type"      : 2,
            "device_info"    : {"buyer_payment_info": {}},
        }

        self._checkout_payload = payload
        log.info("Checkout payload pre-built — %d order line(s)", len(orders))
        return payload

    def refresh_timestamp(self) -> None:
        """
        Update the timestamp inside the pre-built payload to NOW.
        Call this immediately before firing so the server sees a fresh nonce.
        """
        if self._checkout_payload:
            self._checkout_payload["timestamp"] = int(time.time())

    # ── Private helpers ────────────────────────────────────────────────────────

    def _payment_channel_payload(self) -> dict:
        if self._payment_channel_id:
            return {
                "channel_id"  : self._payment_channel_id,
                "version"     : 2,
            }
        # Default: ShopeePay / COD — Shopee will pick the user's default
        return {}

    def summary(self) -> dict:
        return {
            "cart_items"          : len(self._cart_items),
            "payload_pre_built"   : self.is_ready,
            "address_id"          : self._address_id,
            "payment_channel_id"  : self._payment_channel_id,
        }
