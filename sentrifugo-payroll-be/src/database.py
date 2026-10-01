"""Database bootstrap — MongoDB (Percona Server for MongoDB) via Beanie.

The same store every sibling Sentrifugo service uses. Call ``init_db()`` /
``close_db()`` from the FastAPI lifespan.
"""

from __future__ import annotations

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from src.config import settings
from src.logger import logger
from src.models import ALL_DOCUMENTS

mongo_client: AsyncIOMotorClient | None = None
mongo_db: AsyncIOMotorDatabase | None = None


async def init_db() -> None:
    global mongo_client, mongo_db
    mongo_client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    mongo_db = mongo_client[settings.MONGO_DB_NAME]
    await init_beanie(database=mongo_db, document_models=ALL_DOCUMENTS)
    logger.info(
        "MongoDB + Beanie ODM initialized",
        database=settings.MONGO_DB_NAME,
        models=len(ALL_DOCUMENTS),
    )


async def close_db() -> None:
    global mongo_client
    if mongo_client:
        mongo_client.close()
        logger.info("MongoDB connection closed")


def get_mongo() -> AsyncIOMotorDatabase:
    """Return the Motor database instance (health pings, raw queries)."""
    if mongo_db is None:
        raise RuntimeError("MongoDB not initialised — call init_db() first")
    return mongo_db
