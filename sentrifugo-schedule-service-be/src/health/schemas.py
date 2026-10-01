from typing import Literal

from src.models import CustomModel

class HealthResponse(CustomModel):
    status: Literal["ok", "degraded"]
    db_connected: bool
    redis_connected: bool
    rabbitmq_connected: bool
