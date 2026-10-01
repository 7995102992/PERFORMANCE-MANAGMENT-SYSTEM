from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from src.config import settings
from src.logger import logger

mongo_client: AsyncIOMotorClient | None = None
db: AsyncIOMotorDatabase | None = None


async def init_db():
    global mongo_client, db
    mongo_client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = mongo_client[settings.MONGO_DB_NAME]

    await db.inbox_events.create_index(
        [("tenant_id", 1), ("idempotency_key", 1)], unique=True,
    )
    await db.email_log.create_index(
        [("tenant_id", 1), ("idempotency_key", 1)], unique=True,
    )
    await db.email_log.create_index([("tenant_id", 1), ("status", 1)])
    await db.tenant_email_config.create_index("tenant_id", unique=True)
    await db.template_mappings.create_index(
        [("tenant_id", 1), ("template_id", 1), ("provider", 1)], unique=True,
    )
    await db.audit_outbox_events.create_index("idempotency_key", unique=True)
    await db.audit_outbox_events.create_index([("status", 1), ("created_at", 1)])
    logger.info("MongoDB initialized", database=settings.MONGO_DB_NAME)


async def close_db():
    if mongo_client:
        mongo_client.close()
        logger.info("MongoDB connection closed")


def get_db() -> AsyncIOMotorDatabase:
    # NOTE: compare with `is None` — Motor Database/Collection objects raise
    # NotImplementedError on truth-value testing (`if not db`), which would make
    # every call here throw once `db` is set.
    if db is None:
        raise RuntimeError("MongoDB not initialized")
    return db
