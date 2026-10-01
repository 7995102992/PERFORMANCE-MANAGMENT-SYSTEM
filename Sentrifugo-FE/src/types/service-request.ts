export type ExecutorRole = 'primary' | 'secondary'

/**
 * A person authorised to work a category's tickets. Primaries inherit the
 * department head's powers (assign / reassign / escalation target); secondaries
 * are the working pool. Name and email are a server-side snapshot taken when
 * the category is saved, so a roster member can be rendered even when they are
 * not on the currently loaded page of employees.
 */
export interface CategoryExecutor {
  user_id: string
  role: ExecutorRole
  employee_id: string | null
  /** e.g. EMP0142 — shown in the roster list and on the notification chips. */
  emp_code: string
  name: string
  email: string
  /** Which of the category's departments this person was resolved under. */
  department_id: string | null
  /** e.g. ENG — the short form the notification chips render. */
  department_code: string
  department_name: string
  /**
   * True for a head of one of the category's departments. They hold the primary
   * powers implicitly, so the form renders them checked, Primary and locked.
   * Derived server-side on every read — never stored, never sent back.
   */
  is_department_head: boolean
}

/** What the client sends — name/email are resolved server-side. */
export interface CategoryExecutorInput {
  user_id: string
  role: ExecutorRole
}

export interface Category {
  id: string
  organisation_id: string
  name: string
  description: string
  /** Departments whose employees staff this category. At least one; every one
   *  belongs to business_unit_id. */
  department_ids: string[]
  department_names: string[]
  /** @deprecated department_ids[0]. Still emitted so consumers reading the
   *  scalar keep working; remove once they have all migrated. */
  department_id: string
  /** @deprecated department_names[0]. */
  department_name: string | null
  business_unit_id: string
  business_unit_name: string | null
  restricted_visibility: boolean
  /** Visibility scope (multi-select) — only meaningful when restricted_visibility is true. */
  visibility_business_unit_ids: string[]
  visibility_department_ids: string[]
  /** Tagged executor roster. At least one primary is required in practice:
   *  raising a ticket against a category with no primary is refused by the API
   *  (CATEGORY_ROSTER_NOT_CONFIGURED). Empty is still storable for categories
   *  that predate the roster — it does NOT hand the powers to the department
   *  heads any more, it just leaves the category unusable for new tickets. */
  executors: CategoryExecutor[]
  /** @deprecated No longer read by the API. A category with a roster is always
   *  roster-only: the flag used to let the departments count as executors too,
   *  and defaulted to doing so. Still present on the wire for back-compat, and
   *  still sent as `true` whenever a roster exists so a stored `false` can't
   *  outlive an older client. */
  roster_is_exclusive: boolean
  status: 'active' | 'inactive'
  created_by: string
  created_on: string
  modified_by: string | null
  modified_on: string | null
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface SlaRule {
  id?: string
  request_type_id?: string
  priority: 'high' | 'medium' | 'low' | 'urgent'
  first_response_minutes: number
  resolution_minutes: number
  business_hours_only: boolean
  description: string
  violation_actions: SlaViolationAction[]
  notification_recipients: string[]
  status: 'active' | 'inactive'
}

export interface RequestType {
  id: string
  organisation_id: string
  category_id: string
  name: string
  description: string
  status: 'active' | 'inactive'
  sla_rules: SlaRule[]
  created_by: string
  created_on: string
  modified_by: string | null
  modified_on: string | null
}

export interface RequestTypeListItem {
  request_type_id: string
  category_id: string
  category_name: string | null
  request_type_name: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  first_response_minutes: number
  resolution_minutes: number
  business_hours_only: boolean
  violation_actions: SlaViolationAction[]
  status: 'active' | 'inactive'
}

export type SlaViolationAction =
  | 'send_alert'
  | 'send_notification'
  | 'change_priority'
  | 'reassign'

export interface Approver {
  id: string
  userId: string
  userName: string
  type: 'specific_user'
}

export interface ApprovalLevel {
  level: number
  logic: 'and' | 'or'
  approvers: Approver[]
}

export interface EscalationRule {
  enabled: boolean
  escalateAfter: number
  escalateAfterUnit: 'hours' | 'days'
  escalateTo: string
  notifyBeforeEscalation: boolean
  notificationLeadTime: number
}

export interface Workflow {
  id: string
  categoryId: string
  categoryName: string
  requestTypeId: string
  requestTypeName: string
  primaryAssignee: string
  approvalRequired: boolean
  approvalLevels: ApprovalLevel[]
  escalation: EscalationRule
  notifications: {
    methods: ('system' | 'email')[]
    events: ('assignment' | 'approval' | 'escalation' | 'sla_breach')[]
  }
  status: 'active' | 'inactive'
  createdAt: string
}

export interface CategoryFormData {
  name: string
  description: string
  business_unit_id: string
  department_ids: string[]
  restricted_visibility: boolean
  visibility_business_unit_ids: string[]
  visibility_department_ids: string[]
  executors: CategoryExecutorInput[]
  /** @deprecated Sent as `executors.length > 0`, never chosen by the user. */
  roster_is_exclusive: boolean
  status: 'active' | 'inactive'
}

export interface RequestTypeFormData {
  category_id: string
  name: string
  description: string
  status: 'active' | 'inactive'
  sla_rules: Omit<SlaRule, 'id' | 'request_type_id'>[]
}

export interface WorkflowFormData {
  categoryId: string
  requestTypeId: string
  approvalRequired: boolean
  approvalLevels: ApprovalLevel[]
  escalation: EscalationRule
  notifications: Workflow['notifications']
}

export type RequestStatus =
  | 'pending_assignment'
  | 'in_progress'
  | 'escalated'
  | 'resolved'
  | 'closed'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export type Priority = 'urgent' | 'high' | 'medium' | 'low'

export interface QueueItem {
  id: string
  requestId: string
  requestType: string
  requester: string
  category: string
  priority: Priority
  status: RequestStatus
  assignedDate: string
  slaDeadline: string
}

export interface ApprovalQueueItem {
  id: string
  requestId: string
  requestType: string
  requester: string
  category: string
  priority: Priority
  approvalLevel: string
  status: ApprovalStatus
  requestedDate: string
  slaDeadline: string
}

export interface Attachment {
  name: string
  size: string
}

export interface SlaProgress {
  responseTime: string
  responseStatus: 'met' | 'pending' | 'breached'
  resolutionTime: string
  resolutionStatus: 'met' | 'pending' | 'breached'
  percentUsed: number
}

export interface ApproverDetail {
  name: string
  level: string
  status: ApprovalStatus
}

export interface AssigneeDetail {
  name: string
  role: string
  department: string
  assignedOn: string
  contact: string
}

export interface TimelineStep {
  label: string
  status: 'completed' | 'current' | 'pending' | 'conditional'
  timestamp?: string
  detail?: string
}

export interface Comment {
  id: string
  author: string
  role: string
  timestamp: string
  text: string
}

export interface InternalNote {
  id: string
  author: string
  role: string
  timestamp: string
  text: string
}

export interface Activity {
  id: string
  action: string
  user: string
  timestamp: string
}

export interface ServiceRequestDetail {
  id: string
  requestId: string
  title: string
  status: string
  submittedDate: string
  category: string
  priority: Priority
  department: string
  requesterId: string
  requester: string
  requesterDepartment: string
  description: string
  attachments: Attachment[]
  assignee: AssigneeDetail | null
  sla: SlaProgress
  approvers: ApproverDetail[]
  totalApprovalLevels: number
  currentApprovalLevel: string
}

// API response types (matching the backend)
export interface WorkflowListItem {
  id: string
  category_id: string
  category_name: string | null
  request_type_id: string
  request_type_name: string | null
  primary_assignee_user_id: string
  /** The workflow's frozen snapshot — one user, the default assignee for new
   *  tickets. Drifts when the category roster is edited, so don't show it as
   *  "the primaries"; use `primary_executor_names` for that. */
  primary_assignee_name: string | null
  /** The category's current primaries, read live off its roster. */
  primary_executor_names: string[]
  /** Auto-escalation target, when configured. Used by the category screen to
   *  warn before removing a primary that a workflow escalates to. */
  escalate_to_user_id: string | null
  total_approval_levels: number
  /** @deprecated Always empty. Built from stored `approvers` rows, and no
   *  workflow has any — approval routes per ticket from the requester's own
   *  L1/L2 in IAM, so there is nothing workflow-level to summarise. Kept
   *  because the API still returns the fields. Do not put a column back. */
  approvers_summary: string | null
  /** @deprecated Always 0 — see `approvers_summary`. */
  approvers_count: number
  escalation_summary: string | null
  status: 'active' | 'inactive'
}

export interface WorkflowApprover {
  user_id?: string
  approver_user_id?: string
  approver_type?: string
  name?: string | null
  role?: string | null
  sort_order: number
}

export interface WorkflowApprovalLevel {
  level_index: number
  logic: 'and' | 'or'
  approvers: WorkflowApprover[]
}

export interface WorkflowEscalationConfig {
  auto_escalate_enabled: boolean
  escalate_after_minutes: number
  escalate_to_user_id: string
  pre_notify_enabled: boolean
  pre_notify_minutes_before: number
  notification_methods: string[]
  notify_on: string[]
}

export interface WorkflowCreatePayload {
  category_id: string
  request_type_id: string
  approval_required: boolean
  approval_levels: WorkflowApprovalLevel[]
  escalation_config: WorkflowEscalationConfig | null
  status?: 'active' | 'inactive'
}

export interface WorkflowDetail {
  id: string
  category_id: string
  request_type_id: string
  approval_required: boolean
  approval_levels: WorkflowApprovalLevel[] | null
  escalation_config: WorkflowEscalationConfig | null
  status: 'active' | 'inactive'
  created_by: string
  created_on: string
  modified_by: string | null
  modified_on: string | null
}

export interface RequestListItem {
  id: string
  ticket_no: string
  title: string
  request_type_id: string
  request_type_name: string | null
  requester_user_id: string
  requester_name: string | null
  category_id: string
  category_name: string | null
  priority: 'low' | 'medium' | 'high' | 'urgent'
  created_on: string
  status: string
  is_escalated: boolean
  /**
   * Which handoff `is_escalated` refers to — the flag alone conflates two
   * unrelated events.
   *
   * `executor` — Phase A, the executor handed the ticket to the dept head. This
   * moves `executor_user_id` to the target, so the ticket leaves the escalator's
   * queue and turns up in the target's.
   * `approval` — Phase B, one approver handed a decision to another while the
   * ticket sat in approval. It leaves `executor_user_id` untouched, so the
   * executor still holds a ticket that was never escalated to or from them.
   *
   * `null` when the ticket isn't currently flagged as escalated.
   */
  escalation_phase?: 'executor' | 'approval' | null
  /**
   * Who held the ticket before the current executor. The only way to tell a
   * ticket escalated TO the caller from one they escalated AWAY — both arrive
   * as `is_escalated: true`.
   */
  previous_executor_user_id?: string | null
  /** Where the TICKET is in the approval chain. */
  current_level_index?: number
  rejected_at_level?: number | null
  /**
   * Which level the CALLER is the approver at — 1, 2, or null when they aren't
   * an approver on this ticket at all (a reporting-tree row). Distinct from
   * `current_level_index`: an L1 approver looking at a ticket now sitting at L2
   * gets `my_approval_level: 1` with `current_level_index: 2`.
   *
   * Only present on GET /requests/pending-approvals — GET /requests omits it.
   * `null` is normal, not an error state: most `scope=my_team` rows have it.
   */
  my_approval_level?: number | null
  /**
   * The caller's own vote at their level: "pending" | "approved" | "rejected".
   * Only on GET /requests/pending-approvals. NB "pending" does NOT mean
   * actionable — reporting-tree rows carry it too; use `?scope=awaiting_me`.
   */
  my_decision?: string | null
  executor_user_id?: string | null
  first_response_due_by?: string | null
  resolution_due_by?: string | null
}

export interface RequestListParams {
  q?: string
  category_id?: string
  status?: string
  priority?: string
  status_group?: string
  my_requests?: boolean
  for_my_department?: boolean
  requester_user_id?: string
  executor_user_id?: string
  /**
   * Tickets the given user escalated away. `executor_user_id` cannot express
   * this: escalation reassigns that field to the target, so a handed-off ticket
   * is no longer matched by it at all. Employees are scoped back to their own
   * id server-side.
   */
  previous_executor_user_id?: string
  page?: number
  page_size?: number
}

export interface RaiseRequestPayload {
  category_id: string
  request_type_id: string
  title: string
  description: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  /** Optional: requester picks an executor up-front. If omitted the ticket
   *  stays unassigned and any dept employee can self-assign. */
  executor_user_id?: string
}

export interface DashboardCard {
  id: string
  label: string
  value: number
  filter: Record<string, string>
}

export interface DashboardSummary {
  cards: DashboardCard[]
}

export interface CommentItem {
  id: string
  author_user_id: string
  author_name: string | null
  author_role: string | null
  body: string
  created_on: string
}

export interface RequestDetail {
  id: string
  ticket_no: string
  title: string
  description: string
  status: string
  is_escalated: boolean
  escalation_count: number
  priority: string
  submitted_on: string
  requester_user_id: string
  requester_name: string | null
  rejection_reason: string | null
  resolution_notes: string | null
  closing_remarks: string | null
  escalation_reason: string | null
  metadata: {
    category_id: string
    category_name: string | null
    request_type_id: string
    request_type_name: string | null
    department_id: string
    department_name: string | null
  }
  attachments: { id: string; filename: string; size_bytes: number; mime_type: string }[]
  assignment: {
    executor_user_id: string | null
    executor_name: string | null
    executor_role: string | null
    executor_department: string | null
    executor_contact: string | null
    assigned_on: string | null
  }
  sla: {
    // false when the ticket's SLA rule is no longer in force (rule or request
    // type deactivated / deleted) or no deadline was ever set. The tick treats
    // those tickets as untracked — no breach, no email — so the panel must not
    // claim a breach either.
    enabled?: boolean
    disabled_reason?: string
    first_response_due_by: string | null
    first_response_at: string | null
    resolution_due_by: string | null
    percent_used: number
    first_response_status?: string
    resolution_status?: string
  }
  approvals: {
    required: boolean
    total_levels: number
    current_level_index: number | null
    triggered_at: string | null
    levels: {
      level_index: number
      logic: 'and' | 'or'
      status: 'pending' | 'approved' | 'rejected'
      approvers: {
        user_id: string
        name: string | null
        decision: 'approved' | 'rejected' | null
        decided_at: string | null
        remarks: string | null
      }[]
    }[]
  }
  timeline: { stage: string; status: string; at: string | null; note: string | null }[]
  capabilities: {
    can_approve: boolean
    can_reject: boolean
    can_first_response: boolean
    /** Executor triggers L1 approval (one-shot per ticket). */
    can_submit_for_approval: boolean
    /** Executor triggers L2 approval — only after L1 approved. */
    can_trigger_l2_approval: boolean
    can_assign_executor: boolean
    can_self_assign: boolean
    can_reassign_executor: boolean
    can_escalate: boolean
    can_resolve: boolean
    can_close: boolean
    /** Requester-only, computed from the state machine's WITHDRAW_FROM set. */
    can_withdraw: boolean
    can_add_comment: boolean
    can_add_internal_note: boolean
    can_see_internal_notes: boolean
    can_download_attachments: boolean
  }
}

export interface Department {
  id: string
  organisationId: string
  businessUnits: string[]
  departmentName: string
  departmentCode: string
  description: string | null
  departmentHead: string | null
  is_active: boolean
  departmentHeadName: string
}

export interface Employee {
  id: string
  userId: string
  empCode: string
  firstName: string
  middleName: string | null
  lastName: string
  workEmail: string
  departmentId: string
  departmentName: string
  designationName: string
}

export interface MeResponse {
  id: string
  email: string
  first_name: string
  last_name: string
  middle_name: string | null
  avatar_url: string | null
  status: string
  organisation_id: string
  is_super_admin: boolean
  is_org_admin: boolean
  policy_ids: string[]
  permissions: Record<string, { acl: string; actions: Record<string, boolean> }>
}

/**
 * GET /requests/pending-approvals/counts — every stat-card total in one call.
 * Keys match the equivalent list query exactly (`all` = no params,
 * `awaiting_me` = ?scope=awaiting_me, and so on), so a badge can never
 * disagree with the table it opens.
 */
export interface ApprovalCounts {
  all: number
  awaiting_me: number
  my_team: number
  approved: number
  escalated: number
  urgent: number
}
