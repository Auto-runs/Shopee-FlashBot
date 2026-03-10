"""
main.py
───────
Top-level orchestrator — wires all modules together and drives the full
flash-sale lifecycle from authentication to order confirmation.

Lifecycle
─────────
  Phase 1 — Setup     : open session, login via cookies, initial time-sync
  Phase 2 — Monitor   : confirm product exists, start background time-sync
  Phase 3 — Countdown : sleep until WARMUP_SECONDS before T=0
  Phase 4 — Cart prep : add item & pre-build checkout payload (dekat T=0)
  Phase 5 — Final sync: last time-sync for maximum accuracy
  Phase 6 — T=0 FIRE  : concurrent checkout attempts
  Phase 7 — Report    : log result, clean up
"""

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv()

from config.settings import BotConfig, WARMUP_SECONDS
from modules import (
    setup_logging,
    get_logger,
    SessionManager,
    Authenticator,
    TimeSynchroniser,
    ProductMonitor,
    CartManager,
    CheckoutEngine,
    CheckoutStatus,
    AuthenticationError,
    CartError,
)

log = get_logger(__name__)

COOKIES_FILE = "sessions/mysession.json"


def load_cookies() -> dict:
    if not os.path.exists(COOKIES_FILE):
        print(f"[ERROR] File cookies tidak ditemukan: {COOKIES_FILE}")
        sys.exit(1)

    with open(COOKIES_FILE, "r", encoding="utf-8") as f:
        cookies_list = json.load(f)

    cookies_dict = {c["name"]: c["value"] for c in cookies_list}

    required_cookies = ["SPC_U", "SPC_F", "csrftoken"]
    missing = [c for c in required_cookies if c not in cookies_dict]
    if missing:
        print(f"[ERROR] Cookie penting tidak ada: {', '.join(missing)}")
        sys.exit(1)

    log.info("Cookies loaded — user_id=%s", cookies_dict.get("SPC_U", "?"))
    return cookies_dict


def build_config() -> BotConfig:
    required = ("SHOPEE_USER", "SHOPEE_SHOP_ID",
                "SHOPEE_ITEM_ID", "SHOPEE_MODEL_ID", "SHOPEE_TARGET_TS")
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        print(f"[ERROR] Missing env vars: {', '.join(missing)}")
        sys.exit(1)

    return BotConfig(
        username           = os.environ["SHOPEE_USER"],
        password           = "",
        target_shop_id     = int(os.environ["SHOPEE_SHOP_ID"]),
        target_item_id     = int(os.environ["SHOPEE_ITEM_ID"]),
        target_model_id    = int(os.environ["SHOPEE_MODEL_ID"]),
        target_timestamp   = float(os.environ["SHOPEE_TARGET_TS"]),
        quantity           = int(os.getenv("SHOPEE_QUANTITY", "1")),
        address_id         = int(v) if (v := os.getenv("SHOPEE_ADDRESS_ID")) else None,
        payment_channel_id = int(v) if (v := os.getenv("SHOPEE_PAYMENT_ID"))  else None,
    )


async def run_bot(cfg: BotConfig, cookies: dict) -> int:
    wib_dt = datetime.fromtimestamp(cfg.target_timestamp, tz=timezone.utc) + timedelta(hours=7)

    log.info("=" * 65)
    log.info("Shopee Flash-Sale Bot starting")
    log.info("  User         : %s", cfg.username)
    log.info("  Target item  : shop=%d  item=%d  model=%d",
             cfg.target_shop_id, cfg.target_item_id, cfg.target_model_id)
    log.info("  Sale opens   : %s WIB  (epoch=%.0f)",
             wib_dt.strftime("%Y-%m-%d %H:%M:%S"), cfg.target_timestamp)
    log.info("=" * 65)

    async with SessionManager(extra_headers=cfg.extra_headers) as session:

        # ── Phase 1: Auth ──────────────────────────────────────────────────────
        log.info("Phase 1 — Injecting session cookies …")
        auth = Authenticator(session, cfg.username, cfg.password)
        auth.inject_cookies(cookies)
        log.info("✅ Session aktif")

        # ── Phase 2: Time sync + product check ────────────────────────────────
        log.info("Phase 2 — Syncing server clock …")
        time_sync = TimeSynchroniser(session)
        await time_sync.sync_once()
        bg_sync_task = asyncio.create_task(
            time_sync.run_background(), name="bg-time-sync"
        )

        log.info("Phase 2b — Checking product (info only, belum flash sale) …")
        monitor = ProductMonitor(
            session,
            shop_id  = cfg.target_shop_id,
            item_id  = cfg.target_item_id,
            model_id = cfg.target_model_id,
        )
        snapshot = await monitor.fetch_once()
        if snapshot:
            log.info("✅ Product confirmed: %s", snapshot)
        else:
            log.warning("⚠️  Product fetch gagal sekarang (normal jika flash sale belum buka)")

        # ── Phase 3: Countdown ─────────────────────────────────────────────────
        log.info("Phase 3 — Countdown …")
        while True:
            countdown = time_sync.format_countdown(cfg.target_timestamp)
            delta = cfg.target_timestamp - time_sync.server_time_s()
            log.info("⏳ %s", countdown)
            if delta <= WARMUP_SECONDS + 30:  # mulai cart prep 30 detik sebelum T=0
                break
            await asyncio.sleep(1 if delta < 60 else 10)

        # ── Phase 4: Cart prep (dekat T=0, flash sale sudah buka) ─────────────
        log.info("Phase 4 — Preparing cart (%.1fs before T=0) …",
                 cfg.target_timestamp - time_sync.server_time_s())

        # Retry add_to_cart sampai berhasil atau timeout
        cart = CartManager(
            session,
            address_id         = cfg.address_id,
            payment_channel_id = cfg.payment_channel_id,
        )

        snap = snapshot or _dummy_snapshot(cfg)
        added = False
        cart_deadline = cfg.target_timestamp - 2  # batas 2 detik sebelum T=0

        while time_sync.server_time_s() < cart_deadline:
            added = await cart.add_item(snap, quantity=cfg.quantity)
            if added:
                log.info("✅ Item berhasil ditambahkan ke cart")
                break
            log.warning("⚠️  Add to cart gagal, retry …")
            await asyncio.sleep(0.5)

        if not added:
            log.error("❌ Gagal add to cart sebelum deadline — lanjut dengan payload manual")

        try:
            cart.build_checkout_payload()
        except CartError as exc:
            log.critical("❌ Tidak bisa build checkout payload: %s", exc)
            bg_sync_task.cancel()
            return 1

        log.info("✅ Cart siap: %s", cart.summary())

        # ── Phase 5: Final sync & FIRE ─────────────────────────────────────────
        log.info("Phase 5 — Final time sync sebelum T=0 …")
        await time_sync.sync_once()
        log.info("Clock offset=%.1f ms — waiting for T=0 …", time_sync.offset_ms())
        await time_sync.sleep_until(cfg.target_timestamp)

        fire_time = time_sync.server_time_ms()
        log.info("🔥 T=0 REACHED — FIRING CHECKOUT!")

        engine = CheckoutEngine(session, cart)
        result = await engine.execute()

        # ── Phase 6: Report ────────────────────────────────────────────────────
        bg_sync_task.cancel()
        elapsed_s = (time_sync.server_time_ms() - fire_time) / 1000

        log.info("=" * 65)
        if result.succeeded:
            log.info("🎉 ORDER BERHASIL!")
            log.info("   Order ID   : %s",  result.order_id)
            log.info("   Latency    : %.1f ms", result.latency_ms)
            log.info("   Total time : %.3f s",  elapsed_s)
            return 0
        else:
            log.error("❌ Checkout GAGAL")
            log.error("   Status  : %s",  result.status.value)
            log.error("   Error   : %s",  result.error)
            log.error("   Latency : %.1f ms", result.latency_ms)
            return 1


def _dummy_snapshot(cfg: BotConfig):
    from modules.product_monitor import ProductSnapshot
    return ProductSnapshot(
        item_id          = cfg.target_item_id,
        shop_id          = cfg.target_shop_id,
        model_id         = cfg.target_model_id,
        name             = "Unknown (pre-flight fetch failed)",
        price            = 0,
        stock            = 0,
        promotion_id     = 0,
        flash_sale_stock = 0,
    )


def main() -> None:
    setup_logging()
    cookies = load_cookies()
    cfg     = build_config()
    exit_code = asyncio.run(run_bot(cfg, cookies))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()