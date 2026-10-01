# Schedule & Email Service — Implementation TODO

Gap analysis between HLD v2 and current implementation.

---

## Missing Features

### 1. Circuit Breaker (HLD Section 6.1)
- [ ] Implement per-provider circuit breaker with Valkey keys (`circuit:{provider}`)
- [ ] States: CLOSED → OPEN (5 failures in 60s) → HALF_OPEN (after 30s cooldown)
- [ ] When primary provider circuit opens, fallback chain activates automatically
- [ ] Decision: start with shared per-provider scoping; move to per-tenant if tenants have own API keys

### 2. Suppression List (HLD Section 3.4)
- [ ] Create `suppression_list` DB model (`id`, `tenant_id`, `email`, `reason`, `provider`, `provider_event_id`, `suppressed_at`)
- [ ] Unique constraint: `UNIQUE(tenant_id, email)`
- [ ] Check suppression list **before every send** in `EmailSchedulerExecutor`
- [ ] Reasons: `hard_bounce`, `soft_bounce`, `spam_complaint`
- [ ] Admin API to view and remove false positives

### 3. Bounce/Complaint Webhooks (HLD Section 3.4)
- [ ] Create `src/email/webhooks.py`
- [ ] Endpoint: `POST /email/webhooks/{provider}` to receive provider callbacks
- [ ] Validate provider webhook signature (Brevo, SES, etc.)
- [ ] Resolve `tenant_id` from `email_log` record
- [ ] Update `email_log` status to `bounced` or `complained`
- [ ] Insert recipient into tenant-scoped `suppression_list`

### 4. Scheduled Email Polling Loop (HLD Section 3.3)
- [ ] Background async task that polls DB for due emails (`scheduled_at <= now()`)
- [ ] Distributed lock per tenant via Valkey (`{tenant_id}:scheduler_lock`)
- [ ] Retry policy: exponential backoff (1m, 5m, 15m, 1h) with max 5 retries
- [ ] Ensure one tenant's backlog does not block another tenant's scheduled emails
- [ ] Currently deferred emails are stored but never picked up and sent

### 5. Email Router / Admin API Endpoints (HLD Section 9)
- [ ] Create `src/email/router.py`
- [ ] `GET /email/health` — provider health + circuit breaker states
- [ ] `GET /email/providers` — tenant's configured providers and active selection
- [ ] `POST /email/providers/switch` — hot-swap tenant's active provider
- [ ] `GET /email/dlq` — list dead-letter messages for tenant
- [ ] `POST /email/dlq/{message_id}/replay` — replay a DLQ message
- [ ] `GET /email/log` — query email send log filtered by tenant
- [ ] `GET /email/suppression` — list suppressed addresses for tenant
- [ ] `DELETE /email/suppression/{email}` — remove false-positive suppression
- [ ] `GET /scheduler/status` — scheduler health, pending count, next poll
- [ ] `GET /admin/tenants/{tenant_id}/email-config` — get tenant email config
- [ ] `PUT /admin/tenants/{tenant_id}/email-config` — create/update tenant email config
- [ ] `GET /admin/tenants/{tenant_id}/email-usage` — daily send count vs rate limit

---

## Already Implemented

- [x] Executor framework (base, registry, all 4 executors registered)
- [x] RabbitMQ consumer + generic dispatcher by `task_type`
- [x] Email sending via ThreadPoolExecutor with provider fallback chain
- [x] Provider layer (Brevo/SES/SMTP stubs)
- [x] Multi-tenant config + credential registry (env-based, in-memory)
- [x] Dual-ACK (inbox_events DB + Valkey idempotency cache)
- [x] Per-tenant rate limiting (daily count in Valkey)
- [x] Health monitor (background provider health checks + alert publishing)
- [x] Template resolution (logical template_id → provider-specific ref)
- [x] Email log storage and audit trail
