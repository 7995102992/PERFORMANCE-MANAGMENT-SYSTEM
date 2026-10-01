import re

from src.database import get_mongo
from src.logger import logger


# ---------------------------------------------------------------------------
# Countries
# ---------------------------------------------------------------------------
async def search_countries(query: dict, skip: int = 0, limit: int = 20) -> list[dict]:
    """Return a paginated list of countries matching the query."""
    db = get_mongo()
    cursor = db["countries"].find(query, {"_id": 0}).skip(skip).limit(limit)
    results = await cursor.to_list(length=limit)
    logger.info("Countries search", count=len(results))
    return results


async def get_country_by_id(country_id: int) -> dict | None:
    """Find a country by its numeric ID."""
    db = get_mongo()
    return await db["countries"].find_one({"id": country_id}, {"_id": 0})


async def count_countries(query: dict) -> int:
    """Count countries matching the query."""
    db = get_mongo()
    return await db["countries"].count_documents(query)


async def list_currencies(country_query: dict | None = None) -> list[dict]:
    """Return distinct currencies. If country_query given, only currencies of matching countries."""
    db = get_mongo()
    match_stage: dict = {"currency": {"$ne": None}}
    if country_query:
        match_stage.update(country_query)
    pipeline = [
        {"$match": match_stage},
        {
            "$group": {
                "_id": "$currency",
                "currency": {"$first": "$currency"},
                "currency_name": {"$first": "$currency_name"},
                "currency_symbol": {"$first": "$currency_symbol"},
            }
        },
        {"$project": {"_id": 0}},
        {"$sort": {"currency": 1}},
    ]
    return await db["countries"].aggregate(pipeline).to_list(length=None)


async def list_timezones(country_query: dict | None = None) -> list[dict]:
    """Return distinct timezones. If country_query given, only timezones of matching countries."""
    db = get_mongo()
    match_stage: dict = {"timezones": {"$ne": None}}
    if country_query:
        match_stage.update(country_query)
    pipeline = [
        {"$match": match_stage},
        {"$unwind": "$timezones"},
        {
            "$group": {
                "_id": "$timezones.zoneName",
                "zoneName": {"$first": "$timezones.zoneName"},
                "gmtOffset": {"$first": "$timezones.gmtOffset"},
                "gmtOffsetName": {"$first": "$timezones.gmtOffsetName"},
                "abbreviation": {"$first": "$timezones.abbreviation"},
                "tzName": {"$first": "$timezones.tzName"},
            }
        },
        {"$project": {"_id": 0}},
        {"$sort": {"zoneName": 1}},
    ]
    return await db["countries"].aggregate(pipeline).to_list(length=None)


# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------
async def search_states(query: dict, skip: int = 0, limit: int = 20) -> list[dict]:
    """Return a paginated list of states matching the query."""
    db = get_mongo()
    cursor = db["states"].find(query, {"_id": 0}).skip(skip).limit(limit)
    results = await cursor.to_list(length=limit)
    logger.info("States search", count=len(results))
    return results


async def get_state_by_id(state_id: int) -> dict | None:
    """Find a state by its numeric ID."""
    db = get_mongo()
    return await db["states"].find_one({"id": state_id}, {"_id": 0})


async def count_states(query: dict) -> int:
    """Count states matching the query."""
    db = get_mongo()
    return await db["states"].count_documents(query)


# ---------------------------------------------------------------------------
# Cities
# ---------------------------------------------------------------------------
async def search_cities(query: dict, skip: int = 0, limit: int = 20) -> list[dict]:
    """Return a paginated list of cities matching the query."""
    db = get_mongo()
    cursor = db["cities"].find(query, {"_id": 0}).skip(skip).limit(limit)
    results = await cursor.to_list(length=limit)
    logger.info("Cities search", count=len(results))
    return results


async def get_city_by_id(city_id: int) -> dict | None:
    """Find a city by its numeric ID."""
    db = get_mongo()
    return await db["cities"].find_one({"id": city_id}, {"_id": 0})


async def count_cities(query: dict) -> int:
    """Count cities matching the query."""
    db = get_mongo()
    return await db["cities"].count_documents(query)


# ---------------------------------------------------------------------------
# Query builders (used by service and available for agentic tools)
# ---------------------------------------------------------------------------
def build_name_filter(search: str) -> dict:
    """Build a case-insensitive regex filter for the 'name' field."""
    return {"name": {"$regex": re.escape(search), "$options": "i"}}


def build_exact_name_filter(field: str, value: str) -> dict:
    """Build a case-insensitive exact match filter."""
    return {field: {"$regex": f"^{re.escape(value)}$", "$options": "i"}}
