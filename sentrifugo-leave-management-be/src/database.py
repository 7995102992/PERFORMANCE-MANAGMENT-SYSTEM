from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

mongo_client: AsyncIOMotorClient | None = None


def init_db():
    global mongo_client
    mongo_client = AsyncIOMotorClient(settings.MONGODB_URL)



async def close_db():
    if mongo_client:
        mongo_client.close()


def get_db():
    if not mongo_client:
        raise RuntimeError("MongoDB client not initialized")
    return mongo_client.get_default_database()


async def get_db_session():
    """Dependency to get MongoDB database instance."""
    if not mongo_client:
        raise RuntimeError("MongoDB client not initialized")
    yield mongo_client.get_default_database()
