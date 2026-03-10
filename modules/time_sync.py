"""
modules/time_sync.py
─────────────────────
Server-clock synchronisation module — menggunakan NTP untuk akurasi maksimal.
"""

import asyncio
import time
from typing import Optional

from config.settings import TIME_SYNC_INTERVAL, DRIFT_WARN_MS
from modules.logger import get_logger
from modules.session_manager import SessionManager

log = get_logger(__name__)


class TimeSynchroniser:
    """
    Continuously re-syncs the local clock against NTP server.

    Usage
    ─────
        ts = TimeSynchroniser(session_manager)
        await ts.sync_once()
        asyncio.create_task(ts.run_background())

        server_now_ms = ts.server_time_ms()
        await ts.sleep_until(target_unix_seconds)
    """

    def __init__(self, session: SessionManager):
        self._session      = session
        self._offset_ms    : float = 0.0
        self._last_sync_at : float = 0.0
        self._synced       : bool  = False
        self._sync_count   : int   = 0

    # ── Public API ─────────────────────────────────────────────────────────────

    @property
    def is_synced(self) -> bool:
        return self._synced

    def server_time_ms(self) -> float:
        return time.time() * 1000 + self._offset_ms

    def server_time_s(self) -> float:
        return self.server_time_ms() / 1000

    def offset_ms(self) -> float:
        return self._offset_ms

    async def sync_once(self) -> float:
        """
        Sync via NTP (pool.ntp.org) — akurasi ±1-5ms.
        Fallback ke local clock kalau NTP gagal.
        """
        try:
            import ntplib
            loop = asyncio.get_event_loop()

            response = await loop.run_in_executor(
                None, lambda: ntplib.NTPClient().request('pool.ntp.org', version=3)
            )

            server_ms = response.tx_time * 1000
            local_ms  = time.time() * 1000
            offset    = server_ms - local_ms

            drift_change = abs(offset - self._offset_ms)
            if self._synced and drift_change > DRIFT_WARN_MS:
                log.warning("Clock drift jumped by %.1f ms", drift_change)

            self._offset_ms    = offset
            self._last_sync_at = time.monotonic()
            self._sync_count  += 1
            self._synced       = True

            log.info("Time sync #%d via NTP — offset=%.1f ms", self._sync_count, offset)
            return offset

        except Exception as exc:
            log.error("Time sync failed: %s", exc)
            # Fallback: anggap local clock sudah akurat (offset=0)
            self._synced = True
            return self._offset_ms

    async def run_background(self) -> None:
        while True:
            await self.sync_once()
            await asyncio.sleep(TIME_SYNC_INTERVAL)

    async def sleep_until(self, target_unix_s: float, pre_wake_s: float = 0.0) -> None:
        effective_target = target_unix_s - pre_wake_s

        while True:
            now_s   = self.server_time_s()
            delta_s = effective_target - now_s

            if delta_s <= 0:
                break

            chunk = min(delta_s, 1.0)
            await asyncio.sleep(chunk)

        log.debug("sleep_until reached — server_now=%.3f target=%.3f",
                  self.server_time_s(), target_unix_s)

    def format_countdown(self, target_unix_s: float) -> str:
        delta = target_unix_s - self.server_time_s()
        if delta < 0:
            return f"T+{abs(delta):.3f}s (past)"
        h = int(delta // 3600)
        m = int((delta % 3600) // 60)
        s = delta % 60
        return f"T-{h:02d}:{m:02d}:{s:06.3f}"