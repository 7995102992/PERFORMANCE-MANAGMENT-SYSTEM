from beanie import PydanticObjectId

from src.auth.models import UserDocument
from src.logger import logger


def _serialize(doc: UserDocument) -> dict:
    """Convert a UserDocument to a dict with ObjectId fields as strings."""
    d = doc.model_dump()
    if d.get("id") is not None:
        d["id"] = str(d["id"])
    if d.get("organisation_id") is not None:
        d["organisation_id"] = str(d["organisation_id"])
    d["policy_ids"] = [str(pid) for pid in (d.get("policy_ids") or [])]
    return d


async def create_user(user_data: dict) -> dict:
    """Insert a new user document."""
    user = UserDocument(**user_data)
    await user.insert()
    logger.info("User created", user_id=str(user.id))
    return _serialize(user)


async def get_user_by_id(user_id: str) -> dict | None:
    """Find a user by ObjectId."""
    try:
        oid = PydanticObjectId(user_id)
    except Exception:
        logger.warning("user_id is not a valid ObjectId", user_id=user_id)
        return None
    user = await UserDocument.find_one(
        UserDocument.id == oid,
        UserDocument.deleted_on == None,  # noqa: E711
    )
    return _serialize(user) if user else None


async def get_user_by_email(email: str) -> dict | None:
    """Find a user by email (case-insensitive — emails are stored lowercased)."""
    user = await UserDocument.find_one(
        UserDocument.email == (email or "").strip().lower(),
        UserDocument.deleted_on == None,  # noqa: E711
    )
    return _serialize(user) if user else None


async def get_user_by_azure_oid(azure_oid: str) -> dict | None:
    """Find a user by Azure AD object ID."""
    user = await UserDocument.find_one(
        UserDocument.azure_oid == azure_oid,
        UserDocument.deleted_on == None,  # noqa: E711
    )
    return _serialize(user) if user else None


async def list_users(
    skip: int = 0,
    limit: int = 20,
    organisation_id: str | None = None,
    is_org_admin: bool | None = None,
) -> list[dict]:
    """Return a paginated list of non-deleted users, optionally scoped by org."""
    filters = [UserDocument.deleted_on == None]  # noqa: E711
    if organisation_id is not None:
        filters.append(UserDocument.organisation_id == PydanticObjectId(organisation_id))
    if is_org_admin is not None:
        filters.append(UserDocument.is_org_admin == is_org_admin)  # noqa: E712
    users = await UserDocument.find(*filters).skip(skip).limit(limit).to_list()
    return [_serialize(u) for u in users]


async def update_user(user_id: str, update_data: dict) -> dict | None:
    """Partially update a user and return the updated document."""
    try:
        oid = PydanticObjectId(user_id)
    except Exception:
        logger.warning("user_id is not a valid ObjectId", user_id=user_id)
        return None
    user = await UserDocument.find_one(
        UserDocument.id == oid,
        UserDocument.deleted_on == None,  # noqa: E711
    )
    if not user:
        return None
    await user.set(update_data)
    return _serialize(user)


async def get_org_admin(organisation_id: str) -> dict | None:
    """Return the primary org admin user for a given organisation, if any."""
    user = await UserDocument.find_one(
        UserDocument.organisation_id == PydanticObjectId(organisation_id),
        UserDocument.is_org_admin == True,  # noqa: E712
        UserDocument.deleted_on == None,  # noqa: E711
        sort=[("created_on", -1)],
    )
    return _serialize(user) if user else None


async def search_users(
    query: str,
    skip: int = 0,
    limit: int = 20,
    organisation_id: str | None = None,
) -> list[dict]:
    """Search non-deleted users by email or name (case-insensitive)."""
    import re
    regex = {"$regex": re.escape(query), "$options": "i"}
    filters = [
        {"$or": [{"email": regex}, {"first_name": regex}, {"last_name": regex}]},
        UserDocument.deleted_on == None,  # noqa: E711
    ]
    if organisation_id is not None:
        filters.append(UserDocument.organisation_id == PydanticObjectId(organisation_id))
    users = await UserDocument.find(*filters).skip(skip).limit(limit).to_list()
    return [_serialize(u) for u in users]


async def get_users_with_policy(policy_id: str) -> list[dict]:
    """Return every live user whose policy_ids list contains `policy_id`."""
    rows = await UserDocument.find({
        "policy_ids": PydanticObjectId(policy_id),
        "deleted_on": None,
    }).to_list()
    return [_serialize(u) for u in rows]


async def list_users_with_any_policy(
    policy_ids: list[str], organisation_id: str | None = None
) -> list[dict]:
    """Return live users whose policy_ids intersect `policy_ids`, optionally
    scoped to an organisation."""
    oids = []
    for pid in policy_ids:
        try:
            oids.append(PydanticObjectId(pid))
        except Exception:
            continue
    if not oids:
        return []
    query: dict = {"policy_ids": {"$in": oids}, "deleted_on": None}
    if organisation_id is not None:
        query["organisation_id"] = PydanticObjectId(organisation_id)
    rows = await UserDocument.find(query).to_list()
    return [_serialize(u) for u in rows]


async def attach_policy(user_id: str, policy_id: str) -> dict | None:
    """Append policy_id to the user's policy_ids if not already present."""
    try:
        oid = PydanticObjectId(user_id)
        pid = PydanticObjectId(policy_id)
    except Exception:
        return None
    user = await UserDocument.find_one(
        UserDocument.id == oid,
        UserDocument.deleted_on == None,  # noqa: E711
    )
    if not user:
        return None
    current = list(user.policy_ids or [])
    if pid not in current:
        current.append(pid)
        await user.set({"policy_ids": current})
    return _serialize(user)


async def detach_policy(user_id: str, policy_id: str) -> tuple[bool, dict | None]:
    """Remove policy_id from the user's policy_ids."""
    try:
        oid = PydanticObjectId(user_id)
        pid = PydanticObjectId(policy_id)
    except Exception:
        return False, None
    user = await UserDocument.find_one(
        UserDocument.id == oid,
        UserDocument.deleted_on == None,  # noqa: E711
    )
    if not user:
        return False, None
    current = list(user.policy_ids or [])
    if pid not in current:
        return False, _serialize(user)
    current.remove(pid)
    await user.set({"policy_ids": current})
    return True, _serialize(user)


async def ensure_indexes():
    """No-op — Beanie manages indexes via Document.Settings.indexes."""
    pass
