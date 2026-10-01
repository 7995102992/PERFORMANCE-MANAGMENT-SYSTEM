from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.logger import logger


@dataclass
class TaskContext:
    tenant_id: str
    idempotency_key: UUID
    correlation_id: UUID
    event_type: str
    db: AsyncIOMotorDatabase
    redis_client: Any = None


@dataclass
class TaskResult:
    success: bool
    detail: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


class BaseExecutor(ABC):
    @property
    @abstractmethod
    def task_type(self) -> str:
        ...

    @abstractmethod
    async def execute(self, payload: dict[str, Any], context: TaskContext) -> TaskResult:
        ...


_thread_pool: ThreadPoolExecutor | None = None


def init_thread_pool(max_workers: int = 4) -> None:
    global _thread_pool
    _thread_pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="executor")
    logger.info("ThreadPoolExecutor initialized", max_workers=max_workers)


def get_thread_pool() -> ThreadPoolExecutor:
    if not _thread_pool:
        raise RuntimeError("ThreadPoolExecutor not initialized")
    return _thread_pool


def shutdown_thread_pool() -> None:
    global _thread_pool
    if _thread_pool:
        _thread_pool.shutdown(wait=True)
        _thread_pool = None
        logger.info("ThreadPoolExecutor shut down")
