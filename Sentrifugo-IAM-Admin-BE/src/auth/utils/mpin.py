"""mPIN device-token management in Valkey.

A device token is a random opaque string issued after normal login.
It lets the user authenticate on that device using their payslip PIN
instead of their password on subsequent logins.

Valkey key layout:
  mpin:device:<sha256(token)>      → JSON {user_id, created_at, last_used_at}  TTL 30 days
  user:mpin_devices:<user_id>      → SET of token hashes (for bulk revoke)
  mpin:attempts:<sha256(token)>    → int (failed PIN attempts)                  TTL 15 min
"""

import hashlib
import json
import secrets
from datetime import datetime, timezone

from src import valkey

DEVICE_PREFIX = "mpin:device:"
USER_DEVICES_PREFIX = "user:mpin_devices:"
ATTEMPTS_PREFIX = "mpin:attempts:"

DEVICE_TTL_SECONDS = 30 * 24 * 3600   # 30 days
MAX_ATTEMPTS = 5
LOCKOUT_TTL_SECONDS = 15 * 60         # 15 minutes


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def generate_device_token() -> str:
    return secrets.token_hex(32)


async def store_device_token(user_id: str, token: str) -> None:
    h = _hash(token)
    data = {
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "last_used_at": None,
    }
    await valkey.valkey_client.set(f"{DEVICE_PREFIX}{h}", json.dumps(data), ex=DEVICE_TTL_SECONDS)
    await valkey.valkey_client.sadd(f"{USER_DEVICES_PREFIX}{user_id}", h)


async def get_device_session(token: str) -> dict | None:
    raw = await valkey.valkey_client.get(f"{DEVICE_PREFIX}{_hash(token)}")
    return json.loads(raw) if raw else None


async def touch_device_token(token: str) -> None:
    h = _hash(token)
    key = f"{DEVICE_PREFIX}{h}"
    raw = await valkey.valkey_client.get(key)
    if raw:
        data = json.loads(raw)
        data["last_used_at"] = datetime.now(timezone.utc).isoformat()
        await valkey.valkey_client.set(key, json.dumps(data), ex=DEVICE_TTL_SECONDS)


async def revoke_device_token(token: str, user_id: str) -> None:
    h = _hash(token)
    await valkey.valkey_client.delete(f"{DEVICE_PREFIX}{h}")
    await valkey.valkey_client.srem(f"{USER_DEVICES_PREFIX}{user_id}", h)


async def revoke_all_device_tokens(user_id: str) -> None:
    set_key = f"{USER_DEVICES_PREFIX}{user_id}"
    hashes = await valkey.valkey_client.smembers(set_key)
    if hashes:
        keys = [f"{DEVICE_PREFIX}{h}" for h in hashes]
        await valkey.valkey_client.delete(*keys)
    await valkey.valkey_client.delete(set_key)


async def record_failed_attempt(token: str) -> int:
    """Increment failed PIN attempts and return the new count."""
    key = f"{ATTEMPTS_PREFIX}{_hash(token)}"
    count = await valkey.valkey_client.incr(key)
    if count == 1:
        await valkey.valkey_client.expire(key, LOCKOUT_TTL_SECONDS)
    return count


async def is_device_locked(token: str) -> bool:
    count = await valkey.valkey_client.get(f"{ATTEMPTS_PREFIX}{_hash(token)}")
    return int(count) >= MAX_ATTEMPTS if count else False


async def clear_failed_attempts(token: str) -> None:
    await valkey.valkey_client.delete(f"{ATTEMPTS_PREFIX}{_hash(token)}")
