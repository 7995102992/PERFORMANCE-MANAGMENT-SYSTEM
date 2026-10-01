# IAM Admin BE — Domain Events Reference

Use this document to consume events from IAM Admin BE in Leave Management or other downstream services.

---

## RabbitMQ Exchanges

| Exchange | Type | Purpose |
|----------|------|---------|
| `domain_events` | TOPIC | Cross-service domain events (employee, organisation, etc.) |
| `audit_events` | TOPIC | Audit/logging events consumed by the Logging Service |
| `email_events` | TOPIC | Email task dispatch (activation, password reset, etc.) |

---

## Domain Events

### 1. `employee.created`

**Exchange:** `domain_events` | **Routing Key:** `employee.created`
**Source:** `src/modules/organisation/employees/utils/tools.py`
**Triggered:** When a new employee is onboarded (single create or bulk upload — each row fires one event)

```json
{
  "correlation_id": "string — request trace ID",
  "user_id": "string — auth user ID",
  "employee_id": "string — employee record ID",
  "organisation_id": "string",
  "emp_code": "string — e.g. 'EMP-0001'",
  "work_email": "string",
  "name": "string — full name (first + last)",
  "first_name": "string",
  "last_name": "string",
  "l1_manager_id": "string | null — user ID of L1 manager",
  "l2_manager_id": "string | null — user ID of L2 manager",
  "designation_id": "string | null",
  "department_id": "string | null",
  "business_unit_id": "string | null",
  "employment_status": "string — e.g. 'active', 'probation'",
  "date_of_joining": "string | null — ISO date"
}
```

**Leave Management usage:** Create a local employee record, initialize leave balances based on `date_of_joining`, set up approval chain from `l1_manager_id`/`l2_manager_id`.

---

### 2. `employee.updated`

**Exchange:** `domain_events` | **Routing Key:** `employee.updated`
**Source:** `src/modules/organisation/employees/utils/tools.py`
**Triggered:** When employee details are modified

```json
{
  "correlation_id": "string",
  "employee_id": "string",
  "organisation_id": "string",
  "emp_code": "string",
  "work_email": "string | null",
  "name": "string | null — full name",
  "l1_manager_id": "string | null",
  "l2_manager_id": "string | null",
  "designation_id": "string | null",
  "department_id": "string | null",
  "business_unit_id": "string | null",
  "employment_status": "string",
  "date_of_joining": "string | null — ISO date",
  "changed_fields": ["string — list of field names that changed"]
}
```

**Leave Management usage:** Sync manager changes (affects leave approval chain). If `department_id` or `designation_id` changed, re-evaluate leave policies. If `employment_status` changed to inactive/terminated, cancel pending leaves. If `date_of_joining` changed, re-evaluate mid-year joiner credit on the next cron run.

---

### 3. `employee.deleted`

**Exchange:** `domain_events` | **Routing Key:** `employee.deleted`
**Source:** `src/modules/organisation/employees/utils/tools.py`
**Triggered:** When an employee is soft-deleted

```json
{
  "correlation_id": "string",
  "user_id": "string",
  "organisation_id": "string"
}
```

**Leave Management usage:** Deactivate employee leave records, cancel all pending/approved future leaves, settle leave balance.

---

### 4. `organisation.created`

**Exchange:** `domain_events` | **Routing Key:** `organisation.created`
**Source:** `src/modules/organisation/organisation/utils/tools.py`, `src/tenancy/service.py`
**Triggered:** When a new organisation/tenant is created

```json
{
  "correlation_id": "string",
  "organisation_id": "string",
  "legal_name": "string",
  "financial_year": "string",
  "currency": "string — e.g. 'USD', 'INR'",
  "timezone": "string — e.g. 'Asia/Kolkata'",
  "is_multiple_business_units": "boolean",
  "is_active": "boolean",
  "enabled_modules": [
    { "code": "string — module code", "is_active": "boolean" }
  ],
  "setup_status": "string",
  "created_by": "string",
  "created_on": "string — ISO datetime",
  "modified_by": "string",
  "modified_on": "string — ISO datetime",
  "deleted_by": "string | null",
  "deleted_on": "string | null",
  "admin_email": "string — only present from tenancy service"
}
```

**Leave Management usage:** Initialize default leave policies and leave types for the new tenant. Use `timezone` for date calculations, `financial_year` for annual leave balance periods.

---

### 5. `organisation.updated`

**Exchange:** `domain_events` | **Routing Key:** `organisation.updated`
**Source:** `src/modules/organisation/organisation/utils/tools.py`, `src/tenancy/service.py`
**Triggered:** When organisation details are modified

```json
{
  "correlation_id": "string",
  "organisation_id": "string",
  "legal_name": "string",
  "financial_year": "string",
  "currency": "string",
  "timezone": "string",
  "is_multiple_business_units": "boolean",
  "is_active": "boolean",
  "enabled_modules": [
    { "code": "string", "is_active": "boolean" }
  ],
  "setup_status": "string",
  "created_by": "string",
  "created_on": "string — ISO datetime",
  "modified_by": "string",
  "modified_on": "string — ISO datetime",
  "deleted_by": "string | null",
  "deleted_on": "string | null",
  "changed_fields": ["string — list of field names that changed"]
}
```

**Leave Management usage:** If `financial_year` changed, may need to recalculate leave balance periods. If `timezone` changed, update date calculation logic. Check `enabled_modules` to see if leave module is still active.

---

### 6. `organisation.deleted`

**Exchange:** `domain_events` | **Routing Key:** `organisation.deleted`
**Source:** `src/modules/organisation/organisation/utils/tools.py`
**Triggered:** When an organisation is soft-deleted

```json
{
  "correlation_id": "string",
  "organisation_id": "string",
  "legal_name": "string",
  "financial_year": "string",
  "currency": "string",
  "timezone": "string",
  "is_multiple_business_units": "boolean",
  "is_active": "boolean",
  "enabled_modules": [
    { "code": "string", "is_active": "boolean" }
  ],
  "setup_status": "string",
  "created_by": "string",
  "created_on": "string — ISO datetime",
  "modified_by": "string",
  "modified_on": "string — ISO datetime",
  "deleted_by": "string | null",
  "deleted_on": "string | null"
}
```

**Leave Management usage:** Deactivate all leave data for this organisation.

---

### 7. `business_unit.created`

**Exchange:** `domain_events` | **Routing Key:** `business_unit.created`
**Source:** `src/modules/organisation/businessunit/utils/tools.py`
**Triggered:** When a new business unit is created

```json
{
  "correlation_id": "string",
  "business_unit_id": "string",
  "organisation_id": "string",
  "name": "string"
}
```

---

### 8. `business_unit.deleted`

**Exchange:** `domain_events` | **Routing Key:** `business_unit.deleted`
**Source:** `src/modules/organisation/businessunit/utils/tools.py`
**Triggered:** When a business unit is deleted (single or bulk)

```json
{
  "correlation_id": "string",
  "business_unit_id": "string"
}
```

---

### 9. `department.created`

**Exchange:** `domain_events` | **Routing Key:** `department.created`
**Source:** `src/modules/organisation/department/utils/tools.py`
**Triggered:** When a new department is created

```json
{
  "correlation_id": "string",
  "department_id": "string",
  "organisation_id": "string",
  "name": "string"
}
```

**Leave Management usage:** May need department-specific leave policies.

---

### 10. `department.deleted`

**Exchange:** `domain_events` | **Routing Key:** `department.deleted`
**Source:** `src/modules/organisation/department/utils/tools.py`
**Triggered:** When a department is deleted

```json
{
  "correlation_id": "string",
  "department_id": "string"
}
```

**Leave Management usage:** Reassign employees' leave policies if they were department-specific.

---

### 11. `designation.created`

**Exchange:** `domain_events` | **Routing Key:** `designation.created`
**Source:** `src/modules/organisation/designation/utils/tools.py`
**Triggered:** When a new designation is created

```json
{
  "correlation_id": "string",
  "designation_id": "string",
  "organisation_id": "string",
  "name": "string"
}
```

---

### 12. `designation.deleted`

**Exchange:** `domain_events` | **Routing Key:** `designation.deleted`
**Source:** `src/modules/organisation/designation/utils/tools.py`
**Triggered:** When a designation is deleted

```json
{
  "correlation_id": "string",
  "designation_id": "string"
}
```

---

### 13. `policy.created`

**Exchange:** `domain_events` | **Routing Key:** `policy.created`
**Source:** `src/policies/service.py`
**Triggered:** When a new policy/role is created

```json
{
  "correlation_id": "string",
  "policy_id": "string",
  "name": "string",
  "is_role": "boolean"
}
```

---

### 14. `policy.deleted`

**Exchange:** `domain_events` | **Routing Key:** `policy.deleted`
**Source:** `src/policies/service.py`
**Triggered:** When a policy/role is deleted

```json
{
  "correlation_id": "string",
  "policy_id": "string"
}
```

---

### 15. `user.created`

**Exchange:** `domain_events` | **Routing Key:** `user.created`
**Source:** `src/users/service.py`
**Triggered:** When a new user account is created

```json
{
  "correlation_id": "string",
  "user_id": "string",
  "email": "string",
  "first_name": "string",
  "last_name": "string",
  "auth_method": "string — 'local' | 'azure_sso'",
  "status": "string",
  "created_on": "string | null — ISO datetime"
}
```

---

## Email Events

All email events are wrapped in a standard envelope before publishing to `email_events` exchange:

### Envelope Structure

```json
{
  "task_type": "email.send",
  "event_id": "string — UUID",
  "event_type": "string — routing key (e.g. 'email.activation')",
  "correlation_id": "string",
  "idempotency_key": "string — UUID",
  "tenant_id": "string — organisation_id",
  "payload": { "...see below..." },
  "published_at": "string — ISO datetime"
}
```

### 16. `email.activation`

```json
{
  "to": "string — recipient email",
  "template_id": "activation_v1",
  "template_data": {
    "display_name": "string",
    "activation_link": "string — full URL with token",
    "reset_link": "string | null — optional password reset link",
    "expires_in_human": "string — pre-rendered validity window, e.g. \"72 hours\"; covers BOTH links",
    "expires_in_seconds": "int — same window, machine-readable"
  }
}
```

**Expiry fields.** Every IAM email carries the same pair. `expires_in_human` is
rendered by the publisher, which owns the TTL — consumers print it verbatim and
must not re-derive the wording from `expires_in_seconds`, or the two drift.
An empty `expires_in_human` means "say nothing about expiry"; consumers drop the
sentence rather than substituting a guess.

### 17. `email.password_reset`

```json
{
  "to": "string — recipient email",
  "template_id": "password_reset_v1",
  "template_data": {
    "display_name": "string",
    "reset_link": "string — full URL with token",
    "expires_in_human": "string — e.g. \"30 minutes\"",
    "expires_in_seconds": "int"
  }
}
```

### 18. `email.email_change`

```json
{
  "to": "string — new email address",
  "template_id": "email_change_v1",
  "template_data": {
    "display_name": "string",
    "confirmation_link": "string — full URL with token",
    "expires_in_human": "string — e.g. \"24 hours\"",
    "expires_in_seconds": "int"
  }
}
```

---

## Audit Events

Published via `outbox.publish_audit_log()` to the `audit_events` exchange. Consumed by the Logging Service (TimescaleDB).

### Standard Envelope

```json
{
  "timestamp": "string — ISO datetime",
  "module": "string — e.g. 'iam', 'timesheet'",
  "actor_id": "string — user ID or 'system'",
  "action": "string — e.g. 'created', 'updated', 'deleted'",
  "resource": "string — e.g. 'employee:abc123', 'project:xyz'",
  "debug_level": "int — 1=EMPLOYEE, 2=MANAGER, 3=HR, 4=ADMIN",
  "metadata": "object | null — additional context"
}
```

### Audit Actions

| Action | Description |
|--------|-------------|
| `created` | Entity creation |
| `updated` | Entity modification |
| `deleted` | Entity deletion |
| `bulk_deleted` | Bulk deletion operation |
| `bulk_uploaded` | Bulk upload operation (e.g. employee import) |
| `permissions_updated` | Policy permission changes |
| `self_updated` | User self-service profile updates |
| `profile_photo_updated` | Profile photo uploads |

---

## Leave Management Consumer Guide

### Events You Must Consume

| Event | Why | What to Do |
|-------|-----|------------|
| `employee.created` | New employee joins | Create local employee record, initialize leave balances based on `date_of_joining`, set up approval chain from `l1_manager_id`/`l2_manager_id` |
| `employee.updated` | Employee details change | Sync manager changes (approval chain), re-evaluate leave policies if `department_id`/`designation_id` changed, handle `employment_status` changes |
| `employee.deleted` | Employee offboarded | Deactivate leave records, cancel pending/future leaves, settle balance |
| `organisation.created` | New tenant created | Initialize default leave types and policies |
| `organisation.updated` | Org settings change | Check `financial_year` (affects balance periods), `timezone` (date calculations), `enabled_modules` (leave module active?) |
| `department.created` | New department | May need department-specific leave policies |
| `department.deleted` | Department removed | Reassign employees' leave policies |

### RabbitMQ Binding Patterns

```
employee.*           → all employee events (created, updated, deleted)
organisation.*       → all organisation events
department.*         → all department events
employee.created     → only employee creation
#                    → all events (not recommended for production)
```

### Consumer Setup

```python
exchange = "domain_events"
exchange_type = "topic"
queue_name = "leave_management_queue"
durable = True
prefetch_count = 10

# Idempotency: use correlation_id + event_type as dedup key
# to prevent duplicate processing on redelivery
```

### Outbox Pattern (for publishing your own events)

If Leave Management needs to publish events (e.g. `leave.approved`, `leave.rejected`):

1. Write event to `outbox_events` collection in MongoDB
2. Attempt eager publish to RabbitMQ
3. Background relay picks up any `pending` events and retries
4. Use `idempotency_key` for consumer-side deduplication

See `src/outbox.py` in IAM Admin BE or Timesheet BE for reference implementation.
