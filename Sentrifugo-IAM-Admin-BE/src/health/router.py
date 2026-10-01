from fastapi import APIRouter

from src.health.service import check_health

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
async def get_health_status() -> dict:
    """Public liveness probe (F-11).

    Returns only an overall status. The per-datastore connection detail
    (mongo/pg/valkey/rabbitmq/neo4j) is computed internally to decide the
    status but deliberately NOT exposed — it disclosed the backing-store
    topology to anonymous callers.
    """
    result = await check_health()
    return {"status": result["status"]}
