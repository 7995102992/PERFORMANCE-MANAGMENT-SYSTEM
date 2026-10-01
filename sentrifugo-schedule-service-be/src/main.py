from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.database import close_db, init_db
from src.email.health_monitor import start_health_monitor, stop_health_monitor
from src.exceptions import DomainException, domain_exception_handler, global_exception_handler
from src.executors.base import init_thread_pool, shutdown_thread_pool
from src.executors.consumer import start_consumer_task, stop_consumer
from src.executors.registry import register_all_executors
from src.auth.router import router as auth_router
from src.dashboard.router import router as dashboard_router
from src.health.router import router as health_router
from src.logger import logger
from src.rabbitmq import close_rabbitmq, init_rabbitmq
from src.audit import emit_audit_safe, start_audit_relay, stop_audit_relay
from src.redis import close_redis, init_redis
from src.tenant.config import tenant_settings
from src.tenant.credentials import EnvCredentialSource, VaultCredentialSource, credential_registry


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Initializing infrastructure connections...")

    if tenant_settings.CREDENTIAL_SOURCE == "vault":
        source = VaultCredentialSource(
            vault_url=tenant_settings.VAULT_URL,
            vault_token=tenant_settings.VAULT_TOKEN,
            secret_path=tenant_settings.VAULT_SECRET_PATH,
        )
    else:
        source = EnvCredentialSource()
    try:
        credential_registry.load(source)
    except Exception as e:
        # e.g. CREDENTIAL_SOURCE=vault but VaultCredentialSource is not implemented
        # yet (raises NotImplementedError). Don't hard-crash the whole service —
        # fall back to env credentials so it still boots.
        logger.error(
            f"Credential source '{tenant_settings.CREDENTIAL_SOURCE}' failed to load; "
            f"falling back to env credentials: {e}"
        )
        credential_registry.load(EnvCredentialSource())

    if tenant_settings.DEFAULT_BREVO_API_KEY:
        credential_registry.set_defaults({
            "brevo": {"API_KEY": tenant_settings.DEFAULT_BREVO_API_KEY},
        })

    init_thread_pool(max_workers=4)
    register_all_executors()

    await init_db()

    try:
        await init_redis()
    except Exception as e:
        logger.warning(f"Failed to initialize Redis on startup: {e}")

    try:
        await init_rabbitmq()
    except Exception as e:
        logger.warning(f"Failed to initialize RabbitMQ on startup: {e}")

    # Non-blocking: the retry loop self-heals if RabbitMQ is down at boot, so a
    # downed broker no longer leaves the consumer permanently dead.
    start_consumer_task()

    try:
        await start_audit_relay()
    except Exception as e:
        logger.warning(f"Failed to start audit relay on startup: {e}")

    try:
        await start_health_monitor()
    except Exception as e:
        logger.warning(f"Failed to start health monitor on startup: {e}")

    # Credentials are loaded (above) before the DB/RabbitMQ are ready, so the
    # audit for it is emitted here once the outbox is usable.
    await emit_audit_safe(
        action="credentials.loaded",
        resource="schedule:credentials",
        details={
            "source": tenant_settings.CREDENTIAL_SOURCE,
            "tenant_count": credential_registry.tenant_count(),
        },
    )

    yield

    # Shutdown
    logger.info("Closing infrastructure connections...")
    await stop_consumer()
    await stop_health_monitor()
    await stop_audit_relay()
    shutdown_thread_pool()
    await close_db()
    await close_redis()
    await close_rabbitmq()

app = FastAPI(
    title="Sentrifugo-BE-Boilerplate",
    version="1.0.0",
    lifespan=lifespan,
)

# Wildcard origin + credentials is unsafe (and browsers reject it / Starlette
# reflects the origin, a CSRF footgun). Only allow credentials when an explicit
# origin list is configured.
_cors_origins = settings.CORS_ORIGINS
_allow_credentials = _cors_origins != ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(DomainException, domain_exception_handler)
app.add_exception_handler(Exception, global_exception_handler)

app.include_router(auth_router)
app.include_router(dashboard_router)
app.include_router(health_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=settings.ENVIRONMENT == "development")
