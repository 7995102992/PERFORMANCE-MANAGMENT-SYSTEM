from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from src.config import settings
from src.logger import logger

engine: AsyncEngine | None = None
session_factory: async_sessionmaker[AsyncSession] | None = None


async def init_db():
    global engine, session_factory
    engine = create_async_engine(
        settings.MSSQL_URL,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=5,
        max_overflow=5,
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    # Fail loudly at startup if the source DB is unreachable — the crawler is
    # this service's whole purpose, so a silent bad connection helps nobody.
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        logger.info("MS SQL connection initialized", host=settings.MSSQL_HOST, database=settings.MSSQL_DB_NAME)
    except Exception as e:
        logger.error("MS SQL connection failed on startup", error=str(e))


async def close_db():
    if engine:
        await engine.dispose()
        logger.info("MS SQL connection closed")


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    if session_factory is None:
        raise RuntimeError("Database not initialized")
    return session_factory
