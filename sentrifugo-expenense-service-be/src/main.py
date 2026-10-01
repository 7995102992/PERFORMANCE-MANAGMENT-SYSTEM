"""Sentrifugo Expense — ASGI entrypoint.

Lifespan bootstraps infrastructure in the standard order (Database → Valkey →
RabbitMQ → outbox relay). Every dependency is best-effort at boot: a broker or
cache that is down must NOT prevent the app from starting — the self-healing
clients reconnect on their own once the dependency returns.
"""

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.auth.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.config import settings
from src.correlation import CorrelationIdMiddleware
from src.database import close_db, init_db
from src.exceptions import register_exception_handlers
from src.health.router import router as health_router
from src.internal.router import router as internal_router
from src.logger import logger
from src.rabbitmq import close_rabbitmq, init_rabbitmq, start_relay, stop_relay
from src.valkey import close_valkey, init_valkey


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    logger.info("Initializing infrastructure connections...")

    # MongoDB is required — let a real failure surface.
    await init_db()

    try:
        await init_valkey()
    except Exception as e:
        logger.warning("Failed to initialize Valkey on startup", error=str(e))

    try:
        await init_rabbitmq()
    except Exception as e:
        logger.warning("Failed to initialize RabbitMQ on startup", error=str(e))

    try:
        await start_relay()
    except Exception as e:
        logger.warning("Failed to start outbox relay on startup", error=str(e))

    logger.info("Expense service ready", environment=settings.ENVIRONMENT)

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    logger.info("Closing infrastructure connections...")
    await stop_relay()
    await close_rabbitmq()
    await close_valkey()
    await close_db()
    logger.info("Expense service shutdown complete")


app = FastAPI(
    title="Sentrifugo — Expense",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Correlation-ID"],
)

register_exception_handlers(app)

api_prefix = settings.API_PREFIX
app.include_router(health_router, prefix=api_prefix)
app.include_router(internal_router, prefix=api_prefix)


@app.get(f"{api_prefix}/me", tags=["auth"])
async def me(user: UserBase = Depends(get_current_user)) -> UserBase:
    """Return the authenticated caller resolved from the IAM session."""
    return user


# Expense domain routers are registered alongside the includes above as modules
# are built.


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.ENVIRONMENT == "development",
    )
