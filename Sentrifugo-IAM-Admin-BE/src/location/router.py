from enum import StrEnum
from typing import Annotated

from fastapi import APIRouter, Path, Query, status

from src.exceptions import DomainException
from src.location import service

router = APIRouter(prefix="/master-data", tags=["master-data"])


@router.get("/currencies")
async def list_currencies(
    country_id: int | None = Query(default=None, description="Filter currencies by country ID"),
    country_name: str | None = Query(default=None, description="Filter currencies by country name"),
):
    return await service.list_currencies(country_id, country_name)


@router.get("/timezones")
async def list_timezones(
    country_id: int | None = Query(default=None, description="Filter timezones by country ID"),
    country_name: str | None = Query(default=None, description="Filter timezones by country name"),
):
    return await service.list_timezones(country_id, country_name)


class EntityType(StrEnum):
    COUNTRIES = "countries"
    STATES = "states"
    CITIES = "cities"


@router.get("/{entity}")
async def list_entities(
    entity: Annotated[EntityType, Path(description="Entity type: countries, states, or cities")],
    search: str | None = Query(default=None, description="Search by name"),
    country_id: int | None = Query(default=None, description="Filter by country ID"),
    country_name: str | None = Query(default=None, description="Filter by country name"),
    state_id: int | None = Query(default=None, description="Filter by state ID (cities only)"),
    state_name: str | None = Query(default=None, description="Filter by state name (cities only)"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=300),
):
    if entity == EntityType.COUNTRIES:
        return await service.search_countries(search, skip, limit)

    if entity == EntityType.STATES:
        return await service.search_states(search, country_id, country_name, skip, limit)

    if entity == EntityType.CITIES:
        return await service.search_cities(search, state_id, state_name, country_id, country_name, skip, limit)


@router.get("/{entity}/{entity_id}")
async def get_entity(
    entity: Annotated[EntityType, Path(description="Entity type: countries, states, or cities")],
    entity_id: int = Path(description="Entity ID"),
):
    if entity == EntityType.COUNTRIES:
        result = await service.get_country_by_id(entity_id)
        code = "COUNTRY_NOT_FOUND"

    elif entity == EntityType.STATES:
        result = await service.get_state_by_id(entity_id)
        code = "STATE_NOT_FOUND"

    elif entity == EntityType.CITIES:
        result = await service.get_city_by_id(entity_id)
        code = "CITY_NOT_FOUND"

    if not result:
        raise DomainException(
            message=f"{entity.value.rstrip('s').capitalize()} not found",
            code=code,
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return result
