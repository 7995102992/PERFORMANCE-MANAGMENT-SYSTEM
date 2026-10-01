"""Standalone connectivity smoke check for the payroll service dependencies.

Run after `docker compose up -d` to confirm Mongo, Valkey and RabbitMQ are
reachable with the current `.env`:

    python -m scripts.smoke_check

Exits non-zero if any configured dependency is unreachable. Useful in CI /
deploy gates. This is committed (unlike `local_scripts/`) because it contains no
secrets and is safe for everyone to run.
"""
from __future__ import annotations

import asyncio
import sys

from src import valkey
from src.database import close_db, get_mongo, init_db
from src.rabbitmq import close_rabbitmq, init_rabbitmq, is_connected
from src.valkey import close_valkey, init_valkey


async def main() -> int:
    ok = True

    await init_db()
    try:
        await get_mongo().command("ping")
        print("[ok]   MongoDB reachable")
    except Exception as e:
        ok = False
        print(f"[FAIL] MongoDB: {e}")

    await init_valkey()
    try:
        if valkey.valkey_client and await valkey.valkey_client.ping():
            print("[ok]   Valkey reachable")
        else:
            ok = False
            print("[FAIL] Valkey: no client / ping failed")
    except Exception as e:
        ok = False
        print(f"[FAIL] Valkey: {e}")

    await init_rabbitmq()
    if is_connected():
        print("[ok]   RabbitMQ reachable")
    else:
        ok = False
        print("[FAIL] RabbitMQ: not connected")

    await close_rabbitmq()
    await close_valkey()
    await close_db()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
