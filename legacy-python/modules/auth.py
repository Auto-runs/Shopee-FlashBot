"""
modules/auth.py
───────────────
Authentication module — handles login, session cookies, and token refresh.

Security note
─────────────
Credentials are passed in at runtime (from BotConfig) and are never written
to disk by this module.  Store them in environment variables or a secrets
manager, NOT in source code.

Flow
────
1. POST login with username + password → receive auth cookies + csrftoken.
2. Store cookies in the shared SessionManager cookie jar.
3. Expose `ensure_authenticated()` so other modules can call it before
   making authenticated requests.
"""

import hashlib
import time
from typing import Optional

from config.settings import LOGIN_URL
from modules.logger import get_logger
from modules.session_manager import SessionManager

log = get_logger(__name__)


class AuthenticationError(Exception):
    """Raised when login fails with non-retryable credentials error."""


class Authenticator:
    """
    Manages Shopee session authentication.

    Usage
    ─────
        auth = Authenticator(session_manager, username, password)
        await auth.login()
        # from here the session cookies are set and all requests are auth'd
    """

    def __init__(
        self,
        session  : SessionManager,
        username : str,
        password : str,
    ):
        self._session   = session
        self._username  = username
        self._password  = password
        self._logged_in : bool          = False
        self._login_at  : Optional[float] = None

    # ── Public API ─────────────────────────────────────────────────────────────

    @property
    def is_logged_in(self) -> bool:
        return self._logged_in

    async def login(self) -> None:
        """
        Authenticate with Shopee.
        Raises AuthenticationError on credential failure.
        """
        log.info("Attempting login for user: %s", self._username)

        payload = self._build_login_payload()

        try:
            data = await self._session.post(LOGIN_URL, json=payload)
        except Exception as exc:
            raise AuthenticationError(f"Login request failed: {exc}") from exc

        error_code = data.get("error", -1)
        if error_code != 0:
            msg = data.get("error_msg") or data.get("message") or "Unknown error"
            raise AuthenticationError(
                f"Login rejected (error={error_code}): {msg}"
            )

        # The session cookie jar is automatically populated by aiohttp
        self._logged_in = True
        self._login_at  = time.time()

        # Shopee embeds csrftoken in the response body on some versions
        csrf = (
            (data.get("data") or {}).get("csrftoken")
            or data.get("csrftoken")
        )
        if csrf:
            self._session._session.headers.update({"X-CSRFToken": csrf})
            log.debug("CSRF token injected into session headers")

        log.info("Login successful — session active since %.3f", self._login_at)

    async def ensure_authenticated(self) -> None:
        """Login if not already logged in."""
        if not self._logged_in:
            await self.login()

    def inject_cookies(self, cookies: dict) -> None:
        """
        Alternative to password login: supply exported browser cookies.

        Example
        ───────
            auth.inject_cookies({
                "SPC_U": "123456",
                "SPC_F": "abcdef...",
                "csrftoken": "...",
            })
        """
        self._session.inject_cookies(cookies)
        self._logged_in = True
        self._login_at  = time.time()
        log.info("Auth cookies injected manually — treating as logged in")

    # ── Private helpers ────────────────────────────────────────────────────────

    def _build_login_payload(self) -> dict:
        """
        Construct the login POST body.

        Shopee's web client sends a SHA-256 hash of the password together
        with a client-side timestamp.  We replicate that here.
        """
        password_hash = hashlib.sha256(self._password.encode()).hexdigest()

        return {
            "username"      : self._username,
            "password"      : self._password,
            "password_hash" : password_hash,
            "support_whatsapp": False,
        }

    def get_session_info(self) -> dict:
        """Return a summary dict for logging/debugging (no secrets)."""
        return {
            "username"   : self._username,
            "logged_in"  : self._logged_in,
            "login_age_s": round(time.time() - self._login_at, 1) if self._login_at else None,
            "cookies"    : list(self._session.get_cookies().keys()),
        }
