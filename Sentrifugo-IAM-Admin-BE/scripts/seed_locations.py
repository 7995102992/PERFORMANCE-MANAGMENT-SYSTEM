"""Seed script to load countries, states, and cities into MongoDB.

Usage:
    python -m scripts.seed_locations

Expects the combined JSON file from https://github.com/dr5hn/countries-states-cities-database
to be placed at src/location/data/countries+states+cities.json
"""

import asyncio
import json
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.logger import logger

# ---------------------------------------------------------------------------
# Path to the combined JSON data file
# ---------------------------------------------------------------------------
DATA_FILE = Path(__file__).resolve().parent.parent / "src" / "location" / "data" / "countries+states+cities.json"


def load_and_flatten() -> tuple[list[dict], list[dict], list[dict]]:
    """Read the combined JSON and flatten into separate country, state, and city lists."""
    if not DATA_FILE.exists():
        raise FileNotFoundError(f"{DATA_FILE} not found. See src/location/data/README.md")

    logger.info(f"Reading {DATA_FILE.name}...")
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)

    countries = []
    states = []
    cities = []

    for country in raw:
        # -- Extract country --
        countries.append({
            "id": country["id"],
            "name": country["name"],
            "native": country.get("native"),
            "iso2": country.get("iso2"),
            "iso3": country.get("iso3"),
            "phone_code": country.get("phonecode"),
            "capital": country.get("capital"),
            "currency": country.get("currency"),
            "currency_name": country.get("currency_name"),
            "currency_symbol": country.get("currency_symbol"),
            "region": country.get("region"),
            "subregion": country.get("subregion"),
            "timezones": country.get("timezones"),
            "latitude": country.get("latitude"),
            "longitude": country.get("longitude"),
            "emoji": country.get("emoji"),
        })

        # -- Extract states --
        for state in country.get("states", []):
            states.append({
                "id": state["id"],
                "name": state["name"],
                "state_code": state.get("iso2"),
                "iso3166_2": state.get("iso3166_2"),
                "country_id": country["id"],
                "country_name": country["name"],
                "country_code": country.get("iso2"),
                "latitude": state.get("latitude"),
                "longitude": state.get("longitude"),
                "timezone": state.get("timezone"),
            })

            # -- Extract cities --
            for city in state.get("cities", []):
                cities.append({
                    "id": city["id"],
                    "name": city["name"],
                    "state_id": state["id"],
                    "state_name": state["name"],
                    "state_code": state.get("iso2"),
                    "country_id": country["id"],
                    "country_name": country["name"],
                    "country_code": country.get("iso2"),
                    "latitude": city.get("latitude"),
                    "longitude": city.get("longitude"),
                    "timezone": city.get("timezone"),
                })

    return countries, states, cities


async def seed():
    if not settings.MONGODB_URL:
        logger.error("MONGODB_URL is not configured. Check your .env file.")
        return

    # ---- Load and flatten the combined JSON ----
    countries, states, cities = load_and_flatten()
    logger.info(f"Parsed {len(countries)} countries, {len(states)} states, {len(cities)} cities")

    # ---- Connect to MongoDB ----
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    for collection_name, records in [("countries", countries), ("states", states), ("cities", cities)]:
        collection = db[collection_name]

        # ---- Check if already seeded ----
        existing_count = await collection.count_documents({})
        if existing_count > 0:
            logger.info(f"'{collection_name}' already has {existing_count} documents — skipping insert.")
        else:
            # ---- Insert in batches of 5000 ----
            batch_size = 5000
            for i in range(0, len(records), batch_size):
                batch = records[i : i + batch_size]
                await collection.insert_many(batch)
                logger.info(f"  [{collection_name}] Inserted batch {i // batch_size + 1} ({len(batch)} records)")

            logger.info(f"'{collection_name}' seeded with {len(records)} documents.")

        # ---- Ensure indexes (always runs, even if data was already seeded) ----
        await collection.create_index("name")
        if collection_name in ("states", "cities"):
            await collection.create_index("country_id")
            await collection.create_index("country_name")
        if collection_name == "cities":
            await collection.create_index("state_id")
            await collection.create_index("state_name")

    client.close()
    logger.info("Location seed complete!")


if __name__ == "__main__":
    asyncio.run(seed())
