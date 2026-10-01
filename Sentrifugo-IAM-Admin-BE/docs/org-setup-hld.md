# Sentrifugo Organisation Setup — High-Level Design (HLD)

> **Last updated:** 2026-07-08

---

## 1. OBJECTIVE

Authoritative source of the tenant's organisational graph — legal entity,
business units, departments, controlled document folders, permission
policies, job levels (designation / band / pay grade), employees, master
reference data, geographic locations, assigned heads, dashboard
analytics, multi-admin management, module activation, exit management,
and service request configuration — for the Sentrifugo HRMS platform.

Two portals consume this data:
- **Super Admin Portal** — creates orgs, assigns org admins, enables modules, manages platform, dashboard stats
- **Org Admin Portal** — 10-step setup wizard, then regular HRMS operation

Primary responsibilities:
- **Multi-tenant org lifecycle** — create → setup → active → manage
- **Master data management** — 15 categories of reference data with ObjectId resolution
- **Setup wizard** — prerequisite-based step locking with stored progress (10 steps including assign_head)
- **Employee management** — single + bulk CRUD (XLSX template with cascading dropdowns + validate + selective upload) with auto-provisioned IAM accounts
- **Permission ACL** — module × role × action grant matrix via policies (roles + permissions) with copy support (full policy + per-module copy)
- **Event-driven audit** — outbox-backed domain events + audit logs via RabbitMQ
- **Asset management** — centralized file upload to DigitalOcean Spaces with metadata in MongoDB
- **Location services** — countries, states, cities, currencies, timezones from seeded geographic data
- **Dashboard analytics** — org-level and super-admin-level stats (including pending setup count)
- **Health monitoring** — MongoDB, Valkey, RabbitMQ, DO Spaces connectivity checks
- **Custom fields** — dynamic field definitions (text, textarea, number, date, single_select, multi_select, radio, checkbox, file, url, email, phone) per entity with separate options collection
- **Logo proxy** — company logo discovery by domain via scraping (og:image, apple-touch-icon, favicon) with fallback services
- **Module management** — org admins can toggle module activation; only super admins can add/remove modules
- **Multi-admin management** — orgs can have multiple org admins (create, list, toggle status)
- **Self-service profile** — authenticated users can edit profile, change password, upload profile photo
- **Service request seed data** — SRM database schema and default categories/request types
- **Exit management** — multi-flow exit lifecycle (employee → manager → HR → clearances → exit interview → completion) with IT asset returns, admin tasks, finance clearances, exit interviews, per-department clearance checklists, and email notifications
- **Field-level encryption** — Fernet (AES-128-CBC + HMAC-SHA256) for sensitive numeric/string fields (employee CTC, band min/max amounts) with `ENCRYPTION_KEY` env var
- **CTC revision history** — employee CTC stored as an encrypted, number-keyed version map; every amount/currency revision retained with its timestamp, exposed read-only as `ctc_history`
- **Org document distribution** — employee-facing `/org-documents/my/*` endpoints with folder access scoping (BU + department + worker type) + one-way timestamped read acknowledgements + CORS-safe in-app file streaming
- **Session department context** — employee `department_id` injected into Valkey session payload for downstream microservice consumption (Service Request, etc.)
- **Employee Journey** — IAM aggregates cross-service domain events (IAM, Timesheet, Leave, SRM) into a per-employee timeline + per-FY metrics, served via `/journey` (self / batch / team sub-tree / by-id)
- **Reports & Analytics module** — 12th module with a single `reports` permission, toggled per-org like any other module
- **Internal service API** — unauthenticated `/internal/users-with-permission` for service-to-service permission-holder lookups (e.g. Leave Management resolving HR approvers)
- **Azure AD SSO** — MSAL-based login flow (`/auth/azure/login` → `/auth/azure/callback`) with Valkey-stored auth state

---

## 2. HIGH-LEVEL ARCHITECTURE

```
              ┌─────────────────────────────────┐
              │     React Admin Portal (FE)     │
              │  React 19 · TanStack Router     │
              │  Redux Toolkit · React Query    │
              │  shadcn/ui · Tailwind CSS       │
              │  TanStack Form · Zod            │
              └────────────────┬────────────────┘
                               │ REST / JWT Bearer
                               │ X-Correlation-ID header
                               v
              ┌────────────────┴────────────────┐
              │     FastAPI App (BE)             │
              │  Beanie ODM · Pydantic v2       │
              │  structlog · aio-pika           │
              │  passlib (bcrypt) · PyJWT        │
              │  MSAL (Azure SSO) · boto3       │
              │  openpyxl (bulk XLSX) · httpx   │
              └────────────────┬────────────────┘
                               │
   ┌──────┬──────┬─────┬───────┼───────┬───────┬──────────┬──────────┬──────────┬──────────┐
   │      │      │     │       │       │       │          │          │          │          │
   v      v      v     v       v       v       v          v          v          v          v
┌─────┐┌─────┐┌─────┐┌─────┐┌─────┐┌─────┐┌───────┐┌────────┐┌────────┐┌────────┐┌────────┐
│Auth ││Tenan││Poli-││ Org ││Bands││Empl-││Master ││Location││Dash-   ││Custom  ││Exit    │
│users││cy   ││cies ││Setup││/Pay ││oyees││ Data  ││Ctry/St/││board   ││Fields  ││Mgmt   │
│IAM  ││super││ACL  ││BU/Dp││Grade││+Bulk││14 cat ││City/TZ ││Stats   ││12 types││5 flows│
└──┬──┘└─────┘└──┬──┘└──┬──┘└──┬──┘└──┬──┘└───┬───┘└────────┘└────────┘└────────┘└────────┘
   v             v      v      v      v       v
┌─────────────────────────────────────────────────────────────┐
│                   MongoDB (Beanie ODM)                      │
│  Collections: users, password_history, organisations,       │
│  business_units, departments, designations, bands,          │
│  paygrades, document_folders, org_documents,                │
│  org_document_acknowledgements, employees,                  │
│  addresses, policies, module_acl_permissions, assets,       │
│  outbox_events, acl, modules, permissions, master_data,     │
│  countries, states, cities, custom_field_definitions,       │
│  custom_field_options, custom_field_values,                 │
│  exit_requests, exit_interviews, it_asset_returns,          │
│  admin_tasks, finance_clearances, department_checklists,   │
│  journey_timeline, journey_metrics, journey_processed_events│
├─────────────────────────────────────────────────────────────┤
│  Valkey (Redis)     │  RabbitMQ                             │
│  Sessions, tokens,  │  domain_events (outbox + journey      │
│  user contexts,     │  consumer), audit_events,             │
│  azure auth state    │  email_events exchanges               │
├─────────────────────┼───────────────────────────────────────┤
│  DigitalOcean Spaces (asset storage via boto3)              │
│  Folders: org-logos, org-documents, profile-photos, general │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. BACKEND LAYOUT

```
src/
├── main.py                            # FastAPI app, lifespan (init/close DB, Valkey, RabbitMQ, relay, journey consumer), 25 routers
├── config.py                          # GlobalConfig (pydantic-settings): env, CORS, DB, Valkey, RabbitMQ, DO Spaces, Frontend URL
├── database.py                        # MongoDB/PostgreSQL init + BU prefix backfill + 33 Beanie document models (incl. 3 journey)
├── models.py                          # Shared: StatusEnum, ModuleEnum (12), AclRoleEnum (3), PermissionCodeEnum (36),
│                                      #   MODULE_PERMISSIONS (per-module feature codes), MODULE_LABELS, PERMISSION_LABELS,
│                                      #   permission_label(), permission_doc_id(), OrgModule,
│                                      #   AuditMixin, MetadataMixin, CustomModel, MasterDataCompact,
│                                      #   AssetDocument, OutboxEventDocument, AclDocument, ModuleDocument,
│                                      #   PermissionDocument, PolicyDocument, ModuleAclPermissionDocument
├── correlation.py                     # X-Correlation-ID middleware (UUID4 if absent) + audit_create()/stamp_modified() audit-stamp helpers
├── internal/router.py                 # /internal service-to-service API (unauthenticated, read-only, tenant-scoped):
│                                      #   GET /internal/users-with-permission?module&permission&organisation_id —
│                                      #   reverse permission lookup (policies granting it → users holding those policies;
│                                      #   org/super admins with the full grid are intentionally excluded)
├── exceptions.py                      # DomainException + global handler
├── utils.py                           # Default password hashing (bcrypt)
├── logger.py                          # structlog + correlation ID processor
├── valkey.py                          # Redis/Valkey connection (init/close)
├── storage.py                         # DO Spaces S3-compatible storage service
├── storage_router.py                  # Storage test endpoints (health, upload-test)
├── assets.py                          # AssetService (upload, get, soft/hard delete, 2MB limit)
├── assets_router.py                   # /assets CRUD endpoints
├── logo_proxy.py                      # GET /api/logo — fetches company logos by domain/URL
│                                      #   Strategies: direct URL, homepage scrape (og:image, apple-touch-icon,
│                                      #   favicon links, <img> with "logo"), favicon fallbacks (Google, DuckDuckGo, direct)
│                                      #   24-hour Cache-Control, httpx async client, 10s timeout
│
├── security/
│   ├── __init__.py                    # package marker
│   └── crypto.py                      # Fernet (AES-128-CBC + HMAC-SHA256) helpers:
│                                      #   encrypt_str / decrypt_str (string fields)
│                                      #   encrypt_amount / decrypt_amount (numeric fields, legacy passthrough
│                                      #     for unencrypted int/float rows)
│                                      #   build_ctc / revise_ctc / decrypt_ctc — employee CTC as a number-keyed
│                                      #     version map {"1": {value(fernet), currency, updated_on}, ...};
│                                      #     highest key = current; revise appends a version only on a real
│                                      #     amount/currency change; decrypt returns {amount, currency,
│                                      #     updated_on, history[]}
│                                      #   Key from settings.ENCRYPTION_KEY (memoized via @lru_cache(maxsize=1))
│                                      #   RuntimeError on lazy init if key missing; silent None on decrypt failure
│
├── auth/
│   ├── config.py                      # AuthConfig (JWT secret, password policy, Azure SSO, token TTLs)
│   ├── models.py                      # UserDocument (email, password_hash, auth_method, azure_oid,
│   │                                  #   first/middle/last_name, phone, work_phone, work_phone_extension,
│   │                                  #   avatar_url, dob, gender, marital_status, status, pending_email,
│   │                                  #   is_super_admin, is_org_admin, organisation_id, policy_ids,
│   │                                  #   last_login_at, password_changed_at) + PasswordHistoryDocument
│   ├── router.py                      # /auth/login, /auth/portal/login, /auth/refresh, /auth/me (GET/PUT),
│   │                                  #   /auth/me/profile-photo, /auth/logout (with all_devices),
│   │                                  #   /auth/activate, /auth/resend-activation,
│   │                                  #   /auth/forgot-password, /auth/reset-password,
│   │                                  #   /auth/confirm-email-change, /auth/change-password,
│   │                                  #   /auth/azure/login, /auth/azure/callback
│   ├── schemas.py                     # LoginRequest, TokenResponse, MeResponse (with avatar_asset_id,
│   │                                  #   permissions dict), LogoutRequest (refresh_token + all_devices),
│   │                                  #   ActivateAccountRequest, ResendActivationRequest,
│   │                                  #   ForgotPasswordRequest, ResetPasswordRequest, ConfirmEmailChangeRequest,
│   │                                  #   ChangePasswordRequest, UserBase, AzureCallbackRequest, AzureLoginUrlResponse
│   ├── service.py                     # Login, password, activation (with embedded reset link), email change flows
│   └── utils/
│       ├── dependencies.py            # get_current_user (Valkey hot path + JWT cold path)
│       ├── org_context.py             # resolve_org_id, check_org_access (403 on mismatch)
│       ├── authorization.py           # require_permission, require_super_admin, require_any_module_admin
│       ├── oauth2.py                  # JWT create/refresh/hash (HS256)
│       ├── activation.py              # Activation token (JWT + Valkey, 72h TTL)
│       ├── password_reset.py          # Password reset token (JWT + Valkey, 30min TTL)
│       ├── email_change.py            # Email change confirmation token (JWT + Valkey, 24h TTL)
│       ├── email_events.py            # Outbox-backed email event publishing
│       ├── sessions.py                # Refresh token session management (Valkey sets)
│       ├── user_session.py            # Access-token session + permission grid resolution + delete_all_user_sessions_for_user
│       │                              #   + injects employee.department_id into session payload (looked up via
│       │                              #   EmployeeDocument; lookup failures logged as session.dept_lookup.failed, non-fatal)
│       ├── tools.py                   # bcrypt password hashing
│       └── azure.py                   # MSAL Azure AD SSO integration
│
├── users/
│   ├── router.py                      # /users CRUD + search + /{user_id}/policies/{policy_id} attach/detach
│   │                                  #   List filters: is_org_admin, organisation_id
│   ├── schemas.py                     # UserCreate (with avatar_asset_id, send_activation),
│   │                                  #   UserUpdate, MeUpdate, UserResponse (with avatar_asset_id)
│   ├── service.py                     # User CRUD + profile photo upload + policy attach/detach
│   └── utils/tools.py                 # User repository (Beanie queries, org-scoped, get_users_with_policy, get_org_admin)
│
├── tenancy/                           # Super-admin org lifecycle
│   ├── router.py                      # /super-admin/organisations CRUD (gated by require_super_admin)
│   ├── schemas.py                     # OrganisationCreate/Update/Response + AdministratorInput/Update/View
│   │                                  #   OrganisationListItem (enabled_modules_count, active_modules_count)
│   │                                  #   OrgModule (code + is_active) + SetupStatus type
│   ├── service.py                     # create_org + admin user + activation email + email change
│   └── utils/tools.py                 # Org repository (Beanie queries + legal name search)
│
├── policies/
│   ├── models.py                      # (PolicyDocument + ModuleAclPermissionDocument — defined in src/models.py)
│   ├── router.py                      # /policies CRUD + /roles (is_role=True list) +
│   │                                  #   /{id}/permissions grid + /{id}/copy +
│   │                                  #   /{id}/copy-module-permissions + /by-module/{module_id}
│   ├── schemas.py                     # PolicyCreate (with is_role, permissions dict, seed_module_codes),
│   │                                  #   PolicyResponse (with is_role), PolicyListItem (with is_role),
│   │                                  #   PolicyGridResponse, PolicyGridUpdate, PolicyCopy,
│   │                                  #   PolicyCopyModulePermissions
│   ├── service.py                     # Policy CRUD + grid update + copy with permissions +
│   │                                  #   copy_module_permissions + list_policies_by_module +
│   │                                  #   list_role_policies + policy inactivation dependency check +
│   │                                  #   cache invalidation (drop Valkey sessions for policy holders)
│   └── utils/grants.py               # Grant resolution, batch queries, grid serialization,
│                                      #   replace_policy_grants (minimal diff: soft-delete removed, insert added)
│
├── master_data/
│   ├── models.py                      # MasterDataDocument (category, key, value, is_active, is_custom, organisation_id)
│   └── router.py                      # /master-data CRUD + /countries /states /cities
│                                      #   /currencies /timezones endpoints
│
├── location/
│   ├── router.py                      # /master-data/countries, /states, /cities (shares prefix with master_data)
│   ├── schemas.py                     # CountryResponse, StateResponse, CityResponse
│   ├── service.py                     # Location search + by-id service layer
│   └── utils/tools.py                 # Location repository (countries/states/cities collections)
│
├── lookups/
│   ├── router.py                      # /lookups/modules, /lookups/acl, /lookups/permissions
│   ├── schemas.py                     # ModuleLookup, AclLookup, PermissionLookup schemas
│   ├── service.py                     # Lookup service layer
│   └── utils/tools.py                 # Lookup repository (modules, acl, permissions collections)
│
├── dashboard/
│   ├── router.py                      # /dashboard/stats (super admin), /dashboard/org-stats (org admin),
│   │                                  #   /dashboard/headcount-snapshot, /dashboard/birthdays
│   │                                  #   (birthdays: any authenticated user with an org context)
│   ├── schemas.py                     # DashboardStats (with pending_setup), OrgDashboardStats,
│   │                                  #   HeadcountSnapshot, BirthdayItem (type "birthday" | "anniversary"
│   │                                  #   + years for anniversaries), BirthdaysResponse (today + upcoming)
│   └── service.py                     # Aggregate counts for dashboard widgets +
│                                      #   get_org_birthdays (active org members' birthdays AND work
│                                      #   anniversaries — today's + next 7 upcoming across both types;
│                                      #   anniversaries need ≥1 completed year + not exited;
│                                      #   Feb-29 → Feb-28 fallback via _next_occurrence)
│                                      #   headcount active_employees excludes soft-deleted, exited-by-date
│                                      #   AND inactive employment statuses (both signals must agree)
│
├── health/
│   ├── router.py                      # /health (MongoDB, Valkey, RabbitMQ checks)
│   ├── schemas.py                     # HealthResponse schema
│   └── service.py                     # Connectivity probes for all infrastructure
│
├── rabbitmq/
│   ├── __init__.py                    # Module exports + lifecycle (init/close/start/stop relay)
│   ├── connection.py                  # Singleton RobustConnection lifecycle
│   ├── constants.py                   # Exchange configs, DebugLevel enum (EMPLOYEE/MANAGER/HR/ADMIN)
│   └── outbox.py                      # Transactional outbox (publish + relay 5s/batch50/10retries + publish_audit_log)
│
├── modules/journey/                     # Employee Journey — IAM is the aggregator/sink for cross-service events
│   ├── models.py                      # 3 Beanie docs: JourneyTimelineDocument (timeline "dots" — event_type, title,
│   │                                  #   occurred_at, source_service, metadata, unique idempotency_key),
│   │                                  #   JourneyMetricsDocument (per-user/per-FY worked_hours + service_requests_count),
│   │                                  #   JourneyProcessedEventDocument (idempotency guard, one row per consumed event)
│   ├── consumer.py                    # Durable queue `iam.journey` bound to the `domain_events` topic exchange on 8
│   │                                  #   routing keys: employee.created/updated, exit.applied, project.assigned/reassigned,
│   │                                  #   leave.allocated, service_request.raised, timesheet.approved. Handlers write timeline
│   │                                  #   dots (onboarded, l1/l2_assigned/changed, designation/paygrade/band_assigned/changed,
│   │                                  #   exit, project_assigned/reassigned, leave_allocated, service_request_raised) +
│   │                                  #   metrics (worked_hours ← timesheet.approved, sr_count ← service_request.raised);
│   │                                  #   at-least-once delivery, idempotent via journey_processed_events; started in lifespan
│   ├── router.py                      # /journey: GET /me, POST /batch (user_ids[]), GET /team (reporting sub-tree,
│   │                                  #   include_self), GET /{user_id} — all org-scoped (super admin spans orgs)
│   └── service.py                     # get_journeys (timeline desc + metrics), get_team_user_ids (walks l1_manager_id
│                                      #   graph, up to 10 levels), enrich_with_user_details (name + emp_code)
│
├── modules/custom_fields/
│   ├── models.py                      # CustomFieldDefinitionDocument, CustomFieldOptionDocument (separate collection),
│   │                                  #   CustomFieldValueDocument + enums (EntityType, SectionType, FieldType 12 types)
│   │                                  #   + OPTION_FIELD_TYPES, SINGLE_OPTION_TYPES, MULTI_OPTION_TYPES sets
│   ├── schema.py                      # DefinitionCreate/Update/Response, OptionCreate/Update/Response,
│   │                                  #   ValueUpsert/Response, FieldWithValue (definition + options + value),
│   │                                  #   EntityValuesResponse, ReorderItem/ReorderRequest
│   ├── router.py                      # Definitions CRUD + /reorder + Options CRUD (per definition) + /options/reorder
│   │                                  #   + Values GET/PUT/DELETE per entity
│   ├── service.py                     # Orchestration layer with _resolve_org
│   └── utils/tools.py                 # DefinitionTools + OptionTools + ValueTools (Beanie queries)
│
├── modules/exit_management/
│   ├── models.py                      # 6 Beanie documents: ExitRequestDocument (with AWAITING_EXIT_INTERVIEW status),
│   │                                  #   ExitInterviewDocument, ITAssetReturnDocument (with completed_checklist),
│   │                                  #   AdminTaskDocument, FinanceClearanceDocument (with completed_checklist),
│   │                                  #   DepartmentChecklistDocument (per-org/per-dept clearance checklist items)
│   ├── schema.py                      # ExitRequestCreate/Update/Approval/Response (with itClearanceStatus,
│   │                                  #   adminClearanceStatus, financeClearanceStatus), ManagerApprove/RejectRequest,
│   │                                  #   TeamExitRequestResponse, TeamExitSummaryResponse,
│   │                                  #   HRExitRequestResponse, HRExitSummaryResponse,
│   │                                  #   ExitInterviewCreate/Response,
│   │                                  #   ITAssetReturnResponse (with exitRequestStatus + cross-clearance fields),
│   │                                  #   ITAssetSummaryResponse (with notCleared count), ITAssetVerifyRequest
│   │                                  #   (with completedChecklist + optional status override),
│   │                                  #   AdminTaskResponse, AdminTaskSummaryResponse (with notCleared),
│   │                                  #   AdminTaskCompleteRequest (with optional status),
│   │                                  #   FinanceClearanceResponse, FinanceClearanceSummaryResponse,
│   │                                  #   FinanceClearanceStatusRequest (with completedChecklist),
│   │                                  #   DepartmentChecklistCreate/Update/Response
│   ├── router.py                      # /exit-management/* — 22+ endpoints across 5 flows:
│   │                                  #   Employee: /requests CRUD + /withdraw + /revoke + /reapply + /interview
│   │                                  #   Manager: /team-requests + /team-requests/summary + /manager-approve + /manager-reject
│   │                                  #   HR: /hr-requests + /hr-requests/summary + /initiate-clearances + /deactivate + /remind
│   │                                  #   IT: /it/assets + /it/assets/summary + /it/assets/{id}/verify
│   │                                  #   Admin: /admin/tasks + /admin/tasks/summary + /admin/tasks/{id}/complete
│   │                                  #   Finance: /finance/requests + /finance/requests/summary + /finance/requests/{id}/status
│   │                                  #   Checklists: GET /checklists?deptId=... + PUT /checklists (upsert)
│   │                                  #   All endpoints gated by require_permission("core_hr", "create_resource")
│   ├── service.py                     # Exit lifecycle orchestration with enriched responses (async _enrich_response
│   │                                  #   joins IT/Admin/Finance clearance statuses), clearance auto-completion check
│   │                                  #   (now transitions to AWAITING_EXIT_INTERVIEW until interview submitted, then
│   │                                  #   COMPLETED), employee deactivation, checklist seeding (IT/ADMIN/FINANCE defaults)
│   └── email_events.py                # 6 outbox-backed email events:
│                                      #   exit_request_raised, exit_manager_approved, exit_manager_rejected,
│                                      #   exit_clearances_initiated, exit_clearances_assigned, exit_completed
│
└── modules/organisation/
    ├── dependency_check.py            # Pre-inactivation dependency checks (raises 409 if active dependents exist)
    ├── dependency_router.py           # GET /dependency-check/{entity_type}/{entity_id} (read-only pre-check for FE)
    │                                  #   Supported: organisation, business_unit, department, designation, pay_grade,
    │                                  #   band, document_folder, policy
    ├── models.py                      # All org-setup Beanie documents (11 document classes):
    │                                  #   AddressDocument, OrganisationDocument (with is_multiple_business_units,
    │                                  #     enabled_modules as list[OrgModule], head_user_id),
    │                                  #   BusinessUnitDocument (with emp_code_last_numbers dict {F,C,I} +
    │                                  #     emp_code_start_from dict {F,C,I}, legacy emp_code_last_number retained,
    │                                  #     is_subsidiary bool — FE-only distinction),
    │                                  #   DepartmentDocument (with primary_business_unit ObjectId),
    │                                  #   DesignationDocument (with policy_ids — roles attached to the designation —
    │                                  #     + pay_grade_ids — pay grades assigned to the designation, indexed),
    │                                  #   DocumentFolderDocument,
    │                                  #   OrgDocumentDocument (allow_download defaults False — download opt-in),
    │                                  #   DocumentAcknowledgementDocument (org_document_acknowledgements — one
    │                                  #     employee's timestamped ack of a document, unique (document_id, user_id)),
    │                                  #   EmployeeDocument (with bank_details: BankDetails, ctc as number-keyed
    │                                  #     encrypted version map — _coerce_ctc wraps legacy str/list rows,
    │                                  #     currency ISO code),
    │                                  #   BandDocument (min_amount + max_amount stored as encrypted str,
    │                                  #     legacy numeric coercion via _coerce_legacy_numeric),
    │                                  #   PayGradeDocument (band_ids only — designation link now lives on
    │                                  #     DesignationDocument.pay_grade_ids)
    │                                  #   + embedded models: FolderAccess, IdentityField, WorkExperienceRow,
    │                                  #   DependentRow, EducationRow, EmergencyContact, BankDetails, CtcRecord
    ├── organisation/
    │   ├── router.py                  # /organisations GET (my org), GET /{id}, PUT /{id}, DELETE /{id}
    │   ├── schema.py                  # OrganisationResponse (with address, logo_url, head_employee_name,
    │   │                              #   setup_progress, custom_fields, enabled_modules as list[OrgModule]),
    │   │                              #   OrganisationUpdate (head_user_id, address, logo_asset_id, currency,
    │   │                              #   timezone, setup_status, is_multiple_business_units, enabled_modules)
    │   │                              #   + OrgModule toggle restriction validator (org admins can toggle, not add/remove)
    │   ├── service.py                 # Org CRUD + logo replacement (soft-delete old on update)
    │   │                              #   + module toggle enforcement (org admin vs super admin)
    │   └── utils/
    │       ├── setup_service.py       # 10-step setup_progress calculation + refresh
    │       │                          #   Steps: organisation, business_units, departments, org_documents,
    │       │                          #   policies, designations, bands, pay_grades, employees, assign_head
    │       │                          #   States: locked | pending | completed
    │       │                          #   Organisation completed: address_id + date_of_incorporation + currency + timezone
    │       │                          #   Assign head completed: head_user_id set
    │       │                          #   Others: at least one active record exists
    │       └── tools.py               # OrgTools (aggregation with $lookup for address/logo_url/head_employee_name)
    │                                  #   organisation.* event payload includes head_user_id
    ├── businessunit/
    │   ├── router.py                  # /business-units CRUD + /bulk-delete
    │   │                              #   List filters: skip, limit, search, is_active, is_subsidiary
    │   ├── schema.py                  # BU create (with embedded AddressCreate, emp_code_prefix, currency, time_zone,
    │   │                              #   is_subsidiary (alias isSubsidiary, default False — FE-only distinction),
    │   │                              #   emp_code_start_from: EmpCodeStartFrom { full_time, contract, internship } — REQUIRED on create;
    │   │                              #   each a digit string "\d{1,7}", leading zeros set the zero-pad width),
    │   │                              #   BU response (with address, head_employee_name, head_emp_code,
    │   │                              #   sector/type_of_business/nature_of_business as MasterDataCompact,
    │   │                              #   custom_fields: list[FieldWithValue],
    │   │                              #   emp_code_start_from: EmpCodeStartFromResponse { F, C, I } as padded strings,
    │   │                              #   has_employees: bool flag),
    │   │                              #   BulkDeleteRequest, BU update (empCodePadding override)
    │   ├── service.py                 # BU CRUD + prefix uniqueness + name uniqueness + bulk_delete
    │   └── utils/tools.py             # BuTools: create (address + BU atomic; _split_start_from splits each
    │                                  #   digit string into emp_code_start_from {F,C,I} numbers + emp_code_padding widths),
    │                                  #   get ($lookup address + head employee + master data + has_employees flag
    │                                  #   via employees collection $lookup with $limit:1; _format_start_from rebuilds padded strings),
    │                                  #   update (prefix/name unique check + reject emp_code_prefix /
    │                                  #   emp_code_start_from number-or-padding changes if any employee exists in BU — HTTP 400),
    │                                  #   delete/bulk_delete (soft-delete + outbox + refresh_setup_progress)
    ├── department/
    │   ├── router.py                  # /departments CRUD (filter by business_unit_ids comma-separated)
    │   │                              #   List filters: business_unit_ids, skip, limit, search, is_active
    │   ├── schema.py                  # Dept create (business_units: list[ObjectId], department_code,
    │   │                              #   primary_business_unit: Optional[ObjectId]),
    │   │                              #   DepartmentResponse (department_head_name, business_unit_names[],
    │   │                              #   primary_business_unit_data: PrimaryBusinessUnitCompact { id, business_unit_name }),
    │   │                              #   DepartmentUpdate
    │   ├── service.py                 # Dept CRUD + name uniqueness
    │   └── utils/tools.py             # DeptsTools ($lookup BU names, head user name, primary_business_unit_data
    │                                  #   via $lookup + $unwind + $cond):
    │                                  #   - create/update: if multiple BUs → primary_business_unit required (400);
    │                                  #     primary must be in business_units list (400); single-BU auto-sets primary.
    ├── designation/                   # Org-level job titles (no department, no hierarchy, no policy)
    │   ├── router.py                  # /designations CRUD
    │   │                              #   List filters: skip, limit (≤1000), search, is_active (org-level — no dept/hierarchy)
    │   ├── schema.py                  # Designation create (designation_name, description,
    │   │                              #   pay_grade_ids alias payGradeIds — pay grades assigned to the designation),
    │   │                              #   DesignationResponse (pay_grades as PayGradeCompact[] from pay_grade_ids;
    │   │                              #   department_id/hierarchy_role removed from the form, kept nullable on the doc)
    │   ├── service.py                 # Thin pass-through CRUD (no policy lifecycle); names need NOT be unique
    │   └── utils/tools.py             # DesignationTools ($lookup paygrades for pay_grades;
    │                                  #   list sorted by designation_name before pagination;
    │                                  #   _validate_pay_grades on create/update — each pay grade must be
    │                                  #   active + same-org, else HTTP 400;
    │                                  #   designation.created/.updated events carry department_id + pay_grade_ids)
    ├── bands/
    │   ├── router.py                  # /bands CRUD
    │   ├── schema.py                  # Band create (class_label + frequency as ObjectId, currency,
    │   │                              #   min_amount, max_amount as float — encrypted at rest, effective_from/to, notes),
    │   │                              #   model_validator enforces: effective_to requires effective_from,
    │   │                              #   effective_to must be strictly > effective_from (same-day rejected)
    │   │                              #   BandResponse (class_label + frequency as MasterDataCompact, amounts
    │   │                              #   returned as decrypted float)
    │   ├── service.py                 # Band CRUD + name uniqueness
    │   └── utils/tools.py             # BandTools ($lookup master_data for class_label + frequency)
    │                                  #   + currency validation against location_tools.list_currencies()
    │                                  #   + min/max coherence (max >= min) on create + partial update
    │                                  #   + encrypt_amount on write, decrypt_amount on read
    │                                  #   + legacy numeric passthrough (_coerce_legacy_numeric)
    │                                  #   + outbox events band.created / band.updated / band.deleted
    ├── paygrades/
    │   ├── router.py                  # /paygrades CRUD
    │   ├── schema.py                  # PayGrade create (band_ids[]),
    │   │                              #   PayGradeResponse (band_names[])
    │   │                              #   (designation link removed — now on DesignationDocument.pay_grade_ids)
    │   ├── service.py                 # PayGrade CRUD + FK validation (band_ids exist) + name uniqueness
    │   └── utils/tools.py             # PayGradeTools ($lookup bands for names);
    │                                  #   deactivate/delete call check_pay_grade_dependencies (409 if any
    │                                  #   active designation still references it via pay_grade_ids);
    │                                  #   outbox events pay_grade.created / .updated / .deleted
    ├── orgdocuments/
    │   ├── router.py                  # /org-documents folders + documents CRUD
    │   │                              #   + POST /folders/bulk (create multiple folders)
    │   │                              #   + POST /documents/bulk (create multiple documents)
    │   │                              #   + PATCH /folders/{id}/deactivate-all-documents
    │   │                              #   + GET /documents/{id}/content — admin in-app viewer: streams the
    │   │                              #     file bytes through the API (CORS-safe, inline disposition,
    │   │                              #     private 5-min cache)
    │   │                              #   Employee-facing (any authenticated user, access-scoped):
    │   │                              #   + GET /my/folders + GET /my/documents?folder_id=
    │   │                              #   + GET /my/documents/{id}/content
    │   │                              #   + POST /my/documents/{id}/acknowledge
    │   ├── schema.py                  # Folder/Document create/update + FolderAccess (BU/Dept/WorkerType)
    │   │                              #   + BulkFolderCreate (with FolderCreateItem[])
    │   │                              #   + BulkDocumentCreate (DocumentCreate[])
    │   │                              #   + DocumentResponse (with file_name, file_size, mime_type, file_url from asset $lookup)
    │   │                              #   + MyDocumentResponse (adds acknowledged + acknowledged_at)
    │   │                              #   + AcknowledgeRequest/Response (browser timestamp, server fallback)
    │   │                              #   allow_download now defaults to False (download is opt-in per file)
    │   ├── service.py                 # Folder/document CRUD + cascade delete + deactivate_all_documents_in_folder
    │   │                              #   + bulk folder/document creation
    │   │                              #   + employee-facing flows: _employee_scope (BU/dept/worker-type identity,
    │   │                              #     None = unrestricted for org/super admins), list_my_folders,
    │   │                              #     list_my_documents (with per-caller ack state), get_document_content /
    │   │                              #     get_my_document_content (asset bytes from DO Spaces),
    │   │                              #     acknowledge_document (400 if doc doesn't require acknowledgement)
    │   └── utils/tools.py             # OrgDoc repository (folder tree, document queries, dependency check on folder inactivation)
    │                                  #   + employee_access_filter / folder_accessible (folder visible when
    │                                  #     custom_access off OR BU AND dept AND worker-type all match)
    │                                  #   + get_all_with_ack ($lookup caller's ack onto each document)
    │                                  #   + acknowledge (idempotent insert, unique (document_id, user_id),
    │                                  #     concurrent double-click returns the record that won the race)
    │                                  #   + outbox events document_folder.created/.updated/.deleted +
    │                                  #     org_document.created/.updated/.deleted
    ├── employees/
    │   ├── router.py                  # /employees CRUD + /bulk-template + /bulk-validate + /bulk-upload
    │   │                              #   List filters: business_unit_ids (comma-separated), department_ids,
    │   │                              #   designation_ids, employment_status (ObjectId OR magic "active"/"inactive"),
    │   │                              #   project_status (ObjectId), employment_type_id, search, has_policies,
    │   │                              #   skip, limit (≤1000)
    │   ├── schema.py                  # EmployeeCreate (10 sections: basic, work, personal, bank_details,
    │   │                              #   identity, contact, emergency, work_experience, dependents, education
    │   │                              #   + addresses + Compensation: ctc + currency
    │   │                              #   + project_status + policy_ids alias roleIds — roles assigned directly),
    │   │                              #   EmployeeUpdate, EmployeeResponse (with $lookup names + MasterDataCompact +
    │   │                              #   l1/l2_manager_name/email/emp_code + policies: PolicyCompact[] +
    │   │                              #   custom_fields: FieldWithValue[] + bank_details: BankDetailsDTO +
    │   │                              #   ctc returned decrypted as float + ctc_history: CtcHistoryEntry[] —
    │   │                              #   prior revisions, read-only),
    │   │                              #   BulkValidateResult (per-row status + errors), BulkUploadResult
    │   ├── service.py                 # Single CRUD + bulk template download + bulk validate + bulk upload
    │   │                              #   (selective row insertion via selected_row_nums JSON array)
    │   │                              #   - download_bulk_template enriches with states (limit 5000) + cities
    │   │                              #     (limit 50000) for richer Excel dropdowns
    │   └── utils/
    │       ├── tools.py               # EmployeeTools:
    │       │                          #   - create: business_unit_id + department_id + employment_type are MANDATORY
    │       │                          #     (HTTP 400 if missing), validate optional FKs, check unique email,
    │       │                          #     resolve emp_type letter (F/C/I) → generate emp_code
    │       │                          #     full-time: {PREFIX}-{N} (no letter); contract/internship:
    │       │                          #     {PREFIX}-{C|I}-{N} where N = start_from + counter - 1 (atomic per-type
    │       │                          #     counter, zero-padded to emp_code_padding[letter] width), assign roleIds → user.policy_ids,
    │       │                          #     build CTC version map via build_ctc, validate currency,
    │       │                          #     create addresses + user + employee (rollback on failure +
    │       │                          #     _rollback_emp_code decrements per-type counter),
    │       │                          #     outbox events (employee.created with date_of_joining), refresh_setup_progress;
    │       │                          #     skips send_activation_email when employment_status is inactive
    │       │                          #   - get: $lookup addresses, BU, dept, designation, L1/L2 manager (with user names,
    │       │                          #     emails, emp_codes — the employees join is a pipeline $lookup capped to
    │       │                          #     ONE live doc (deleted_on: None + $limit 1): user_id is not unique in
    │       │                          #     data, and an uncapped $lookup + $unwind after $skip/$limit would
    │       │                          #     duplicate rows and break pagination), master_data (employment_type/status/
    │       │                          #     project_status/source_of_hire/gender/marital_status), user doc (name, email,
    │       │                          #     dob, gender, marital_status, work_phone, policies), bank_details, custom_fields;
    │       │                          #     _normalize decrypts ctc via decrypt_ctc → current amount + ctc_history
    │       │                          #     (no role-based redaction)
    │       │                          #   - get_all: multi-filters + search (by emp_code, email, first/last name) +
    │       │                          #     has_policies filter + employment_status magic value resolution
    │       │                          #     ("active"/"inactive" → $in over master_data with matching is_active flag) +
    │       │                          #     deterministic $sort by emp_code before pagination + $lookups
    │       │                          #   - update: route user fields to UserDocument, validate FKs, validate managers
    │       │                          #     (L1/L2 optional — must exist in org + not be self; no hierarchy requirement),
    │       │                          #     business_unit_id + employment_type are IMMUTABLE after create (400 on
    │       │                          #     actual change — emp_code is derived from both and never regenerated),
    │       │                          #     apply roleIds → user.policy_ids when provided,
    │       │                          #     update addresses in place, handle embedded sub-models,
    │       │                          #     sync UserDocument.status to ACTIVE/INACTIVE on employment_status change,
    │       │                          #     revise CTC via revise_ctc (appends a version, preserves history),
    │       │                          #     outbox employee.updated includes date_of_joining
    │       │                          #   - delete: soft-delete employee + linked user, outbox events
    │       │                          #   - bulk_validate: parse file, build lookup maps, validate each row
    │       │                          #     (required fields, dates, email, phone, PAN, Aadhaar, BU/dept/desg hierarchy,
    │       │                          #     country names, master data resolution, manager lookup,
    │       │                          #     duplicate email detection intra-file + vs DB), intra-batch manager resolution
    │       │                          #   - bulk_upload: validate + insert selected valid rows, second pass for
    │       │                          #     intra-batch manager references
    │       └── bulk.py                # XLSX parsing + validation + template generation:
    │                                  #   - 36 columns with HEADER_ALIASES (flexible column matching)
    │                                  #   - REQUIRED (11 columns): first_name, last_name, work_email, business_unit,
    │                                  #     department, designation, role, employment_type, reporting_manager, gender, marital_status
    │                                  #   - Cascading dropdown: BU → Department (hidden sheets + INDIRECT).
    │                                  #     Designation is org-level → flat dropdown (no dept cascade)
    │                                  #   - Cascading dropdowns: country → state → city (via hidden sheets + INDIRECT)
    │                                  #   - Master data dropdowns: employment_type, employment_status, project_status,
    │                                  #     source_of_hire, gender, marital_status
    │                                  #   - Other dropdowns: country, reporting_manager, role (policies with is_role=true)
    │                                  #   - normalize_md_value: lenient master-data matching (hyphen/underscore/space-insensitive)
    │                                  #   - Validation: email format, phone (10-15 digits), PAN (ABCDE1234F),
    │                                  #     Aadhaar (12 digits), date formats (8 supported), cross-date sanity,
    │                                  #     BU↔Dept link, designation + role resolved by name within org, country names
    │                                  #   - Excel cell formatting for date_of_joining/dob/date_of_exit as text +
    │                                  #     hover tooltip Comments on instruction cells
    │                                  #   - Supports CSV and XLSX input, 5MB file size limit
    └── addresses/
        ├── router.py                  # /addresses CRUD
        ├── schema.py                  # AddressCreate (country, state, city, zip_code, address_line_1/2),
        │                              #   AddressResponse
        ├── service.py                 # Address CRUD
        └── utils/tools.py             # Address repository
```

---

## 4. FRONTEND LAYOUT

```
src/
├── main.tsx                           # React entry + QueryClient with MutationCache
│                                      #   (setupAffecting meta → auto-invalidate org query)
├── router.tsx                         # TanStack Router (basepath: /admin)
│                                      #   Public: login, forgot-password, reset-password, activate
│                                      #   Admin (auth-guarded): profile + org-admin routes + super-admin routes
│
├── api/
│   ├── auth.ts                        # authService (login, portalLogin, refresh, getMe, logout,
│   │                                  #   forgotPassword, resetPassword, updateProfile, changePassword,
│   │                                  #   activateAccount)
│   ├── users.ts                       # usersService (list, getById, create, update) with UserDTO/CreateDTO/UpdateDTO
│   ├── custom-fields.ts               # definitionService + optionService + valueService (full custom fields API)
│   ├── assets.ts                      # assetService (upload multipart, getById, remove)
│   ├── master-data.ts                 # masterDataService (15 categories + countries/states/cities
│   │                                  #   + currencies + timezones)
│   ├── lookups.ts                     # lookupsService (modules, acl, permissions catalogs)
│   ├── query-keys.ts                  # Centralized query key factory (prevents typos)
│   ├── org-setup/
│   │   ├── types.ts                   # All org-setup DTOs (Address, Org, BU, Dept, Designation,
│   │   │                              #   Band, PayGrade, Employee, Folder, Document, Policy,
│   │   │                              #   SetupProgress, MasterDataCompact, BulkValidate/Upload)
│   │   ├── index.ts                   # Re-exports
│   │   ├── organisation.ts            # organisationService
│   │   ├── business-unit.ts           # businessUnitService (CRUD + bulk-delete; list supports is_subsidiary)
│   │   ├── departments.ts             # departmentService (CRUD)
│   │   ├── designations.ts            # designationService (CRUD; create/update carry name, description, payGradeIds)
│   │   ├── bands.ts                   # bandService
│   │   ├── paygrades.ts               # paygradeService
│   │   ├── org-documents.ts           # orgDocumentService (folders + documents + deactivateAllDocuments)
│   │   ├── employees.ts               # employeeService (CRUD + bulk template/validate/upload)
│   │   │                              #   + CtcHistoryEntryDTO; EmployeeResponseDTO carries ctcHistory[]
│   │   ├── policies.ts                # policyService (CRUD + grid + copy + copy-module-permissions + assign)
│   │   ├── address.ts                 # addressService
│   │   ├── dashboard.ts               # dashboardService (org-level stats)
│   │   └── dependency-check.ts        # dependencyCheckService (check entity dependencies before inactivation)
│   ├── external/
│   │   └── google-places.ts           # Google Places API (company search + details)
│   └── super-admin/
│       ├── types.ts                   # Super admin DTOs: ModuleKey (12 types — now matches BE ModuleEnum,
│       │                              #   incl. reports_and_analytics), OrgModule, SetupStatus,
│       │                              #   MODULE_DEFINITIONS (12 module catalog), ModuleCatalogItem,
│       │                              #   AdminInput/Update/View, OrgCreate/Update/Response/ListItem
│       │                              #   (ListItem has enabled_modules_count + active_modules_count),
│       │                              #   SuperAdminDashboardStats (with pending_setup)
│       ├── organisations.ts           # superAdminOrgService (CRUD + dashboard stats)
│       └── index.ts                   # Re-exports
│
├── hooks/
│   ├── queries/
│   │   ├── use-organisation.ts        # useOrganisations, useOrganisation
│   │   ├── use-business-unit.ts       # useBusinessUnits, useBusinessUnit
│   │   ├── use-departments.ts         # useDepartments
│   │   ├── use-designations.ts        # useDesignations
│   │   ├── use-bands.ts              # useBands
│   │   ├── use-paygrades.ts           # usePaygrades
│   │   ├── use-org-documents.ts       # useFolders, useOrgDocuments, useDeactivateAllDocuments
│   │   ├── use-employees.ts           # useEmployees, useEmployee
│   │   ├── use-policies.ts            # usePolicies, usePolicy, usePolicyPermissions
│   │   ├── use-master-data.ts         # useMasterData(category, orgId)
│   │   ├── use-lookups.ts             # useModules, useAcl, usePermissions
│   │   ├── use-module-catalog.ts      # useModuleCatalog
│   │   ├── use-super-admin-orgs.ts    # useSuperAdminOrgs
│   │   ├── use-company-search.ts      # useCompanySearch (Google Places)
│   │   ├── use-company-details.ts     # useCompanyDetails (Google Places)
│   │   ├── use-org-admins.ts          # useOrgAdmins, useCreateOrgAdmin, useToggleOrgAdminStatus
│   │   ├── use-profile.ts             # useUpdateProfile, useChangePassword
│   │   └── use-custom-fields.ts       # useCustomFieldDefinitions, useCustomFieldValues, useCreateDefinition,
│   │                                  #   useUpdateDefinition, useDeleteDefinition, useReorderDefinitions,
│   │                                  #   useCustomFieldOptions, CRUD option hooks, useUpsertValues
│   ├── use-setup-steps.ts             # Setup wizard logic (10 steps, locked/pending/completed)
│   ├── use-auth.ts                    # useAuth (login, portalLogin, logout, isAuthenticated)
│   ├── use-unsaved-guard.ts           # Prevents navigation with unsaved form changes
│   ├── use-navigation-guard.ts        # useBlocker-based navigation guard with confirm dialog + beforeunload
│   ├── use-scroll-to-error.ts         # Scrolls to first invalid field in forms (aria-invalid/data-invalid)
│   ├── use-theme.ts                   # Dark/light theme toggle with localStorage persistence
│   └── use-mobile.ts                  # Mobile viewport detection
│
├── store/
│   ├── index.ts                       # Redux store (configureStore + custom localStorage persistence)
│   └── slices/
│       ├── auth-slice.ts              # token, refreshToken, user profile, is_super_admin,
│       │                              #   is_org_admin, organisation_id, policy_ids, permissions,
│       │                              #   sessionExpired flag
│       └── organisation-slice.ts      # Org data mirror (setup_progress, enabled_modules, etc.)
│
├── lib/
│   ├── axios.ts                       # apiClient with auto-refresh interceptor (queue + retry on 401)
│   ├── permissions.ts                 # filterMenuByPermissions(menu, user) — role-based sidebar
│   ├── setup-mutation-meta.ts         # setupAffecting meta for mutation cache invalidation
│   ├── toast.ts                       # Typed toast wrappers with Axios error extraction
│   └── utils.ts                       # cn() (clsx + tailwind-merge)
│
├── contexts/
│   └── layout-variant-context.tsx     # LayoutVariantContext ('elevated' | 'flat') for shared page styling
│
├── layouts/
│   ├── AdminLayout.tsx                # Root admin layout — routes to correct sub-layout
│   ├── AuthLayout.tsx                 # Shared auth page layout (login, forgot-password, reset, activate)
│   │                                  #   Split-screen: brand panel + form panel with logo
│   ├── OrgSetupLayout.tsx             # Wizard layout for setup_status !== 'active'
│   │                                  #   WizardFooter (Back/Next/Finish Setup) + confirm dialog
│   ├── OrgSetupTopbar.tsx             # Setup-specific topbar with step navigation + theme toggle
│   ├── OrgAdminLayout.tsx             # Post-setup org admin layout (no wizard footer)
│   ├── SuperAdminLayout.tsx           # Super admin portal layout
│   ├── AppSidebar.tsx                 # Step locking via useSetupSteps, dual menu configs
│   ├── Topbar.tsx                     # SetupPill + user dropdown + logout cache clearing
│   ├── OrgBootstrap.tsx               # Org fetch + Redux mirror (guarded by token + not super admin)
│   └── menu-config.ts                 # MenuSection/MenuGroup/MenuItem types + Permission type + SETUP_STEP_PATHS
│
├── providers/
│   └── confirm-dialog-provider.tsx    # Global confirmation dialog (AlertDialog-based)
│
├── components/
│   ├── shared/
│   │   ├── SearchableSelect.tsx       # Async select with search (countries, states, cities, etc.)
│   │   ├── DatePicker.tsx             # Calendar-based date picker
│   │   ├── FileUploader.tsx           # File upload with validation (type, size)
│   │   ├── ImageUploader.tsx          # Image upload with preview (logos, photos)
│   │   ├── SecurePdfViewer.tsx        # In-app PDF renderer — pdf.js pages drawn to canvases (no browser
│   │   │                              #   PDF toolbar), progressive render, auth headers for API-served files
│   │   ├── PageLoader.tsx             # Full-page loading spinner
│   │   ├── StatusBadge.tsx            # Reusable status badge (active/inactive/pending/draft/reject/
│   │   │                              #   inprogress/open/probation/notice-period/terminated/on-bench)
│   │   ├── TablePagination.tsx        # Reusable table pagination with page size selector
│   │   ├── TanStackFieldWrapper.tsx   # TanStack Form field adapter for shadcn/ui
│   │   ├── CustomFieldBuilderDialog.tsx # Dynamic custom field definition builder
│   │   ├── CustomFieldRenderer.tsx    # Renders custom fields based on definitions
│   │   ├── OrgAdminsManager.tsx       # Multi-admin management (list, add, toggle status)
│   │   └── SessionExpiredModal.tsx    # Global modal for expired session (sessionExpired Redux flag)
│   └── ui/                            # shadcn/ui primitives (30+ components)
│
├── modules/
│   ├── org-setup/
│   │   ├── route-guards.ts            # requireSetupPrereq (setup_progress check via loader)
│   │   ├── routes.tsx                 # All org-admin routes (lazy-loaded pages)
│   │   │                              #   Includes: /settings/modules, /settings/org-admins,
│   │   │                              #   /settings/custom-permissions (placeholder),
│   │   │                              #   /timesheet (placeholder), /leave-management (placeholder)
│   │   ├── menu-config.ts             # Wizard sidebar + post-setup sidebar configs
│   │   ├── wizard-tab-context.tsx     # WizardTabContext for multi-tab step pages
│   │   ├── types/                     # FE-side type definitions per entity
│   │   │   ├── organisation.ts        # Zod schema + OrganisationFormValues
│   │   │   ├── business-unit.ts       # Zod schema + BusinessUnitFormValues
│   │   │   ├── department.ts          # DepartmentFormValues + status types
│   │   │   ├── departmentModel.ts     # Zod schema for department dialog
│   │   │   ├── designation.ts         # Designation type
│   │   │   ├── band.ts               # Band type
│   │   │   ├── paygrade.ts            # PayGrade type
│   │   │   ├── employee.ts            # Full EmployeeFormValues (10 sections including bank details)
│   │   │   ├── org-documents.ts       # Folder + Document types + FolderAccess
│   │   │   ├── organization-head.ts   # Zod schema for assign-head form
│   │   │   └── policy.ts             # Policy + PermissionMatrix types
│   │   └── pages/
│   │       ├── Dashboard.tsx          # Org admin dashboard with setup progress
│   │       ├── Home.tsx               # Landing/redirect page (super admins → /super-admin)
│   │       ├── ModuleManagement.tsx   # Module activation toggle page (org admin)
│   │       ├── OrgAdmins.tsx          # Org admin management page (uses OrgAdminsManager)
│   │       ├── Organisation/          # Organisation details form
│   │       ├── BusinessUnit/          # BU list + form (with address, master data selects)
│   │       ├── Departments/           # Department list + dialog (multi-BU select)
│   │       ├── Designations/          # Designation list + form — job title only now
│   │       │   ├── DesignationsPage.tsx     # List page
│   │       │   ├── DesignationsLayout.tsx
│   │       │   └── DesignationForm.tsx      # Create/edit (name, description, payGradeIds) —
│   │       │                                #   no department / hierarchy / permission grid anymore
│   │       ├── Bands/                 # Band list + dialog
│   │       ├── PayGrades/             # Pay grade list + dialog
│   │       ├── OrgDocuments/          # Folder tree + document upload + drop upload + in-app viewer
│   │       │   ├── OrgDocumentsPage.tsx     # + view action per document, live per-file upload progress
│   │       │   │                            #   dialog for direct drag-drop, drop-guard while dialogs open
│   │       │   ├── FolderDialog.tsx
│   │       │   ├── DocumentDialog.tsx       # allow_download opt-in (default off), per-file upload status
│   │       │   ├── DocumentViewSheet.tsx    # Right sheet viewer — PDF via SecurePdfViewer, CSV table
│   │       │   │                            #   preview; Word/Excel → "download to read"; bytes fetched
│   │       │   │                            #   from GET /org-documents/documents/{id}/content with JWT
│   │       │   └── DropUploadDialog.tsx     # Multi-file upload with per-file live status (uploading/
│   │       │                                #   done/failed via onItem callback), stopPropagation drop fix
│   │       ├── Employees/             # Employee list + multi-section form + bulk upload
│   │       │   ├── EmployeesListPage.tsx  # designation filter fetches limit 1000; horizontal-scroll table
│   │       │   ├── EmployeeForm.tsx   # 10-section accordion form; full-screen loader while the record
│   │       │   │                      #   loads in edit/view mode; passes ctcHistory to WorkInfo
│   │       │   ├── BulkUploadDialog.tsx # XLSX template download + validate + selective upload
│   │       │   ├── SectionCustomFields.tsx
│   │       │   └── sections/
│   │       │       ├── BasicDetails.tsx
│   │       │       ├── WorkInfo.tsx   # BU + employment type locked on edit (emp_code derived from them);
│   │       │       │                  #   CTC revision history panel; designation/manager selects fetch limit 1000
│   │       │       ├── PersonalDetails.tsx
│   │       │       ├── IdentityInfo.tsx
│   │       │       ├── ContactAddress.tsx
│   │       │       ├── EmergencyContacts.tsx
│   │       │       ├── WorkExperience.tsx
│   │       │       ├── DependentDetails.tsx
│   │       │       ├── EducationDetails.tsx
│   │       │       └── BankDetails.tsx    # Bank details section (account holder, number, IFSC, bank name)
│   │       │                          # NOTE: roles (is_role=true policies) are managed independently and
│   │       │                          #   assigned directly to employees (role select in the employee form /
│   │       │                          #   Role column in bulk upload). Designations no longer own a policy.
│   │       │                          #   policies.ts / use-policies.ts / types/policy.ts back the role CRUD + grid.
│   │       └── OrganizationHead/      # Assign org/BU/dept heads (employee select fetches limit 1000)
│   ├── audit-logs/                    # Org-admin audit log viewer (menu group + routes + AuditLogsPage);
│   │                                  #   wired into the post-setup sidebar as an "Audit" section
│   └── super-admin/
│       ├── routes.tsx                 # Super admin routes (dashboard, orgs)
│       ├── menu-config.ts             # Super admin sidebar config
│       ├── components/
│       │   └── ModuleSelector.tsx     # Module picker with mandatory enforcement
│       └── pages/
│           ├── Dashboard/             # Super admin dashboard with stats (pending_setup)
│           └── Organisations/
│               ├── OrgsListPage.tsx   # Organisation list with filters
│               ├── AddOrganisation.tsx # Add org + admin form
│               └── EditOrganisation.tsx # Edit org + admin (email change flow)
│
├── pages/
│   ├── Login.tsx                      # Login page (dual portal: super admin + org admin)
│   ├── ForgotPassword.tsx             # Email input → POST /auth/forgot-password → success message
│   ├── ResetPassword.tsx              # Token from URL search params → new password form → POST /auth/reset-password
│   ├── ActivateAccount.tsx            # Token from URL → POST /auth/activate → auto-redirect to reset-password
│   │                                  #   Shows loading → success (countdown to redirect) → or error state
│   ├── Profile.tsx                    # Self-service profile page with tabs:
│   │                                  #   Profile Details (name, phone, DOB, gender, marital_status)
│   │                                  #   + Change Password (current + new password)
│   └── Settings.tsx                   # Tabbed settings page (Modules + Org Admins tabs)
│
└── types/
    ├── company.ts                     # CompanySuggestion, CompanyData (Google Places)
    └── custom-fields.ts               # CustomFieldType (12 types), EntityType, SectionType, FileSettings,
                                       #   CustomFieldDefinition, CustomFieldOption, CustomFieldValue,
                                       #   FieldWithValue, EntityValuesResponse, DTOs (Definition/Option/Value CRUD)
```

---

## 5. TWO-PORTAL ARCHITECTURE

### 5.1 Super Admin Portal

Creates and manages orgs. Slimmed response — only fields the super admin controls.

**Login:** `POST /auth/portal/login` — rejects non-super-admins with 403 (checked AFTER password verification to prevent timing attacks).

**Create:** legal_name + admin contact (name/email/phone) + enabled modules (list of OrgModule with code + is_active) + setup_status (draft/pending/active) + is_multiple_business_units → OrganisationDocument + UserDocument (is_org_admin) + setup_progress initialized + optional activation email.

**Response:** `id`, `legal_name`, `logo_asset_id`, `is_active`, `enabled_modules` (list of OrgModule), `administrator` (resolved from UserDocument with pending_email), `created_on`, `modified_on`

**List response:** `id`, `legal_name`, `is_active`, `setup_status`, `enabled_modules_count`, `active_modules_count`, `created_on`

**List filters:** `is_active`, `search`, `setup_status`, `skip`, `limit` (API-side)

**Dashboard stats (super admin):** `total_organisations`, `active_organisations`, `inactive_organisations`, `pending_setup`, `total_users`

**Dashboard stats (org admin):** `total_employees`, `total_business_units`, `total_departments`, `enabled_modules`

**Headcount snapshot (`GET /dashboard/headcount-snapshot`):** Org admin (gated by `require_permission("core_hr", "create_resource")` + org context). Returns `active_employees` (not soft-deleted, not exited by date — no `date_of_exit` or one still in the future — AND not in an inactive employment status; both signals must agree because source data often has one without the other), `new_joiners_this_month` (`date_of_joining` ≥ start of current month), `in_progress_exits` (`ExitRequestDocument` in an in-progress status).

**Birthdays & anniversaries (`GET /dashboard/birthdays`):** Any authenticated user with an org context. Returns `{ today: BirthdayItem[], upcoming: BirthdayItem[] }` over active org members, mixing two event types — birthdays (from `UserDocument.dob`) and work anniversaries (from `EmployeeDocument.date_of_joining`; only ≥1 completed year, exited employees skipped). Each `BirthdayItem`: `user_id`, `name`, `date` (next-occurrence ISO), `days_until`, `type` (`"birthday"` | `"anniversary"`), `years` (anniversaries only). `upcoming` is the next 7 soonest across both types. Feb 29 maps to Feb 28 on non-leap years.

**Admin email change:** Double opt-in — queues confirmation link to NEW address via `initiate_email_change`. Old email stays active until confirmation clicked.

### 5.2 Org Admin Portal

10-step setup wizard → Finish Setup → regular portal.

| # | Step | Mandatory | BE Prerequisites (setup_progress) | FE Prerequisites (sidebar lock) |
|---|------|-----------|-----------------------------------|----------------------------------|
| 1 | Organisation | Yes | — | — |
| 2 | Business Units | Yes | Organisation | Organisation |
| 3 | Departments | Yes | Business Units | Business Units |
| 4 | Org Documents | No | Departments | Organisation |
| 5 | Policies | Yes | Departments | Departments |
| 6 | Designations | No | Departments | Departments |
| 7 | Bands | No | Organisation | Organisation |
| 8 | Pay Grades | No | Bands + Designations | Bands + Designations |
| 9 | Employees | No | Departments + Designations + Policies | Policies |
| 10 | Assign Head | No | Employees | Policies |

> **Note:** BE and FE prerequisites diverge for Org Documents (BE: Departments, FE: Organisation), Employees (BE: Departments + Designations + Policies, FE: Policies), and Assign Head (BE: Employees, FE: Policies). The BE controls the stored `setup_progress` state; the FE controls sidebar link locking independently. The `policies` step is satisfied only by a **role** (`is_role=true` policy) — a plain permission policy doesn't count.

Wizard footer: Back | Next | Finish Setup (green, when all mandatory done)

**Post-setup pages:** Module Management (toggle modules), Org Admins (manage multiple admins), Audit Logs (org-admin audit trail viewer under an "Audit" sidebar section), "Modules" section with Time Sheet and Leave Management placeholders.

**Three layout shells:**
- `OrgSetupLayout` — wizard with Back/Next/Finish footer (setup_status !== 'active')
- `OrgAdminLayout` — post-setup dashboard (setup_status === 'active')
- `SuperAdminLayout` — super admin portal

---

## 6. SETUP PROGRESS TRACKING

Stored on `OrganisationDocument.setup_progress: dict[str, str]`.

**10 steps tracked:** `organisation`, `business_units`, `departments`, `org_documents`, `policies`, `designations`, `bands`, `pay_grades`, `employees`, `assign_head`.

**States:** `locked` | `pending` | `completed`

**Organisation completed when:** `address_id`, `date_of_incorporation`, `currency`, `timezone` all filled.

**Assign head completed when:** `OrganisationDocument.head_user_id` is set.

**Other steps completed when:** at least one active (non-deleted) record exists for that entity. For `policies` the record must be a **role** — a `PolicyDocument` with `is_role=true` (a default/permission-only policy does not satisfy the step).

**Refresh triggers:** entity create/delete, org update, tenancy create, policy create/delete.

**No cascade-lock:** deleting last BU → `business_units: "pending"`, departments stay `"completed"`.

**Parallel computation:** `refresh_setup_progress` uses `asyncio.gather` to check all entity collections concurrently.

**FE:** `useSetupSteps()` → sidebar locking, route guards, SetupPill, WizardFooter.

**FE auto-refresh:** `setupAffecting` mutation meta in `MutationCache.onSuccess` → invalidates organisation query → sidebar updates automatically.

---

## 7. AUTHENTICATION & SESSION MANAGEMENT

### 7.1 Login Flow

1. `POST /auth/login` (org) or `POST /auth/portal/login` (super admin)
2. Verify email/password → check auth_method (local/seeded vs azure_sso)
3. Check account status (active required)
4. Check password expiry (90 days configurable, skip for seeded first login)
5. Issue JWT access token (15 min) + signed JWT refresh token (7 days)
6. Create Valkey session: `session:rt:<hash>` + `user:sessions:<user_id>` set
7. Create user session: `session:<access_token>` → full user context + resolved permissions
8. Update `last_login_at` on UserDocument
9. Audit log via outbox

### 7.2 Token Architecture

- **Access token:** JWT (HS256), `sub=email`, `uid=user_id`, 15 min TTL
- **Refresh token:** JWT (HS256), `sub=user_id`, `typ=refresh`, `jti=uuid4`, 7 day TTL
- **Activation token:** JWT + Valkey entry, `typ=activation`, 72 hour TTL. Activation email also embeds a password-reset link as a fallback (same 72h TTL).
- **Password reset token:** JWT + Valkey entry, `typ=password_reset`, 30 min TTL
- **Email change token:** JWT + Valkey entry, `typ=email_change`, 24 hour TTL, stores `{user_id, new_email}`

All tokens use defence-in-depth: JWT signature verified first, then Valkey entry checked for single-use/revocation.

### 7.3 User Session (Valkey)

Key layout:
- `session:<access_token>` → JSON payload (user context + permissions grid)
- `user:access_tokens:<user_id>` → SET of access tokens (for bulk revoke)
- `session:rt:<hash>` → refresh token session data
- `user:sessions:<user_id>` → SET of refresh token hashes

Permissions grid shape:
```json
{
  "permissions": {
    "<module>": {
      "acl": "admin" | "editor" | "viewer",
      "actions": { "create": bool, "read": bool, "update": bool, ... }
    }
  }
}
```

Super/org admins get a full grid (every module × every action = true). The `_full_grid()` function iterates all 11 ModuleEnum values and their module-specific actions via `MODULE_PERMISSIONS`.

### 7.4 Password Policy

- Expiry: 90 days (configurable via `PASSWORD_EXPIRY_DAYS`)
- History: last 5 passwords checked (configurable via `PASSWORD_HISTORY_COUNT`)
- On change/reset: revoke ALL sessions (refresh + access token caches)
- Password-history checked against `PasswordHistoryDocument` collection

### 7.5 Azure AD SSO

MSAL ConfidentialClientApplication → auth code flow → auto-provision user on first SSO login.

### 7.6 Account Activation Flow

1. Super admin creates org → admin user created with `status=inactive`
2. Activation email sent with activation token + embedded password-reset link (fallback)
3. User clicks activation link → `POST /auth/activate` → account activated, returns `password_reset_token`
4. FE (`ActivateAccount.tsx`) receives token → countdown → auto-redirect to `/reset-password?token=...`
5. User sets password via reset flow

### 7.7 FE Session Management

- **Login:** clear Redux org + React Query cache → set tokens → OrgBootstrap fetches fresh
- **Logout:** `POST /auth/logout` (with refresh_token, optional all_devices) → clear Redux + React Query + localStorage → navigate to /login
- **OrgBootstrap:** guarded by token + not super admin. QueryFn double-checks token.
- **Token refresh:** Axios interceptor with queue + retry on 401 (skips /auth/ routes)
- **Session expired modal:** `SessionExpiredModal` component shown when `sessionExpired` Redux flag is set
- **Forgot Password:** `/forgot-password` page → email input → POST /auth/forgot-password → success message (no email enumeration)
- **Reset Password:** `/reset-password?token=...` page → validates token presence → new password + confirm → POST /auth/reset-password
- **Profile page:** `/profile` route — tabs for profile details (name, phone, DOB, gender, marital_status) + change password

---

## 8. INTER-SERVICE COMMUNICATION

### 8.1 Exchanges

| Exchange | Type | Purpose |
|----------|------|---------|
| `domain_events` | Topic | Business events |
| `audit_events` | Topic | Audit trail |
| `email_events` | Topic | Email triggers |

### 8.2 Transactional outbox

All messages go through `src/rabbitmq/outbox.py`:
1. Persist to `outbox_events` (status: `pending`)
2. Eager publish (best-effort)
3. Relay loop (5s interval, batch 50, max 10 retries) drains failures

### 8.3 Domain event routing keys

`organisation.created`, `organisation.updated`, `organisation.deleted`,
`business_unit.created`, `business_unit.deleted`,
`department.created`, `department.deleted`,
`designation.created`, `designation.updated`, `designation.deleted`,
`band.created`, `band.updated`, `band.deleted`,
`pay_grade.created`, `pay_grade.updated`, `pay_grade.deleted`,
`document_folder.created`, `document_folder.updated`, `document_folder.deleted`,
`org_document.created`, `org_document.updated`, `org_document.deleted`,
`employee.created`, `employee.updated`, `employee.deleted`,
`policy.created`, `policy.deleted`,
`user.created`

**Employee event payload note:** Both `employee.created` and `employee.updated` payloads now include `date_of_joining` so downstream consumers (Leave Management Service, Timesheet, SRM) can compute accruals and tenure without an extra IAM round-trip.

**Other payload notes:** `organisation.*` payloads include `head_user_id`; `designation.created`/`.updated` include `department_id` + `pay_grade_ids`; band / pay-grade / folder / document events carry their id, org id, name/title and (for updates) `changed_fields`.

### 8.4 Email event routing keys

`email.activation`, `email.password_reset`, `email.email_change`,
`email.exit_request_raised`, `email.exit_manager_approved`, `email.exit_manager_rejected`,
`email.exit_clearances_initiated`, `email.exit_clearances_assigned`, `email.exit_completed`

### 8.5 Audit logging

Every mutation calls `publish_audit_log(module, actor_id, action, resource, debug_level, metadata)`.
DebugLevel: EMPLOYEE(1), MANAGER(2), HR(3), ADMIN(4).

Actions logged: `created`, `updated`, `deleted`, `bulk_deleted`, `bulk_uploaded`, `permissions_updated`, `login`, `password_changed`, `activated`, `document_acknowledged` (EMPLOYEE level).

### 8.6 Message envelope

Headers: `idempotency_key`, `correlation_id`.
Consumers MUST deduplicate via `idempotency_key`.

### 8.7 Correlation ID

`X-Correlation-ID` header per request → stored on AuditMixin, outbox events, RabbitMQ headers.
Middleware generates UUID4 if not provided by client. Exposed via `expose_headers=["X-Correlation-ID"]` CORS setting.

---

## 9. MASTER DATA

15 categories: SECTORS, BUSINESS_TYPES, BUSINESS_NATURES, WORKER_TYPES,
CLASS_LABELS, FREQUENCIES, EMPLOYMENT_TYPES, EMPLOYMENT_STATUSES,
PROJECT_STATUSES, SOURCES_OF_HIRE, GENDERS, MARITAL_STATUSES, RELATIONSHIPS,
EMPLOYMENT_SOURCES, HIERARCHY_ROLES.

All stored as `PydanticObjectId`. Resolved via `$lookup` → `MasterDataCompact { id, category, key, value, is_active }`.
FE: `useMasterData(category, orgId)` → `{ label, value: id }`.
Custom entries: `is_custom: true`, `organisation_id` set. Global deletion forbidden (403).

**Active-flag exposure:** `MasterDataCompact` carries `is_active: bool` (alias `isActive`) so downstream consumers can hide retired entries without an extra fetch.

**List endpoint filter:** `GET /master-data` accepts `include_inactive: bool = False` — default still hides inactive entries; pass `?include_inactive=true` to retrieve all.

**JSON-driven seeding:** Categories are derived from filenames under `src/master_data/data/*.json`. Each entry can specify `isActive` explicitly (honoured by `seed_master_data.py`).

**Recent category-level changes:**
- `employment_types.json` pruned from 9 to **3 entries** — `full-time`, `contract`, `internship` (aligns with new F/C/I emp-code letter map)
- `employment_statuses.json` now holds **lifecycle** statuses only. Active: `notice-period`, `probation`, `permanent`, `direct-contract`, `third-party-contract`. Inactive: `absconded`, `exit`, `retired`, `terminated`.
- `project_statuses.json` — **new** PROJECT_STATUSES category, split out of EMPLOYMENT_STATUSES. Holds **allocation/resourcing** states: `allocated-to-project`, `bench`, `long-leave` (all active). An employee carries both an `employment_status` (lifecycle) and a `project_status` (allocation).
- `hierarchy_roles.json` — `leadership` removed. Remaining: `cxo`, `manager`, `employee`.

**Usage in entities:**
- BU: sector, type_of_business, nature_of_business
- Designation: none (department/hierarchy_role were removed from the form; `HIERARCHY_ROLES` is no longer consumed by any active entity)
- Band: class_label, frequency
- Employee: employment_type, employment_status, project_status, source_of_hire, gender, marital_status

---

## 10. LOCATION DATA

Three seeded collections: `countries`, `states`, `cities` (from scripts/seed_locations.py).

Endpoints:
- `GET /master-data/countries` — search by name, paginated
- `GET /master-data/countries/{id}` — single country
- `GET /master-data/states` — search by name, filter by country_id/country_name
- `GET /master-data/states/{id}` — single state
- `GET /master-data/cities` — search by name, filter by state/country
- `GET /master-data/currencies` — filter by country
- `GET /master-data/timezones` — filter by country

FE uses cascading SearchableSelect components: Country → State → City.
Currency and timezone auto-suggested based on selected country.

---

## 11. PERMISSIONS & POLICIES

`PolicyDocument` + `ModuleAclPermissionDocument` (junction: policy × module × acl_role × permission).

**12 modules** (ModuleEnum): core_hr, attendance_management, leave_management, payroll, performance_management, recruitment, training_and_development, expense_management, asset_management, service_request, timesheet_management, **reports_and_analytics**.

**MODULE_LABELS:** Display label mapping for all 12 modules (e.g., `SERVICE_REQUEST → "Service Request"`, `REPORTS_AND_ANALYTICS → "Reports & Analytics"`).

**3 roles** (AclRoleEnum): admin, editor, viewer — with numeric ranks (10/20/30) from seeded AclDocument.

**36 permission codes** (PermissionCodeEnum):
- 6 generic: create, read, update, delete, export, create_resource
- 6 Core HR (exit management): apply_exit_request, approve_exit_request, monitor_exit_request, it_clearances, admin_clearances, final_settlement
- 7 Timesheet Management: my_timesheet, manage_timesheet, client_timesheet, manage_clients, manage_projects, manage_settings, view_reports
- 9 Leave Management: holiday_plan, leave_plan, work_calendar, leave_configuration, leave_types, leave_request, manage_leave_request, **leave_balance**, **approve_as_hr** (dedicated HR capability — enforced by the Leave service for plans with allow_hr_to_act / allow_hr_to_view)
- 7 Service Request: raise_request, execute_request, approve_request, manage_request, view_all_requests, manage_catalog, manage_workflows
- 1 Reports & Analytics: **reports**

**PERMISSION_LABELS:** Per-(module, code) display label dict for UI rendering. Generic codes fall back to `_GENERIC_LABELS`. Unknown codes fall back to title-cased value.

**MODULE_PERMISSIONS mapping:** Each module lists its valid codes. Core HR gets create_resource + 6 exit management codes (7 total). Leave Management gets 9 feature-specific codes (including `leave_balance` + `approve_as_hr`). Timesheet Management gets 7 feature-specific codes. Service Request gets 7 feature-specific codes. Reports & Analytics gets 1 code (`reports`). Other modules (Attendance, Payroll, Performance, Recruitment, Training, Expense, Asset) get create_resource only.

**Service request permission migration:** `scripts/migrate_service_request_permissions.py` (one-shot, idempotent) splits the legacy `service_request:create_resource` grant into the 7 new role-based codes. Steps: (1) upsert 7 `PermissionDocument` rows for SERVICE_REQUEST, (2) for every `module_acl_permissions` row matching `(service_request, create_resource)`, insert 7 new rows under the same `(policy_id, acl_id)`, (3) hard-delete the legacy SR `create_resource` rows. Reports `found / inserted / skipped / deleted_legacy` counts.

`UserDocument.policy_ids` binds users to policies (multiple policies per user). For employees these are **assigned directly** via `EmployeeCreate`/`EmployeeUpdate.policy_ids` (alias `roleIds`) — the employee service writes them straight onto `UserDocument.policy_ids` (see §13). Org admins and non-employee users can also have policies attached directly via `POST/DELETE /users/{user_id}/policies/{policy_id}`.

`OrganisationDocument.enabled_modules` — list of `OrgModule(code, is_active)`. Core HR mandatory (validated in schema). Org admins can toggle `is_active` but not add/remove modules (403 if codes differ). Only super admins can modify the module list.

**Policy `is_role` flag:** Boolean to distinguish role-based policies from regular permission policies. Separate list endpoint `GET /policies/roles` returns only `is_role=True` policies.

**Roles (`is_role=True` policies) are standalone, employee-assigned:** Roles are created independently via `POST /policies` (`is_role=True` + a `permissions` grid), listed via `GET /policies/roles`, and assigned **directly to employees** through `roleIds` on employee create/update. Designations no longer own or create policies (that model was removed — see §16). The FE surfaces `is_role=True` policies as **roles**; the bulk-upload template exposes them as a mandatory **Role** column resolved by name.

**Policy creation options:**
1. `seed_module_codes` — auto-generates default grid (admin=all module-valid codes, editor=read+update, viewer=read)
2. `permissions` dict — explicit grant grid takes precedence over seed
3. Neither — empty policy, grants added via grid editor later

**Policy copy:** `POST /policies/{id}/copy` — clones policy + all grant rows with new name.

**Copy module permissions:** `POST /policies/{id}/copy-module-permissions` — copies specific module grants from source policy into target (replaces those modules, keeps others untouched).

**List by module:** `GET /policies/by-module/{module_id}` — policies with at least one grant on that module.

**Permission resolution:** OR'd across policies; highest role rank wins per module. Role ranks loaded from AclDocument collection (with fallback: viewer=10, editor=20, admin=30).

**Cache invalidation:** On policy update/delete/permissions change → find all users with that policy_id → delete their Valkey access-token sessions (forces re-resolution on next request). Best-effort — one bad user doesn't abort the mutation.

**Policy inactivation dependency check:** Cannot inactivate a policy if users are assigned to it (409 with user count).

**IAM-internal modules:** `users`, `policies`, `dashboard`, `tenancy` — admin-only by construction, bypass grid.

**require_any_module_admin:** Authorization dependency that allows super/org admins and users who hold admin ACL on at least one module. Used for the `/policies/roles` endpoint.

**Presence-based grants:** Row exists = permission granted. Removing a grant soft-deletes the row. `replace_policy_grants` does a minimal diff (soft-delete removed rows, insert new ones).

---

## 12. USER MODEL

`UserDocument` fields:
- `email` (unique), `password_hash`, `auth_method` (local/seeded/azure_sso), `azure_oid`
- `first_name`, `last_name`, `middle_name`
- `phone`, `work_phone`, `work_phone_extension`
- `avatar_url`, `dob` (datetime), `gender` (ObjectId), `marital_status` (ObjectId)
- `status` (active/inactive), `pending_email`
- `is_super_admin`, `is_org_admin`, `organisation_id`
- `policy_ids` (list[ObjectId])
- `last_login_at`, `password_changed_at`
- AuditMixin fields (created_by/on, modified_by/on, deleted_by/on, correlation_id)

**Indexes:** unique email, unique partial azure_oid, organisation_id.

**User management routes:** `/users` — CRUD, search, attach/detach policies (`POST/DELETE /{user_id}/policies/{policy_id}`). Org-scoped for non-super-admins. List filters: `is_org_admin`, `organisation_id`, `skip`, `limit`.

**Profile:** `/auth/me` (GET/PUT), `/auth/me/profile-photo` — self-service profile editing. MeResponse includes `avatar_asset_id` and resolved `permissions` dict.

**Session department context:** On login, the access-token session payload (stored at `session:<access_token>` in Valkey) is enriched with the user's `department_id` looked up from `EmployeeDocument` (`user_id == user_oid`, `deleted_on == None`). Downstream microservices (Service Request / "Employee Requests") read it from the session to scope department-aware views without an extra IAM round-trip. Lookup failures are logged as `session.dept_lookup.failed` (warning) and the session is still issued (non-fatal). Signature: `build_session_payload(user_doc, permissions=None, department_id: str|None=None)`.

**Multi-admin management:** Orgs can have multiple org admins. FE uses `OrgAdminsManager` component (via `/users` API with `is_org_admin=true` filter) to list, create, and toggle status of org admins. New admins get `send_activation=true`.

---

## 13. EMPLOYEE MODEL

`EmployeeDocument` — the richest document, 10 form sections + compensation:

1. **Basic Details:** emp_code (server-generated `{PREFIX}-{F|C|I}-{N}`), linked user_id
2. **Work Info:** business_unit_id, department_id, designation_id, source_of_hire, l1/l2_manager_id, employment_type, employment_status (lifecycle), project_status (allocation — Allocated to Project / Bench / Long Leave), date_of_joining/exit, current/total_exp
3. **Personal Details:** about_me (dob/gender/marital_status on UserDocument)
4. **Bank Details:** bank_details embedded (account_holder_name, account_number, ifsc_code, bank_name)
5. **Identity Info:** identity_fields (dynamic label/value pairs, e.g. PAN, Aadhaar)
6. **Contact:** personal_phone, personal_email, seat_location (work_phone/work_phone_extension on UserDocument)
7. **Address:** permanent_address_id, present_address_id, same_as_permanent
8. **Emergency Contacts:** embedded list (contact_name, contact_number, relationship) — at least 1 required for single create
9. **Work Experience:** embedded list (company_name, job_title, from/to_date, job_description, relevant)
10. **Dependents + Education:** embedded lists (name/relationship/dob, institute/degree/specialization/date)
11. **Compensation:** `ctc` stored as a number-keyed **version map** `{"1": {value(fernet), currency, updated_on}, ...}` — highest key is the current CTC, each amount Fernet-encrypted at rest. Responses return `ctc` (current, decrypted float, no role-based redaction), `currency` (ISO code, validated against `location_tools.list_currencies()`), and `ctc_history` (prior revisions oldest→newest, each `{amount, currency, updated_on}` decrypted).

**CTC revision flow:** create builds the map via `build_ctc`; update goes through `revise_ctc` — a new version is appended **only when the amount or currency actually changes** (no-op otherwise); clearing the amount keeps existing history untouched. Legacy rows (single Fernet string, or a list) are coerced into the map by the `_coerce_ctc` Beanie pre-validator.

**Mandatory create fields:** `business_unit_id`, `department_id`, `employment_type` — HTTP 400 if missing. The "draft without BU" branch has been removed.

**Immutable after create:** `business_unit_id` and `employment_type` — the emp_code is derived from both and never regenerated, so an actual value change returns HTTP 400 (same-value no-ops pass). The FE disables both selects in edit mode with an explanatory hint.

**Roles/policies:** assigned **directly to the employee** via `policy_ids` (alias `roleIds`) on `EmployeeCreate`/`EmployeeUpdate`. On create the service copies them onto `UserDocument.policy_ids`; on update, when `roleIds` is provided, it replaces the user's `policy_ids`. Roles are `is_role=True` policies created separately (see §20) — they are **not** derived from the designation.

**Response enrichment:** business_unit_name, department_name, designation_name, l1_manager_name/email/emp_code, l2_manager_name/email/emp_code, policies (list of PolicyCompact: id + name), custom_fields (list of FieldWithValue), bank_details, ctc (decrypted), source_of_hire/employment_type/employment_status/project_status/gender/marital_status as MasterDataCompact.

**emp_code generation:** Full-time codes omit the type letter — `{BU.emp_code_prefix}-{number}` (e.g. `SIL-0001`); contract and internship keep it — `{BU.emp_code_prefix}-{C|I}-{number}`. The letter ∈ `{F, C, I}` is resolved from the employment_type master-data key (`full-time` → F, `contract` → C, `internship` → I; 400 if unsupported) and still drives the per-type counter even when omitted from the code. `number = BU.emp_code_start_from[LETTER] + counter − 1`, where `counter` is the atomic per-type `$inc` on `emp_code_last_numbers.{letter}` (starts at 1). So **`emp_code_start_from` is the first code** (start_from `5000` → first employee is `5000`). The number is zero-padded to `BU.emp_code_padding[LETTER]` width when that width > 0 (e.g. width 3 → `006`); width 0/unset → no padding. On user/employee/address insert failure, `_rollback_emp_code` decrements the counter. See §14 for how start/padding are derived from the `empCodeStartFrom` digit strings.

**Manager validation rules:** L1 and L2 managers are **both optional** (the hierarchy-role requirement was removed along with `hierarchy_role`). Any provided L1/L2 must exist in the org and must not be the employee themselves (self-reference blocked, HTTP 400).

**Create atomicity:** Address docs → User doc → Employee doc. On failure at any step, all prior docs are rolled back (deleted).

**List filters:** `business_unit_ids` (comma-separated multi), `department_ids` (comma-separated multi), `designation_ids` (comma-separated multi), `employment_status` (ObjectId OR magic strings `"active"` / `"inactive"` — resolves all matching master-data rows by `is_active` flag), `project_status` (ObjectId), `employment_type_id`, `search` (by emp_code, email, first/last name), `has_policies`, `skip`, `limit` (max raised to **1000** — FE selects that resolve IDs to labels fetch the whole org).

**List ordering & join safety:** the list pipeline `$sort`s by `emp_code` before `$skip`/`$limit` (deterministic pagination), and the L1/L2 manager → employees `$lookup` is a pipeline join capped to **one live doc** (`deleted_on: None` + `$limit 1`) — `user_id` is not unique in data, and an uncapped join + `$unwind` after pagination would duplicate rows and over-fill pages.

**Employment-status / user-status sync:** When `employment_status` changes on update, `UserDocument.status` is synchronised to `ACTIVE` / `INACTIVE` based on the resolved master-data `is_active` flag. Creating an employee with an inactive status skips the activation email.

**Bulk upload:**
1. `GET /employees/bulk-template` — XLSX with:
   - 36 columns, **11 required** (first_name, last_name, work_email, business_unit, department, designation, role, employment_type, reporting_manager, gender, marital_status); `project_status` is an optional column
   - Cascading dropdown: BU → Department (Excel INDIRECT formulas via hidden sheets). Designation is org-level → flat dropdown (no department cascade)
   - Cascading dropdowns: country → state → city
   - Master data dropdowns from org's active records (employment_type, employment_status, project_status, source_of_hire, gender, marital_status)
   - Manager dropdown ("Name - email - empCode" label, but matched by the **email portion only** — `extract_manager_email` pulls the email; names are ambiguous)
   - **Role** dropdown — `is_role=True` policies for the org (resolved by name to a single `roleId`)
   - Hover-tooltip Comments on instruction cells + text formatting for date_of_joining/dob/date_of_exit
2. `POST /employees/bulk-validate` — parse + validate → per-row results with status (valid/error/duplicate/empty)
   - Validates: required fields, date formats (8 supported), email/phone/PAN/Aadhaar format, BU↔Dept link, designation + role resolved by name within org, country names, master data resolution (lenient via `normalize_md_value`), manager lookup (by email only), duplicate email (intra-file + vs DB)
   - Intra-batch manager resolution (rows referencing other rows as managers)
3. `POST /employees/bulk-upload?selected_row_nums=[2,3,5]` — insert selected valid rows
   - Second pass: resolve intra-batch manager references after all rows inserted
   - 5MB file size limit, supports CSV and XLSX

---

## 14. BUSINESS UNIT MODEL

`BusinessUnitDocument` fields:
- `organisation_id`, `head_user_id` (employee ObjectId for BU head)
- `business_unit_name` (unique per org, case-insensitive)
- `emp_code_prefix` (unique per org, uppercase, 1-10 chars)
- `emp_code_last_number` (legacy counter — retained for backward compatibility)
- `emp_code_last_numbers: dict[str, int]` — per-type counters keyed `"F"` / `"C"` / `"I"` (full-time / contract / internship)
- `emp_code_start_from: dict[str, int]` — per-type **first code** keyed `"F"` / `"C"` / `"I"` (stored as a plain int)
- `emp_code_padding: dict[str, int]` — per-type zero-pad width keyed `"F"` / `"C"` / `"I"` (e.g. `{"F": 3}` → `006`; 0/unset → no padding)
- `address_id` (embedded address created alongside BU)
- `ein`, `date_of_incorporation`, `financial_year`
- `currency`, `time_zone`, `time_format`
- `sector`, `type_of_business`, `nature_of_business` (master data ObjectIds)
- `is_subsidiary` (bool, default False; alias `isSubsidiary`) — FE-only distinction, behaves like a normal BU
- `is_active`

**`empCodeStartFrom` is a digit string per type** (`EmpCodeStartFrom { fullTime, contract, internship }`, each `"\d{1,7}"`). **Leading zeros are significant** and define the zero-pad width: `"006"` → first code `006` (width 3, e.g. `SIL-006` full-time / `SIL-C-006` contract); `"1"` → first code `1` (no padding); `"0001"` → `0001`. On persist, `_split_start_from` splits each string into a number (→ `emp_code_start_from`) and a pad width (→ `emp_code_padding`, set only when the string has a leading zero). The response rebuilds the padded strings via `_format_start_from`.

**Response enrichment:** $lookup for address, head employee (name + emp_code via employee→user join), sector/type_of_business/nature_of_business as MasterDataCompact, custom_fields as list[FieldWithValue], `emp_code_start_from: EmpCodeStartFromResponse { F, C, I }` (padded digit strings), `has_employees: bool` (computed via $lookup on `employees` with `$limit: 1`).

**Uniqueness:** Both `business_unit_name` and `emp_code_prefix` are unique per org (case-insensitive check, prefix stored uppercase).

**List filters:** `skip`, `limit`, `search`, `is_active`, `is_subsidiary` (filter by subsidiary flag).

**Bulk delete:** `POST /business-units/bulk-delete` — soft-deletes multiple BUs in one call.

**Locked fields when employees exist:** Once any employee references a BU, both `emp_code_prefix` and `emp_code_start_from` (number **or** padding width) are frozen against **value changes** — update requests that actually modify either return HTTP 400. Same-value no-op updates (e.g. re-PUTing the existing prefix) are silently allowed and dropped from the persist set, so PATCH-like clients don't trip the guard.

---

## 15. DEPARTMENT MODEL

`DepartmentDocument` fields:
- `organisation_id`, `business_units` (list of BU ObjectIds — multi-BU support)
- `primary_business_unit` (single BU ObjectId — required when multiple BUs selected; auto-set when only one)
- `department_name` (unique per org), `department_code`, `description`
- `department_head` (employee ObjectId), `is_active`

**Primary BU validation rules:**
- If `len(business_units) > 1` → `primary_business_unit` is required (HTTP 400 otherwise)
- `primary_business_unit` must be one of the entries in `business_units` (HTTP 400 otherwise)
- If exactly one BU is selected → `primary_business_unit` is auto-set to that BU
- Same rules apply on update using merged (incoming + existing) state

**List filter:** `business_unit_ids` query param (comma-separated) — filter departments by one or more BUs.

**Response enrichment:** $lookup for department_head_name (employee → user name), business_unit_names[] (resolved BU names), `primary_business_unit_data: PrimaryBusinessUnitCompact { id, business_unit_name }` (via $lookup + $unwind + $cond).

---

## 16. DESIGNATION MODEL

A designation is **just a job title** now — an org-level entity with a name,
description, and the pay grades assigned to it. It no longer carries a
department or a hierarchy role, and it does **not** own a policy. Roles
(policies) are a separate concept, managed independently and assigned **directly
to employees** (see §13 + §20).

`DesignationDocument` fields:
- `organisation_id`
- `designation_name`, `description`
- `pay_grade_ids` (list[ObjectId]) — pay grades assigned to this designation (the pay-grade ↔ designation link lives here, not on the pay grade; indexed)
- `department_id` (Optional), `hierarchy_role` (Optional) — **removed from the form**; kept nullable only for backward compatibility with old data
- `is_active`

**Names are NOT unique** — two designations may share a name (roles, not titles, carry permissions now). No duplicate-name check on create/rename.

**List filters:** `skip`, `limit` (max raised to **1000**), `search` (by name), `is_active`. The list is `$sort`ed by `designation_name` before pagination (deterministic order for dropdowns). The old `department_id` / `department_ids` / `hierarchy_role` filters were removed — designations are org-level and flat.

**Response enrichment:** `pay_grades` resolved as `PayGradeCompact[]` (id + name) from `pay_grade_ids`.

**Pay-grade validation:** `_validate_pay_grades` (create + update) requires every `pay_grade_ids` entry to be an active, same-org pay grade (HTTP 400 otherwise).

**Service (`designation/service.py`) is now a thin pass-through** — create/update/delete just persist the document (no policy lifecycle). `create_designation` stamps the org and inserts; `update_designation` validates pay grades and saves; `delete_designation` is blocked by `check_designation_dependencies` (only **employees** holding the designation block it — pay grades no longer do) and emits a plain `designation.deleted` event (no `deleted_role_ids`).

**Outbox events** (`designation.created` / `.updated` / `.deleted`): created/updated payloads carry `department_id` (nullable legacy field) + `pay_grade_ids` for downstream consumers.

---

## 17. BAND MODEL

`BandDocument` fields:
- `organisation_id`, `name` (unique per org)
- `class_label` (master data ObjectId from CLASS_LABELS)
- `frequency` (master data ObjectId from FREQUENCIES)
- `currency`, `min_amount` (Fernet-encrypted str at rest), `max_amount` (Fernet-encrypted str at rest)
- `effective_from`, `effective_to`, `notes`, `is_active`

**Response enrichment:** class_label and frequency resolved as MasterDataCompact. min_amount and max_amount returned as decrypted float.

**Currency validation:** validated against `location_tools.list_currencies()` (uppercased case-insensitive set) — 400 `"Invalid currency '<code>'."`.

**Amount coherence:** `max_amount >= min_amount` on create + partial update (else HTTP 400 `"max_amount must be greater than or equal to min_amount."`). Partial updates use `decrypt_amount(existing)` to fill the missing side.

**Effective-date validation rules** (enforced on create via `@model_validator(mode="after")` and on update):
- `effective_to is None` → always allowed (open-ended)
- `effective_to` set without `effective_from` → 400 `"Effective From is required when Effective To is provided."`
- `effective_to <= effective_from` → 400 `"Effective To must be after Effective From."` (same-day rejected)

**Legacy compatibility:** `_coerce_legacy_numeric` (Beanie pre-validator) casts pre-encryption `int`/`float` rows to `str` on read so legacy bands hydrate; `decrypt_amount` returns numeric values for both encrypted tokens and untouched legacy rows.

**Domain events:** `band.created` / `band.updated` (with `changed_fields`) / `band.deleted` published via the outbox.

---

## 18. PAY GRADE MODEL

`PayGradeDocument` fields:
- `organisation_id`, `name` (unique per org), `description`
- `band_ids` (list of Band ObjectIds — multiple bands per pay grade)
- `is_active`

**FK validation:** All band_ids must exist (non-deleted) on create/update.

**Response enrichment:** $lookup for band_names[].

**Designation link inverted:** The pay-grade ↔ designation relationship now lives on the **designation** (`DesignationDocument.pay_grade_ids`), not the pay grade. A pay grade no longer stores `designation_ids`. Deactivating or deleting a pay grade is blocked (`check_pay_grade_dependencies`, 409) while any active designation still references it via `pay_grade_ids`.

**Domain events:** `pay_grade.created` / `pay_grade.updated` (with `band_ids` + `changed_fields`) / `pay_grade.deleted` published via the outbox.

---

## 19. ORG DOCUMENTS

**Two-level hierarchy:** Folders → Documents

`DocumentFolderDocument`:
- `organisation_id`, `name` (unique per org), `description`
- `custom_access` (bool), `access` (FolderAccess: business_units[], departments[], worker_types[])
- `is_active`

`OrgDocumentDocument`:
- `organisation_id`, `folder_id`, `title`, `description`
- `allow_download` (**default False** — download is opt-in per file), `require_acknowledgement`
- `asset_id` (reference to AssetDocument), `is_active`

`DocumentAcknowledgementDocument` (`org_document_acknowledgements`):
- `organisation_id`, `document_id`, `user_id`, `acknowledged` (always True), `acknowledged_at`
- Unique index on `(document_id, user_id)` — one acknowledgement per user per document

**Document response enrichment:** file_name, file_size, mime_type, file_url resolved via $lookup to AssetDocument.

**In-app viewing (admin):** `GET /org-documents/documents/{doc_id}/content` streams the asset bytes through the API with `Content-Disposition: inline` and a private 5-minute cache. Rationale: the FE viewers (pdf.js, CSV preview) fetch via JS and need CORS headers, which the public bucket URL doesn't send. FE renders PDF via `SecurePdfViewer` (pdf.js canvases, no browser toolbar) and CSV as a table in `DocumentViewSheet`; Word/Excel fall back to "download to read".

**Employee-facing endpoints (user portal, any authenticated user):**
- `GET /org-documents/my/folders` — active folders visible to the caller
- `GET /org-documents/my/documents?folder_id=` — `MyDocumentResponse[]` with the caller's `acknowledged` / `acknowledged_at` joined per document
- `GET /org-documents/my/documents/{id}/content` — file bytes, access-checked
- `POST /org-documents/my/documents/{id}/acknowledge` — record acknowledgement

**Folder access scoping:** org/super admins are unrestricted (`scope=None`). For everyone else, `_employee_scope` resolves the caller's employee record → `{business_unit, department, worker_type}` (worker type = employment_type master-data key; missing pieces become `''` sentinels that match nothing). A folder is visible when `custom_access` is off, OR when the caller's BU **and** department **and** worker type all appear in the folder's access lists (`employee_access_filter` in Mongo, `folder_accessible` per folder).

**Acknowledgements:** only valid for documents with `require_acknowledgement=True` (400 otherwise). One-way and idempotent — first timestamp wins; a concurrent double-click loses the unique-index race and gets the winning record back. The FE sends the browser's clock as `acknowledged_at`; server time is the fallback. Each ack publishes a `document_acknowledged` audit log (EMPLOYEE level).

**Domain events:** `document_folder.created/.updated/.deleted` + `org_document.created/.updated/.deleted` published via the outbox (folder delete cascades emit per-document deleted events).

**Bulk creation:**
- `POST /org-documents/folders/bulk` — create multiple folders in one request (BulkFolderCreate with FolderCreateItem[])
- `POST /org-documents/documents/bulk` — create multiple documents in one request (BulkDocumentCreate with DocumentCreate[])

**Cascade delete:** Deleting a folder soft-deletes all its documents + associated assets.

**Tenant scoping (cross-org guards):**
- `DocTools.create` and `DocTools.create_bulk` require the parent folder's `organisation_id` to match the caller's org — prevents cross-tenant document attachment.
- `DocTools.get_all` accepts an `organisation_id` filter and applies it as a `match_filter` — list endpoint is now scoped at the data layer (passed in by `service.py::list_documents`).
- `create_bulk` deduplicates by `(folder_id, organisation_id)` pairs rather than `folder_id` alone.

---

## 20. ASSET SYSTEM

Centralized file storage via `AssetDocument` + DO Spaces.

- **Upload:** `POST /assets/upload` (multipart, folder param)
- **Limits:** 2 MB max, allowed types: pdf, doc/docx, xls/xlsx, csv, ppt/pptx, jpg, png, txt
- **Storage key:** `{folder}/{uuid12}.{ext}` — unique per upload
- **CDN URL:** `https://{bucket}.{host}/{key}`
- **Folders:** `org-logos`, `org-documents`, `profile-photos`, `employee-photos`, `general`, `test-uploads`
- **Soft delete:** marks `deleted_on` + `is_active=false`, file stays in DO Spaces
- **Hard delete:** removes file from DO Spaces + deletes MongoDB record

Logo replacement: old logo soft-deleted when new one uploaded on org update.

---

## 21. LOGO PROXY

`GET /api/logo` — fetches company logos by domain or direct URL.

**Parameters:** `domain` (optional), `url` (optional — checked first).

**Resolution strategies (in order):**
1. Direct URL fetch if `url` provided
2. Homepage scrape for: og:image, apple-touch-icon, favicon links, `<img>` tags with "logo" in class/id/alt/src
3. Favicon fallbacks: Google Favicons API (256px), DuckDuckGo icons, direct `/favicon.ico`

**Response:** Binary image with `Cache-Control: public, max-age=86400` (24-hour cache). Returns 404 if no logo found.

**Implementation:** httpx async client, 10s timeout (5s connect), User-Agent spoofing.

---

## 22. ACTIVE STATUS FILTERING

All list endpoints: `is_active: Optional[bool]` query param.
BU, Dept, Designation, Bands, PayGrades, Policies — all support it.
FE dropdowns pass `is_active: true`. List pages pass from status dropdown.

---

## 23. NAME UNIQUENESS VALIDATION

All entities enforce unique names within an organisation (case-insensitive):
- **Organisation:** `legal_name` (unique globally via partial index on `is_active: true`)
- **Business Unit:** `business_unit_name` (case-insensitive regex check per org) + `emp_code_prefix` (uppercase, unique per org)
- **Department:** `department_name` per org
- **Designation:** `designation_name` per org
- **Band:** `name` per org (unique partial index on `is_active: true`)
- **Pay Grade:** `name` per org (unique partial index on `is_active: true`)
- **Document Folder:** `name` per org (unique partial index on `is_active: true`)
- **Policy:** `name` per org (unique partial index on `deleted_on: null`)

On update, the current entity is excluded from uniqueness checks (self-comparison ignored).

---

## 24. DEPENDENCY CHECKS (INACTIVATION GUARDS)

Before setting `is_active=False` on any entity, the BE validates that no active dependents still reference it. If dependents exist, returns 409 with dependency details.

**Enforcement:** Called automatically in each entity's `update` method when `is_active` transitions from `True` → `False`.

**Dependency graph:**

| Entity | Blocks inactivation if active… |
|--------|-------------------------------|
| Organisation | BUs, departments, employees, document_folders, designations, bands, pay_grades |
| Business Unit | Departments (via `business_units` array), employees, document_folders (via `access.business_units`) |
| Department | Employees, document_folders (via `access.departments`) — designations are org-level now, no longer a dependency |
| Designation | Employees (pay grades are no longer dependents — the link lives on the designation) |
| Pay Grade | Designations (via `pay_grade_ids`) |
| Band | Pay_grades (via `band_ids`) |
| Document Folder | Org_documents |
| Policy | Users (via `policy_ids`) |

**Two access patterns:**

1. **Inline guard** (`dependency_check.py`): called during entity update — raises 409 HTTP exception, blocking the save.
2. **Read-only endpoint** (`dependency_router.py`): `GET /dependency-check/{entity_type}/{entity_id}` — returns `{ entity_type, entity_id, can_inactivate: bool, dependencies: [...] }` so FE can show a warning dialog before attempting the update.

**Supported entity_types:** `organisation`, `business_unit`, `department`, `designation`, `pay_grade`, `band`, `document_folder`, `policy`.

**Folder deactivation helper:** `PATCH /org-documents/folders/{folder_id}/deactivate-all-documents` — bulk-deactivates all documents in a folder (allows the folder itself to then be inactivated). FE calls this to resolve folder dependencies.

---

## 25. INDEXING STRATEGIES

Unique partial indexes on `(name, organisation_id)` with `is_active: true` or `deleted_on: null`.
Compound indexes for prefix uniqueness, email uniqueness, FK lookups.
Outbox: `(status, created_at)` for relay, `(idempotency_key)` unique for dedup.
Users: `(email)` unique, `(azure_oid)` unique partial, `(organisation_id)`.
BU: `(emp_code_prefix, organisation_id)` for prefix uniqueness, `(address_id)`.
Employees: `(organisation_id)`, `(business_unit_id)`, `(department_id)`, `(designation_id)`, `(emp_code, organisation_id)`, `(user_id)`.
Departments: `(organisation_id)`, `(business_units)`.
Designations: `(organisation_id)`, `(department_id)`, `(pay_grade_ids)`.
Bands: `(organisation_id)`, `(frequency)`, `(name, organisation_id)` unique partial.
PayGrades: `(organisation_id)`, `(band_ids)`, `(name, organisation_id)` unique partial.
Policies: `(name, organisation_id)` unique partial, `(organisation_id)`, `(is_active)`.
ModuleAclPermissions: `(policy_id)`, unique `(policy_id, module_id, acl_id, permission_id)` partial.
Assets: `(folder)`, unique `(storage_key)`.
Custom field definitions: `(organisation_id, entity_type, section, is_active)`, `(organisation_id, key)` unique partial.
Custom field options: `(field_definition_id, is_active, sort_order)`, `(field_definition_id, value)` unique partial.
Custom field values: `(organisation_id, entity_id, entity_type)`, `(field_definition_id, entity_id)` unique.
Exit requests: `(organisation_id, employee_id)`, `(organisation_id, status)`, `(request_code, organisation_id)` unique partial, `(created_on DESC)`.
Exit interviews: `(exit_request_id)` unique partial on `deleted_on: null`.
IT asset returns: `(organisation_id, status)`, `(organisation_id, employee_id)`, `(exit_request_id, asset_id)` unique.
Admin tasks: `(organisation_id, status)`, `(organisation_id, employee_id)`, `(task_type)`.
Finance clearances: `(organisation_id, status)`, `(settlement_date DESC)`, `(exit_request_id)` unique.
Department checklists: `(organisation_id, dept_id)` unique.
Org document acknowledgements: `(document_id, user_id)` unique, `(organisation_id)`, `(user_id)`.

---

## 26. CUSTOM FIELDS

Org-level dynamic field system. Admin defines fields once per entity type — every instance of that entity gets the field in its form, each with its own value.

### 26.1 Core Concepts

- **Definition** = org-level, shared. "Blood Group" defined once → appears on every employee form.
- **Option** = separate entity per definition. Each option has CRUD and its own sort_order.
- **Value** = per entity instance. Employee A = "O+", Employee B = "A-".
- **Entity types:** `organisation`, `business_unit`, `department`, `employee`.
- **Sections (employee only):** `basic`, `work`, `personal`, `identity`, `contact`, `emergency`, `experience`, `dependents`, `education`. Non-employee entities use `section="default"`.

### 26.2 Field Types (12)

| Type | Value stored in | UI widget |
|------|----------------|-----------|
| `text` | `value` | Input |
| `textarea` | `value` | Textarea |
| `number` | `value` | Number input |
| `date` | `value` | DatePicker |
| `single_select` | `option_ids` (1 item) | Dropdown |
| `multi_select` | `option_ids` (N items) | Multi-select |
| `radio` | `option_ids` (1 item) | Radio group |
| `checkbox` | `option_ids` (N items) | Checkbox group |
| `file` | (file uploaded via AssetDocument) | FileUploader |
| `url` | `value` | Input (URL validation) |
| `email` | `value` | Input (email validation) |
| `phone` | `value` | Input (phone validation) |

Helper sets: `OPTION_FIELD_TYPES = {single_select, multi_select, radio, checkbox}`, `SINGLE_OPTION_TYPES = {single_select, radio}`, `MULTI_OPTION_TYPES = {multi_select, checkbox}`.

### 26.3 Data Model (3 Collections)

**`custom_field_definitions`**

```
organisation_id:    PydanticObjectId        # tenant isolation
entity_type:        str (enum)              # organisation | business_unit | department | employee
section:            str (enum)              # default | basic | work | personal | identity | contact | emergency | experience | dependents | education
name:               str                     # display label: "T-Shirt Size"
key:                str                     # slug: auto-generated, unique per org+entity_type
field_type:         str (enum)              # text | textarea | number | date | single_select | multi_select | radio | checkbox | file | url | email | phone
file_settings:      {max_size_mb, allowed_file_types[]}  # only for file type
placeholder:        str | None              # optional hint text
help_text:          str | None              # optional description below field
is_required:        bool
sort_order:         int                     # display ordering within section
is_active:          bool
+ AuditMixin fields
```

Indexes:
- `(organisation_id, entity_type, section, is_active)` — primary list query
- `(organisation_id, key)` unique partial where `is_active: true` — prevent duplicate keys

**`custom_field_options`** (separate collection)

```
field_definition_id:  PydanticObjectId      # FK → definition
label:                str                   # display text
value:                str                   # stored value
sort_order:           int                   # ordering within the dropdown/radio/checkbox
is_active:            bool
+ AuditMixin fields
```

Indexes:
- `(field_definition_id, is_active, sort_order)` — list query with ordering
- `(field_definition_id, value)` unique partial where `is_active: true` — prevent duplicate values

**`custom_field_values`**

```
organisation_id:        PydanticObjectId    # tenant isolation
field_definition_id:    PydanticObjectId    # FK → definition
entity_id:              PydanticObjectId    # the BU/dept/employee/org ObjectId
entity_type:            str (enum)          # denormalized for query perf
value:                  str | None          # for text, textarea, number, date, url, email, phone
option_ids:             list[PydanticObjectId]  # selected option ObjectIds for select/radio/checkbox
+ AuditMixin fields
```

Indexes:
- `(organisation_id, entity_id, entity_type)` — "get all custom values for entity X"
- `(field_definition_id, entity_id)` unique — one value per field per entity

### 26.4 Backend Module

```
src/modules/custom_fields/
├── models.py           # CustomFieldDefinitionDocument, CustomFieldOptionDocument, CustomFieldValueDocument + enums
├── schema.py           # Pydantic schemas (DefinitionCreate/Update/Response, OptionCreate/Update/Response,
│                       #   ValueUpsert/Response, FieldWithValue, EntityValuesResponse, ReorderItem/Request)
├── router.py           # REST endpoints (definitions CRUD + reorder, options CRUD + reorder, values GET/PUT/DELETE)
├── service.py          # Orchestration layer with _resolve_org
└── utils/
    └── tools.py        # DefinitionTools + OptionTools + ValueTools (Beanie queries)
```

### 26.5 API Endpoints

**Definitions (admin configures what fields exist)**

```
POST   /custom-fields/definitions                          # create definition
GET    /custom-fields/definitions?entity_type=&section=     # list definitions
GET    /custom-fields/definitions/{id}                      # get single definition
PUT    /custom-fields/definitions/{id}                      # update definition
DELETE /custom-fields/definitions/{id}                      # soft-delete definition
PATCH  /custom-fields/definitions/reorder                   # bulk update sort_order
       Body: { "items": [{"id": "...", "sort_order": 1}, ...] }
```

**Options (per definition, separate CRUD)**

```
POST   /custom-fields/definitions/{def_id}/options          # create option
GET    /custom-fields/definitions/{def_id}/options           # list options
PUT    /custom-fields/options/{option_id}                    # update option
DELETE /custom-fields/options/{option_id}                    # soft-delete option
PATCH  /custom-fields/definitions/{def_id}/options/reorder   # bulk update option sort_order
```

**Values (saved with entity data)**

```
GET    /custom-fields/values/{entity_type}/{entity_id}      # returns definitions + options + values together
PUT    /custom-fields/values/{entity_type}/{entity_id}      # bulk upsert values
       Body: [{ "field_definition_id": "...", "value": "..." }, ...]
DELETE /custom-fields/values/{entity_type}/{entity_id}      # cleanup when entity deleted
```

**GET values response shape (definitions + options + values in one call):**

```json
{
  "entity_id": "...",
  "entity_type": "business_unit",
  "fields": [
    {
      "definition": { "id": "...", "name": "Office Floor", "key": "office_floor", "field_type": "text", "is_required": true, "sort_order": 1 },
      "options": [],
      "value": { "value": "3rd Floor", "option_ids": [] }
    },
    {
      "definition": { "id": "...", "name": "Region", "key": "region", "field_type": "single_select", "is_required": false, "sort_order": 2 },
      "options": [{"id": "...", "label": "North", "value": "north", "sort_order": 1}],
      "value": { "value": null, "option_ids": ["<option_oid>"] }
    }
  ]
}
```

### 26.6 Validation Rules

- Required fields: checked on `PUT /values` — if definition has `is_required: true`, value must be non-empty.
- Section validation: non-employee entities must use `section="default"`.
- File settings: validated — `file_settings` required for file type, forbidden for other types.
- Key uniqueness: auto-generated slug from `name`, unique per `(organisation_id, entity_type)` where `is_active: true`.
- Option value uniqueness: unique per `(field_definition_id)` where `is_active: true`.
- **Cross-tenant option mutation guard:** `update_option` / `delete_option` resolve the parent `CustomFieldDefinitionDocument` via the option's `field_definition_id` and raise 404 if the definition's `organisation_id` does not match the caller's org (closes a previous cross-tenant gap).
- **Definition / URL entity_type consistency on PUT /values:** each item's `field_definition_id` is loaded and its `entity_type` must match the URL's `entity_type`. 400 otherwise: `"'<name>' is defined for '<def_entity_type>', not '<url_entity_type>'."` Prevents submitting employee-section definitions against a `/values/business_unit/<id>` URL.
- **Option ID validity on PUT /values:** for any option-type definitions in the batch, `CustomFieldOptionDocument` is preloaded once (`field_definition_id $in def_ids`, `is_active: True`). Each item's `option_ids` are checked against that allowed-set; unknown / inactive / cross-definition option IDs return 400: `"'<name>' has invalid option ids: [<ids>]"`.
- **Cleanup (`delete_entity_values`) tenant + type scoped:** signature now requires `organisation_id` AND `entity_type` (both previously optional). Filter is `organisation_id + entity_id + entity_type + NOT_DELETED`. Call-sites in BU and Employee delete paths pass `organisation_id=entity.organisation_id` and explicit `entity_type`. Closes a potential cross-tenant / cross-entity-type value-wipe risk.
- **Duplicate-field guard within a batch:** PUT /values rejects payloads where the same `field_definition_id` appears twice — 400 `"Duplicate field_definition_id '<id>' in items."` Protects the unique `(field_definition_id, entity_id)` index and prevents last-write-wins ambiguity in a single PUT.
- **Two-pass batch validation (all-or-nothing):** Pass 1 validates every item (definition existence, entity_type match, type rules, length/numeric guards, option ID validity) without touching the DB. Pass 2 persists only if every item passed. A single bad item rejects the entire batch — no partial writes.
- **Text / textarea length caps:** `text` capped at 500 chars (`TEXT_MAX_LENGTH`), `textarea` capped at 5000 chars (`TEXTAREA_MAX_LENGTH`). 400 `"'<name>' must be at most <N> characters."`
- **Finite-number guard:** `number` type accepts only finite values — `nan`, `inf`, `-inf` (which `float()` parses successfully) are rejected with 400 `"'<name>' must be a finite number."`
- **Definition `field_type` change guards:** updating a definition's `field_type` is blocked if either
  (a) any value has been recorded for it — 409 `"Cannot change field type once values have been recorded. Delete the field or clear its values first."`, or
  (b) any active option exists for it — 409 `"Cannot change field type while options exist. Delete the options first."`
- **Definition `file_settings` ↔ `field_type` invariant:** the effective field_type after the update (incoming or existing) drives validation:
  - effective type = `file`: payload cannot clear `file_settings` (400 `"file_settings cannot be cleared for file field type"`) and existing doc must already have one or payload must supply one (400 `"file_settings is required for file field type"`).
  - effective type ≠ `file`: payload cannot supply `file_settings` (400 `"file_settings is only allowed for file field type"`); if existing doc has a stale `file_settings` and the type is changing away, it is silently cleared.
- **Cascade delete now covers Department too:** Department soft-delete invokes `ValueTools().delete_entity_values(dept_id, organisation_id=..., entity_type=EntityType.DEPARTMENT)` — matches BU and Employee cleanup. Any entity that owns custom field values must do this on delete.

### 26.7 Integration with Existing Entities

- Entity responses embed custom field values: `OrganisationResponse.custom_fields`, `BusinessUnitResponse.custom_fields`, `EmployeeResponse.custom_fields` — all as `list[FieldWithValue]`.
- Entity DELETE cascades soft-delete to custom field values for that entity.

### 26.8 sort_order

Integer controlling display position. Admin reorders fields via drag-and-drop → FE calls `PATCH /definitions/reorder` with new positions. Same concept applies to options — `PATCH /definitions/{def_id}/options/reorder` controls dropdown/radio/checkbox item ordering.

### 26.9 Frontend Architecture

- **Options are separate entities** — `CustomFieldOptionDocument` has its own CRUD rather than being embedded in the definition. This allows independent CRUD on options after definition creation.
- **Value model:** `CustomFieldValue` stores `value?: string | null` (for text/number/date/url/email/phone) + `option_ids: PydanticObjectId[]` (for select/radio/checkbox). Simpler single-field approach.
- **Field types include `radio`** — FE adds `radio` type (separate from `checkbox`). `SINGLE_OPTION_TYPES = ['single_select', 'radio']`, `MULTI_OPTION_TYPES = ['multi_select', 'checkbox']`.
- **Integration pattern:** Entity forms fetch definitions on mount → render via `CustomFieldRenderer` → save values via `valueService.upsertEntityValues()` after entity save.
- **Hooks:** `useCustomFieldDefinitions(entityType, section)` + `useCustomFieldValues(entityType, entityId)` + full mutation hooks for definitions, options, and values.

---

## 27. GOOGLE PLACES INTEGRATION

FE integrates Google Places API for company lookup during Business Unit creation:
- `useCompanySearch(query)` — searches for companies by name
- `useCompanyDetails(placeId)` — fetches full company details
- Auto-fills: name, country, state, city, address, postal code, phone, industry

External API service in `src/api/external/google-places.ts`.

---

## 28. HEALTH MONITORING

`GET /health` — checks connectivity to all configured infrastructure:
- MongoDB (ping command)
- Valkey/Redis (ping)
- RabbitMQ (connection state)

Returns per-service status (`mongo_connected`, `valkey_connected`, `rabbitmq_connected`) and overall `status: "ok" | "degraded"`. All configured services must be healthy for "ok".

---

## 29. CONFIGURATION

`GlobalConfig` (pydantic-settings, loaded from `.env`):

| Category | Settings |
|----------|----------|
| **General** | ENVIRONMENT, CORS_ORIGINS, DATABASE_TYPE, FRONTEND_URL |
| **MongoDB** | MONGO_DB_HOST, MONGO_DB_PORT, MONGO_DB_USER, MONGO_DB_PASSWORD, MONGO_DB_NAME → computed MONGODB_URL |
| **PostgreSQL** | POSTGRES_URL (optional dual-database support) |
| **Valkey** | VALKEY_HOST, VALKEY_PORT, VALKEY_USER, VALKEY_PASSWORD, VALKEY_DB → computed VALKEY_URL |
| **RabbitMQ** | RABBITMQ_URL |
| **DO Spaces** | DO_SPACES_ACCESS_KEY, DO_SPACES_SECRET_KEY, DO_SPACES_ENDPOINT, DO_SPACES_BUCKET, DO_SPACES_REGION |
| **Encryption** | ENCRYPTION_KEY — URL-safe base64-encoded 32-byte Fernet key. Required at runtime for any CTC / band-amount read or write. RuntimeError raised on the first lazy `_fernet()` call (not at startup) if unset. |

`AuthConfig` (pydantic-settings, loaded from `.env`):

| Category | Settings |
|----------|----------|
| **JWT** | JWT_SECRET_KEY, JWT_EXP_MINUTES (15), REFRESH_TOKEN_EXPIRE_DAYS (7) |
| **Password** | PASSWORD_EXPIRY_DAYS (90), PASSWORD_HISTORY_COUNT (5) |
| **Tokens** | ACTIVATION_TOKEN_EXPIRE_HOURS (72), PASSWORD_RESET_TOKEN_EXPIRE_MINUTES (30), EMAIL_CHANGE_TOKEN_EXPIRE_HOURS (24) |
| **Azure SSO** | AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_REDIRECT_URI |

---

## 30. LIFESPAN & STARTUP

FastAPI lifespan manages infrastructure connections:

**Startup (in order):**
1. `init_db()` — MongoDB/PostgreSQL connection + Beanie document registration (31 document models, including `DepartmentChecklistDocument`)
2. `init_valkey()` — Redis/Valkey connection (warning on failure, non-blocking)
3. `init_rabbitmq()` — RabbitMQ connection (warning on failure, non-blocking)
4. `start_relay()` — Outbox relay background task

**Shutdown (in order):**
1. `stop_relay()` — Stop outbox relay
2. `close_db()` — Close database connections
3. `close_valkey()` — Close Valkey connection
4. `close_rabbitmq()` — Close RabbitMQ connection

Valkey and RabbitMQ failures during startup are non-fatal (logged as warnings) — the app starts in degraded mode.

**25 routers registered:** auth, dashboard, health, lookups, organisations (tenancy), policies, location, users, addresses, orgsetup, business_units, departments, designations, orgdocuments, employees, assets, bands, paygrades, storage, master_data, **internal**, custom_fields, dependency_check, exit_management, **journey**, logo_proxy.

**Journey consumer:** Started in lifespan after RabbitMQ init — declares the durable `iam.journey` queue, binds it to the `domain_events` exchange on the 8 journey routing keys, and consumes. Failure to start is non-fatal (logged as a warning).

---

## 31. ORGANISATION MODEL

`OrganisationDocument` fields:
- `legal_name` (unique globally, partial index on `is_active: true`)
- `address_id`, `head_user_id` (the org head, set via assign-head step)
- `date_of_incorporation`, `financial_year`, `currency`, `timezone`
- `logo_asset_id`
- `is_multiple_business_units` (boolean — controls whether BU management is shown)
- `is_active`
- `enabled_modules: list[OrgModule]` — each OrgModule has `code` (ModuleEnum) + `is_active` (bool). Core HR always forced to `is_active=True`.
- `setup_status: Literal["draft", "pending", "active"]`
- `setup_progress: dict[str, str]` — 10-step progress tracking

**Module management:** Super admins control which modules appear in the list. Org admins can toggle `is_active` on existing modules but cannot add/remove modules (403 if codes differ). The `_core_hr_mandatory` validator ensures Core HR is always present and active.

**Legacy format handling:** `_coerce_modules` validator handles both string format (legacy) and OrgModule dict format (current).

---

## 32. EDGE CASES

| Case | Handling |
|------|----------|
| Legacy BUs without prefix | Backfill on startup (random 3-letter uppercase) |
| Partial employee create (no BU) | emp_code left None, filled when BU assigned later |
| Employee create failure | Atomic rollback (addresses + user deleted) |
| Bulk upload partial success | Per-row errors, selective insertion via selected_row_nums |
| Intra-batch manager reference | Second pass after all rows inserted resolves by email |
| Folder cascade delete | Docs + assets soft-deleted |
| Cross-org access | 403 via check_org_access |
| Stale session | SessionExpiredModal shown, cache clearing on login/logout |
| Duplicate document title | 409 from BE |
| Duplicate folder in drag-drop | Reuses existing |
| File >2MB | Pre-upload validation in AssetService |
| Empty string dates | model_validator coerces to None |
| Org API after logout | Enabled guard + queryFn token check |
| Concurrent 401s | Queue in Axios interceptor, single refresh, retry all |
| Admin email change | Double opt-in via confirmation to NEW address |
| Password expiry | 90-day check on login, force change-password |
| Seeded user first login | Allow login without password_changed_at |
| Policy deletion | Soft delete, dangling policy_ids silently dropped, Valkey cache invalidated |
| Policy permissions change | All holders' Valkey sessions deleted (forces re-resolution) |
| Policy inactivation with assigned users | 409 with user count |
| Org without admin | Refuse admin update (404) |
| Duplicate BU emp_code_prefix | 409 per org (case-insensitive, stored uppercase) |
| Duplicate BU name | 409 per org (case-insensitive regex check) |
| Super admin missing org_id | 400 "must specify organisation_id" |
| Employee self-reference as manager | 400 "cannot be their own L1/L2 Manager" |
| BU without emp_code_prefix | 400 blocks employee creation until prefix set |
| Bulk file too large | 5MB limit, error returned before processing |
| Bulk missing required columns | file_errors returned, no row processing |
| Bulk cascading dropdown mismatch | Dept not under BU → validation error per row |
| Inactivate entity with active dependents | 409 with dependency list (type + count) |
| Inactivate folder with active documents | FE calls deactivate-all-documents first, then retries folder inactivation |
| Dependency check read-only query | GET /dependency-check/{type}/{id} — FE pre-checks before showing confirm dialog |
| Forgot password with non-existent email | Always shows "check your email" (no email enumeration) |
| Reset password with expired/invalid token | 400 from BE, FE shows "request a new link" |
| Activation token already used | Account already active message, still returns password_reset_token |
| Org admin tries to add/remove modules | 403 "can only toggle module status" |
| SSO user tries password reset | Silently skipped (no email enumeration) |
| Logo proxy domain not found | 404 "Logo not found" |
| Logo proxy non-image response | Skipped, tries next strategy |
| Exit request update after approval | 400 "Only pending requests can be updated" |
| Exit withdraw from wrong status | 400 — only pending/approved/awaiting_clearances allowed |
| Exit reapply for non-rejected request | 400 "Can only reapply for rejected requests" |
| Exit rejection without reason | 400 "Rejection reason is required" |
| Exit clearances already initiated | Idempotent — skips existing IT/admin/finance docs |
| Exit reason "others" without other_reason | 400 "Other reason is required" |
| Duplicate exit interview | 400 "Exit interview already submitted" |
| Finance not_cleared without reason | 400 "Reason and remarks required when not cleared" |
| All clearances done + interview submitted | Auto-transition to completed + completion email |
| All clearances done + interview NOT submitted | Auto-transition to `awaiting_exit_interview`; flips to `completed` when interview is submitted |
| Band effective_to set without effective_from | 400 "Effective From is required when Effective To is provided." |
| Band effective_to <= effective_from | 400 "Effective To must be after Effective From." (same-day rejected) |
| Band amount min > max | 400 "max_amount must be greater than or equal to min_amount." (on create and partial update) |
| Invalid currency on Band/Employee | 400 "Invalid currency '<code>'." (checked against location_tools.list_currencies()) |
| Encryption key missing | RuntimeError on first lazy `_fernet()` call (not at startup) |
| Decryption failure (wrong key / corrupt token) | Silent `None` from `decrypt_str` / `decrypt_amount` — CTC appears as missing |
| Legacy band amount (int/float) | `_coerce_legacy_numeric` casts to str on read; `decrypt_amount` passthrough on int/float |
| Employee create missing BU / Dept / employment_type | 400 — these are mandatory; "draft without BU" path removed |
| BU update of `emp_code_prefix` / `emp_code_start_from` after employees exist | 400 only on actual value change; same-value no-op silently allowed |
| Department with multiple BUs missing primary_business_unit | 400 — primary required when len(business_units) > 1 |
| Department primary_business_unit not in business_units | 400 — primary must be one of the selected BUs |
| Employment status filter "active" / "inactive" | Resolves to `$in` over EMPLOYMENT_STATUSES master rows by `is_active` flag |
| Employee employment_status change | UserDocument.status synced to ACTIVE / INACTIVE based on master-data flag |
| Cross-tenant custom-field option mutation | 404 — option's parent definition org must match caller's org |
| PUT /values with definition belonging to a different entity_type | 400 — definition entity_type must match URL entity_type |
| PUT /values with option_ids not belonging to the named definition | 400 — option IDs must be real, active, and belong to that definition |
| Entity delete with custom-field values | `delete_entity_values` now requires (org_id + entity_type) — soft-deletes only the matching values, not foreign ones |
| PUT /values with duplicate field_definition_id in items | 400 — same field can't appear twice in one batch |
| PUT /values where any single item fails validation | Entire batch rejected, no partial writes (two-pass validate-then-persist) |
| Custom-field `text` > 500 chars or `textarea` > 5000 chars | 400 with field name + max length |
| Custom-field `number` value of nan / inf / -inf | 400 "must be a finite number." |
| Definition field_type change with active options present | 409 "Cannot change field type while options exist." |
| Update file-type definition trying to clear file_settings | 400 "file_settings cannot be cleared for file field type" |
| Update non-file definition supplying file_settings | 400 "file_settings is only allowed for file field type" |
| Change file → non-file field_type with stale file_settings | Silently cleared on save |
| Department delete with custom-field values | Cascades to soft-delete those values (org_id + dept_id + entity_type=DEPARTMENT) |
| Cross-tenant org document creation | Rejected — folder org must match caller's org |
| Bulk template missing any of 11 required columns | file_errors returned, no row processing |
| Exit awaiting_exit_interview pre-submit | Submit interview is the only path to `completed` |
| Employee BU / employment-type change after create | 400 — emp_code is derived from both and never regenerated (same-value no-op passes; FE disables both selects on edit) |
| CTC update with unchanged amount + currency | No new version appended (`revise_ctc` no-op) |
| CTC cleared on update | Prior versions kept untouched |
| Legacy CTC row (single Fernet string or list) | `_coerce_ctc` wraps it into the version map (string → version "1" with `datetime.min`) |
| Duplicate employee docs for one user (L1/L2 join) | Pipeline `$lookup` capped to 1 live doc — pages can't over-return rows |
| Unsorted list pagination | Employees `$sort` by emp_code, designations by name, before `$skip`/`$limit` |
| Acknowledge a doc without require_acknowledgement | 400 "This document does not require acknowledgement" |
| Repeat / concurrent double acknowledge | Idempotent — first timestamp wins; unique-index race returns the winning record |
| Employee folder access with custom_access on | Visible only when BU AND department AND worker type all appear in the access lists |
| Employee record missing on /my access check | `''` sentinels match no access list — custom-access folders hidden |
| In-app preview of Word/Excel | FE shows "Preview not available" + download (PDF + CSV render in-app) |
| Public bucket URL lacks CORS headers | Viewer fetches bytes via authenticated `/content` endpoints instead |

---

## 33. SCRIPTS

| Script | Purpose |
|--------|---------|
| `scripts/seed_master_data.py` | 15 categories from JSON files (honours `isActive` flag per entry) |
| `scripts/seed_locations.py` | Countries/states/cities geographic data |
| `scripts/seed_superadmin.py` | Super admin user with seeded password |
| `scripts/seed_lookups.py` | Modules (12), ACL roles (3), permissions (36 codes × relevant modules) |
| `scripts/grant_hr_leave_permission.py` | One-off: grants the `leave_management:approve_as_hr` permission to a target policy/role (HR-as-approver capability) |
| `scripts/seed_service_request.py` | SRM database: 16 collections with indexes + 13 default categories with 100+ request types |
| `scripts/seed_employees.py` | ~25 employees with L1/L2 manager chain across IT / Engineering / Finance / HR for an existing org (locates org via `ORG_ADMIN_EMAIL`). Sets `status=ACTIVE`, password `test@123`, `password_changed_at=NOW`. Uses BU `emp_code_prefix` + counter. Run: `python -m scripts.seed_employees` |
| `scripts/seed_org_full.py` | Direct-to-DB full org bootstrap: 1 Org + admin + 3 BUs + 6 Depts + 12 Designations + 6 Bands + 3 Pay Grades + 2 Policies + 15 Employees + heads + setup_progress complete. Does NOT emit RabbitMQ events (fast). Admin: `orgadmin@acmecorp.com / test@123` |
| `scripts/seed_org_via_api.py` | Same data shape as `seed_org_full` (12 flat designations + 2 standalone role policies — Admin Full Access / Employee Basic — assigned to employees via `roleIds`; each employee gets a `projectStatus`), but driven through REST so RabbitMQ domain events fire (LMS / Timesheet / SRM consumers stay in sync). Requires running IAM Admin BE. Org: `NexaGen Solutions Pvt Ltd`, admin `orgadmin@nexagen.com / test@123` |
| `scripts/seed_org_small_via_api.py` | Lightweight API-driven seed: 1 Org (`Brightwave Labs Pvt Ltd`, single BU `Brightwave HQ`) + 3 Departments + 7 flat designations + 2 Bands + 1 Pay Grade + 2 role policies (Administrator / Employee) + **10 Employees** (assigned `roleIds` + `projectStatus`, L1 manager chain). Org / BU / dept heads assigned. Admin: `orgadmin@brightwave.com / test@123` |
| `scripts/seed_org_large_via_api.py` | API-driven, larger scale: ~75 employees, 10-15 per department. 1 Org (`Zenith Digital Pvt Ltd`) + 3 BUs + 6 Depts + 15 Designations (flat org-level job titles, linked to pay grades) + 6 Bands + 3 Pay Grades + 3 standalone role policies (Administrator / Manager / Employee). Each employee is assigned a `roleId` directly + a `projectStatus`. Admin: `orgadmin@zenithdigital.com / test@123` |
| `scripts/clear_org_large.py` | Tears down everything created by `seed_org_large_via_api` for `Zenith Digital Pvt Ltd` (employees, pay grades, bands, designations, departments, BUs, policies + ACL grants, users, addresses, org doc). Direct-to-DB. Run: `python -m scripts.clear_org_large` |
| `scripts/migrate_service_request_permissions.py` | One-shot idempotent migration: splits legacy `service_request:create_resource` grant into 7 role-based codes; upserts new `PermissionDocument` rows; back-fills `module_acl_permissions`; hard-deletes legacy SR `create_resource` rows |

**SRM seed details:** Creates `sentrifugo_srm` database with collections: org_sr_config, categories, request_types, sla_rules, workflows, approval_levels, approvers, escalation_configs, service_requests, approval_decisions, comments, internal_notes, attachments, counters, idempotency_records, outbox_events. Seeds 13 global categories (IT Support, HR Services, Payroll & Compensation, Finance & Accounts, Admin/Facilities, Recruitment, Procurement, PMO, Compliance, Application Support, Travel & Visa, Security, General) with their request types.

---

## 34. DESIGN PRINCIPLES

1. Master data over hardcoded enums (ObjectId references everywhere)
2. Setup progress stored, not computed on-the-fly
3. No cascade-lock on delete (independent step progression)
4. API-side filtering on all list endpoints (is_active, search, skip, limit)
5. Two portals, one collection (UserDocument.is_super_admin/is_org_admin)
6. Server-owned emp_code (atomic counter, never from payloads)
7. Soft delete everywhere (deleted_on/deleted_by audit trail)
8. Aggregation over N+1 ($lookup pipelines for enriched responses)
9. Session hygiene (clear on login/logout, invalidate on permission change)
10. Outbox reliability (persist before publish, relay drains failures)
11. Correlation tracing (end-to-end X-Correlation-ID)
12. Idempotent consumers (deduplicate via idempotency_key)
13. Defence-in-depth token validation (JWT signature + Valkey state)
14. Centralized asset service (modules reference asset_id)
15. Presence-based grants (row exists = permission granted, no boolean flag)
16. Permission grid resolved at login, cached in Valkey, invalidated on policy change
17. Unsaved changes guard on FE navigation
18. Cascading dropdowns in bulk template (INDIRECT + hidden sheets)
19. Relaxed API contract (only 3 fields required) + strict FE forms
20. Name uniqueness per org (case-insensitive) on all entities
21. Atomic employee creation with full rollback on failure
22. Parallel async checks (asyncio.gather for setup progress)
23. Module activation control (super admin assigns, org admin toggles)
24. Three layout shells (wizard, post-setup, super admin) for UI isolation
25. Options as separate collection (independent CRUD after definition creation)
26. Session expired modal for graceful UX on token expiry
27. Multi-flow exit lifecycle (employee → manager → HR → clearances → auto-completion)
28. Layout variant context for adaptive page styling across portal shells
29. Field-level encryption for sensitive financial data (CTC, band amounts) via Fernet with single `ENCRYPTION_KEY`
30. Per-employment-type emp-code counters (F/C/I) and start offsets to allow custom numbering schemes per BU
31. Session payload enrichment with department_id to spare downstream microservices an IAM round-trip
32. Per-department clearance checklists drive IT/Admin/Finance verification UIs (auto-seeded on first read)
33. Tenant scoping enforced at the data layer (not just the router) on org documents and custom-field options
34. CTC revisions preserved as an encrypted number-keyed version map (highest key = current; append-only)
35. In-app document viewing streams bytes through the API (CORS-safe) instead of the public bucket URL
36. Deterministic list ordering before pagination (employees by emp_code, designations by name)
37. Employee-facing document access resolved server-side from the caller's employee record (BU + dept + worker type)

---

## 35. CRITICAL RULES

1. `emp_code` server-generated via atomic BU counter, never from payloads
2. `emp_code_prefix` unique per org, uppercase, 1-10 chars
3. Each entity owns distinct Address docs (not shared)
4. Employee create atomic (addresses + user + employee, rollback all on failure)
5. Folder delete cascades to docs + assets (soft-delete)
6. Master data fields as ObjectIds, never strings (resolved via $lookup)
7. Global master data deletion forbidden (403)
8. All queries filter `deleted_on: None` (soft-delete pattern)
9. `setup_progress` refreshed on every entity create/delete/update that affects it
10. Organisation step requires address + date_of_incorporation + currency + timezone
11. Mandatory steps: Organisation, BU, Departments, Policies
12. Roles are `is_role=true` policies, created separately and assigned directly to employees via `roleIds` (designations no longer own policies)
13. All outbox events include `idempotency_key` + `correlation_id`
14. Never publish directly to RabbitMQ — always through outbox
15. Consumers must deduplicate via `idempotency_key`
16. Core HR module is mandatory in enabled_modules (schema validator enforces, always is_active=True)
17. Access token session payload always includes permissions grid (even for admins — full grid)
18. Password changes revoke ALL sessions (refresh + access token caches)
19. Email changes require double opt-in (confirmation link to NEW address)
20. Asset uploads capped at 2 MB with MIME type whitelist
21. Policy permission changes invalidate Valkey sessions for all policy holders
22. L1/L2 managers are optional; any provided manager must exist in the org and not be the employee (no hierarchy-based requirement)
23. Bulk upload validates the BU → Department link; designation + role are resolved by name within the org (designations are org-level, not dept-scoped)
24. Entity names unique per org (case-insensitive), self-excluded on update — **except designations**, whose names need not be unique
25. Valkey/RabbitMQ startup failures are non-fatal (degraded mode)
26. Inactivation blocked by 409 if active dependents exist (dependency_check enforced in update path)
27. Folder inactivation requires all documents deactivated first (deactivate-all-documents helper)
28. Policy inactivation blocked if users are assigned (409 with user count)
29. Org admins can toggle module is_active but cannot add/remove modules (403)
30. 12 modules in ModuleEnum, **36 permission codes** in PermissionCodeEnum
31. Module-specific permission codes: Core HR (7 codes incl. create_resource), Timesheet Management (7 codes), Leave Management (**8 codes** incl. `leave_balance`), Service Request (7 codes)
32. Custom field options are separate documents with independent CRUD (not embedded in definition)
33. Activation email embeds password-reset link as fallback
34. Exit request code auto-generated: `EXR-{YYYY}-{NNNN}` with org-scoped counter
35. Exit clearances auto-complete: all 3 clearances done → `awaiting_exit_interview`; then interview submitted → `completed`
36. Exit management uses outbox-backed email events (6 event types) for multi-party notifications
37. Employee CTC and Band min/max amounts are Fernet-encrypted at rest via `ENCRYPTION_KEY`; decrypted on read with no role-based redaction (gap to address)
38. Employee emp_code format: full-time `{PREFIX}-{counter}` (no letter); contract/internship `{PREFIX}-{C|I}-{counter}`; counter = `emp_code_start_from[L] + emp_code_last_numbers[L]++` (atomic per-type `$inc`, letter ∈ {F, C, I})
39. Employee create requires business_unit_id + department_id + employment_type (HTTP 400 if missing) — draft-without-BU branch removed
40. Bulk-upload XLSX template requires 9 columns (was 3): first_name, last_name, work_email, business_unit, department, designation, employment_type, reporting_manager, gender
41. `MasterDataCompact` carries `is_active` flag; employment_status filter accepts magic strings `"active"`/`"inactive"`; UserDocument.status is synced from employment_status on update
42. Both `employee.created` and `employee.updated` RabbitMQ payloads include `date_of_joining`
43. Department with multiple BUs requires `primary_business_unit` (must be one of `business_units`); single-BU auto-sets primary
44. Business Unit's `emp_code_prefix` and `emp_code_start_from` are immutable against value-changes once any employee references the BU (no-op same-value updates allowed)
45. Custom-field options and org documents enforce cross-tenant guards at the data layer (option's parent definition / folder must match caller's org); PUT /values rejects cross-entity-type definitions and unknown option IDs; `delete_entity_values` is mandatorily scoped by (org_id + entity_id + entity_type)
46. Department checklists are auto-seeded for IT / ADMIN / FINANCE on first read (per org)
47. Service-request permissions migrated from single `create_resource` to 7 role-based codes via `scripts/migrate_service_request_permissions.py` (idempotent)
48. Session payload includes `department_id` looked up from EmployeeDocument; dept-lookup failure is non-fatal
49. Employee `business_unit_id` + `employment_type` are immutable after create (emp_code derived from both; 400 on actual change)
50. Employee `ctc` is an append-only version map — updates go through `revise_ctc`, history is never overwritten
51. Org-document downloads are opt-in (`allow_download` defaults False)
52. Document acknowledgements are one-way + idempotent — unique `(document_id, user_id)`, first timestamp wins, 400 if the document doesn't require acknowledgement
53. Employee-facing `/org-documents/my/*` access is scoped server-side (folder visible only when custom_access off OR BU + dept + worker type all match)

---

## 36. EXIT MANAGEMENT

Full exit lifecycle module under `src/modules/exit_management/`. Part of Core HR module permissions.

### 36.1 Data Model (6 Collections)

**`exit_requests`** — `ExitRequestDocument`:
- `organisation_id`, `employee_id`, `request_code` (auto-generated `EXR-{YYYY}-{NNNN}`)
- `last_working_day`, `reason`, `other_reason`, `additional_details`
- `status`: pending_approval → under_review → approved → awaiting_clearances → **awaiting_exit_interview** → completed | rejected | withdrawn | archived | deactivated
- `exit_type` (resignation default), `hr_initiated`, `immediate_exit`
- `rejection_reason`, `approved_by`, `approved_on`
- `deactivated_on`, `deactivated_by`
- `requested_last_working_day` (original date before manager adjustment)
- `parent_request_id` (links reapply to rejected original)
- `document_ids` (attached asset references)
- `manager_completed_checklist`, `hr_completed_checklist` (list[str]) — checklist items the manager (on approve) and HR (on initiate-clearances / deactivate) ticked off; HR steps accept an optional `HRChecklistSubmit { completedChecklist }`
- Indexes: (org_id, employee_id), (org_id, status), unique (request_code, org_id) partial, (created_on DESC)

**`exit_interviews`** — `ExitInterviewDocument`:
- `exit_request_id`, `employee_id`, `organisation_id`
- `reason_for_leaving`, `other_reason`, `overall_rating` (0.5–5), `liked_most`, `improvements`, `manager_feedback`
- Index: unique (exit_request_id) partial on deleted_on: null

**`it_asset_returns`** — `ITAssetReturnDocument`:
- `exit_request_id`, `employee_id`, `organisation_id`
- `asset_type`, `asset_id`, `serial_number`, `model`
- `issued_date`, `returned_date`
- `status`: pending → returned → verified | not_cleared
- `condition`, `verification_notes`, `verified_by`, `verified_on`
- `completed_checklist: list[str]` — chosen items from `department_checklists` for "IT"
- Indexes: (org_id, status), (org_id, employee_id), unique (exit_request_id, asset_id)

**`admin_tasks`** — `AdminTaskDocument`:
- `exit_request_id`, `employee_id`, `organisation_id`
- `task_type`, `details`, `desk_number`, `locker_number`
- `issued_date`, `submitted_date`
- `status`: pending → returned → completed
- `completed_checklist` (list), `notes`, `completed_by`, `completed_on`
- Indexes: (org_id, status), (org_id, employee_id), (task_type)

**`finance_clearances`** — `FinanceClearanceDocument`:
- `exit_request_id`, `employee_id`, `organisation_id`
- `amount_due`, `settlement_date`, `notice_period_days`
- `status`: pending → under_review → approved → sent_to_payroll → paid | not_cleared
- `clearance_reason`, `remarks`, `cleared_by`, `cleared_on`
- `completed_checklist: list[str]` — chosen items from `department_checklists` for "FINANCE"
- Indexes: (org_id, status), (settlement_date DESC), unique (exit_request_id)

**`department_checklists`** — `DepartmentChecklistDocument`:
- `organisation_id`, `dept_id` (e.g. `"IT"`, `"ADMIN"`, `"FINANCE"`), `dept_name`
- `items: list[str]` — checklist line items shown on the clearance form for that department
- Indexes: unique compound `(organisation_id, dept_id)`
- Auto-seeded with defaults for IT / ADMIN / FINANCE on first read when no rows exist for the org.

### 36.2 Exit Lifecycle Flows

**Employee flow:**
1. Create exit request → status = `pending_approval`
2. Can update (only while pending), withdraw (pending/approved/awaiting), or reapply (after rejection, creates new request linked via `parent_request_id`)
3. Submit exit interview (allowed for approved/pending/awaiting/completed/deactivated requests, one per request)

**Manager flow:**
1. View team exit requests (with enriched employee details: role, department, date of joining, reporting manager)
2. Approve → sets `approved_by/on`, saves original as `requested_last_working_day`, allows `final_last_working_day` override
3. Reject → `standard` or `retention` action type, rejection reason required

**HR flow:**
1. View all org exit requests (enriched with emp_type, grade, phone, sub_dept)
2. Initiate clearances → creates IT asset return + admin task + finance clearance records, transitions to `awaiting_clearances`
3. Deactivate employee → sets status to `deactivated`
4. Send clearance reminders

**IT Admin flow:**
- List IT asset returns with filters (status, asset_type)
- Verify assets (set condition + notes)

**Admin flow:**
- List admin tasks with filters (status, task_type)
- Complete tasks (checklist + notes)

**Finance flow:**
- List finance clearances with filters (status, department, date range)
- Update clearance status (reason + remarks required for `not_cleared`)

### 36.3 Auto-Completion

After any clearance action (IT verify, admin complete, finance status update, interview submit), `_check_and_complete_clearances` runs:
- If IT = verified AND admin = completed AND finance = approved/paid/sent_to_payroll AND interview NOT submitted → transition exit request to `awaiting_exit_interview` status
- Once interview is also submitted → transition exit request to `completed` status + send completion email
- `submit_exit_interview` accepts `awaiting_exit_interview` as a valid pre-condition (alongside approved / pending / awaiting / completed / deactivated)

### 36.4 Email Notifications

6 outbox-backed email events via `email_events.py`:

| Event | Recipients | Trigger |
|-------|-----------|---------|
| `exit_request_raised` | L1 manager + org admins (HR) | Employee creates exit request |
| `exit_manager_approved` | Employee + org admins (HR) | Manager approves |
| `exit_manager_rejected` | Employee + org admins (HR) | Manager rejects |
| `exit_clearances_initiated` | Employee + L1 manager | HR initiates clearances |
| `exit_clearances_assigned` | Org admins (clearance team) | HR initiates clearances |
| `exit_completed` | Employee + L1 manager + org admins | All clearances complete |

### 36.5 Response Enrichment

- **ExitRequestResponse:** employee_name, employee_email, emp_code (via employee → user lookups), `itClearanceStatus`, `adminClearanceStatus`, `financeClearanceStatus` (joined from clearance docs via async `_enrich_response`)
- **TeamExitRequestResponse:** + employee_role (designation), department, date_of_joining, current_location, reporting_manager_name, notice_period_days
- **HRExitRequestResponse:** + sub_dept, emp_type, grade, phone
- **IT/Admin/Finance responses:** + request_code, employee_name, emp_code, department, last_working_day (via exit_request + employee lookups), `exitRequestStatus`, and cross-clearance statuses (`itClearanceStatus` / `adminClearanceStatus` / `financeClearanceStatus`)
- **IT/Admin Summary responses:** + `notCleared` count

### 36.6 Permission Gating

All exit management endpoints — including the 9 IT/Admin/Finance clearance endpoints and the new `/checklists` endpoints — are gated by `require_permission("core_hr", "create_resource")`. Commit `edb1127` migrated the IT (was `asset_management:create_resource`), Admin (was `asset_management:create_resource`), and Finance (was `payroll:create_resource`) endpoints onto this single Core HR code. Core HR module permissions also include 6 exit-specific fine-grained codes (`apply_exit_request`, `approve_exit_request`, `monitor_exit_request`, `it_clearances`, `admin_clearances`, `final_settlement`) — wiring those into individual endpoints is still pending (see Open Items).

### 36.7 Department Checklists

`DepartmentChecklistDocument` provides per-org, per-department clearance item lists used by the IT / Admin / Finance verification UIs.

**Endpoints (under `/exit-management`):**
- `GET /checklists?deptId=<dept_id>` → `list[DepartmentChecklistResponse]` — auto-seeds IT/ADMIN/FINANCE defaults on first read if the org has none.
- `PUT /checklists` (body: `{ deptId, deptName, items }`) → upsert checklist for a department.

**Usage:** When IT verifies an asset / Admin completes a task / Finance updates a clearance, the request can include `completedChecklist: list[str]` (items chosen from the relevant department's checklist), which is persisted on the clearance doc.

---

## 37. OPEN ITEMS

- RabbitMQ downstream consumers (email service, notification service)
- Request-Reply (RPC) pattern for synchronous cross-service calls
- DLQ processing for failed messages
- Leave Management module implementation (placeholder route exists)
- Attendance Management module implementation
- Timesheet Management module implementation (placeholder route exists)
- Service Request Management module implementation (SRM seed data exists, separate microservice)
- Custom field search/filtering
- Employee self-service portal
- Role-based sidebar filtering enforcement on BE routes
- PostgreSQL support (DATABASE_TYPE config exists but MongoDB is primary)
- FE dependency check UI (confirm dialog with dependency list before inactivation)
- Custom permissions page (placeholder route at /settings/custom-permissions)
- ViewOrganisation page (super admin — removed or not yet reimplemented)
- Exit management FE pages (BE complete, no FE exit management pages yet)
- Exit management: fine-grained permission gating (currently all endpoints use `create_resource`, should use exit-specific codes like `apply_exit_request`, `approve_exit_request`, etc.)
- Exit management: l1_manager_id filtering for team requests (TODOs in service.py — currently shows all org requests)
- **CTC role-based redaction:** `_normalize` decrypts `ctc` unconditionally — anyone authorised to read an employee sees their salary. Should be HR/manager-gated.
- **Encryption-key rotation strategy:** no scripted re-encryption; corrupt / wrong-key reads silently return `None`. Rotation requires a backfill job (still to design).
- **Legacy band-amount migration:** new writes always encrypt, but `_coerce_legacy_numeric` allows mixed encrypted + plaintext rows over time. Optional backfill job to encrypt legacy rows once.
- **employee.updated diff drift:** commit `61385e2` ("added the date of joining in the rabbit mq to the lms") added `date_of_joining` to the `employee.updated` payload only; `employee.created` already carried it from earlier — confirm downstream consumers handle both.
- **Inactive employment-status workflow:** activation email is skipped on create when the status is inactive, but there is no explicit UX to (re)issue activation when a previously-inactive employee is reactivated.
- **department_checklists FE wiring:** auto-seed only fires on first GET; orgs that never hit `GET /checklists` will not have default checklists materialised.
- **Duplicate `CtcHistoryEntry` / `ctc_history` declarations in `employees/schema.py`:** the file defines `CtcHistoryEntry` twice ( `{amount, currency, updated_on}` then `{value, updated_on}` ) and declares `ctc_history` twice on `EmployeeResponse` (dict then list). Python/Pydantic resolve to the **later** definitions, so history entries serialize as `{value: null, updatedOn}` — dropping the `amount`/`currency` the FE `CtcHistoryEntryDTO` expects. Needs dedup to the first class.
- **CTC history redaction:** like the current `ctc`, `ctc_history` is returned decrypted to anyone who can read the employee — the role-based redaction gap now also covers the full salary trail.
- **allow_download not enforced on `/content`:** the employee `/my/documents/{id}/content` endpoint streams bytes regardless of `allow_download` (the flag only drives FE download UI); admins can always download. Decide whether the flag should gate the employee byte stream too.
