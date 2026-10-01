"""Brute-force / password-spray throttling for password login (F-07).

The password login path had no rate limiting: an attacker with a list of valid
emails (obtainable elsewhere) could guess passwords at full speed. This adds
Valkey-backed sliding-window counters across three dimensions so both the
single-IP and the distributed cases are covered:

* (email, ip)  — the common case: one attacker hammering one account.
* ip           — one source spraying many accounts.
* email        — one account targeted from many IPs (distributed spray). A
                 higher threshold keeps the victim-lockout DoS surface small.

Counters live for a fixed window (they self-expire) and the email-scoped ones
are cleared on a successful login, so a legitimate user who eventually gets
their password right is not penalised. Mirrors the existing MPIN lockout style
(``src/auth/utils/mpin.py``). Fails open: if Valkey is unreachable the login
proceeds rather than locking everyone out.
"""
from __future__ import annotations

from fastapi import status

from src import valkey
from src.exceptions import DomainException
from src.logger import logger

_PREFIX = "login_fail:"
WINDOW_SECONDS = 15 * 60  # 15-minute sliding window

# Per-dimension thresholds (failures within the window before a 429).
ACCOUNT_IP_MAX = 5    # one attacker, one account
IP_MAX = 20           # one IP spraying many accounts
ACCOUNT_MAX = 15      # one account from many IPs (kept high to limit DoS)


def _norm(email: str) -> str:
    return (email or "").strip().lower()


def _keys(email: str, ip: str) -> list[tuple[str, int]]:
    e = _norm(email)
    return [
        (f"{_PREFIX}ai:{e}:{ip}", ACCOUNT_IP_MAX),
        (f"{_PREFIX}ip:{ip}", IP_MAX),
        (f"{_PREFIX}acct:{e}", ACCOUNT_MAX),
    ]


async def check_not_locked(email: str, ip: str) -> None:
    """Raise 429 if any dimension is over its threshold. Fails open on error."""
    try:
        for key, limit in _keys(email, ip):
            count = await valkey.valkey_client.get(key)
            if count is not None and int(count) >= limit:
                logger.warning(
                    "Login throttled", key=key, count=int(count), ip_address=ip
                )
                raise DomainException(
                    message="Too many failed login attempts. Please try again later.",
                    code="TOO_MANY_REQUESTS",
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                )
    except DomainException:
        raise
    except Exception as exc:  # Valkey down / parse error -> do not block login
        logger.warning("Login throttle check skipped", error=str(exc))


async def record_failure(email: str, ip: str) -> None:
    """Increment every dimension's counter for a failed attempt. Fails open."""
    try:
        for key, _ in _keys(email, ip):
            count = await valkey.valkey_client.incr(key)
            if count == 1:
                await valkey.valkey_client.expire(key, WINDOW_SECONDS)
    except Exception as exc:
        logger.warning("Login throttle record skipped", error=str(exc))


async def clear(email: str, ip: str) -> None:
    """Clear the email-scoped counters after a successful login. Fails open.

    The pure-IP counter is intentionally left to expire on its own so a single
    valid login cannot reset spray protection for the whole source IP.
    """
    try:
        e = _norm(email)
        await valkey.valkey_client.delete(f"{_PREFIX}ai:{e}:{ip}", f"{_PREFIX}acct:{e}")
    except Exception as exc:
        logger.warning("Login throttle clear skipped", error=str(exc))
