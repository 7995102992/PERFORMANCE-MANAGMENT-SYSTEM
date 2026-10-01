"""MongoDB bootstrap (Mongo-only — Foundation §2).

Call `init_db()` from the FastAPI lifespan.
"""
from __future__ import annotations

import logging

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from .config import settings
from .models import ALL_DOCUMENTS

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None
_db = None


async def init_db() -> None:
    global _client, _db
    _client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    _db = _client[settings.MONGO_DB_NAME]
    await init_beanie(database=_db, document_models=ALL_DOCUMENTS)
    logger.info("mongo.init db=%s models=%d", settings.MONGO_DB_NAME, len(ALL_DOCUMENTS))


async def close_db() -> None:
    global _client
    if _client:
        _client.close()
        _client = None
        logger.info("mongo.closed")


def get_db():
    if _db is None:
        raise RuntimeError("Database not initialised — call init_db() first")
    return _db


def get_client() -> AsyncIOMotorClient:
    if _client is None:
        raise RuntimeError("Mongo client not initialised")
    return _client
