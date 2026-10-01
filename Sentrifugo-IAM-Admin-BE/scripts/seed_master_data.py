"""Seed script to load global master data (sectors, business types, etc.) into MongoDB.

Global records have organisation_id=null — every org sees them.
Orgs can add their own custom entries via the API.

Usage:
    python -m scripts.seed_master_data
"""

import asyncio
import json
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.logger import logger

DATA_DIR = Path(__file__).resolve().parent.parent / "src" / "master_data" / "data"

FILE_TO_CATEGORY = {
    "sectors": "SECTORS",
    "business_types": "BUSINESS_TYPES",
    "business_natures": "BUSINESS_NATURES",
    "worker_types": "WORKER_TYPES",
    "class_labels": "CLASS_LABELS",
    "frequencies": "FREQUENCIES",
    "employment_types": "EMPLOYMENT_TYPES",
    "employment_statuses": "EMPLOYMENT_STATUSES",
    "project_statuses": "PROJECT_STATUSES",
    "sources_of_hire": "SOURCES_OF_HIRE",
    "genders": "GENDERS",
    "marital_statuses": "MARITAL_STATUSES",
    "relationships": "RELATIONSHIPS",
    "employment_sources": "EMPLOYMENT_SOURCES",
    "hierarchy_roles": "HIERARCHY_ROLES",
}

COLLECTION_NAME = "master_data"


def load_all() -> list[dict]:
    """Read each JSON file and tag every record with its UPPERCASE category + organisation_id=null."""
    records: list[dict] = []
    for filename, category in FILE_TO_CATEGORY.items():
        filepath = DATA_DIR / f"{filename}.json"
        if not filepath.exists():
            logger.warning(f"Missing data file: {filepath.name} — skipping")
            continue
        with open(filepath, "r", encoding="utf-8") as f:
            items = json.load(f)
        for item in items:
            records.append({
                "category": category,
                "key": item["key"],
                "value": item["value"],
                "organisation_id": None,
                "is_active": item.get("isActive", True),
                "is_custom": False,
            })
        logger.info(f"  Loaded {len(items)} items from {filepath.name} → {category}")
    return records


async def seed():
    if not settings.MONGODB_URL:
        logger.error("MONGODB_URL is not configured. Check your .env file.")
        return

    records = load_all()
    logger.info(f"Total global master data records: {len(records)}")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    collection = db[COLLECTION_NAME]

    # Only re-seed globals — preserve org-specific custom entries
    global_count = await collection.count_documents({"organisation_id": None})
    if global_count > 0:
        logger.info(f"Dropping {global_count} existing global records and re-seeding.")
        await collection.delete_many({"organisation_id": None})

    if records:
        batch_size = 500
        for i in range(0, len(records), batch_size):
            batch = records[i : i + batch_size]
            await collection.insert_many(batch)
            logger.info(f"  Inserted batch {i // batch_size + 1} ({len(batch)} records)")

    # Indexes
    await collection.create_index([("category", 1), ("organisation_id", 1)])
    await collection.create_index([("category", 1), ("key", 1), ("organisation_id", 1)], unique=True)

    client.close()
    logger.info(f"Master data seed complete! {len(records)} global records inserted.")


if __name__ == "__main__":
    asyncio.run(seed())
