/**
 * Expense Management types — mirrors the backend response models one-for-one.
 *
 * Enums are copied from `src/expense_common/enums.py`; response shapes from the
 * per-domain `schemas.py`. Money crosses the wire as a **decimal string**
 * (Pydantic `Decimal`) — keep it a string and format at the edge. Parsing it to
 * a float loses paise and re-serialises wrong.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export type RecordStatus =
  | 'DRAFT'
  /**
   * Submitted and somewhere in the approval chain. **One** pending state, not
   * one per stage: `PENDING_FINANCE` was only meaningful while Finance was
   * guaranteed to be the second rung, and a configurable ladder can put it
   * anywhere or nowhere. Which rungs are open is data on the record —
   * `current_levels` and `current_level_names` — not a status value.
   */
  | 'PENDING_APPROVAL'
  /**
   * **Expense only.** Finished by the claimant and waiting to be *marked* by each
   * verifying level, rather than approved by each rung.
   *
   * A trip expense is never submitted individually, so `submit` never freezes it.
   * Without this it stayed `DRAFT` while sitting on Finance's table — which meant
   * the claimant could still raise the amount after Finance had marked it, and
   * draft privacy had to be widened before the marker could see it at all. Both
   * problems are the one status doing two jobs.
   *
   * Entered by the claimant's own *Ready* action on the trip's expense table —
   * never by attaching to a trip, which would freeze the record before its
   * receipt could be attached.
   */
  | 'PENDING_VERIFICATION'
  | 'APPROVED'
  | 'REJECTED'
  | 'SETTLED'
  | 'ACTIVE'
  | 'CLOSED'

export type SubjectType = 'expense' | 'trip' | 'advance'

/**
 * What one person did at one rung.
 *
 * `FORWARDED` is gone because escalating is no longer a verdict of its own.
 * *Send to Leadership* records an `APPROVED` at the forwarder's own rung and
 * opens the optional one above it, so the trail shows that they signed rather
 * than only that they passed it on.
 */
export type GateDecision = 'APPROVED' | 'REJECTED' | 'SENT_BACK' | 'RECALLED'

/**
 * The server-declared row/detail actions. The client renders the subset it is
 * given and never derives this from a role flag — a status the UI has not been
 * taught about must degrade to view-only, not offer an illegal action.
 */
export type GateAction =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'send_back'
  | 'forward'
  | 'recall'
  | 'mark_paid'
  | 'comment'
  | 'edit'
  | 'delete'
  /**
   * Refuse the awaiting verifying rung and send the expense back to its
   * claimant. Not a `reject`: rejection is terminal and ends the claim, this
   * returns a DRAFT the claimant can fix and hand over again.
   *
   * Listed here only so the union does not lie about what the wire sends —
   * `GateActionBar` deliberately does not render it. The verification actions
   * are driven off the `verification` flags, which is the one place that knows
   * whether the caller holds *this* rung; `available_actions` carries the action
   * for anything reading the list generically.
   */
  | 'not_verified'

export type ExpenseFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'date_range'
  | 'select'
  | 'boolean'
  | 'employee_multi'

export type TripType = 'DOMESTIC' | 'INTERNATIONAL'

export type VisaRequirement = 'YES' | 'NO' | 'NOT_SURE'

export type AdvanceOrigin = 'REQUESTED' | 'ALLOCATED'

export type ListScope = 'my' | 'team' | 'approvals' | 'employees'

/**
 * Trips and advances share this vocabulary; expenses use ListScope.
 *
 * `team` is the caller's reporting line; `approvals` is their approver working
 * set — open at a level they can sign, plus what they have decided. They were one
 * scope carrying both, which made "my team" name a different row set depending on
 * which grant the caller held.
 */
export type SubjectScope = 'mine' | 'team' | 'approvals' | 'org'

export type TripScope = SubjectScope

export type AdvanceScope = SubjectScope

/**
 * Business milestones on a record's timeline.
 *
 * **The approval codes are level-generic.** They used to be role-named — one per
 * gate, `L1_APPROVED` / `FINANCE_APPROVED` / `MANAGEMENT_APPROVED` — which only
 * worked while the gates were fixed at three and known at compile time. A
 * configurable ladder has no fixed role to name, so a fourth rung would have
 * needed a fourth code and a redeploy. The rung's number and the org's name for
 * it ride in the entry's metadata instead.
 */
export type HistoryEvent =
  | 'CREATED'
  | 'SUBMITTED'
  /** A rung cleared — its quorum is satisfied and the chain moved past it. */
  | 'LEVEL_APPROVED'
  /**
   * One approver signed at a rung that is **still open** (`quorum: 'all'` with
   * signatures outstanding). The record has not moved. Distinct from
   * `LEVEL_APPROVED` because a timeline rendering a partial vote as the rung's
   * outcome would report a claim as decided while others still held it.
   */
  | 'LEVEL_VOTE_RECORDED'
  /**
   * An approver passed the claim up to an `optional` rung instead of settling
   * it. The old `FORWARDED` named a *person*, chosen from a picker; an
   * escalation names a *level*, whose holders are resolved live.
   *
   * There is deliberately no `LEVEL_SKIPPED`: skipping is the *absence* of an
   * escalation on the same click that approved the rung below, so a row for it
   * would be a milestone nobody ever reached. Skipped rungs are derived at
   * render time from `LevelState.skipped`.
   */
  | 'ESCALATED'
  | 'RECALLED'
  | 'REJECTED'
  | 'SENT_BACK'
  | 'AMOUNT_ADJUSTED'
  | 'SETTLED'
  | 'CLOSED'
  | 'CLONED'
  | 'ALLOCATED'
  | 'DISBURSED'
  | 'RETURNED'

/** Statuses the "Submitted" tile aggregates (§6.2). */
/**
 * "Out of the claimant's hands, not yet decided" — what the *Submitted* tile
 * aggregates.
 *
 * `PENDING_VERIFICATION` belongs here even though nothing was submitted: to the
 * employee reading the tile the distinction is invisible and uninteresting, and
 * leaving it out would strand those rows in no tile at all, since they are not
 * drafts either. Mirrors `IN_FLIGHT_STATUSES` on the server.
 */
export const IN_FLIGHT_STATUSES: RecordStatus[] = [
  'PENDING_APPROVAL',
  'PENDING_VERIFICATION',
]

// ─── Shared embedded shapes ──────────────────────────────────────────────────

export interface ActorSnapshot {
  id: string
  name?: string | null
  role?: string | null
  email?: string | null
  /**
   * The employee code — `EMP0142`. What people actually call each other by, and
   * the only field here that reliably separates two colleagues sharing a name.
   *
   * **Optional, and absent today.** IAM does not yet send it on the replies the
   * approval chain resolves against (verified against DEV on 2026-08-28); the
   * expense service already reads it, so it appears the moment IAM ships it.
   * Treat absence as *not supplied*, never as *this person has no code* —
   * rendering a stray separator or a blank where a code belongs is worse than
   * rendering nothing.
   */
  emp_code?: string | null
}

export interface ReferenceSnapshot {
  id?: string | null
  name?: string | null
  code?: string | null
}

/**
 * Where a record stands in its approval chain.
 *
 * The three named slots are gone. A ladder has no fixed second rung to call
 * `finance`, so verdicts are an append-only list carrying the level they were
 * given at, and progress is `current_levels` — *which rungs are open* — rather
 * than a status per stage.
 */
export interface ApprovalBlockResponse {
  status: RecordStatus
  reporting_manager?: ActorSnapshot | null
  /**
   * The chain **as it was when the record was submitted**, frozen onto it.
   * `null` before submit, and `null` is not an empty chain: it means no policy
   * was captured, which the server treats as unapprovable rather than as
   * approved-on-arrival.
   */
  chain?: ApprovalChain | null
  /** Every verdict given, in the order given. Append-only. */
  decisions: DecisionResponse[]
  /** Optional rungs a previous level chose to open. */
  escalated_to: number[]
  /** Which rungs are open right now — the replacement for a per-stage status. */
  current_levels: number[]
  /** Those rungs' snapshotted names, for anything that renders a heading. */
  current_level_names: string[]
  /** Per-rung state for the timeline: awaiting / cleared / skipped / blocked. */
  levels: LevelState[]
  /** Why the chain cannot progress — an empty rung, say. Never merely unknown. */
  blocked_reason?: string | null
  submitted_at?: string | null
  version: number
  available_actions: GateAction[]
}

/** The server's paginated envelope (`src/common/pagination.py`). */
export interface PageResult<T> {
  items: T[]
  page: number
  page_size: number
  total: number
}

// ─── Config (§7.1, §7.2, §11.1) ──────────────────────────────────────────────

export interface SelectOptionOut {
  value: string
  label: string
}

export interface FieldSpecOut {
  key: string
  label: string
  type: ExpenseFieldType
  required: boolean
  options: SelectOptionOut[]
  max_length?: number | null
  help_text?: string | null
}

export interface ExpenseTypeOut {
  code: string
  name: string
  /** Drives which extra fields the expense form renders. */
  field_schema: FieldSpecOut[]
  receipt_required: boolean
  active: boolean
}

export interface ExpenseCategoryOut {
  code: string
  name: string
  active: boolean
}

export interface PaymentModeOut {
  code: string
  name: string
  active: boolean
}

// ─── Directory (§5.2) ────────────────────────────────────────────────────────

export interface DirectoryActor {
  id: string
  name?: string | null
  role?: string | null
  email?: string | null
}

export interface ActorListResponse {
  items: DirectoryActor[]
  count: number
  /** True when IAM was unreachable and the list is incomplete. Surface it. */
  degraded: boolean
}

// ─── Expenses ────────────────────────────────────────────────────────────────

export interface ReferenceInput {
  id?: string | null
  name?: string | null
  code?: string | null
}

export interface TripPayload {
  trip_id?: string | null
  display_id?: string | null
  name?: string | null
  trip_type?: string | null
  from_date?: string | null
  to_date?: string | null
}

export interface AdvancePayload {
  advance_id?: string | null
  display_id?: string | null
  applied_amount?: string | null
}

/** The §9.8 arithmetic, for a real or proposed approved amount. */
export interface SettlementPreviewResponse {
  claimed_amount: string
  approved_amount: string
  payable: string
  advance_applied: string
  net_payable: string
  currency: string
  reimbursable: boolean
  advance_id?: string | null
  advance_display_id?: string | null
}

/**
 * One verifying rung's standing on one expense.
 *
 * `name` is frozen at mark time exactly as a decision's `level_name` is, so
 * renaming a level in settings cannot retroactively rewrite what somebody was
 * told they were confirming. An unmarked rung carries the chain's current name
 * because there is nothing frozen for it yet.
 */
export interface LevelMark {
  level: number
  name: string
  marked: boolean
  actor?: ActorSnapshot | null
  at?: string | null
}

/**
 * Where an expense stands in the trip's *verification* pass — the marks each
 * verifying level leaves before the trip can be bulk settled.
 *
 * **`can_verify` and `can_unverify` are server-computed per caller**, exactly
 * like {@link ExpenseRow.available_actions}, and are rendered rather than
 * derived. The client cannot answer either: it knows neither who the next rung
 * resolves to on *this* record, nor who left the mark below it, nor that the
 * claimant may never verify their own expense. A client-side "is this my level?"
 * would be a second implementation of the sequencing rule, free to disagree with
 * the one the server actually enforces — and it would offer buttons that 403.
 *
 * `null` on the record means verification does not apply: the chain has no
 * verifying level, so the expense is submitted individually as it always was.
 */
export interface VerificationState {
  /** Every verifying level, in rung order — a subsequence of the chain. */
  required_levels: LevelMark[]
  /** Every required level has marked. Only then is the row bulk settleable. */
  complete: boolean
  /** The rung awaiting a mark, or null once complete. */
  next_level?: number | null
  next_level_name?: string | null
  /** THIS caller may mark `next_level` right now. Never re-derive it. */
  can_verify: boolean
  /**
   * THIS caller may **refuse** `next_level` right now, sending the expense back
   * to its claimant as a draft with every mark on it cleared.
   *
   * Carries the same value as `can_verify` today — whoever may sign the awaiting
   * rung may decline it instead — and is still sent as its own flag rather than
   * having the client light two buttons off `can_verify`. The two are free to
   * diverge server-side (a level that may pass but not refuse, say) without a
   * client change, which is the same reason `can_verify` and `can_unverify` are
   * two flags rather than one tri-state. A client that collapsed them would have
   * to be found and unpicked the day they stop agreeing.
   */
  can_not_verify: boolean
  /** THIS caller may undo their own mark right now. Never re-derive it. */
  can_unverify: boolean
  /**
   * THIS caller is the **claimant** and may hand the expense over right now.
   *
   * Deliberately a separate flag from `can_verify` rather than a mode on it: the
   * two are for different people, and a client that conflated them would offer
   * the marker a Ready button and the claimant a Mark button — precisely
   * backwards.
   */
  can_mark_ready: boolean
  /** THIS caller may take it back. Withdrawn the instant any level marks it. */
  can_unready: boolean
  /**
   * The claimant has not handed it over yet, so no mark is possible.
   *
   * Lets the trip's table say *why* a row has no mark button instead of just
   * omitting one, which reads as a bug to whoever is waiting to mark it.
   */
  awaiting_claimant: boolean
}

export interface ExpenseRow {
  id: string
  display_id: string
  org_id: string
  /**
   * The claimant. **The server sends no name here** — unlike `AdvanceRow`,
   * which carries `employee_name`. The "Raised By" column resolves it through
   * `useEmployeeNames()` against the IAM pool. See the note in that hook.
   */
  employee_id: string
  title: string
  expense_type_code: string
  category_code: string
  project?: ReferenceInput | null
  client?: ReferenceInput | null
  expense_date: string
  claimed_amount: string
  approved_amount?: string | null
  net_payable?: string | null
  currency: string
  reimbursable: boolean
  status: RecordStatus
  submitted_at?: string | null
  trip?: TripPayload | null
  advance?: AdvancePayload | null
  approved_by?: ActorSnapshot | null
  /** Who the record was escalated to, when a rung opened the optional one above it. */
  forwarded_to?: ActorSnapshot | null
  reporting_manager?: ActorSnapshot | null
  settled_at?: string | null
  /** How this row reached the caller's list — 'own' | 'approval' (§5.2a). */
  scope: string
  /** Which rungs are open on this row. */
  current_levels: number[]
  /** Their snapshotted names, for the status column's detail line. */
  current_level_names: string[]
  /** Server-rendered status text, so the list and the detail cannot disagree. */
  status_label: string
  /**
   * Which of the open rungs *the caller* sits on — the row-level answer to "is
   * this waiting on me?". Empty on a row the caller merely owns.
   */
  actor_levels: number[]
  /**
   * The org's name for the level `forward` would open — what goes on the button.
   * Null whenever `forward` is not among `available_actions`: the server decides
   * both from one `escalation_after` call, so they cannot disagree.
   */
  escalation_level_name?: string | null
  available_actions: GateAction[]
  /**
   * The trip verification pass, or null/absent when it does not apply — see
   * {@link VerificationState}. Present on the row as well as the detail because
   * the trip's expense table is the work surface: an approver marks from the
   * list, and a flag only the detail carried would mean opening every expense.
   */
  verification?: VerificationState | null
}

export interface ReceiptResponse {
  id: string
  org_id: string
  owner_employee_id: string
  expense_id?: string | null
  ref_type?: string | null
  filename: string
  size: number
  content_type: string
  uploaded_at: string
  deleted: boolean
  download_url?: string | null
  /** DRAFT + ownership, computed server-side. Never re-derive it (§10.2). */
  can_delete: boolean
}

export interface SettlementBlock {
  payment_reference?: string | null
  payment_date?: string | null
  settled_by?: ActorSnapshot | null
  settled_at?: string | null
  note?: string | null
}

export interface ExpenseDetail extends ExpenseRow {
  description?: string | null
  type_data: Record<string, unknown>
  /** The schema as it was at submit — a later config edit must not re-render it. */
  type_schema_snapshot: FieldSpecOut[]
  payment_mode?: string | null
  payment_reference?: string | null
  receipts: ReceiptResponse[]
  receipt_count: number
  settlement?: SettlementBlock | null
  approval: ApprovalBlockResponse
  /**
   * Whether **this caller** may lower the approved amount on **this record**.
   *
   * Server-declared, because the client cannot derive it: it knows neither who
   * holds `expense_finance_approval` nor who the open rung resolves to. The old
   * UI asked "is this the Finance gate?", answerable only while Finance was
   * structurally rung 2. Do not substitute `available_actions.includes('approve')`
   * — that is every approver at every rung, and the server refuses the rest.
   */
  can_adjust_amount: boolean
  settlement_preview: SettlementPreviewResponse
  draft_version: number
}

export interface ExpenseCreatePayload {
  title: string
  description?: string | null
  expense_type_code: string
  type_data?: Record<string, unknown>
  category_code: string
  project_ref?: ReferenceInput | null
  client_ref?: ReferenceInput | null
  expense_date: string
  claimed_amount: string
  currency?: string | null
  reimbursable?: boolean
  payment_mode?: string | null
  payment_reference?: string | null
  trip_id?: string | null
  advance_id?: string | null
}

/**
 * Autosave body. Only the fields actually sent are applied, so a single-field
 * save cannot blank the rest — send a partial, not the whole form.
 * `draft_version` is the optimistic guard; a lost race is refused, not merged.
 */
export interface ExpenseUpdatePayload extends Partial<ExpenseCreatePayload> {
  draft_version: number
}

export interface SummaryTile {
  key: string
  /** Label comes from the payload — the manager's list says "All Requests". */
  label: string
  count: number
  claimed_amount: string
  approved_amount: string
  net_payable: string
}

export interface SummaryResponse {
  scope: ListScope
  month_from: string
  month_to: string
  currency: string
  tiles: SummaryTile[]
}

export interface CalendarCard {
  id: string
  display_id: string
  title: string
  claimed_amount: string
  approved_amount?: string | null
  status: RecordStatus
}

export interface CalendarDay {
  day: string
  count: number
  claimed_amount: string
  approved_amount: string
  cards: CalendarCard[]
}

export interface CalendarResponse {
  scope: ListScope
  month_from: string
  month_to: string
  currency: string
  card_limit: number
  days: CalendarDay[]
}

export interface BulkMarkPaidOutcome {
  expense_id: string
  settled: boolean
  code?: string | null
  detail?: string | null
  net_payable?: string | null
}

export interface BulkMarkPaidResponse {
  requested: number
  settled: number
  skipped: number
  failed: number
  outcomes: BulkMarkPaidOutcome[]
}

export interface MarkPaidPayload {
  payment_reference: string
  payment_date: string
  note?: string | null
}

/**
 * The outcome of settling a whole trip's fully-verified expenses in one action.
 *
 * Counted, not verdicted. **An unmarked expense is `skipped`, never a failure**
 * — the run is deliberately repeatable, so a trip half-marked today is settled
 * in two passes rather than blocked until every level has caught up. Rendering a
 * skip as an error would train Finance to ignore the result, which is the same
 * reasoning behind {@link BulkMarkPaidResponse}.
 *
 * `rows` is per-expense and independent: one refusal cannot abort the batch.
 */
export interface BulkSettleResponse {
  settled: number
  skipped: number
  failed: number
  rows: BulkMarkPaidOutcome[]
}

export interface ExpenseListParams {
  scope: ListScope
  month_from: string
  month_to: string
  page?: number
  page_size?: number
  search?: string
  project_id?: string
  client_id?: string
  category_code?: string
  expense_type_code?: string
  reimbursable?: boolean
  /** Repeatable. One pending status now, so this filters lifecycle, not stage. */
  status?: RecordStatus[]
  trip_id?: string
  advance_id?: string
}

// ─── Gate action bodies (shared across all three subjects) ───────────────────

export interface ApprovePayload {
  note?: string | null
  /**
   * A lowered figure, honoured only downward (§19.2).
   *
   * **The authority is a grant, not a rung.** The old rule was "only at the
   * Finance gate", expressible only while Finance was guaranteed to be rung 2;
   * an org can now put Finance first, last, twice or nowhere. The server tests
   * for `expense_finance_approval` plus the record still being open, so the
   * client cannot decide who may adjust — render the panel from what the server
   * declares, never from a rung number.
   *
   * Expenses only. Trip and advance approvals take a note and nothing else.
   */
  approved_amount?: string | null
  adjustment_reason?: string | null
}

export interface RejectPayload {
  reason: string
}

export interface SendBackPayload {
  note: string
}

/**
 * Finance's Send to Leadership body.
 *
 * There is **no target**. Finance presses one button and the org's approval rule
 * decides who receives it — Finance never sees or chooses the names, and never
 * learns whether the rule is an and/or or how many people are on the other side
 * (`design_docs/approval-rule-config.md` §1.1, §8).
 */
export interface ForwardPayload {
  reason?: string | null
}

// ─── History / timeline (§11.2) ──────────────────────────────────────────────

export type EntryState = 'done' | 'pending' | 'skipped'

export interface TimelineEntry {
  event_code?: HistoryEvent | null
  /** The rung this entry is about, when it is about one. */
  level?: number | null
  /** What that rung was called at the time. Frozen, never re-derived. */
  level_name?: string | null
  /** Already the display wording — "Approved at Level 2 (Finance)". Do not re-map. */
  label: string
  state: EntryState
  optional: boolean
  actor_id?: string | null
  actor_name?: string | null
  actor_role?: string | null
  at?: string | null
  from_status?: RecordStatus | null
  to_status?: RecordStatus | null
  note?: string | null
  metadata: Record<string, unknown>
}

export interface TimelineResponse {
  subject_type: SubjectType
  subject_id: string
  /** The chain this record was submitted under. `null` if never submitted. */
  chain?: ApprovalChain | null
  /** Includes the hollow pending dots, derived from `chain`. */
  entries: TimelineEntry[]
}

// ─── Comments (§11.4) ────────────────────────────────────────────────────────

export interface CommentResponse {
  id: string
  subject_type: SubjectType
  subject_id: string
  org_id: string
  author_id: string
  author_name?: string | null
  author_role?: string | null
  body: string
  at: string
  deleted: boolean
  can_delete: boolean
}

export interface CommentCreatePayload {
  subject_type: SubjectType
  subject_id: string
  body: string
}

// ─── Trips (§8) ──────────────────────────────────────────────────────────────

export interface TripRollup {
  expense_count: number
  claimed: string
  approved: string
  settled: string
  count_by_status: Record<string, number>
}

export interface TripFormDefaults {
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
}

export interface TripRow {
  id: string
  display_id: string
  name: string
  trip_type: TripType
  destination_city?: string | null
  destination_country?: string | null
  destination_state?: string | null
  from_date?: string | null
  to_date?: string | null
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
  status: RecordStatus
  /** Name resolved client-side via `useEmployeeNames()`, as for expenses. */
  owner_employee_id: string
  total: string
  expense_count: number
  /**
   * Which rungs are open and what this org calls them. On the row as well as the
   * detail: the collapse to one pending status is felt in the list first —
   * without these, every in-flight row reads "Pending" and nothing tells an
   * approver which one is theirs.
   */
  current_levels: number[]
  current_level_names: string[]
  /** The chip's text, composed server-side. The rung names are the org's, not ours. */
  status_label: string
  available_actions: string[]
}

export interface TripDetail extends TripRow {
  visa_required?: VisaRequirement | null
  description?: string | null
  cloned_from?: string | null
  closed_at?: string | null
  created_on?: string | null
  /**
   * The approval block — one shape, shared by all three subjects. Flattening it
   * onto the detail would put the number of approval stages back in the schema,
   * which is the thing the ladder exists to remove.
   */
  approval: ApprovalBlockResponse
  rollup: TripRollup
  /** Pre-fills the expense form when created from the trip (§8.3). */
  form_defaults: TripFormDefaults
}

export interface TripCreatePayload {
  name: string
  trip_type: TripType
  destination_city?: string | null
  destination_country?: string | null
  destination_state?: string | null
  visa_required?: VisaRequirement | null
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
  from_date: string
  to_date: string
  description?: string | null
}

export interface TripSummaryResponse {
  month_from: string
  month_to: string
  scope: TripScope
  total_trips: number
  count_by_status: Record<string, number>
  total_claimed: string
}

export interface TripCalendarCard {
  id: string
  display_id: string
  name: string
  destination?: string | null
  description?: string | null
  status: RecordStatus
}

export interface TripCalendarDay {
  day: string
  count: number
  cards: TripCalendarCard[]
}

export interface TripCalendarResponse {
  month_from: string
  month_to: string
  scope: TripScope
  card_limit: number
  days: TripCalendarDay[]
}

/** Trip picker row for the expense form. Status drives the gating note (§8.5). */
export interface TripPickerRow {
  trip_id?: string | null
  display_id?: string | null
  name?: string | null
  trip_type?: TripType | null
  from_date?: string | null
  to_date?: string | null
  status: RecordStatus
  /**
   * Whether attaching here replaces **Submit** with the hand-off to the trip's
   * verifying levels.
   *
   * The org's answer, carried on the row because the picker is where the form
   * asks what attaching implies — the same reason `status` is here. An org that
   * ticks no level to verify runs trip expenses exactly as it always did, one
   * submit at a time, and a form that assumed otherwise offered a *Submit to
   * Trip* button whose only possible reply was `NO_VERIFYING_LEVELS`.
   *
   * Optional so a client reading an older server does not crash; treat a missing
   * value as *unknown*, never as `false` — see `ExpenseFormSheet`.
   */
  verified_via_trip?: boolean
}

export interface TripExportRow {
  expense_id: string
  display_id?: string | null
  title?: string | null
  employee_id?: string | null
  expense_date?: string | null
  expense_type_code?: string | null
  category_code?: string | null
  status?: string | null
  reimbursable?: boolean | null
  currency?: string | null
  claimed_amount: string
  approved_amount?: string | null
  net_payable?: string | null
}

export interface TripExportResponse {
  trip: TripDetail
  rollup: TripRollup
  rows: TripExportRow[]
  row_limit: number
  /** When true the export is partial — say so rather than exporting silently. */
  truncated: boolean
  generated_at: string
}

export interface TripDeleteResponse {
  trip_id: string
  detached_draft_expenses: number
}

export interface TripListParams {
  scope?: TripScope
  month_from: string
  month_to: string
  page?: number
  page_size?: number
  search?: string
  trip_type?: TripType
  /** Single-valued on trips, unlike the expense list's repeatable filter. */
  status?: RecordStatus
  /** Also return cloned drafts that have no dates yet. */
  include_undated?: boolean
}

// ─── Advances (§9) ───────────────────────────────────────────────────────────

export interface ApproverChainEntry {
  position: number
  level: number
  level_name: string
  employee_id?: string | null
  name?: string | null
  role?: string | null
  decision?: GateDecision | null
  note?: string | null
  at?: string | null
  /** A nomination is a suggestion for Finance's forward, not a routing order. */
  nominated: boolean
}

export interface HoldEntry {
  expense_id: string
  amount: string
  created_at: string
}

export interface DrawEntry {
  expense_id: string
  expense_display_id?: string | null
  expense_title?: string | null
  amount: string
  claimed_amount?: string | null
  committed_at?: string | null
  finalised_at?: string | null
}

export interface ReturnEntry {
  amount: string
  payment_mode?: string | null
  payment_reference?: string | null
  returned_to?: ActorSnapshot | null
  recorded_by?: ActorSnapshot | null
  description?: string | null
  at: string
}

export interface AdvanceRow {
  id: string
  display_id: string
  employee_id: string
  employee_name?: string | null
  origin: AdvanceOrigin
  status: RecordStatus
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
  description?: string | null
  amount: string
  utilized: string
  /** Live soft holds from drafts. The gap between balance and available. */
  held: string
  returned: string
  balance: string
  /** balance − held. What a new expense may actually draw (§9.6). */
  available: string
  is_utilized: boolean
  allotted_at?: string | null
  disbursed_at?: string | null
  disbursed_by?: ActorSnapshot | null
  /**
   * Which rungs are open and what this org calls them. On the row as well as the
   * detail: the collapse to one pending status is felt in the list first —
   * without these, every in-flight row reads "Pending" and nothing tells an
   * approver which one is theirs.
   */
  current_levels: number[]
  current_level_names: string[]
  /** The chip's text, composed server-side. The rung names are the org's, not ours. */
  status_label: string
  available_actions: string[]
}

export interface AdvanceDetail extends AdvanceRow {
  /** See {@link TripDetail.approval}. `reporting_manager`, `submitted_at` and
   *  `version` live inside it — they are all one state and were only ever
   *  separate because the gate model had nowhere to put them together. */
  approval: ApprovalBlockResponse
  requested_by?: ActorSnapshot | null
  requested_at?: string | null
  payment_mode?: string | null
  payment_reference?: string | null
  approver_chain: ApproverChainEntry[]
  holds: HoldEntry[]
  draws: DrawEntry[]
  returns: ReturnEntry[]
}

export interface AdvanceSummary {
  count: number
  total: string
  utilized: string
  held: string
  returned: string
  balance: string
  available: string
  count_by_status: Record<string, number>
}

/** Only ACTIVE advances with balance appear here — APPROVED is not yet money. */
export interface SelectableAdvance {
  advance_id: string
  display_id?: string | null
  amount: string
  balance: string
  available: string
  description?: string | null
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
  returned_to?: ActorSnapshot | null
}

export interface ApproverCandidatesResponse {
  /**
   * Whether the org configured an optional rung after this one. False disables
   * Approver 2 — the successor to the old collapse rule, which asked whether
   * *this claimant's* manager happened to hold the leadership grant.
   */
  escalation_available: boolean
  escalation_level?: number | null
  escalation_level_name?: string | null
  default_approver_1?: ActorSnapshot | null
  approver_1: ActorSnapshot[]
  approver_2: ActorSnapshot[]
  /**
   * Every rung the caller's next request would climb, resolved for **them**.
   *
   * The form named its approvers only because the requester picked them. The
   * ladder comes from settings now, so without this the destination is stated
   * nowhere — and the record cannot say either: a draft has no chain snapshotted
   * onto it, so `approval.chain` is null and `ApprovalLadder` has nothing to draw
   * until after the thing is submitted.
   *
   * A rung with an empty `approvers` is a real and important answer: it is
   * configured but unheld, and the request will jam there.
   */
  chain_preview?: ApprovalPreviewLevel[]
  /**
   * Whether the org asks for any approval at all. An empty `chain_preview` is
   * also what an unreachable directory gives, and "nobody has to approve this"
   * must not render as the same sentence as "we could not find out who does".
   */
  approval_required?: boolean
}

/** One rung of a ladder the request has not climbed yet. A preview, not a promise. */
export interface ApprovalPreviewLevel {
  level: number
  name: string
  /** The rung below may end the chain instead of passing it up here. */
  optional?: boolean
  approvers: ActorSnapshot[]
}

export interface AdvanceRequestPayload {
  title: string
  amount: string
  description?: string | null
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
  /**
   * Both are optional and the form no longer sends them — the approval chain in
   * settings decides who signs an advance. Still accepted by the API, and still
   * validated when present, so an older client is refused rather than misrouted.
   */
  approver_1_employee_id?: string | null
  approver_2_employee_id?: string | null
}

/**
 * *Allocate Advance* — Finance raising an advance in an employee's name (§9.4).
 *
 * No payment fields. They were here, and `payment_mode` was required on this
 * body alone, because an allocation used to be created already `ACTIVE` with the
 * money moved: the manager who allocated was also the one paying. An allocation
 * runs the org's approval chain now, so at the moment this is posted nothing has
 * been paid. Recording the payment happens where it always did for a request —
 * `DisbursementPayload`, once the chain clears.
 *
 * The endpoint rejects unknown keys rather than ignoring them, uniquely in this
 * module: a stale client's `payment_reference` silently dropped would leave
 * Finance believing they had booked a payment the ledger never saw.
 */
export interface AdvanceAllocationPayload {
  employee_id: string
  amount: string
  description?: string | null
  project_ref?: ReferenceSnapshot | null
  client_ref?: ReferenceSnapshot | null
}

export interface DisbursementPayload {
  payment_mode: string
  payment_reference?: string | null
  note?: string | null
}

export interface AdvanceReturnPayload {
  amount: string
  payment_mode: string
  payment_reference?: string | null
  /** Locked to the disburser — money goes back where it came from (§9.7). */
  returned_to_employee_id?: string | null
  description?: string | null
}

export interface AdvanceListParams {
  scope?: AdvanceScope
  month_from: string
  month_to: string
  page?: number
  page_size?: number
  search?: string
  project_id?: string
  client_id?: string
  /** The boolean the wireframe's `Utilized` dropdown filters on (§9.9). */
  utilized?: boolean
  /** Repeatable. Note the plural — the advance router names it `statuses`. */
  statuses?: RecordStatus[]
}

// ─── Leadership approval rule (approval-rule-config.md §1, §3, §8) ───────────

// ─── Approval chain (approval-chain-hld.md §2, §3, §5, §7) ───────────────────

/**
 * Where a level's approvers come from.
 *
 * `reporting_manager` is the one source that is not org-wide: it resolves to a
 * different person for every claimant, read off the record's own snapshot. That
 * is why a `reporting_manager` level has no `holder_count` — see
 * {@link ApprovalLevel.holder_count}.
 */
export type LevelSource = 'reporting_manager' | 'permission' | 'roles'

/** Within one level: does any single signature clear it, or must everyone sign? */
export type Quorum = 'any' | 'all'

/**
 * Across levels: must every level clear, or does any single one end the chain?
 *
 * Not the same question as {@link Quorum}, and conflating the two is how a chain
 * ends up weaker than the person who configured it believed. `and` is also
 * *sequential* — level 2 cannot act until level 1 has signed.
 */
export type LevelOperator = 'and' | 'or'

/** One rung, as the settings page posts it — ids only, never display names. */
export interface ApprovalLevelPayload {
  level: number
  name: string
  source: LevelSource
  role_ids: string[]
  permission_code?: string | null
  /**
   * Optional narrowing to specific people *within* the resolved holders. The
   * server **intersects**, never unions: somebody who has lost the role stops
   * being eligible even though their id is still here.
   */
  user_ids: string[]
  quorum: Quorum
  /**
   * Whether the level before this one may **skip** it instead of passing the
   * claim up. This is the *Send to Leadership* button.
   *
   * Skipping is per rung, not an early exit: the server marks every unescalated
   * optional rung `skipped` and hands the claim to the first mandatory rung after
   * it, so approving only settles the claim when nothing mandatory follows.
   *
   * Refused on level 1 (nothing precedes it) and in an `or` chain (any single
   * level already ends those).
   */
  optional: boolean
  /**
   * Whether this level takes part in **verifying** trip expenses.
   *
   * Separate from approving, and deliberately so: an expense filed under a trip
   * is not submitted on its own — each ticked level marks it from the trip's
   * expense table, in rung order, and only a fully marked expense can be bulk
   * settled with the trip.
   *
   * **The order is the ticked levels only.** Untick level 1 and level 2 verifies
   * first; the sequence is a subsequence of the chain and levels are never
   * renumbered for it.
   *
   * Optional on the wire because a chain saved before this field existed carries
   * no value for it, and an absent flag means *this level does not verify* —
   * which is also the safe reading: an org that has ticked nothing keeps
   * per-expense submit exactly as it was.
   */
  can_verify?: boolean
}

/** One rung as the server returns it, with its **live** resolution attached. */
export interface ApprovalLevel extends ApprovalLevelPayload {
  /**
   * How many people this level resolves to right now.
   *
   * `null` and `0` mean different things and must never be conflated in the UI.
   * `0` is a real finding — the level can never clear, and the page must warn.
   * `null` means *not applicable or not known*: a `reporting_manager` level,
   * which has no org-wide count at all, or a level whose holders were not looked
   * up. Rendering `null` as "0 holders" would tell an admin their entirely normal
   * level 1 is broken.
   */
  holder_count: number | null
  /** A short display sample — never the eligible set. `holder_count` is the truth. */
  holder_names: string[]
  /** Why this level can never clear as configured, in the admin's own terms. */
  blocked_reason?: string | null
}

/**
 * An org's approval configuration for one subject.
 *
 * An org that has never configured one gets a default (a single reporting-manager
 * level) rather than a 404, because "the manager approves" is a real, renderable
 * answer and the page has to draw itself either way.
 */
export interface ApprovalChain {
  subject_type: SubjectType
  /** `false` means no approval step: a submitted record is approved on arrival. */
  approval_required: boolean
  levels: ApprovalLevel[]
  levels_operator: LevelOperator
  /**
   * Whether a human ever saved this, as opposed to it being the default the
   * endpoint synthesises for a subject nobody has configured.
   *
   * The endpoint never 404s, and a default is identical to a saved chain in every
   * other field — the page draws them the same way on purpose. This is the only
   * thing that separates them, and it exists for the *copy from another subject*
   * picker: offering an unconfigured subject as a source would import a single
   * reporting-manager rung while claiming to carry over a configured ladder.
   */
  configured: boolean
  /**
   * Plain-English rendering, built server-side so the page and the API can never
   * disagree about what a saved chain means. Render it, never re-derive it — a
   * client-side version would be a second implementation of the operator
   * precedence, free to drift.
   */
  summary: string
}

/**
 * Who one level resolves to, for the *narrow to specific people* picker.
 *
 * **Before** any narrowing — this is the set the admin is choosing a subset of,
 * so feeding their current selection back would offer only the people already
 * picked. Empty is a real answer (nobody holds what the level names); an outage
 * is a 503, never an empty list, because the two are indistinguishable on screen
 * and the first would have an admin "fix" a chain that was right.
 */
export interface LevelCandidates {
  candidates: ActorSnapshot[]
}

/** The PUT body: a whole chain, replacing whatever is stored. No `org_id`. */
export interface ApprovalChainPayload {
  subject_type: SubjectType
  approval_required: boolean
  levels: ApprovalLevelPayload[]
  levels_operator: LevelOperator
}

/** One person's verdict at one rung, as stored on a record. */
export interface DecisionResponse {
  level: number
  /**
   * What the rung was called *at the moment of the decision*, frozen onto the
   * record. An admin renaming a level must not retroactively change what an
   * approver was told they were signing.
   */
  level_name: string
  actor: ActorSnapshot
  decision: GateDecision
  note?: string | null
  at?: string | null
}

/** Where one rung of a record's chain stands, evaluated live. */
export interface LevelState {
  level: number
  name: string
  quorum: Quorum
  /** This rung is waiting on a signature right now. */
  awaiting: boolean
  /** Its quorum is satisfied and the chain has moved past it. */
  cleared: boolean
  /**
   * An `optional` rung the previous level chose not to escalate to. Render it as
   * skipped rather than omitting it — a rung that vanishes looks like a
   * configuration that never had it.
   */
  skipped: boolean
  /**
   * How many people this rung resolves to on **this record**, right now.
   *
   * Unlike {@link ApprovalLevel.holder_count} this is never `null` — a record's
   * chain is always evaluated against a resolved directory or the request fails,
   * so there is no "not looked up" case to represent. `0` is therefore a real
   * finding, but do not render it as one: the server already turns an
   * unclearable rung into `blocked_reason`, in wording that says what to do
   * about it. A client-side "0 approvers" is a second, worse version of that
   * judgement.
   */
  eligible_count: number
  approved_by: string[]
  rejected_by: string[]
  blocked_reason?: string | null
}
