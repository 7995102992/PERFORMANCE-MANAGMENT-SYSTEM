from typing import Any

from sqlalchemy import text

from src.config import settings
from src.database import get_pg, get_mongo
from src.logger import logger
from src.rabbitmq import is_connected as rabbitmq_is_connected
from src import valkey
from src.graph import is_healthy as graph_is_healthy


async def check_health() -> dict[str, Any]:
    pg_connected: bool | None = None
    mongo_connected: bool | None = None
    valkey_connected = False
    rabbitmq_connected = False
    neo4j_connected = False

    # Check PostgreSQL
    if settings.POSTGRES_URL:
        pg_connected = False
        try:
            session = get_pg()
            await session.execute(text("SELECT 1"))
            pg_connected = True
        except Exception as e:
            logger.error("PostgreSQL health check failed", error=str(e))

    # Check MongoDB
    if settings.MONGODB_URL:
        mongo_connected = False
        try:
            db = get_mongo()
            await db.command("ping")
            mongo_connected = True
        except Exception as e:
            logger.error("MongoDB health check failed", error=str(e))

    # Check Valkey
    try:
        if valkey.valkey_client and await valkey.valkey_client.ping():
            valkey_connected = True
    except Exception as e:
        logger.error("Valkey health check failed", error=str(e))

    # Check RabbitMQ
    try:
        if rabbitmq_is_connected():
            rabbitmq_connected = True
    except Exception as e:
        logger.error("RabbitMQ health check failed", error=str(e))

    # Check Neo4j (graph projection store)
    try:
        neo4j_connected = await graph_is_healthy()
    except Exception as e:
        logger.error("Neo4j health check failed", error=str(e))

    # All configured services must be healthy for "ok"
    all_healthy = valkey_connected and rabbitmq_connected and neo4j_connected
    if pg_connected is not None:
        all_healthy = all_healthy and pg_connected
    if mongo_connected is not None:
        all_healthy = all_healthy and mongo_connected

    return {
        "status": "ok" if all_healthy else "degraded",
        "pg_connected": pg_connected,
        "mongo_connected": mongo_connected,
        "valkey_connected": valkey_connected,
        "rabbitmq_connected": rabbitmq_connected,
        "neo4j_connected": neo4j_connected,
    }
