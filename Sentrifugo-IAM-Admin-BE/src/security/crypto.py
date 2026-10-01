"""Symmetric encryption helpers for sensitive fields at rest (e.g. CTC, band amounts).

Values are stored in MongoDB as Fernet-encrypted strings and decrypted in the
service/tools layer before they hit the response. The Fernet key is read from
the ENCRYPTION_KEY setting.
"""
from datetime import datetime, timezone
from functools import lru_cache
from typing import Optional, Union

from cryptography.fernet import Fernet, InvalidToken

from src.config import settings
from src.logger import logger


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    if not settings.ENCRYPTION_KEY:
        raise RuntimeError("ENCRYPTION_KEY is not configured")
    return Fernet(settings.ENCRYPTION_KEY.encode())


def encrypt_str(value: Optional[str]) -> Optional[str]:
    if value is None or value == "":
        return None
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: Optional[str]) -> Optional[str]:
    if token is None or token == "":
        return None
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        logger.error(
            "Failed to decrypt value: InvalidToken. The stored ciphertext does not "
            "match the current ENCRYPTION_KEY (key rotated, or value encrypted under "
            "a different key)."
        )
        return None


def encrypt_amount(value: Optional[Union[int, float, str]]) -> Optional[str]:
    """Encrypt a numeric amount. Stored as a Fernet string in Mongo."""
    if value is None or value == "":
        return None
    return encrypt_str(str(value))


def decrypt_amount(token: Optional[Union[str, int, float]]) -> Optional[float]:
    """Decrypt an amount back to float. Returns None if input is None/empty or
    the value is already numeric (legacy unencrypted rows pass through)."""
    if token is None or token == "":
        return None
    if isinstance(token, (int, float)):
        return float(token)
    plain = decrypt_str(token)
    if plain is None:
        return None
    try:
        return float(plain)
    except (TypeError, ValueError):
        return None


# ─── Employee CTC (numbered version map) ────────────────────────────────────
# CTC is stored on EmployeeDocument as a number-keyed version map so every salary
# revision is retained with the moment it changed:
#   {
#     "1": {"value": "<fernet>", "currency": "INR", "updated_on": "2026-06-18T09:57:00+00:00"},
#     "2": {"value": "<fernet>", "currency": "USD", "updated_on": "2026-06-18T10:03:08+00:00"},
#     ...
#   }
# Keys are sequential 1-based strings; the highest key is the current CTC. Each
# entry holds the Fernet-encrypted amount (``value``), the ``currency`` it was set
# in (snapshot for history), and the ``updated_on`` timestamp. The separate
# top-level ``currency`` field is also kept (current currency). A new version is
# appended when the amount or currency changes.

def _iso(value) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else (value or None)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sorted_keys(versions: dict) -> list[str]:
    """Version keys ordered oldest→newest by their numeric value."""
    return sorted(versions.keys(), key=lambda k: int(k))


def build_ctc(amount, currency=None, updated_on=None) -> Optional[dict]:
    """Create the initial ctc version map ``{"1": {value, currency, updated_on}}``
    from a single amount, or None when the amount is empty (used on create)."""
    enc = encrypt_amount(amount)
    if enc is None:
        return None
    return {"1": {"value": enc, "currency": currency, "updated_on": _iso(updated_on) or _now_iso()}}


def revise_ctc(existing, amount, currency=None, updated_on=None) -> Optional[dict]:
    """Append a new CTC version when the amount or currency changes, preserving all
    prior versions. ``existing`` is the stored version map (or None). Returns the
    updated map. If nothing changed, ``existing`` is returned as-is; if the amount
    is cleared, the prior versions are kept untouched."""
    enc = encrypt_amount(amount)
    if not isinstance(existing, dict) or not existing:
        # No prior history — start a fresh map (or nothing if cleared).
        return build_ctc(amount, currency, updated_on)
    if enc is None:
        # Amount cleared — keep the existing history unchanged.
        return existing
    keys = _sorted_keys(existing)
    latest = existing[keys[-1]]
    same_amount = decrypt_amount(latest.get("value")) == decrypt_amount(enc)
    same_currency = latest.get("currency") == currency
    if same_amount and same_currency:
        return existing  # no real change → don't add a version
    updated = dict(existing)
    next_key = str(int(keys[-1]) + 1)
    updated[next_key] = {"value": enc, "currency": currency, "updated_on": _iso(updated_on) or _now_iso()}
    return updated


def decrypt_ctc(stored) -> Optional[dict]:
    """Decrypt a stored ctc version map for the API response. Returns
    ``{"amount", "currency", "updated_on", "history": [...]}`` or None. ``history``
    is the prior versions (excluding current), oldest→newest, each
    ``{amount, currency, updated_on}`` decrypted."""
    if not isinstance(stored, dict) or not stored:
        return None
    keys = _sorted_keys(stored)

    def _dec(entry):
        return {
            "amount": decrypt_amount(entry.get("value")),
            "currency": entry.get("currency"),
            "updated_on": entry.get("updated_on"),
        }

    current = _dec(stored[keys[-1]])
    history = [_dec(stored[k]) for k in keys[:-1]]
    return {
        "amount": current["amount"],
        "currency": current["currency"],
        "updated_on": current["updated_on"],
        "history": history,
    }
