# Sentrifugo Attendance MSSQL Service

FastAPI microservice that connects to an MS SQL Server database, crawls attendance
data on a fixed schedule (every 6 hours by default), and pushes the results to a
configured target API.

## Architecture

Follows the shared Sentrifugo BE structure (see `AGENTS.md`): code organized by
domain, each domain owning its `router.py` / `schemas.py` / `service.py` / `config.py`.

```
src/
├── attendance/         # Crawl domain
│   ├── config.py       # Crawl interval, query, batch size, target API settings
│   ├── schemas.py      # Crawl run/status Pydantic models
│   ├── service.py      # Crawl logic: query MS SQL, serialize, batch, push
│   ├── client.py       # HTTP client for the target API
│   ├── cron.py         # 6-hour background loop (runs once on startup too)
│   └── router.py       # Manual trigger + status endpoints
├── health/             # Health check endpoint
├── config.py           # Global configuration (env, CORS, MS SQL connection)
├── database.py         # Async SQLAlchemy engine (mssql+aioodbc)
├── exceptions.py       # Global exception handlers
├── logger.py           # structlog setup
└── main.py             # FastAPI app initialization + lifespan
```

## Endpoints

| Method | Path                       | Description                          |
|--------|----------------------------|--------------------------------------|
| GET    | `/health`                  | DB connectivity + crawler status     |
| POST   | `/attendance/crawl`        | Manually trigger a crawl now         |
| GET    | `/attendance/crawl/status` | Last run result + whether one is running |

## Setup

Requires Python 3.10+ and the [Microsoft ODBC Driver 18 for SQL Server](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server).

```shell
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt

copy .env.example .env        # then fill in MSSQL_* and TARGET_API_* values

uvicorn src.main:app --reload
```

## Configuration

All settings come from environment variables (see `.env.example`):

- `MSSQL_*` — source database connection
- `CRAWL_INTERVAL_HOURS` — schedule (default `6`)
- `CRAWL_ON_STARTUP` — run one crawl immediately on boot (default `true`)
- `CRAWL_QUERY` — the SQL that pulls attendance rows (placeholder until the real table is confirmed)
- `CRAWL_BATCH_SIZE` — rows per request to the target API (default `500`)
- `TARGET_API_URL` / `TARGET_API_KEY` — where crawled data is pushed

## Testing & Linting

```shell
pytest
ruff check --fix src
ruff format src
```

## Docker

The Dockerfile installs `msodbcsql18` automatically:

```shell
docker build -t sentrifugo-attendance-mssql-service .
docker run --env-file .env -p 8000:8000 sentrifugo-attendance-mssql-service
```
