from motor.motor_asyncio import AsyncIOMotorDatabase

EMPLOYMENT_TYPES_COLLECTION = "employment_types"

# Only employees whose employment_type key is in this set get counted toward
# leave allocations or credit posting. Contract / internship / etc. are
# excluded by design — change this set if the business decides to extend
# leave benefits to other types.
ELIGIBLE_EMPLOYMENT_TYPE_KEYS = frozenset({"full-time"})


async def get_eligible_type_ids(db: AsyncIOMotorDatabase) -> set:
    """Return the set of ObjectIds whose key is in ELIGIBLE_EMPLOYMENT_TYPE_KEYS."""
    docs = await db[EMPLOYMENT_TYPES_COLLECTION].find(
        {"key": {"$in": list(ELIGIBLE_EMPLOYMENT_TYPE_KEYS)}},
        {"_id": 1},
    ).to_list(length=None)
    return {d["_id"] for d in docs}
