import asyncio
import random
from datetime import datetime, timedelta

import httpx

URL = "http://localhost:8000/logs"
API_KEY = "my-api-key-1"

TOTAL_LOGS = 100000
BATCH_SIZE = 500          # logs per request
CONCURRENT_REQUESTS = 10  # parallel requests

MODULES = ["auth", "hr", "payroll", "finance", "admin"]
ACTIONS = ["login", "update", "delete", "export", "create"]
RESOURCES = [
    "/auth/login",
    "/employees",
    "/payroll/run",
    "/reports",
    "/admin/settings",
]


def generate_log(ts: datetime):
    return {
        "module": random.choice(MODULES),
        "actor_id": f"user-{random.randint(1, 1000)}",
        "action": random.choice(ACTIONS),
        "resource": random.choice(RESOURCES),
        "debug_level": random.randint(1, 5),
        "timestamp": ts.isoformat() + "Z"
    }


def generate_batch(batch_size: int, start_time: datetime):
    return [
        generate_log(start_time + timedelta(seconds=i))
        for i in range(batch_size)
    ]


async def send_batch(client: httpx.AsyncClient, batch):
    try:
        response = await client.post(
            URL,
            headers={
                "accept": "application/json",
                "x-api-key": API_KEY,
                "Content-Type": "application/json",
            },
            json=batch,
            timeout=30.0,
        )
        response.raise_for_status()
        return len(batch)
    except Exception as e:
        print(f"Batch failed: {e}")
        return 0


async def main():
    total_sent = 0
    start_time = datetime.utcnow()

    async with httpx.AsyncClient() as client:
        tasks = []

        for i in range(0, TOTAL_LOGS, BATCH_SIZE):
            batch = generate_batch(BATCH_SIZE, start_time)

            task = asyncio.create_task(send_batch(client, batch))
            tasks.append(task)

            # control concurrency
            if len(tasks) >= CONCURRENT_REQUESTS:
                results = await asyncio.gather(*tasks)
                total_sent += sum(results)
                print(f"Sent so far: {total_sent}")
                tasks = []

        # remaining
        if tasks:
            results = await asyncio.gather(*tasks)
            total_sent += sum(results)

    print(f"\n✅ Done! Total logs sent: {total_sent}")


if __name__ == "__main__":
    asyncio.run(main())
