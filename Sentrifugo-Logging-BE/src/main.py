import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.exceptions import DomainException, domain_exception_handler, global_exception_handler
from src.health.router import router as health_router
from src.logger import logger
from src.logs.router import router as logs_router
from src.rabbitmq import close_rabbitmq, init_rabbitmq, start_relay, stop_relay
from src.rabbitmq.consumer import run_audit_consumer
from src.redis import close_redis, init_redis
from src.timescaledb import close_timescaledb, init_timescaledb


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Initializing infrastructure connections...")
    await init_timescaledb()

    try:
        await init_redis()
    except Exception as e:
        logger.warning(f"Failed to initialize Redis on startup: {e}")

    consumer_task = None
    try:
        await init_rabbitmq()
    except Exception as e:
        logger.warning(f"Failed to initialize RabbitMQ on startup: {e}")

    try:
        await start_relay()
    except Exception as e:
        logger.warning(f"Failed to start outbox relay on startup: {e}")

    try:
        consumer_task = asyncio.create_task(run_audit_consumer())
    except Exception as e:
        logger.warning(f"Failed to start audit consumer on startup: {e}")

    yield

    # Shutdown
    logger.info("Closing infrastructure connections...")
    if consumer_task:
        consumer_task.cancel()
    await stop_relay()
    await close_timescaledb()
    await close_redis()
    await close_rabbitmq()

app = FastAPI(
    title="Sentrifugo-Logging-BE",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(DomainException, domain_exception_handler)
app.add_exception_handler(Exception, global_exception_handler)

app.include_router(health_router)
app.include_router(logs_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8001, reload=settings.ENVIRONMENT == "development")
