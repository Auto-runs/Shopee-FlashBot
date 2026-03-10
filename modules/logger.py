"""
modules/logger.py
─────────────────
Centralised, structured logging setup.

• One JSON-friendly StreamHandler (stdout) for real-time monitoring.
• One rotating FileHandler to persist debug traces.
• Every module grabs its own child logger via get_logger(__name__).
"""

import logging
import logging.handlers
import os
import sys
from typing import Optional

from config.settings import LOG_LEVEL, LOG_FILE, LOG_FORMAT, LOG_DATE_FORMAT


_INITIALISED = False


def setup_logging(level: Optional[str] = None) -> None:
    """
    Call once at startup (main.py).  Subsequent calls are no-ops.
    """
    global _INITIALISED
    if _INITIALISED:
        return
    _INITIALISED = True

    root = logging.getLogger()
    root.setLevel(getattr(logging, (level or LOG_LEVEL).upper(), logging.DEBUG))

    fmt = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)

    # ── stdout handler ────────────────────────────────────────────────────────
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.addHandler(sh)

    # ── rotating file handler ─────────────────────────────────────────────────
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    fh = logging.handlers.RotatingFileHandler(
        LOG_FILE,
        maxBytes=5 * 1024 * 1024,   # 5 MB per file
        backupCount=3,
        encoding="utf-8",
    )
    fh.setFormatter(fmt)
    root.addHandler(fh)

    # Silence noisy third-party libraries
    logging.getLogger("aiohttp").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Return a named child logger.  Always call after setup_logging()."""
    return logging.getLogger(name)
