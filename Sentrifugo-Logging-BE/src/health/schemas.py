from typing import Literal

from src.models import CustomModel


class HealthResponse(CustomModel):
    status: Literal["ok", "degraded"]
    timescaledb_connected: bool
    redis_connected: bool
    rabbitmq_connected: bool
