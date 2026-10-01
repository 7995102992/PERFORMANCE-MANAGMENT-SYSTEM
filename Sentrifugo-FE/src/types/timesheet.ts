import type { AuditFields } from './leave'

// ─── Enums ────────────────────────────────────────────────────

export type TimesheetStatus =
  | 'draft'
  | 'submitted'
  | 'l1_approved'
  | 'l1_rejected'
  | 'client_approved'
  | 'client_rejected'
  | 'resubmitted'

export type ProjectApprovalStatus =
  | 'submitted'
  | 'resubmitted'
  | 'l1_approved'
  | 'l1_rejected'
  | 'client_approved'
  | 'client_rejected'

export interface TimesheetProjectApproval {
  project_id: string
  project_name: string
  status: ProjectApprovalStatus
  submitted_by_id: string
  submitted_by_name: string | null
  l1_approver_id: string | null
  l1_approver_name: string | null
  l1_acted_at: string | null
  l1_comments: string | null
  client_approver_id: string | null
  client_approver_name: string | null
  client_acted_at: string | null
  client_comments: string | null
}

export type ProjectStatus = 'active' | 'inactive' | 'completed' | 'on_hold'
export type ProjectType = 'time_and_materials' | 'fixed_fee' | 'non_billable'
export type EntityStatus = 'active' | 'inactive'

// ─── Paginated Response ───────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

// ─── Clients ──────────────────────────────────────────────────

export interface ClientCreate {
  name: string
  contact_person: string
  contact_email: string
  contact_phone: string
  country: string
  state: string
  business_unit_ids: string[]
  department_ids: string[]
  address?: string | null
  fax?: string | null
  portal_access_enabled?: boolean
  notes?: string | null
  status?: EntityStatus
}

export interface ClientUpdate {
  name?: string | null
  contact_person?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  address?: string | null
  country?: string | null
  state?: string | null
  business_unit_ids?: string[] | null
  department_ids?: string[] | null
  fax?: string | null
  portal_access_enabled?: boolean | null
  notes?: string | null
  status?: EntityStatus | null
}

export interface ClientResponse extends AuditFields {
  id: string
  organisation_id: string
  name: string
  contact_person?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  address?: string | null
  country?: string | null
  state?: string | null
  business_unit_ids?: string[] | null
  department_ids?: string[] | null
  business_unit_names?: string[] | null
  department_names?: string[] | null
  fax?: string | null
  portal_access_enabled: boolean
  notes?: string | null
  status: EntityStatus
}

// ─── Projects ─────────────────────────────────────────────────

export type BillableRateType = "per_hour" | "per_day"
export type BillableOn = "project" | "resource"

export interface ProjectCreate {
  client_id: string
  name: string
  code?: string | null
  description?: string | null
  project_type?: ProjectType
  start_date?: string | null
  end_date?: string | null
  budget_hours?: number | null
  budget_cost?: number | null
  billable_rate?: number | null
  billable_rate_type?: BillableRateType | null
  billable_on?: BillableOn | null
  currency?: string
  project_head_ids?: string[] | null
  send_alerts?: number | null
  client_approval_required?: boolean
  is_internal?: boolean
}

export interface ProjectUpdate {
  name?: string | null
  code?: string | null
  description?: string | null
  project_type?: ProjectType | null
  project_status?: ProjectStatus | null
  start_date?: string | null
  end_date?: string | null
  budget_hours?: number | null
  budget_cost?: number | null
  billable_rate?: number | null
  billable_rate_type?: BillableRateType | null
  billable_on?: BillableOn | null
  currency?: string | null
  project_head_ids?: string[] | null
  send_alerts?: number | null
  client_approval_required?: boolean
  is_internal?: boolean | null
}

export interface ProjectResponse extends AuditFields {
  id: string
  organisation_id: string
  client_id: string
  /**
   * Denormalised client name — present on list, detail, create and update, so
   * nothing needs to read /clients just to label a project. Null only when the
   * client record is missing, which shouldn't happen for a live project.
   */
  client_name?: string | null
  name: string
  code?: string | null
  description?: string | null
  project_type: ProjectType
  project_status: ProjectStatus
  start_date?: string | null
  end_date?: string | null
  budget_hours?: number | null
  budget_cost?: number | null
  billable_rate?: number | null
  billable_rate_type?: BillableRateType
  billable_on?: BillableOn
  currency: string
  project_head_ids?: string[] | null
  /**
   * Denormalised head names. Index-aligned with `project_head_ids` EXCEPT where
   * a head's IAM record no longer resolves — that entry is dropped rather than
   * failing the request, so the two arrays can differ in length. Render this
   * array directly; don't pair it positionally with the ids.
   */
  project_head_names?: string[] | null
  send_alerts?: number | null
  client_approval_required?: boolean
  is_internal?: boolean | null
}

// ─── Tasks ────────────────────────────────────────────────────

export interface TaskCreate {
  name: string
  description?: string | null
  is_global?: boolean
  is_billable?: boolean
  is_time_off?: boolean
  is_frequent?: boolean
  estimated_hours?: number | null
  billable_rate?: number | null
}

export interface TaskUpdate {
  name?: string | null
  description?: string | null
  is_global?: boolean | null
  is_billable?: boolean | null
  is_frequent?: boolean | null
  status?: EntityStatus | null
}

export interface TaskResponse extends AuditFields {
  _id?: string
  id: string
  organisation_id: string
  /**
   * null = shared task: created via POST /tasks, or flagged global/frequent.
   * Offered to every project, name unique across the organisation.
   * Set = owned by that project only, name unique within the project, so two
   * projects can each have their own "Design".
   */
  project_id?: string | null
  name: string
  description?: string | null
  is_global: boolean
  is_billable: boolean
  is_time_off?: boolean | null
  is_frequent: boolean
  estimated_hours?: number | null
  billable_rate?: number | null
  notes?: string | null
  status: EntityStatus
}

/**
 * POST /projects/{project_id}/tasks does double duty — send EXACTLY ONE of
 * task_id (link an existing shared task) or name (create a task owned by this
 * project). Both, or neither, is a 422.
 *
 * When creating inline, is_global/is_frequent make it a SHARED task instead of
 * a project-owned one, which brings back organisation-wide name uniqueness.
 * add_to_all_existing only applies to shared tasks.
 */
export interface ProjectTaskCreate {
  task_id?: string
  name?: string
  description?: string | null
  is_billable?: boolean
  is_time_off?: boolean
  is_frequent?: boolean
  is_global?: boolean
  estimated_hours?: number | null
  billable_rate?: number | null
  notes?: string | null
  add_to_all_existing?: boolean
}

// PUT /projects/{project_id}/tasks/{task_id}. Fields split across two records:
// estimated_hours / billable_rate / notes are per-project overrides, everything
// else edits the shared task record visible in every project it is assigned to.
// Unknown keys are rejected with 422 — send only what the form owns.
export interface ProjectTaskUpdate {
  name?: string | null
  description?: string | null
  is_global?: boolean | null
  is_billable?: boolean | null
  is_time_off?: boolean | null
  is_frequent?: boolean | null
  estimated_hours?: number | null
  billable_rate?: number | null
  notes?: string | null
}

export interface ProjectTaskResponse extends AuditFields {
  _id: string
  id?: string
  /** The project this link belongs to. The task's OWNER is task.project_id,
   *  which is null for shared tasks — the two are not the same thing. */
  project_id: string
  task_id: string
  task_name?: string | null
  task?: TaskResponse
  description?: string | null
  estimated_hours?: number | null
  billable_rate?: number | null
  notes?: string | null
  is_global?: boolean | null
  is_billable?: boolean | null
  is_time_off?: boolean | null
  is_frequent?: boolean | null
  is_active?: boolean | null
}

// ─── Resources ────────────────────────────────────────────────

// An assignment covers EITHER the whole project (no tasks) OR a specific set of
// tasks — never both. An empty/omitted task_ids means project level. The backend
// stores one row per task and returns the whole set as an array.
export interface ResourceAssignmentCreate {
  user_id: string
  task_ids?: string[] | null
  /** @deprecated merged into task_ids server-side — send task_ids instead */
  task_id?: string | null
  role?: string | null
  allocation_percentage?: number
  billable_rate?: number | null
  is_billable?: boolean
  start_date?: string | null
  end_date?: string | null
}

// PUT rejects unknown keys (extra="forbid") — never send task_id here.
// Including task_ids REPLACES the whole task selection (send the full desired
// set, not a delta); omitting it leaves the task set untouched; [] converts the
// assignment to project level.
export interface ResourceAssignmentUpdate {
  task_ids?: string[]
  role?: string | null
  allocation_percentage?: number | null
  billable_rate?: number | null
  is_billable?: boolean | null
  start_date?: string | null
  end_date?: string | null
  status?: EntityStatus | null
}

/**
 * Removing a resource closes the allocation on a date rather than deleting it:
 *
 *   allocated  live and fully editable
 *   ending     removed, end_date not yet passed — still logging time, read-only
 *   removed    removed and past the date — read-only, final (TSM-037 on edit)
 *
 * Note this is NOT the `status` field, which stays "active" by design so time
 * entry keeps working up to the end date.
 */
export type AllocationStatus = 'allocated' | 'ending' | 'removed'

export interface ResourceAssignmentResponse extends AuditFields {
  _id: string
  id?: string
  allocation_status?: AllocationStatus
  /** When the manager issued the removal; null while the allocation is live */
  released_on?: string | null
  project_id: string
  task_id?: string | null
  user_id: string
  user_name?: string | null
  emp_code?: string | null
  department?: string | null
  role?: string | null
  allocation_percentage: number
  billable_rate?: number | null
  is_billable: boolean
  start_date?: string | null
  end_date?: string | null
  status: EntityStatus
  removal_comment?: string | null
  removal_history?: unknown[] | null
}

// ─── Timesheets ───────────────────────────────────────────────

export interface WeeklyTimesheetCreate {
  week_start_date: string
  notes?: string | null
}

export interface TimesheetEntryInput {
  project_id: string
  task_id: string
  entry_date: string
  hours: number
  notes?: string | null
}

export interface TimesheetEntriesBulk {
  entries: TimesheetEntryInput[]
}

export interface TimesheetEntryResponse extends AuditFields {
  id: string
  weekly_timesheet_id: string
  project_id: string
  task_id: string
  entry_date: string
  hours: number
  notes?: string | null
  is_billable: boolean
}

export interface WeeklyTimesheetResponse extends Omit<AuditFields, 'created_by'> {
  id: string
  organisation_id: string
  user_id: string
  user_name?: string | null
  emp_code?: string | null
  week_start_date: string
  week_end_date: string
  total_hours: number
  billable_hours: number
  non_billable_hours: number
  timesheet_status: TimesheetStatus
  /**
   * Whether this viewer can approve or reject THIS week. Present on
   * GET /approvals/employees/{id}/timesheets, which is what the detail sheet's
   * week tabs render from.
   *
   * Per week, not per employee-month: that endpoint isn't project-filtered, so
   * consecutive weeks can touch different projects and your relationship to
   * them can differ — one week actionable, the next only watched. Never
   * propagate a list-level `read_only` down here; the two won't always agree.
   *
   * It's the answer, not the reason — true both for a week you only watch and
   * for one touching no project you have a claim on. Don't re-derive it from
   * `timesheet_status`: status says where the sheet is in the workflow, not
   * whether you may act on it.
   */
  read_only?: boolean
  submitted_at?: string | null
  notes?: string | null
  entries?: TimesheetEntryResponse[]
  project_names?: string[]
  project_tasks?: { project_name: string; task_name: string }[]
  daily_entries?: Record<string, { project_name: string; task_name: string; hours: number }[]>
  created_by?: string | null
  project_approvals?: TimesheetProjectApproval[]
  work_calendar?: WorkCalendar | null
}

// Work-calendar day types for a week (ISO date strings), from weekend_matrix
export interface WorkCalendar {
  weekoffs: string[]
  first_half_days: string[]
  second_half_days: string[]
}

// ─── Summary ─────────────────────────────────────────────────

export interface TimesheetSummaryResponse {
  total: number
  draft: number
  submitted: number
  l1_approved: number
  l1_rejected: number
  client_approved: number
  client_rejected: number
  resubmitted: number
  pending_approval: number
}

// ─── Approvals ────────────────────────────────────────────────

export interface ManagerDashboardResponse {
  total: number
  submitted: number
  resubmitted: number
  l1_approved: number
  l1_rejected: number
  client_approved: number
  client_rejected: number
}

export interface ApprovalActionPayload {
  comments?: string | null
}

export interface BulkApprovalPayload {
  timesheet_ids: string[]
  comments?: string | null
}

export interface BulkRejectPayload {
  timesheet_ids: string[]
  comments: string
}

export interface EmployeeDetailResponse {
  user_id: string
  user_name: string | null
  total_submitted: number
  approved: number
  rejected: number
  client_approved: number
  pending_manager: number
  pending_client: number
  client_rejected: number
}

export interface WeeklyTimelineRow {
  project_id: string
  project_name: string | null
  task_id: string
  task_name: string | null
  mon: number
  tue: number
  wed: number
  thu: number
  fri: number
  sat: number
  sun: number
  total: number
}

export interface ApprovalHistoryRecord {
  id: string
  approver_id: string
  approver_name?: string | null
  approver_role: string
  approval_level: number
  action: string
  comments: string | null
  acted_at: string | null
  scope_project_ids?: string[]
}

// Leave / holiday as LMS reports them — passed straight through, same shape the
// team-calendar endpoint serves per employee.
export interface TimesheetLeave {
  id: string
  leave_type_id: string
  leave_type_name: string
  start_date: string
  end_date: string
  duration_mode: 'FULL_DAYS' | 'HALF_DAY'
  half_day_period: string | null
  start_session: string | null
  end_session: string | null
  duration_hours: number
  duration_days: number
  status: string
  reason: string
}

export interface TimesheetHoliday {
  id: string
  name: string
  date: string
  description: string | null
  classification_name: string
  classification_color: string
}

export interface TimesheetDetailResponse extends WeeklyTimesheetResponse {
  /**
   * Whether this viewer may act on the sheet, or only read it.
   *
   * Resolved approver-scope-first server-side: a shared project stays
   * actionable even when you also watch it through your reporting line. Gate
   * approve / reject on this, never on which tab you arrived from — a deep
   * link or a refresh has no tab.
   *
   * Optional because older cached responses predate it; treat absent as
   * actionable, which is the pre-existing behaviour.
   */
  read_only?: boolean
  /**
   * Whether this caller may reopen the month named by `reopen_period`.
   *
   * ENTITLEMENT, not state — it stays true for a month that is already open.
   * For "is it open right now", read
   * GET /approvals/employees/{userId}/past-submission-overrides.
   *
   * True only when the cutoff has actually closed that month AND the caller
   * would not be refused. It runs through the same predicate the POST does, so
   * the button and the endpoint cannot disagree.
   */
  can_reopen?: boolean
  /**
   * The month `can_reopen` is about, stated rather than inferred.
   *
   * On the weekly detail this is the WEEK's own month, which for a straddling
   * week (Mon 27 Jul – Sun 2 Aug) is July even when opened from an August
   * view. Never compare this response's flag with the monthly one's: they
   * answer about different months by design.
   */
  reopen_period?: { year: number; month: number } | null
  weekly_timeline?: WeeklyTimelineRow[]
  approval_history?: ApprovalHistoryRecord[]
  project_approvals?: TimesheetProjectApproval[]
  /**
   * Scoped to this timesheet's week. OPTIONAL and possibly empty: LMS is reached
   * over RPC and the backend degrades to [] rather than failing the request, and
   * older cached responses omit them entirely. An empty array therefore means
   * "nothing to show", never "no leave was taken" — don't state the negative.
   * Not present on the client-facing detail; leave records aren't client data.
   */
  leaves?: TimesheetLeave[]
  holidays?: TimesheetHoliday[]
}

// ─── Client Portal ──────────────────────────────────────────

export interface ClientDashboardResponse {
  total: number
  pending: number
  approved: number
  rejected: number
}

export interface ClientTimesheetItem extends WeeklyTimesheetResponse {
  project_name?: string | null
  client_approval_required?: boolean
}

export interface DailyBreakdownTask {
  project_name: string
  task_name: string
  hours: number
  notes: string | null
  is_billable: boolean
}

export interface DailyBreakdownEntry {
  date: string
  day: string
  hours: number
  comments: string
  tasks: DailyBreakdownTask[]
}

export interface ProjectContext {
  project_name: string
  client_name: string
  project_code: string | null
  project_type: string
  billing_status: string
}

export interface ClientTimesheetDetailResponse extends WeeklyTimesheetResponse {
  daily_breakdown?: DailyBreakdownEntry[]
  project_context?: ProjectContext | null
  total_weekly_hours?: number
  approval_history?: ApprovalHistoryRecord[]
  project_approvals?: TimesheetProjectApproval[]
  client_approval_required?: boolean
}

export interface ActivityHistoryItem {
  id: string
  acted_at: string | null
  approver_id: string
  approver_name: string | null
  approver_role: string
  employee_id: string
  employee_name: string
  project_names: string[]
  hours: number
  action: string
  comments: string | null
}

export interface ActivityHistorySummary {
  total_reviews: number
  approved_mtd: number
  rejected_mtd: number
  avg_decision_time_hours: number
}

export interface ActivityHistoryResponse {
  items: ActivityHistoryItem[]
  total: number
  page: number
  page_size: number
  summary: ActivityHistorySummary
}

// ─── Client Project Heads ─────────────────────────────────────

export interface ProjectHeadCreate {
  client_id: string
  first_name: string
  last_name: string
  email: string
  phone?: string | null
}

export interface ProjectHeadUpdate {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  status?: EntityStatus | null
}

export interface ProjectHeadResponse {
  id: string
  organisation_id: string
  client_id: string
  first_name: string
  last_name: string
  email: string
  phone?: string | null
  iam_user_id?: string | null
  status: EntityStatus
  created_by?: string | null
  created_on: string
  modified_by?: string | null
  modified_on?: string | null
}

/**
 * GET /client-project-heads/available?client_id=… — who can be assigned as a
 * project head for the given client, in two independently-rendered groups.
 * Anyone already heading that client is excluded from BOTH lists, so a
 * selection can never collide.
 */

/** Active employee whose BU is one of the client's BUs AND whose department is
 *  one of the client's departments. Reuses their existing IAM login on assign. */
export interface AvailableEmployeeHead {
  user_id: string
  emp_code: string
  first_name: string
  last_name: string
  email: string
  business_unit_id: string
  business_unit_name: string
  department_id: string
  department_name: string
}

/** Existing external head, deduped to one entry per person. */
export interface AvailableExternalHead {
  id: string
  first_name: string
  last_name: string
  email: string
  phone?: string | null
  iam_user_id?: string | null
  client_ids: string[]
  client_names: string[]
}

export interface AvailableProjectHeadsResponse {
  employees: AvailableEmployeeHead[]
  external_heads: AvailableExternalHead[]
  total: number
}

/** POST /client-project-heads/bulk-assign — both groups expose exactly these
 *  fields, so employees and external contacts go into one uniform array. */
export interface ProjectHeadBulkAssignItem {
  first_name: string
  last_name: string
  email: string
  phone?: string | null
}

export interface ProjectHeadBulkAssign {
  client_id: string
  heads: ProjectHeadBulkAssignItem[]
}

/** Re-assigning an already-assigned person is SKIPPED, not a 409 — one
 *  duplicate never fails the batch. */
export interface ProjectHeadBulkAssignResponse {
  created: ProjectHeadResponse[]
  skipped: Array<Record<string, unknown>>
  total_created: number
  total_skipped: number
}

// ─── Settings ─────────────────────────────────────────────────

export interface ApprovalLevelConfigResponse {
  level: number
  approver_role: string
  approver_id?: string | null
}

export interface TimesheetSettingsResponse {
  _id: string
  organisation_id: string
  project_id?: string | null
  // Hour settings
  daily_restrictions_enabled: boolean
  min_hours_per_day: number
  max_hours_per_day: number
  deduct_leave_daily: boolean
  weekly_restrictions_enabled: boolean
  standard_hours_per_day: number
  max_hours_per_week: number
  deduct_leave_weekly: boolean
  show_hours_type: string
  shortage_penalty_enabled: boolean
  penalty_percentage: number
  // Submission settings
  daily_time_entry_enabled: boolean
  allow_past_due_submission: boolean
  restrict_time_off_entries: boolean
  allow_attachment: boolean
  submission_compliance_type: string
  submission_deadline_hours: number
  submission_day: string
  submission_time: string
  auto_submit_enabled: boolean
  // Approval settings
  approval_required: boolean
  allow_future_entries: boolean
  // A timesheet period closes on this day of the month: once it passes, weeks
  // that already ended are frozen until a project manager reopens the month.
  // Values past a month's length clamp to its last day, so 31 = month end.
  past_submission_cutoff_enabled: boolean
  past_submission_cutoff_day: number
  approval_levels: ApprovalLevelConfigResponse[]
  client_notify_on_pending_count_enabled: boolean
  client_notify_pending_count: number
  client_notify_on_schedule_enabled: boolean
  client_notify_schedule: "weekend" | "month_end"
  employee_reminder_enabled: boolean
  employee_reminder_time: string
  employee_reminder_days: EmployeeReminderDays
  /**
   * Master-data ObjectIds of the employment types excluded from timesheet
   * emails — the same value an employee record carries in `employment_type`.
   * An EXCLUSION list, so an empty array (the default) means everyone is
   * notified.
   *
   * Approval traffic only: submitted / resubmitted / edited / approved /
   * rejected. The weekly fill reminder still goes to everyone.
   *
   * Notifications only — people on this list keep every timesheet capability
   * they have; nothing in the UI may gate on it.
   */
  notification_excluded_employment_types?: string[]
  created_on: string
  modified_on: string
}

/** GET /settings/employment-types — active built-ins plus the org's own. */
export interface SettingsEmploymentType {
  /**
   * Master-data ObjectId — the value to submit. Re-seeding master data changes
   * these, and nothing rewrites a stale id server-side: it just matches nobody
   * and that group quietly starts receiving mail again. Re-saving this screen
   * is what repairs it.
   */
  id: string
  /** Stable slug. Not what the setting stores. */
  key: string
  /** Display label. */
  value: string
}

// Per-weekday reminder flags (PUT accepts any subset; GET returns all 7)
export interface EmployeeReminderDays {
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
}

export interface HourSettingsUpdate {
  daily_restrictions_enabled: boolean
  min_hours_per_day: number
  max_hours_per_day: number
  deduct_leave_daily: boolean
  weekly_restrictions_enabled: boolean
  standard_hours_per_day: number
  max_hours_per_week: number
  deduct_leave_weekly: boolean
  show_hours_type: string
  shortage_penalty_enabled: boolean
  penalty_percentage: number
}

export interface SubmissionSettingsUpdate {
  daily_time_entry_enabled: boolean
  allow_past_due_submission: boolean
  restrict_time_off_entries: boolean
  allow_attachment: boolean
  submission_compliance_type: string
  submission_deadline_hours: number
  submission_day: string
  submission_time: string
  auto_submit_enabled: boolean
  client_notify_on_pending_count_enabled: boolean
  client_notify_pending_count: number
  client_notify_on_schedule_enabled: boolean
  client_notify_schedule: "weekend" | "month_end"
  employee_reminder_enabled: boolean
  employee_reminder_time: string
  employee_reminder_days: EmployeeReminderDays
  /**
   * Deliberately on BOTH submission and approval payloads, exactly like the
   * client_notify_* block above it: the control is rendered in the submission
   * tab but the setting is approval-notification config, so either Save must be
   * able to persist it and neither may clear it. Don't "tidy" it out of one.
   */
  notification_excluded_employment_types: string[]
}

export interface ApprovalLevelInput {
  level: number
  approver_role: string
  approver_id?: string | null
}

/**
 * A month reopened for one project after the cutoff closed it. A week belongs to
 * the month its START date falls in, so a week running Mon 27 Jul – Sun 2 Aug is
 * reopened by a July override.
 */
/**
 * One manager's grant reopening one employee's closed month.
 *
 * Per employee + month, but it lifts the cutoff only on the GRANTING manager's
 * projects — `project_ids` is a snapshot of their scope at the moment of
 * granting. So a month is never simply "open": it is open for those projects.
 * Two managers can each grant for the same month, and the employee can refile
 * against the union; they are separate rows, not one on/off state.
 *
 * An admin's grant is unrestricted and returns `project_ids: []`. Empty means
 * ALL projects, never none.
 */
export interface PastSubmissionOverride {
  id: string
  user_id: string
  user_name?: string | null
  year: number
  /** 1-12, unlike JS Date months */
  month: number
  /** Projects this grant unlocks. Empty = every project (admin grant). */
  project_ids?: string[]
  reason?: string | null
  created_by?: string | null
  created_by_name?: string | null
  created_on?: string | null
  /**
   * When this grant lapses — a week after it was made. It closes itself; there
   * is nothing to revoke afterwards.
   *
   * GET returns LIVE grants only, so a lapsed month simply comes back with no
   * rows. Absence is the normal end state, never an error: the button returns
   * to offering a fresh reopen.
   */
  expires_at?: string | null
}

export interface ApprovalSettingsUpdate {
  approval_required: boolean
  allow_future_entries: boolean
  past_submission_cutoff_enabled: boolean
  past_submission_cutoff_day: number
  levels: ApprovalLevelInput[]
  client_notify_on_pending_count_enabled: boolean
  client_notify_pending_count: number
  client_notify_on_schedule_enabled: boolean
  client_notify_schedule: "weekend" | "month_end"
  /** Replaces the stored list wholesale — always send the whole array. */
  notification_excluded_employment_types: string[]
}

// ─── Reports ──────────────────────────────────────────────────

export interface ProjectSummaryItem {
  project_id: string
  project_name?: string | null
  total_hours: number
  total_days: number
  billable_hours: number
  non_billable_hours: number
  resource_count: number
}

export interface EmployeeSummaryItem {
  user_id: string
  user_name?: string
  total_hours: number
  billable_hours: number
  non_billable_hours: number
  submitted_count: number
  approved_count: number
}

// ─── Timeline ────────────────────────────────────────────────

export interface TimelineEntry {
  timestamp: string
  action: string
  actor_id: string
  details: Record<string, unknown>
}
