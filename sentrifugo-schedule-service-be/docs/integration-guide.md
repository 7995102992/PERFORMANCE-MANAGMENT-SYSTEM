# Schedule & Task Execution Service — Integration Guide

## Overview

This service is a multi-tenant **task execution engine** that consumes task events from RabbitMQ and dispatches them to registered executors by `task_type`. Each executor handles a specific domain — email sending (via ThreadPoolExecutor), inbound email processing, leave entitlement calculation, service request archival, etc. All tasks share a common message envelope, idempotency layer, and inbox_events audit trail.

---

## Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| Python | 3.10+ | Runtime |
| PostgreSQL | 14+ | inbox_events, email_log, tenant_email_config tables |
| Redis / Valkey | 7+ | Idempotency cache, rate limiting, scheduler locks |
| RabbitMQ | 3.12+ | Email event consumption, alerts publishing |

---

## 1. Executor Architecture

The service uses a **ThreadPoolExecutor-based task dispatch** model:

| Executor | `task_type` | Execution Model | Purpose |
|---|---|---|---|
| `EmailSchedulerExecutor` | `email.send` | **ThreadPoolExecutor** | Send emails via provider fallback chain. Offloads blocking HTTP calls to thread pool. |
| `ProcessInboundEmailsExecutor` | `email.inbound` | Async | Parse inbound emails, extract attachments, route internally. |
| `LeaveEntitlementExecutor` | `leave.entitlement` | Async | Calculate leave accruals, update balances, handle carry-forward. |
| `ArchiveServiceRequestExecutor` | `servicerequest.archive` | Async | Archive closed service requests, clean up attachments. |

### Why ThreadPoolExecutor for Email Only

Email sending involves HTTP calls to external provider APIs (Brevo, SES) which may use synchronous SDKs or experience high latency. Running in a `ThreadPoolExecutor` prevents slow provider responses from blocking the async event loop and starving other task types. Internal async executors only do DB operations via asyncpg — no thread pool needed.

### Adding a New Executor

1. Create a class extending `BaseExecutor` in `src/executors/`
2. Implement `task_type` property and `async execute(payload, context) -> TaskResult`
3. Register in `src/executors/registry.py` → `register_all_executors()`
4. Publishers send messages with `"task_type": "your.task_type"`

---

## 2. Publishing Service Integration (e.g. IAM Admin)

The publishing service must send messages to the `email_events` exchange (topic type) on RabbitMQ.

### Message Contract (Generic Task Envelope)

```json
{
  "task_type": "email.send",
  "event_id": "uuid",
  "event_type": "email.activation",
  "correlation_id": "uuid",
  "idempotency_key": "uuid",
  "tenant_id": "uuid",
  "payload": {
    "to": "user@example.com",
    "template_id": "activation_v1",
    "template_data": { "display_name": "John", "activation_link": "https://...", "reset_link": "https://..." },
    "priority": "high",
    "scheduled_at": null
  },
  "published_at": "2026-04-30T10:00:00Z"
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `task_type` | String | Yes | Executor routing key — determines which executor handles the message (e.g. `email.send`, `leave.entitlement`) |
| `event_id` | UUID | Yes | Unique event identifier |
| `event_type` | String | Yes | Descriptive event type (e.g. `email.activation`, `leave.annual_accrual`) |
| `correlation_id` | UUID | Yes | End-to-end request tracing |
| `idempotency_key` | UUID | Yes | Dedup key — must be unique per (tenant_id, operation). Reusing the same key will cause the consumer to skip processing. |
| `tenant_id` | UUID | Yes | Tenant scope for multi-tenant isolation |
| `payload` | Object | Yes | Executor-specific data (see per-executor payload sections below) |
| `published_at` | ISO DateTime | Yes | When the publisher created the event |

### Email Payload (`task_type: "email.send"`)

| Field | Type | Required | Description |
|---|---|---|---|
| `payload.to` | String | Yes | Recipient email address |
| `payload.template_id` | String | Yes | Logical template name (maps to provider-specific template) |
| `payload.template_data` | Object | No | Template variables (default: `{}`) |
| `payload.priority` | Enum | No | `high`, `normal`, `low` (default: `normal`) |
| `payload.scheduled_at` | ISO DateTime | No | If set to a future time, email is deferred. `null` = send immediately. |

### Task Types & Routing Keys

| task_type | Routing Key | Description |
|---|---|---|
| `email.send` | `email.activation` | Send activation email |
| `email.send` | `email.password_reset` | Send password reset email |
| `email.send` | `email.employee_timesheet_reminder` | Remind an employee to fill their timesheet |
| `email.send` | `email.payslip_pin_generated` | Notify an employee of a new PIN for viewing payslips |
| `email.send` | `email.onboarding_approval_ack` | Acknowledge an onboarding stage approval to the approver |
| `email.send` | `email.onboarding_approval_notice` | Notify the reporting manager an onboarding stage was approved |
| `email.send` | `email.onboarding_stage_cleared` | Notify the candidate an onboarding stage is complete |
| `email.send` | `email.onboarding_manager_approved` | Notify the HR who added a candidate that the manager approved them |
| `email.send` | `email.onboarding_manager_rejected` | Notify the HR who added a candidate that the manager rejected them |
| `email.send` | `email.onboarding_clearances_complete` | Notify the candidate that all departmental clearances are complete |
| `email.send` | `email.scheduled.*` | Scheduled/deferred emails |
| `email.inbound` | `email.inbound` | Process inbound email |
| `leave.entitlement` | `leave.entitlement` | Leave entitlement calculation |
| `servicerequest.archive` | `servicerequest.archive` | Archive service requests |

### Publisher-Side Outbox (Recommended)

Use a transactional outbox pattern in the publishing service to guarantee at-least-once delivery:

```python
# In the same DB transaction as the business operation:
await outbox.publish(
    "email.activation",
    payload,
    idempotency_key=f"email.activation:{token}",
    exchange="task_events",
)
```

The outbox relay publishes to RabbitMQ and marks the row as `sent`. If RabbitMQ is down, the relay retries from DB.

---

## 3. Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
# Required infrastructure
DATABASE_URL=postgresql+asyncpg://postgres:password@localhost:5432/schedule_service_db
REDIS_URL=redis://localhost:6379/0
RABBITMQ_URL=amqp://guest:guest@localhost:5672/

# Email provider defaults
DEFAULT_EMAIL_PROVIDER=brevo
DEFAULT_FALLBACK_CHAIN=ses,smtp

# Credential source
CREDENTIAL_SOURCE=env   # or "vault"

# Per-tenant credentials (loaded into memory at startup)
TENANT__<tenant_uuid>__BREVO__API_KEY=xkeysib-...
TENANT__<tenant_uuid>__SES__ACCESS_KEY=AKIA...
TENANT__<tenant_uuid>__SES__SECRET_KEY=wJalr...
TENANT__<tenant_uuid>__SES__REGION=ap-south-1
```

### Credential Naming Convention

```
TENANT__{tenant_id}__{PROVIDER}__{KEY}
```

- `tenant_id`: UUID of the tenant (case-insensitive, stored lowercase)
- `PROVIDER`: `BREVO`, `SES`, `SMTP`
- `KEY`: Provider-specific credential key (`API_KEY`, `ACCESS_KEY`, `SECRET_KEY`, `REGION`, `HOST`, `PORT`, `USERNAME`, `PASSWORD`)

Credentials are loaded into process memory at startup. No network calls for credential resolution on the hot path.

---

## 4. Database Setup

Tables are auto-created at startup via SQLAlchemy `metadata.create_all`. No manual migration needed.

### Tables Created

| Table | Purpose |
|---|---|
| `inbox_events` | Consumer-side ACK store for idempotent processing |
| `email_log` | Audit trail of all emails sent/scheduled/failed |
| `tenant_email_config` | Per-tenant email configuration (provider, sender, rate limit) |
| `template_mappings` | Logical template_id → provider-specific template reference |

### Seed Script (Recommended for Brevo Integration)

```bash
# Default: seeds a test tenant with Brevo template mappings
python -m scripts.seed_brevo

# Custom tenant:
SEED_TENANT_ID=your-tenant-uuid SEED_SENDER_EMAIL=noreply@yourapp.com python -m scripts.seed_brevo
```

The seed script:
- Creates/updates `tenant_email_config` (brevo as primary, ses/smtp fallback)
- Creates/updates `template_mappings` for all standard email types (activation, password_reset, email_change, welcome, invite)
- Safe to re-run (uses upsert)
- Reminds you to set the `TENANT__<id>__BREVO__API_KEY` env var

After seeding, update `scripts/seed_brevo.py` → `BREVO_TEMPLATE_MAPPINGS` with your actual Brevo template IDs from https://app.brevo.com/templates.

### Template Mappings

Each logical `template_id` (sent by the publisher) maps to a provider-specific reference:

| template_id | Brevo | SES | SMTP |
|---|---|---|---|
| `activation_v1` | Template #1 | ARN or template name | `activation.html` |
| `password_reset_v1` | Template #2 | ... | ... |
| `email_change_v1` | Template #3 | ... | ... |

This mapping allows the same `template_id` to work across providers without changing publisher code.

### Manual Tenant Config (Alternative to Seed Script)

```sql
INSERT INTO tenant_email_config (id, tenant_id, primary_provider, fallback_chain, sender_email, sender_name, daily_rate_limit, is_active)
VALUES (
  gen_random_uuid(),
  'your-tenant-uuid',
  'brevo',
  '["ses", "smtp"]',
  'noreply@yourdomain.com',
  'Your App Name',
  1000,
  true
);
```

---

## 5. Running the Service

```bash
pip install -r requirements.txt
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

### What happens at startup:
1. Credentials loaded from env vars (or vault) into in-memory registry
2. ThreadPoolExecutor initialized (4 workers for email sending)
3. All executors registered (email.send, email.inbound, leave.entitlement, servicerequest.archive)
4. PostgreSQL connected, tables auto-created
5. Redis/Valkey connected
6. RabbitMQ connected
7. Generic task consumer starts (listens on `email_events` exchange, routes by `task_type`)
8. Health monitor starts (periodic provider health checks)

---

## 6. Processing Flow

```
Message arrives from RabbitMQ
    │
    ▼
[1] Parse TaskMessage — extract task_type
    │
    ▼
[2] Lookup executor in registry ─── not found → reject to DLQ
    │ found
    ▼
[3] Valkey idempotency check (fast path) ─── hit → ACK & skip
    │ miss
    ▼
[4] INSERT inbox_events (status=received) ── conflict → ACK & skip
    │ success
    ▼
[5] Dispatch to executor.execute(payload, context)
    │
    ├── EmailSchedulerExecutor (ThreadPool):
    │     ├── scheduled_at in future? → defer to DB, ACK
    │     ├── rate limit check → exceeded → NACK
    │     └── send_with_fallback(primary, fallback_chain) via run_in_executor
    │
    ├── ProcessInboundEmailsExecutor (async):
    │     └── parse, route, update ticket
    │
    ├── LeaveEntitlementExecutor (async):
    │     └── calculate accruals, update balances
    │
    └── ArchiveServiceRequestExecutor (async):
          └── archive records, clean attachments
    │
    ▼
[6] Result:
    ├── success → mark inbox processed, ACK
    └── failure → mark inbox failed, NACK + requeue (DLQ after max retries)
```

---

## 7. Adding a New Email Provider

1. Create `src/email/providers/your_provider.py`:

```python
from src.email.providers.base import EmailProviderBase, SendResult

class YourProvider(EmailProviderBase):
    name = "your_provider"

    async def send(self, to, template_id, template_data, sender_email, sender_name, credentials) -> SendResult:
        api_key = credentials.get("API_KEY")
        # ... your send logic ...
        return SendResult(success=True, provider=self.name, provider_message_id="...")

    async def health_check(self, credentials) -> bool:
        # ... check provider is reachable ...
        return True
```

2. Register in `src/email/providers/registry.py`:

```python
from src.email.providers.your_provider import YourProvider

_PROVIDERS: dict[str, EmailProviderBase] = {
    "brevo": BrevoProvider(),
    "ses": SESProvider(),
    "smtp": SMTPProvider(),
    "your_provider": YourProvider(),  # add here
}
```

3. Add tenant credentials:

```bash
TENANT__<tenant_id>__YOUR_PROVIDER__API_KEY=...
```

4. Update tenant config to use it:

```sql
UPDATE tenant_email_config
SET primary_provider = 'your_provider', fallback_chain = '["brevo", "ses"]'
WHERE tenant_id = 'your-tenant-uuid';
```

Zero changes to consumer or scheduler code.

---

## 8. Alerts

The service publishes alerts to the `alerts` RabbitMQ exchange (topic type). Subscribe an alerting consumer (Slack bot, PagerDuty, etc.) to receive notifications.

### Alert Types

| Routing Key | Severity | Trigger |
|---|---|---|
| `alert.email.all_providers_failed` | critical | Every provider in the fallback chain failed for a send attempt |
| `alert.email.provider_health_check_failed` | warning/critical | Provider health check failed N consecutive times |

### Alert Payload Structure

```json
{
  "alert_id": "uuid",
  "alert_type": "all_email_providers_failed",
  "severity": "critical",
  "tenant_id": "uuid",
  "timestamp": "2026-05-04T10:00:00Z",
  "message": "Human-readable description of the issue",
  "...": "type-specific fields"
}
```

### Subscribing to Alerts

```python
# In your alerting consumer service:
channel = await connection.channel()
exchange = await channel.declare_exchange("alerts", ExchangeType.TOPIC, durable=True)
queue = await channel.declare_queue("my_alert_queue", durable=True)
await queue.bind(exchange, routing_key="alert.email.#")
await queue.consume(handle_alert)
```

---

## 9. Dual-ACK Pattern

This service uses dual-ACK to guarantee no message loss:

| Side | Mechanism | Survives |
|---|---|---|
| Publisher (IAM Admin) | Transactional outbox table | RabbitMQ outage — outbox retries from DB |
| Consumer (this service) | `inbox_events` table with `UNIQUE(tenant_id, idempotency_key)` | Consumer crash, Valkey flush, RabbitMQ redelivery |

**Key rule:** The `idempotency_key` from the publisher must be globally unique per operation. Reusing the same key = the consumer will deduplicate and skip.

---

## 10. Scheduled/Deferred Emails

Set `payload.scheduled_at` to a future ISO datetime:

```json
{
  "payload": {
    "to": "user@example.com",
    "template_id": "reminder_v1",
    "scheduled_at": "2026-05-10T09:00:00Z"
  }
}
```

The consumer will persist it to `email_log` (status=`pending`) and ACK immediately. A background scheduler polls for due emails and dispatches them.

---

## 11. Rate Limiting

Per-tenant daily rate limit is configured in `tenant_email_config.daily_rate_limit`. Counter stored in Valkey key `{tenant_id}:daily_email_count` (expires every 24h).

When the limit is hit, the message is NACK'd + requeued (will retry after the daily reset).

---

## 12. Health Check Endpoint

```
GET /health
```

Returns:
```json
{
  "status": "ok",
  "db_connected": true,
  "redis_connected": true,
  "rabbitmq_connected": true
}
```

---

## 13. Project Structure

```
src/
├── executors/                     # ★ Task execution engine
│   ├── base.py                    # BaseExecutor ABC, TaskContext, TaskResult, ThreadPoolExecutor lifecycle
│   ├── registry.py                # Executor registry — maps task_type → executor instance
│   ├── schemas.py                 # TaskMessage (generic message envelope with task_type)
│   ├── consumer.py                # Generic RabbitMQ consumer — dispatches by task_type
│   ├── email_scheduler.py         # EmailSchedulerExecutor (ThreadPoolExecutor for email sending)
│   ├── process_inbound_emails.py  # ProcessInboundEmailsExecutor (async)
│   ├── leave_entitlement.py       # LeaveEntitlementExecutor (async)
│   └── archive_service_request.py # ArchiveServiceRequestExecutor (async)
├── email/
│   ├── alerts.py              # Alert publishing (all-providers-failed, health-check-failed)
│   ├── config.py              # EmailConfig (exchange, queue, DLQ, health check settings)
│   ├── health_monitor.py      # Background periodic provider health checks
│   ├── models.py              # SQLAlchemy ORM (InboxEvent, EmailLog, TenantEmailConfig)
│   ├── schemas.py             # Pydantic schemas (EmailPayload, InboxEventStatus)
│   ├── service.py             # Core logic (inbox insert, mark processed/failed, rate limit)
│   └── providers/
│       ├── base.py            # EmailProviderBase ABC + SendResult
│       ├── registry.py        # send_with_fallback() — fallback chain orchestration
│       ├── brevo.py           # BrevoProvider (stub — implement API call)
│       ├── ses.py             # SESProvider (stub)
│       └── smtp.py            # SMTPProvider (stub)
├── tenant/
│   ├── config.py              # TenantConfig settings (credential source, defaults)
│   ├── credentials.py         # CredentialSource ABC, EnvCredentialSource, VaultCredentialSource, CredentialRegistry
│   ├── schemas.py             # Response models
│   └── service.py             # Tenant config resolution (DB + in-memory credentials)
├── config.py                  # Global settings (DB, Redis, RabbitMQ URLs)
├── database.py                # Async PostgreSQL + auto-create tables at startup
├── rabbitmq.py                # RabbitMQ connection management
├── redis.py                   # Redis/Valkey connection management
└── main.py                    # FastAPI app, lifespan (startup/shutdown orchestration)
```

---

## 14. Credential Rotation

1. Update the env var (or vault secret) with the new credential
2. Restart the service (or call `/admin/credentials/reload` once implemented)

No Valkey cache to invalidate. Credentials are always read from process memory.

---

## 15. Example: Sending an Activation Email (End-to-End)

This walks through the complete flow from user registration to email delivered.

### Step 1 — Publisher (IAM Admin BE)

When a user registers, IAM Admin creates the user and publishes an email event via the transactional outbox:

```python
# In IAM Admin's user registration service:
await outbox.publish(
    "email.activation",
    {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": "email.activation",
        "correlation_id": get_correlation_id(),
        "idempotency_key": str(uuid4()),  # unique per activation
        "tenant_id": str(user.tenant_id),
        "payload": {
            "to": "newuser@example.com",
            "template_id": "activation_v1",
            "template_data": {
                "display_name": "John",
                "activation_link": "https://app.yoursite.com/activate?token=abc123",
                "reset_link": "https://app.yoursite.com/reset-password?token=def456"
            },
            "priority": "high",
            "scheduled_at": None
        },
        "published_at": datetime.now(timezone.utc).isoformat()
    },
    idempotency_key=f"email.activation:{activation_token}",
    exchange="task_events",
)
```

The outbox relay publishes this to RabbitMQ → `email_events` exchange with routing key `email.activation`.

### Step 2 — Consumer (Schedule Service) — Automatic

```
RabbitMQ delivers message to email_events_queue
    │
    ▼
[1] Parse TaskMessage → task_type = "email.send"
    │
    ▼
[2] Lookup executor → EmailSchedulerExecutor (ThreadPool)
    │
    ▼
[3] Valkey check: {tenant_id}:idempotency:{key} → miss
    │
    ▼
[4] INSERT INTO inbox_events (status=received) → success (not a duplicate)
    │
    ▼
[5] Dispatch to EmailSchedulerExecutor.execute()
    │
    ▼
[6] scheduled_at = null → process immediately (no deferral)
    │
    ▼
[7] Load tenant config from DB:
    primary_provider=brevo, fallback=["ses","smtp"],
    sender_email=noreply@yourapp.com
    │
    ▼
[8] Rate limit check: {tenant_id}:daily_email_count → 42 (under 1000 limit)
    │
    ▼
[9] send_with_fallback() via run_in_executor(ThreadPool):
    ├── Try brevo:
    │     ├── Credentials from memory: TENANT__<id>__BREVO__API_KEY
    │     └── POST https://api.brevo.com/v3/smtp/email
    │         {
    │           "sender": {"email": "noreply@yourapp.com", "name": "Your App"},
    │           "to": [{"email": "newuser@example.com"}],
    │           "subject": "Activate Your Account",
    │           "htmlContent": "<rendered activation_v1.html>"
    │         }
    │     └── Brevo returns 201 → success!
    │
    ▼
[10] Finalize:
    ├── UPDATE inbox_events SET status=processed
    ├── INSERT INTO email_log (status=sent, provider_used=brevo)
    ├── INCR {tenant_id}:daily_email_count
    ├── SET {tenant_id}:idempotency:{key} (TTL 24h)
    └── ACK message to RabbitMQ
```

### Step 3 — If Brevo Fails (Fallback Chain in Action)

```
brevo returns 500 (API error)
    │
    ▼
Try SES (fallback 1):
    ├── Credentials found? → TENANT__<id>__SES__ACCESS_KEY exists → try send
    │   └── SES returns timeout → fail
    │
    ▼
Try SMTP (fallback 2):
    ├── Credentials found? → no TENANT__<id>__SMTP__HOST → skip
    │
    ▼
All providers exhausted:
    ├── inbox_events status = failed, error_detail = "All providers failed: {...}"
    ├── Alert published → alert.email.all_providers_failed (severity=critical)
    │   └── Alert consumer notifies super admin (Slack / PagerDuty / email)
    └── NACK + requeue → RabbitMQ will redeliver (up to 3 retries, then DLQ)
```

### One-Time Setup Checklist

| # | Task | Command / Location |
|---|---|---|
| 1 | Create Brevo account, get API key | https://app.brevo.com → SMTP & API |
| 2 | Create activation template in Brevo (note the numeric ID) | Brevo → Email Templates |
| 3 | Verify sender domain (SPF/DKIM/DMARC) | Brevo → Senders & Domains |
| 4 | Update seed script with your Brevo template IDs | `scripts/seed_brevo.py` → `BREVO_TEMPLATE_MAPPINGS` |
| 5 | Set env var for tenant credentials | `TENANT__<tenant_uuid>__BREVO__API_KEY=xkeysib-...` |
| 6 | Run seed script | `python -m scripts.seed_brevo` |
| 7 | Start the service | `uvicorn src.main:app` |
| 8 | Publish a test event from IAM Admin (or manually via RabbitMQ management UI) | See payload above |

### Brevo Provider Implementation (What Needs Completing)

The `src/email/providers/brevo.py` currently has a stub. The actual send implementation:

```python
import httpx
from src.email.providers.base import EmailProviderBase, SendResult

class BrevoProvider(EmailProviderBase):
    name = "brevo"
    BASE_URL = "https://api.brevo.com/v3"

    async def send(self, to, template_id, template_data, sender_email, sender_name, credentials) -> SendResult:
        api_key = credentials.get("API_KEY")
        if not api_key:
            return SendResult(success=False, provider=self.name, error="Missing API_KEY")

        # TODO: resolve template_id → brevo numeric ID from template_mappings table
        # For now, pass template_data as params to Brevo's transactional API
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.BASE_URL}/smtp/email",
                headers={"api-key": api_key, "Content-Type": "application/json"},
                json={
                    "sender": {"email": sender_email, "name": sender_name},
                    "to": [{"email": to}],
                    "templateId": int(brevo_template_id),
                    "params": template_data,
                },
                timeout=30.0,
            )

        if resp.status_code == 201:
            msg_id = resp.json().get("messageId")
            return SendResult(success=True, provider=self.name, provider_message_id=msg_id)
        return SendResult(success=False, provider=self.name, error=f"{resp.status_code}: {resp.text}")

    async def health_check(self, credentials) -> bool:
        api_key = credentials.get("API_KEY")
        if not api_key:
            return False
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.BASE_URL}/account",
                headers={"api-key": api_key},
                timeout=10.0,
            )
        return resp.status_code == 200
```

---

## 16. Troubleshooting

| Symptom | Check |
|---|---|
| Emails not being sent | Check `inbox_events` table — status `received` means processing hung. Status `failed` shows `error_detail`. |
| Duplicate emails | Verify publisher is using unique `idempotency_key` per operation |
| Rate limit hit too early | Check `tenant_email_config.daily_rate_limit` and Valkey key `{tenant_id}:daily_email_count` |
| All providers failing | Check alerts exchange for `alert.email.all_providers_failed`. Verify credentials in env vars are correct. |
| Health check alerts firing | Provider may be down or credentials expired. Check `alert.email.provider_health_check_failed` payload for error details. |
| Unknown task_type rejected | Message had a `task_type` with no registered executor — check spelling or register the executor. |
| Message stuck in DLQ | Inspect `email_events_dlq` queue. Fix the issue, then replay via admin API (when implemented). |
