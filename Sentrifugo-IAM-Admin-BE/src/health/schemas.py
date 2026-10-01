from typing import Literal

from src.models import CustomModel

class HealthResponse(CustomModel):
    status: Literal["ok", "degraded"]
    pg_connected: bool | None = None
    mongo_connected: bool | None = None
    valkey_connected: bool
    rabbitmq_connected: bool
    neo4j_connected: bool
