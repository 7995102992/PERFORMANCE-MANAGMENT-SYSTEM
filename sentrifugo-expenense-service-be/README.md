# sentrifugo-expenense-service-be

Expense Management backend microservice for the **Sentrifugo HRMS** suite —
expense claims, receipt uploads, approval gates and employee advances.

It follows the standardised Sentrifugo backend architecture shared by IAM,
Service-Request, Timesheet, Leave-Management, Schedule and Payroll services:

| Concern      | Technology                                    |
| ------------ | --------------------------------------------- |
| Web          | FastAPI (async) + Uvicorn                     |
| Database     | Percona Server for MongoDB (Beanie ODM)       |
| Cache        | Valkey (Redis-compatible)                     |
| Messaging    | RabbitMQ via a **transactional outbox**       |
| Object store | DigitalOcean Spaces (S3-compatible) receipts  |
| Logging      | structlog (JSON in prod) + correlation IDs    |
| Auth         | IAM-issued sessions read from Valkey          |

---

## Resilience & fallback (the point of this base)

- **Self-healing Valkey** — the client is created lazily and auto-reconnects; a
  failed boot-time ping logs a warning instead of crashing the app.
- **Self-healing RabbitMQ** — a robust connection that re-establishes across
  broker flaps. If the broker is down at boot, the app still starts and
  `ensure_ready()` reconnects on the next publish/relay tick.
- **Transactional outbox** — every event is persisted to `outbox_events` first,
  then eagerly published. A background relay drains pending/failed events with
  bounded retries and dead-letters poison messages. Nothing is lost during a
  broker outage. **All publishing goes through `src.rabbitmq.outbox`.**
- **Best-effort startup** — only the database may hard-fail boot; cache and
  broker failures degrade gracefully.
- **Health endpoint** — `GET /health` reports per-dependency status and returns
  `ok` / `degraded`.

---

## Project layout

```
src/
├── config.py          # global settings (env-driven)
├── correlation.py     # X-Correlation-ID middleware + audit helpers
├── logger.py          # structlog setup
├── database.py        # MongoDB (Beanie) bootstrap
├── valkey.py          # auto-reconnecting cache client
├── exceptions.py      # DomainException + handlers
├── models.py          # base models, mixins, OutboxEventDocument, ALL_DOCUMENTS
├── main.py            # app + resilient lifespan wiring
├── storage.py         # DO Spaces receipt uploads + presigned URLs
├── audit.py           # audit-event helpers (via the outbox)
├── email_events.py    # email notification events (via the outbox)
├── auth/              # session-based identity (get_current_user)
├── common/            # shared helpers, constants, pagination
├── health/            # GET /health
├── internal/          # service-to-service endpoints (X-Internal-Token)
├── security/          # Fernet field encryption
└── rabbitmq/          # connection + transactional outbox + relay
tests/                 # pytest + httpx async client
postman/               # API collection
scripts/               # committed seed/maintenance scripts
local_scripts/         # local-only dev scripts (gitignored)
design_docs/           # internal design notes (gitignored)
```

---

## Quick start

```bash
# 1. Bring up infra (Mongo + Valkey + RabbitMQ)
docker compose up -d percona valkey rabbitmq

# 2. Install deps (Python 3.13)
python -m venv venv && . venv/Scripts/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 3. Configure
cp .env.example .env        # adjust as needed

# 4. Run
uvicorn src.main:app --reload

# 5. Verify
curl http://localhost:8000/health
```

Interactive API docs: <http://localhost:8000/docs>

### Local auth without IAM

When `IAM_BASE_URL` is empty, pass a dev session blob to authenticated routes:

```
X-Expense-Dev-Session: {"user_id":"000000000000000000000001","org_id":"...","is_org_admin":true}
```

---

## Testing & linting

```bash
pytest
ruff check --fix src && ruff format src
```

---

## Environment variables

See [`.env.example`](.env.example) for the full list. Key groups: database
(`MONGO_DB_*`, DB name `sentrifugo_expense`), `VALKEY_*`, `RABBITMQ_URL`,
sibling services (`IAM_BASE_URL`, `LOGGING_BASE_URL`), `INTERNAL_API_KEY`,
`FRONTEND_URL`, object storage (`DO_SPACES_*`, receipts land under the
`expense-receipts` folder), and `ENCRYPTION_KEY`.

## Building new expense modules

1. Create `src/<domain>/{router,schemas,service,models}.py`.
2. Register Beanie documents in `src/models.py::ALL_DOCUMENTS`.
3. Include the router in `src/main.py`.
4. Emit events via `src.rabbitmq.outbox.publish(...)` / `publish_audit_log(...)`.
5. Add tests under `tests/`.

See `AGENTS.md` for the team coding standards and `CLAUDE.md` for the
architecture invariants.
