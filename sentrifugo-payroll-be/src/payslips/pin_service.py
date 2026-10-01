"""Payslip PIN access — the PIN lifecycle is owned by IAM.

IAM generates, stores, emails and regenerates the employee PIN. This service only
*reads* it when a PIN is needed (to lock/unlock payslip PDFs): it RPC-calls IAM,
which returns the AES-256-GCM ``cipher_text`` + ``iv_key`` (the exact pair IAM
persists), and decrypts it with the shared ``ENCRYPTION_KEY``-derived key. Both
services derive the key identically, so the ciphertext round-trips.
"""

from __future__ import annotations

import secrets

from src.auth.schemas import UserBase
from src.logger import logger
from src.rabbitmq import iam_rpc
from src.security.crypto import aes_gcm_decrypt

__all__ = ["get_or_create_pin", "regenerate_pin", "verify_pin"]


class PinUnavailable(RuntimeError):
    """IAM returned no PIN, or the ciphertext could not be decrypted."""


def _decrypt(data: dict | None) -> str | None:
    """Decrypt the ``{cipher_text, iv_key}`` pair IAM returned, or ``None``."""
    if not data:
        return None
    return aes_gcm_decrypt(data.get("cipher_text"), data.get("iv_key"))


async def get_or_create_pin(user: UserBase) -> tuple[str, bool]:
    """Fetch the caller's PIN from IAM, creating + emailing one if absent.

    Returns ``(pin, created)`` — ``created`` is True when IAM generated (and
    emailed) a new PIN on this call.

    Raises:
        PinUnavailable: IAM returned no PIN, or the ciphertext failed to decrypt
            (an ``ENCRYPTION_KEY`` mismatch between this service and IAM).
    """
    data = await iam_rpc.employee_pin(user.id, user.organisation_id, "get_or_create")
    pin = _decrypt(data)
    if not pin:
        logger.error("pin.unavailable", user_id=user.id, has_data=bool(data))
        raise PinUnavailable("Could not obtain the employee PIN from IAM")
    return pin, bool(data.get("created"))


async def verify_pin(user: UserBase, pin: str) -> tuple[bool, bool]:
    """Check ``pin`` against the caller's IAM-held PIN (screen-lock unlock).

    Returns ``(valid, pin_set)`` — ``pin_set`` is False when the user has no PIN
    yet. Fetch-only (never creates a PIN). Constant-time compare.
    """
    stored = _decrypt(await iam_rpc.employee_pin(user.id, user.organisation_id, "get"))
    if not stored:
        return False, False
    return secrets.compare_digest(stored, (pin or "").strip()), True


async def regenerate_pin(user: UserBase) -> None:
    """Ask IAM to regenerate + email a fresh PIN for the caller."""
    await iam_rpc.employee_pin(user.id, user.organisation_id, "regenerate")
