"""Employee PIN lifecycle — get, get_or_create, regenerate, verify."""
import secrets
from datetime import datetime, timezone
from typing import Optional

from beanie import PydanticObjectId
from pymongo.errors import DuplicateKeyError

from src import valkey
from src.auth.models import UserDocument
from src.logger import logger
from src.modules.employee_pin.crypto import generate_pin, pin_decrypt, pin_encrypt
from src.modules.employee_pin.email import publish_pin_email
from src.modules.employee_pin.models import EmployeePinDocument
from src.rabbitmq import DebugLevel, outbox

# Verify rate-limit: 5 failures → 15-minute cooldown (verify is a PIN oracle).
VERIFY_ATTEMPTS_PREFIX = "pin:verify:attempts:"
VERIFY_MAX_ATTEMPTS = 5
VERIFY_LOCKOUT_TTL_SECONDS = 15 * 60


def _to_oid(val) -> Optional[PydanticObjectId]:
    try:
        return PydanticObjectId(val) if val else None
    except Exception:
        return None


async def _user(user_id) -> Optional[UserDocument]:
    oid = _to_oid(user_id)
    if not oid:
        return None
    return await UserDocument.find_one({"_id": oid, "deleted_on": None})


def _result(doc: EmployeePinDocument, created: bool) -> dict:
    return {
        "cipher_text": doc.cipher_text,
        "iv_key": doc.iv_key,
        "created": created,
    }


async def _store_new_pin(
    doc: Optional[EmployeePinDocument],
    user: UserDocument,
    organisation_id,
    correlation_id: str = "",
) -> tuple[EmployeePinDocument, str]:
    pin = generate_pin()
    cipher_text, iv_key = pin_encrypt(pin)
    now = datetime.now(timezone.utc)

    if doc is None:
        doc = EmployeePinDocument(
            organisation_id=_to_oid(organisation_id),
            user_id=user.id,
            cipher_text=cipher_text,
            iv_key=iv_key,
            correlation_id=correlation_id,
            created_on=now,
            updated_on=now,
        )
        try:
            await doc.insert()
        except DuplicateKeyError:
            # Concurrent get_or_create raced us on the unique user_id index — the
            # other coroutine created the row; update that one instead of failing.
            existing = await EmployeePinDocument.find_one({"user_id": user.id, "deleted_on": None})
            if existing is None:
                raise
            doc = existing
            doc.cipher_text = cipher_text
            doc.iv_key = iv_key
            doc.correlation_id = correlation_id
            doc.organisation_id = _to_oid(organisation_id) or doc.organisation_id
            doc.updated_on = now
            await doc.save()
    else:
        doc.cipher_text = cipher_text
        doc.iv_key = iv_key
        doc.correlation_id = correlation_id
        # Refresh the tenant on the existing row so it never carries a stale org.
        doc.organisation_id = _to_oid(organisation_id) or doc.organisation_id
        doc.updated_on = now
        await doc.save()

    return doc, pin


async def get_pin(user_id: str, organisation_id: str) -> Optional[dict]:
    oid = _to_oid(user_id)
    if not oid:
        return None
    doc = await EmployeePinDocument.find_one({"user_id": oid, "deleted_on": None})
    if not doc or not doc.cipher_text:
        return None
    return _result(doc, False)


async def get_or_create_pin(
    user_id: str,
    organisation_id: str,
    correlation_id: str = "",
) -> Optional[dict]:
    oid = _to_oid(user_id)
    if not oid:
        return None

    doc = await EmployeePinDocument.find_one({"user_id": oid, "deleted_on": None})
    if doc and doc.cipher_text:
        return _result(doc, False)

    user = await _user(user_id)
    if not user:
        logger.warning("employee_pin.get_or_create: user not found", user_id=user_id)
        return None

    doc, pin = await _store_new_pin(doc, user, organisation_id, correlation_id)
    full_name = f"{(user.first_name or '').strip()} {(user.last_name or '').strip()}".strip()
    try:
        await publish_pin_email(
            user_email=user.email,
            display_name=full_name,
            pin=pin,
            tenant_id=str(organisation_id),
            correlation_id=correlation_id,
        )
    except Exception as exc:
        logger.error("employee_pin: failed to send pin email", error=repr(exc))

    await outbox.publish_audit_log(
        module="employee_pin",
        actor_id=str(user.id),
        action="pin_created",
        resource=f"employee_pin:{user.id}",
        debug_level=DebugLevel.HR,
        organisation_id=str(organisation_id) if organisation_id else None,
    )

    return _result(doc, True)


async def regenerate_pin(
    user_id: str,
    organisation_id: str,
    correlation_id: str = "",
) -> Optional[dict]:
    oid = _to_oid(user_id)
    if not oid:
        return None

    user = await _user(user_id)
    if not user:
        logger.warning("employee_pin.regenerate: user not found", user_id=user_id)
        return None

    doc = await EmployeePinDocument.find_one({"user_id": oid, "deleted_on": None})
    doc, pin = await _store_new_pin(doc, user, organisation_id, correlation_id)
    full_name = f"{(user.first_name or '').strip()} {(user.last_name or '').strip()}".strip()
    try:
        await publish_pin_email(
            user_email=user.email,
            display_name=full_name,
            pin=pin,
            tenant_id=str(organisation_id),
            correlation_id=correlation_id,
        )
    except Exception as exc:
        logger.error("employee_pin: failed to send pin email", error=repr(exc))

    await outbox.publish_audit_log(
        module="employee_pin",
        actor_id=str(user.id),
        action="pin_regenerated",
        resource=f"employee_pin:{user.id}",
        debug_level=DebugLevel.HR,
        organisation_id=str(organisation_id) if organisation_id else None,
    )

    return _result(doc, True)


async def verify_pin(user_id: str, organisation_id: str, pin: str) -> dict:
    """Constant-time verify of a candidate PIN. Never auto-creates; the plaintext
    never leaves this function. Rate-limited per user since verify is a PIN oracle.

    Returns ``{valid, pin_set, locked, retry_after}``. ``pin_set`` reflects whether
    a PIN actually exists (even during lockout, so callers don't mistake a
    cooldown for 'no PIN'); ``locked``/``retry_after`` describe the cooldown so
    callers can tell 'too many attempts' apart from a wrong or unset PIN.
    """
    result = {"valid": False, "pin_set": False, "locked": False, "retry_after": 0}

    oid = _to_oid(user_id)
    if not oid:
        return result

    # Resolve PIN existence up front so pin_set is correct on every return path.
    doc = await EmployeePinDocument.find_one({"user_id": oid, "deleted_on": None})
    result["pin_set"] = bool(doc and doc.cipher_text and doc.iv_key)

    attempts_key = f"{VERIFY_ATTEMPTS_PREFIX}{user_id}"
    try:
        attempts = int(await valkey.valkey_client.get(attempts_key) or 0)
    except Exception as exc:  # fail-open, but never silently
        logger.warning("employee_pin.verify: attempts read failed (fail-open)", user_id=user_id, error=repr(exc))
        attempts = 0
    if attempts >= VERIFY_MAX_ATTEMPTS:
        try:
            ttl = await valkey.valkey_client.ttl(attempts_key)
        except Exception:
            ttl = VERIFY_LOCKOUT_TTL_SECONDS
        result["locked"] = True
        result["retry_after"] = ttl if ttl and ttl > 0 else VERIFY_LOCKOUT_TTL_SECONDS
        logger.warning("employee_pin.verify: rate-limited", user_id=user_id, retry_after=result["retry_after"])
        return result

    if not result["pin_set"]:
        return result

    try:
        stored_pin = pin_decrypt(doc.cipher_text, doc.iv_key)
    except Exception as exc:
        logger.error("employee_pin.verify: decrypt failed", user_id=user_id, error=repr(exc))
        return result

    result["valid"] = secrets.compare_digest(stored_pin, (pin or "").strip())

    try:
        if result["valid"]:
            await valkey.valkey_client.delete(attempts_key)
        else:
            n = await valkey.valkey_client.incr(attempts_key)
            await valkey.valkey_client.expire(attempts_key, VERIFY_LOCKOUT_TTL_SECONDS)
            logger.info("employee_pin.verify: mismatch", user_id=user_id, attempts=n)
    except Exception as exc:  # counter update failed -> log; do not fail the verify
        logger.warning("employee_pin.verify: attempts update failed", user_id=user_id, error=repr(exc))

    if not result["valid"]:
        await outbox.publish_audit_log(
            module="employee_pin",
            actor_id=str(user_id),
            action="pin_verify_failed",
            resource=f"employee_pin:{user_id}",
            debug_level=DebugLevel.EMPLOYEE,
            organisation_id=str(organisation_id) if organisation_id else None,
        )

    return result
