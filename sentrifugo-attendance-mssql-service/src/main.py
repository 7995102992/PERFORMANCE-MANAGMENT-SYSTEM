from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.attendance.cron import start_cron, stop_cron
from src.attendance.router import router as attendance_router
from src.config import settings
from src.database import close_db, init_db
from src.exceptions import DomainException, domain_exception_handler, global_exception_handler
from src.health.router import router as health_router
from src.logger import logger


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Initializing infrastructure connections...")
    await init_db()
    start_cron()

    yield

    # Shutdown
    logger.info("Closing infrastructure connections...")
    await stop_cron()
    await close_db()


app = FastAPI(
    title="Sentrifugo Attendance MSSQL Service",
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

app.include_router(health_router)
app.include_router(attendance_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=settings.ENVIRONMENT == "development")
