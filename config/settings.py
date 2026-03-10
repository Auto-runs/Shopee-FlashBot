"""
Central configuration for the Shopee Flash Sale Bot.
All tunable parameters live here — no magic numbers in business logic.
"""

from dataclasses import dataclass, field
from typing import Optional


# ─── HTTP / Network ───────────────────────────────────────────────────────────
BASE_URL          = "https://shopee.co.id"
API_BASE          = f"{BASE_URL}/api/v4"
LOGIN_URL         = f"{API_BASE}/user/account/login"
CART_ADD_URL      = f"{API_BASE}/cart/add_to_cart"
CHECKOUT_URL      = f"{API_BASE}/order/checkout/place_order"
PRODUCT_INFO_URL  = f"{API_BASE}/flash_sale/flash_sale_batch_get_items"

REQUEST_TIMEOUT   = 8
CONNECT_TIMEOUT   = 4

# ─── Retry / Backoff ──────────────────────────────────────────────────────────

MAX_RETRIES       = 5
BACKOFF_BASE      = 0.3
BACKOFF_MAX       = 4.0
JITTER_RANGE      = 0.15

# ─── Concurrency ──────────────────────────────────────────────────────────────

CONCURRENT_CHECKOUT_ATTEMPTS = 5
MONITOR_POLL_INTERVAL        = 0.5
TIME_SYNC_INTERVAL           = 30

# ─── Time Synchronisation ─────────────────────────────────────────────────────

WARMUP_SECONDS    = 3
DRIFT_WARN_MS     = 200

# ─── Session / Headers ────────────────────────────────────────────────────────

DEFAULT_HEADERS = {
    "User-Agent"       : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/124.0.0.0 Safari/537.36",
    "Accept"           : "application/json",
    "Accept-Language"  : "id,en-US;q=0.9,en;q=0.8",
    "Accept-Encoding"  : "gzip, deflate, br",
    "Content-Type"     : "application/json",
    "X-Requested-With" : "XMLHttpRequest",
    "Referer"          : "https://shopee.co.id/",
    "Origin"           : "https://shopee.co.id",
    "X-API-Source"     : "pc",
    "X-Shopee-Language": "id",
    "af-ac-enc-dat"    : "null",
}

# ─── Logging ──────────────────────────────────────────────────────────────────

LOG_LEVEL  = "DEBUG"
LOG_FILE   = "logs/bot.log"
LOG_FORMAT = (
    "%(asctime)s.%(msecs)03d | %(levelname)-8s | "
    "%(name)-25s | %(message)s"
)
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


# ─── Typed config bundle ──────────────────────────────────────────────────────

@dataclass
class BotConfig:
    username          : str
    password          : str
    target_shop_id    : int
    target_item_id    : int
    target_model_id   : int
    target_timestamp  : float
    quantity          : int  = 1
    address_id        : Optional[int] = None
    payment_channel_id: Optional[int] = None
    extra_headers     : dict = field(default_factory=dict)