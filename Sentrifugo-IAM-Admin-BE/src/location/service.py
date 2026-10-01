from src.location.utils import tools as repository
from src.location.schemas import CityResponse, CountryResponse, CurrencyResponse, StateResponse, TimezoneResponse


# ---------------------------------------------------------------------------
# Countries
# ---------------------------------------------------------------------------
async def search_countries(search: str | None, skip: int, limit: int) -> list[CountryResponse]:
    query: dict = {}
    if search:
        query.update(repository.build_name_filter(search))
    results = await repository.search_countries(query, skip, limit)
    return [CountryResponse(**doc) for doc in results]


async def get_country_by_id(country_id: int) -> CountryResponse | None:
    doc = await repository.get_country_by_id(country_id)
    return CountryResponse(**doc) if doc else None


async def list_currencies(
    country_id: int | None = None,
    country_name: str | None = None,
) -> list[CurrencyResponse]:
    country_query = _build_country_query(country_id, country_name)
    results = await repository.list_currencies(country_query)
    return [CurrencyResponse(**doc) for doc in results]


async def list_timezones(
    country_id: int | None = None,
    country_name: str | None = None,
) -> list[TimezoneResponse]:
    country_query = _build_country_query(country_id, country_name)
    results = await repository.list_timezones(country_query)
    return [TimezoneResponse(**doc) for doc in results]


def _build_country_query(country_id: int | None, country_name: str | None) -> dict | None:
    query: dict = {}
    if country_id is not None:
        query["id"] = country_id
    if country_name:
        query.update(repository.build_exact_name_filter("name", country_name))
    return query or None


# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------
async def search_states(
    search: str | None,
    country_id: int | None,
    country_name: str | None,
    skip: int,
    limit: int,
) -> list[StateResponse]:
    query: dict = {}
    if search:
        query.update(repository.build_name_filter(search))
    if country_id is not None:
        query["country_id"] = country_id
    if country_name:
        query.update(repository.build_exact_name_filter("country_name", country_name))
    results = await repository.search_states(query, skip, limit)
    return [StateResponse(**doc) for doc in results]


async def get_state_by_id(state_id: int) -> StateResponse | None:
    doc = await repository.get_state_by_id(state_id)
    return StateResponse(**doc) if doc else None


# ---------------------------------------------------------------------------
# Cities
# ---------------------------------------------------------------------------
async def search_cities(
    search: str | None,
    state_id: int | None,
    state_name: str | None,
    country_id: int | None,
    country_name: str | None,
    skip: int,
    limit: int,
) -> list[CityResponse]:
    query: dict = {}
    if search:
        query.update(repository.build_name_filter(search))
    if state_id is not None:
        query["state_id"] = state_id
    if state_name:
        query.update(repository.build_exact_name_filter("state_name", state_name))
    if country_id is not None:
        query["country_id"] = country_id
    if country_name:
        query.update(repository.build_exact_name_filter("country_name", country_name))
    results = await repository.search_cities(query, skip, limit)
    return [CityResponse(**doc) for doc in results]


async def get_city_by_id(city_id: int) -> CityResponse | None:
    doc = await repository.get_city_by_id(city_id)
    return CityResponse(**doc) if doc else None
