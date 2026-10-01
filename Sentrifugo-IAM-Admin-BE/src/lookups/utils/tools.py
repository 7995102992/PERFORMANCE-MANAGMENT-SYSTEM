"""Repository layer for the seeded lookup collections.

These tables are small (3 + 9 + 5 rows) and rarely change, so reads return
all rows ordered by business key. Seed helpers upsert by id for idempotency.
"""

from src.models import AclDocument, ModuleDocument, PermissionDocument


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
async def list_acl() -> list[dict]:
    rows = await AclDocument.find_all().sort("+rank").to_list()
    return [r.model_dump() for r in rows]


async def list_modules() -> list[dict]:
    rows = await ModuleDocument.find_all().sort("+code").to_list()
    return [r.model_dump() for r in rows]


async def list_permissions(module: str | None = None) -> list[dict]:
    """Return raw permission rows via the motor collection (not the Document model).

    Bypasses Beanie/Pydantic validation on `module`/`code` so a row with a value
    not yet in ModuleEnum/PermissionCodeEnum doesn't blow up the whole request —
    the service layer filters such rows out instead.
    """
    query = {"module": module} if module else {}
    cursor = PermissionDocument.get_motor_collection().find(query).sort([("module", 1), ("code", 1)])
    rows = await cursor.to_list(length=None)
    for r in rows:
        r["id"] = r.pop("_id")
    return rows


# ---------------------------------------------------------------------------
# Upsert (idempotent — used by the seed script)
# ---------------------------------------------------------------------------
async def upsert_acl(data: dict) -> AclDocument:
    existing = await AclDocument.get(data["id"])
    if existing:
        await existing.set({k: v for k, v in data.items() if k != "id"})
        return existing
    doc = AclDocument(**data)
    await doc.insert()
    return doc


async def upsert_module(data: dict) -> ModuleDocument:
    existing = await ModuleDocument.get(data["id"])
    if existing:
        await existing.set({k: v for k, v in data.items() if k != "id"})
        return existing
    doc = ModuleDocument(**data)
    await doc.insert()
    return doc


async def upsert_permission(data: dict) -> PermissionDocument:
    existing = await PermissionDocument.get(data["id"])
    if existing:
        await existing.set({k: v for k, v in data.items() if k != "id"})
        return existing
    doc = PermissionDocument(**data)
    await doc.insert()
    return doc
