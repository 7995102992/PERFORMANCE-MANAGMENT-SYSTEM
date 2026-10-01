"""Symmetric encryption helpers for sensitive fields at rest (CTC, salary
components, bank details).

Values are stored as Fernet-encrypted strings and decrypted in the
service/tools layer before they hit the response. The Fernet key is read from
the ``ENCRYPTION_KEY`` setting. Generate one with::

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""

import base64
import hashlib
import json
import os
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.config import settings
from src.logger import logger


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    if not settings.ENCRYPTION_KEY:
        raise RuntimeError("ENCRYPTION_KEY is not configured")
    return Fernet(settings.ENCRYPTION_KEY.encode())


@lru_cache(maxsize=1)
def _file_fernet() -> Fernet:
    """Fernet for uploaded-file encryption — a key separate from ``ENCRYPTION_KEY``."""
    if not settings.FILE_ENCRYPTION_KEY:
        raise RuntimeError("FILE_ENCRYPTION_KEY is not configured")
    return Fernet(settings.FILE_ENCRYPTION_KEY.encode())


def encrypt_bytes(data: bytes) -> bytes:
    """Encrypt raw file bytes for storage at rest (uses ``FILE_ENCRYPTION_KEY``)."""
    return _file_fernet().encrypt(data)


def decrypt_bytes(token: bytes) -> bytes:
    """Decrypt bytes produced by :func:`encrypt_bytes`.

    Legacy objects stored before file encryption are not Fernet tokens, so an
    ``InvalidToken`` is treated as "already plaintext" and the input is returned
    unchanged — keeping pre-existing uploads downloadable.
    """
    try:
        return _file_fernet().decrypt(token)
    except InvalidToken:
        logger.warning("file.decrypt.passthrough", reason="not a Fernet token (legacy plaintext upload?)")
        return token


def encrypt_str(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: str | None) -> str | None:
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


def encrypt_amount(value: int | float | str | None) -> str | None:
    """Encrypt a numeric amount. Stored as a Fernet string."""
    if value is None or value == "":
        return None
    return encrypt_str(str(value))


def decrypt_amount(token: str | int | float | None) -> float | None:
    """Decrypt an amount back to float. Returns None if input is None/empty;
    legacy unencrypted numeric rows pass through unchanged."""
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


def encrypt_json(value: dict | None) -> str | None:
    """Encrypt a JSON-serialisable mapping into a single Fernet token.

    Used for structured sensitive payloads — e.g. a payslip's ``earnings`` /
    ``deductions`` objects — that must be stored opaque at rest and decrypted as
    a whole object in the service layer.

    Args:
        value: The mapping to encrypt, or ``None``.

    Returns:
        The Fernet ciphertext string, or ``None`` when ``value`` is ``None``.
    """
    if value is None:
        return None
    return encrypt_str(json.dumps(value, separators=(",", ":"), default=str))


def decrypt_json(token: str | None) -> dict | None:
    """Decrypt a token produced by :func:`encrypt_json` back into a dict.

    Args:
        token: The Fernet ciphertext, or ``None``.

    Returns:
        The decoded mapping, or ``None`` when the input is empty or cannot be
        decrypted/parsed (key rotated, corrupt ciphertext, or non-JSON payload).
    """
    plain = decrypt_str(token)
    if plain is None:
        return None
    try:
        return json.loads(plain)
    except json.JSONDecodeError:
        logger.error("Failed to parse decrypted JSON payload (corrupt data or wrong key)")
        return None


# ---------------------------------------------------------------------------
# AES-256-GCM (random IV stored alongside the ciphertext)
# ---------------------------------------------------------------------------
# Used where the IV must be persisted explicitly and separately from the
# ciphertext (e.g. the ``employee_pin`` collection's ``iv_key`` / ``cipher_text``
# columns), rather than embedded as Fernet does. The 256-bit key is derived from
# the same ``ENCRYPTION_KEY`` master secret.


@lru_cache(maxsize=1)
def _aes_gcm_key() -> bytes:
    if not settings.ENCRYPTION_KEY:
        raise RuntimeError("ENCRYPTION_KEY is not configured")
    return hashlib.sha256(settings.ENCRYPTION_KEY.encode()).digest()  # 32 bytes


def aes_gcm_encrypt(plaintext: str) -> tuple[str, str]:
    """Encrypt ``plaintext`` with AES-256-GCM under a fresh random 96-bit IV.

    Returns ``(cipher_text_b64, iv_b64)`` where the ciphertext already includes
    the GCM authentication tag. Store both columns; decryption needs the IV.
    """
    iv = os.urandom(12)
    ciphertext = AESGCM(_aes_gcm_key()).encrypt(iv, plaintext.encode(), None)
    return base64.b64encode(ciphertext).decode(), base64.b64encode(iv).decode()


def aes_gcm_decrypt(cipher_text_b64: str | None, iv_b64: str | None) -> str | None:
    """Decrypt a value produced by :func:`aes_gcm_encrypt`.

    Returns ``None`` when either input is missing or authentication fails (wrong
    key, tampered ciphertext, or corrupt IV).
    """
    if not cipher_text_b64 or not iv_b64:
        return None
    try:
        iv = base64.b64decode(iv_b64)
        ciphertext = base64.b64decode(cipher_text_b64)
        return AESGCM(_aes_gcm_key()).decrypt(iv, ciphertext, None).decode()
    except (InvalidTag, ValueError, TypeError) as exc:
        logger.error("AES-GCM decryption failed", error=str(exc))
        return None
