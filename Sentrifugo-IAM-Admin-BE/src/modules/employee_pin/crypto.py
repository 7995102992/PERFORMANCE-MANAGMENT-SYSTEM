"""AES-256-GCM PIN encryption — must match payroll's aes_gcm_encrypt/decrypt exactly.

Key derivation: SHA-256(ENCRYPTION_KEY.encode()) → 32 bytes.
Cipher: AES-256-GCM, 12-byte random IV per encrypt, no AAD.
Storage: cipher_text = base64(ciphertext || 16-byte GCM tag), iv_key = base64(iv).
"""
import base64
import hashlib
import os
import secrets
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.config import settings


@lru_cache(maxsize=1)
def _aes_key() -> bytes:
    if not settings.ENCRYPTION_KEY:
        raise RuntimeError("ENCRYPTION_KEY is not configured")
    return hashlib.sha256(settings.ENCRYPTION_KEY.encode()).digest()


def pin_encrypt(pin: str) -> tuple[str, str]:
    """Returns (cipher_text_b64, iv_key_b64)."""
    iv = os.urandom(12)
    ct = AESGCM(_aes_key()).encrypt(iv, pin.encode(), None)
    return base64.b64encode(ct).decode(), base64.b64encode(iv).decode()


def pin_decrypt(cipher_text: str, iv_key: str) -> str:
    iv = base64.b64decode(iv_key)
    ct = base64.b64decode(cipher_text)
    return AESGCM(_aes_key()).decrypt(iv, ct, None).decode()


def generate_pin() -> str:
    return f"{secrets.randbelow(10 ** 6):06d}"
