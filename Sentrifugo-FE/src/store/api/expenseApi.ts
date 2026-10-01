/**
 * Expense Management API — sentrifugo-expenense-service-be.
 *
 * One approval chain, three subjects (expense / trip / advance), so the gate
 * mutations are generated from a shared factory rather than written out three
 * times: the request bodies are already identical server-side
 * (`src/gates/schemas.py`) and three hand-rolled copies is how they drift.
 *
 * Invalidation is the subtle part. One gate action moves money across three
 * collections — submitting an expense commits a draw against an advance, and a
 * Gate-2 approval at a lower amount trues that draw back up. Every mutation that
 * can touch the ledger therefore invalidates the advance tags too, or the user
 * files an expense and sees a stale balance on the Advances page.
 */
import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery, repeatArrayParams } from './baseQuery'
import type {
  ApprovalChain,
  ApprovalChainPayload,
  ApprovalLevelPayload,
  LevelCandidates,
  ActorListResponse,
  AdvanceAllocationPayload,
  AdvanceDetail,
  AdvanceListParams,
  AdvanceRequestPayload,
  AdvanceReturnPayload,
  AdvanceRow,
  AdvanceSummary,
  ApproverCandidatesResponse,
  ApprovePayload,
  BulkMarkPaidResponse,
  BulkSettleResponse,
  CalendarResponse,
  CommentCreatePayload,
  CommentResponse,
  DisbursementPayload,
  ExpenseCategoryOut,
  ExpenseCreatePayload,
  ExpenseDetail,
  ExpenseListParams,
  ExpenseRow,
  ExpenseTypeOut,
  ExpenseUpdatePayload,
  ForwardPayload,
  MarkPaidPayload,
  PageResult,
  PaymentModeOut,
  RejectPayload,
  SelectableAdvance,
  SendBackPayload,
  SettlementPreviewResponse,
  SubjectType,
  SummaryResponse,
  TimelineResponse,
  TripCalendarResponse,
  TripCreatePayload,
  TripDeleteResponse,
  TripDetail,
  TripExportResponse,
  TripListParams,
  TripPickerRow,
  TripRow,
  TripSummaryResponse,
} from '@/types/expense'

const EXPENSE_BASE_URL = import.meta.env.VITE_EXPENSE_API_BASE_URL as string

/** Tags touched by any expense gate action. */
const EXPENSE_WIDE = [
  'ExpenseList',
  'ExpenseSummary',
  'ExpenseCalendar',
] as const

/**
 * Tags for a mutation that can move the advance ledger.
 *
 * Submit commits a hold to `utilized`; reject and send-back release it; a
 * Gate-2 approval below the claimed amount trues it up (§9.6). None of those
 * name the advance in the request, so we cannot invalidate it by id — the whole
 * advance surface is refetched instead. Correct, and cheap enough: these are
 * one-at-a-time human actions, not a hot path.
 */
// `AdvancePicker` belongs here, not only on the advance's own mutations. The
// *Return Advance* picker carries each advance's balance, and an expense drawing
// on that advance moves it without touching the advance directly — so without
// this the sheet offers a balance from before the draw, and a return sized
// against it is refused by the server with `OVER_RETURN`. That reads to the
// employee as "I cannot return any more", which is how this was reported.
const LEDGER_WIDE = [
  'Advance',
  'AdvanceList',
  'AdvanceSummary',
  'AdvancePicker',
] as const

/** Everything a trip gate transition invalidates, for one trip id. */
const TRIP_WIDE = (id: string) =>
  [
    { type: 'Trip' as const, id },
    { type: 'Timeline' as const, id },
    'TripList' as const,
    'TripSummary' as const,
    'TripCalendar' as const,
    'TripPicker' as const,
  ] as const

/**
 * A verification mark's blast radius — the tags one mark or unmark makes stale.
 *
 * **Both timelines, not one.** Every mark, unmark and bulk settle writes two
 * history rows: one against the expense and one against the trip, so the trip's
 * rail reads as a list of its expenses being cleared. Invalidating only the
 * expense's timeline leaves the rail on the *very screen the mark was made from*
 * showing the state before it — the trip sheet renders the marks and the trip
 * timeline side by side.
 *
 * The trip itself goes too: its rollup and its own action set move as its
 * expenses clear. `tripId` is optional only because the caller may not have it
 * to hand; without it the trip lists are still refreshed, so nothing is left
 * stale that the user can see, only refetched more narrowly than it could be.
 *
 * No `LEDGER_WIDE` here on purpose. A mark is a signature, not a settlement —
 * it moves no money and no advance draw, so pulling the whole advance surface
 * down on every row of a long trip would be cost with nothing to show for it.
 * Bulk settle *does* move the ledger, and invalidates it.
 */
const VERIFICATION_WIDE = (expenseId: string, tripId?: string | null) => [
  { type: 'Expense' as const, id: expenseId },
  { type: 'Timeline' as const, id: expenseId },
  ...EXPENSE_WIDE,
  ...(tripId ? TRIP_WIDE(tripId) : (['TripList', 'TripSummary'] as const)),
]

export const expenseApi = createApi({
  reducerPath: 'expenseApi',
  // Status filters are multi-valued (the Submitted tile is three statuses) and
  // this backend declares them as repeatable query params.
  baseQuery: createBaseQuery(EXPENSE_BASE_URL, { paramsSerializer: repeatArrayParams }),
  tagTypes: [
    'ApprovalChain',
    'Expense',
    'ExpenseList',
    'ExpenseSummary',
    'ExpenseCalendar',
    'Trip',
    'TripList',
    'TripSummary',
    'TripCalendar',
    'TripPicker',
    'Advance',
    'AdvanceList',
    'AdvanceSummary',
    'AdvancePicker',
    'Receipt',
    'Comment',
    'Timeline',
    'ExpenseConfig',
    'Directory',
  ],
  endpoints: (builder) => ({
    // ─── Config (§11.1) — seeded, effectively static per session ─────────────
    getExpenseTypes: builder.query<ExpenseTypeOut[], void>({
      query: () => ({ url: '/expense-config/expense-types' }),
      providesTags: ['ExpenseConfig'],
      keepUnusedDataFor: 3600,
    }),

    getExpenseCategories: builder.query<ExpenseCategoryOut[], void>({
      query: () => ({ url: '/expense-config/categories' }),
      providesTags: ['ExpenseConfig'],
      keepUnusedDataFor: 3600,
    }),

    getPaymentModes: builder.query<PaymentModeOut[], void>({
      query: () => ({ url: '/expense-config/payment-modes' }),
      providesTags: ['ExpenseConfig'],
      keepUnusedDataFor: 3600,
    }),

    // ─── Approval chain (approval-chain-hld.md §2, §7) ─────────────────────
    /**
     * The org's approval configuration for one subject.
     *
     * Never 404s. An org that has never opened the settings page gets a default
     * chain — a single reporting-manager level — because "the manager approves"
     * is a real, renderable answer and the page has to draw itself either way.
     *
     * The response carries **live** holder counts per level, so the page can warn
     * about a chain that can never clear at configuration time rather than when a
     * claim is already stuck behind it. That means this call can fail with a
     * retryable 503 when IAM is unreachable: the live resolution is the whole
     * point of the endpoint, and a 200 with every warning silently missing is the
     * page failing its job while looking authoritative.
     */
    getApprovalChain: builder.query<ApprovalChain, { subject_type?: SubjectType } | void>({
      query: (params) => ({
        url: '/expense-config/approval-chain',
        params: params ?? {},
      }),
      providesTags: ['ApprovalChain'],
    }),

    /**
     * Resolve one **unsaved** level to the people it may be narrowed to.
     *
     * A mutation rather than a query because it POSTs a level being composed —
     * its roles are not stored yet — but it reads nothing and writes nothing, so
     * it invalidates no tags.
     */
    getLevelCandidates: builder.mutation<LevelCandidates, ApprovalLevelPayload>({
      query: (body) => ({
        url: '/expense-config/approval-chain/level-candidates',
        method: 'POST',
        body,
      }),
    }),

    /**
     * Whole-chain replacement, not a patch. A partial update of a *sequenced
     * ladder* has no meaning an admin could predict — is a posted level appended,
     * or does it replace level 2?
     *
     * Invalidates the expense and trip lists as well as the chain: the chain
     * decides which buttons an approver is offered, so a stale action bar would
     * offer an action the server now refuses.
     */
    putApprovalChain: builder.mutation<ApprovalChain, ApprovalChainPayload>({
      query: (body) => ({ url: '/expense-config/approval-chain', method: 'PUT', body }),
      invalidatesTags: ['ApprovalChain', 'Expense', 'ExpenseList', 'Trip', 'TripList'],
    }),

    // ─── Directory (§5.2) — resolved live, never cached as a roster ──────────
    getManagerCandidates: builder.query<ActorListResponse, { search?: string } | void>({
      query: (params) => ({ url: '/directory/manager-candidates', params: params ?? {} }),
      providesTags: ['Directory'],
    }),

    // ─── Expense lists ───────────────────────────────────────────────────────
    getExpenses: builder.query<PageResult<ExpenseRow>, ExpenseListParams>({
      query: ({ scope, ...params }) => ({ url: `/expenses/${scope}`, params }),
      providesTags: ['ExpenseList'],
    }),

    getExpenseSummary: builder.query<
      SummaryResponse,
      Omit<ExpenseListParams, 'page' | 'page_size'>
    >({
      query: (params) => ({ url: '/expenses/summary', params }),
      providesTags: ['ExpenseSummary'],
    }),

    getExpenseCalendar: builder.query<
      CalendarResponse,
      Omit<ExpenseListParams, 'page' | 'page_size'> & { card_limit?: number }
    >({
      query: (params) => ({ url: '/expenses/calendar', params }),
      providesTags: ['ExpenseCalendar'],
    }),

    // ─── Expense record ──────────────────────────────────────────────────────
    getExpense: builder.query<ExpenseDetail, string>({
      query: (id) => ({ url: `/expenses/${id}` }),
      providesTags: (_r, _e, id) => [{ type: 'Expense', id }],
    }),

    createExpense: builder.mutation<ExpenseDetail, ExpenseCreatePayload>({
      query: (body) => ({ url: '/expenses', method: 'POST', body }),
      invalidatesTags: [...EXPENSE_WIDE, ...LEDGER_WIDE, 'TripPicker'],
    }),

    /**
     * Debounced autosave. Sends only changed fields plus `draft_version`; a lost
     * race returns 409 and must be surfaced, not silently retried.
     *
     * Invalidates the ledger because changing `claimed_amount` or `advance_id`
     * recomputes the soft hold on every save (§9.6).
     */
    updateExpense: builder.mutation<
      ExpenseDetail,
      { id: string; body: ExpenseUpdatePayload }
    >({
      query: ({ id, body }) => ({ url: `/expenses/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Expense', id },
        ...EXPENSE_WIDE,
        ...LEDGER_WIDE,
      ],
    }),

    /**
     * Put an existing draft onto a trip — the *Attach existing…* picker.
     *
     * The same `PATCH /expenses/{id}` as `updateExpense`, declared separately
     * because the two need different blast radii. `updateExpense` is the
     * debounced autosave: hanging `TRIP_WIDE` on it would refetch the trip
     * list, summary and calendar on every keystroke that lands a save. Attaching
     * happens once, deliberately, and genuinely does move the trip's totals.
     *
     * Both tag sets are needed. `VERIFICATION_WIDE` refreshes the expense, its
     * timeline and the expense surface — the row's `verification` block and its
     * `available_actions` both change the moment a trip is attached, because
     * `applies_to` starts governing it. `TRIP_WIDE` refreshes the trip that just
     * gained a line. Miss either and the row keeps a stale verification block
     * and the wrong primary button.
     */
    attachExpenseToTrip: builder.mutation<
      ExpenseDetail,
      { id: string; tripId: string; draftVersion: number }
    >({
      query: ({ id, tripId, draftVersion }) => ({
        url: `/expenses/${id}`,
        method: 'PATCH',
        body: { trip_id: tripId, draft_version: draftVersion },
      }),
      invalidatesTags: (_r, _e, { id, tripId }) => [
        ...VERIFICATION_WIDE(id, tripId),
        ...TRIP_WIDE(tripId),
      ],
    }),

    deleteExpense: builder.mutation<void, string>({
      query: (id) => ({ url: `/expenses/${id}`, method: 'DELETE' }),
      invalidatesTags: [...EXPENSE_WIDE, ...LEDGER_WIDE, 'Trip'],
    }),

    // ─── Expense gate actions ────────────────────────────────────────────────
    submitExpense: builder.mutation<ExpenseDetail, string>({
      query: (id) => ({ url: `/expenses/${id}/submit`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
        ...LEDGER_WIDE,
        'Trip',
      ],
    }),

    approveExpense: builder.mutation<
      ExpenseDetail,
      { id: string; body: ApprovePayload }
    >({
      query: ({ id, body }) => ({ url: `/expenses/${id}/approve`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
        ...LEDGER_WIDE,
        'Trip',
      ],
    }),

    rejectExpense: builder.mutation<ExpenseDetail, { id: string; body: RejectPayload }>({
      query: ({ id, body }) => ({ url: `/expenses/${id}/reject`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
        ...LEDGER_WIDE,
        'Trip',
      ],
    }),

    sendBackExpense: builder.mutation<
      ExpenseDetail,
      { id: string; body: SendBackPayload }
    >({
      query: ({ id, body }) => ({
        url: `/expenses/${id}/send-back`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
        ...LEDGER_WIDE,
        'Trip',
      ],
    }),

    forwardExpense: builder.mutation<ExpenseDetail, { id: string; body: ForwardPayload }>({
      query: ({ id, body }) => ({ url: `/expenses/${id}/forward`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
      ],
    }),

    recallExpense: builder.mutation<ExpenseDetail, string>({
      query: (id) => ({ url: `/expenses/${id}/recall`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
      ],
    }),

    markExpensePaid: builder.mutation<
      ExpenseDetail,
      { id: string; body: MarkPaidPayload }
    >({
      query: ({ id, body }) => ({ url: `/expenses/${id}/mark-paid`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Expense', id },
        { type: 'Timeline', id },
        ...EXPENSE_WIDE,
        ...LEDGER_WIDE,
        'Trip',
      ],
    }),

    /**
     * Gate-2 what-if. Recomputes advance_applied and net_payable without
     * committing, so the approver sees the money returning to the employee's
     * advance before deciding (§18.1 B). Never invalidates — it writes nothing.
     */
    previewApprovedAmount: builder.mutation<
      SettlementPreviewResponse,
      { id: string; approved_amount: string }
    >({
      query: ({ id, approved_amount }) => ({
        url: `/expenses/${id}/approved-amount/preview`,
        method: 'POST',
        body: { approved_amount },
      }),
    }),

    bulkMarkPaid: builder.mutation<
      BulkMarkPaidResponse,
      MarkPaidPayload & { expense_ids: string[] }
    >({
      query: (body) => ({ url: '/expenses/bulk-mark-paid', method: 'POST', body }),
      invalidatesTags: [...EXPENSE_WIDE, ...LEDGER_WIDE, 'Trip'],
    }),

    // ─── Trip verification ───────────────────────────────────────────────────
    /**
     * Leave this caller's mark on one trip expense.
     *
     * Sent only where the record itself said `verification.can_verify`. The
     * client never decides who may mark, which rung is next, or whether the
     * claimant is about to verify their own claim — the server resolves the
     * verifying level exactly as it resolves an approver, and refuses anything
     * else. `tripId` is passed for invalidation only; the URL names the expense.
     */
    verifyExpense: builder.mutation<
      ExpenseDetail,
      { id: string; tripId?: string | null }
    >({
      query: ({ id }) => ({ url: `/expenses/${id}/verify`, method: 'POST' }),
      invalidatesTags: (_r, _e, { id, tripId }) => VERIFICATION_WIDE(id, tripId),
    }),

    /**
     * Undo a mark — **and every mark above it**.
     *
     * The cascade is the server's, not something the UI replays row by row: a
     * higher level marked on the strength of the one beneath it, so withdrawing
     * the lower one withdraws what rested on it, the same principle as a
     * send-back discarding the decisions beneath it. That is why this
     * invalidates the whole expense rather than patching a single rung: one
     * call can change several.
     *
     * `POST /unverify`, not `DELETE /verify`. It carries a mandatory reason now
     * — the levels above whose marks this sweeps away only ever learn why from
     * the timeline row it writes — and a DELETE with a body is dropped or
     * stripped by enough proxies and fetch stacks to be a bad bet. The verb
     * moved rather than the payload becoming a query string because a reason is
     * free text that can run to `NOTE_MAX_LENGTH`.
     */
    unverifyExpense: builder.mutation<
      ExpenseDetail,
      { id: string; tripId?: string | null; reason: string }
    >({
      query: ({ id, reason }) => ({
        url: `/expenses/${id}/unverify`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: (_r, _e, { id, tripId }) => VERIFICATION_WIDE(id, tripId),
    }),

    /**
     * Refuse the awaiting rung: back to the claimant as a draft, marks cleared.
     *
     * The counterpart that verification lacked. Until this existed a verifier
     * who would not pass a row could only decline to press Verify — silently,
     * with nothing written down and nobody told — because the approval chain
     * never opens on a trip expense, so `reject` and `send_back` are not among
     * its actions and never will be.
     *
     * Same invalidation as a mark, and for a stronger reason: the server clears
     * **every** mark on the record, not just the awaiting rung, since the
     * figures those signatures were given against are about to be edited. Rungs
     * the caller cannot see change, so nothing local may be patched.
     */
    notVerifyExpense: builder.mutation<
      ExpenseDetail,
      { id: string; tripId?: string | null; reason: string }
    >({
      query: ({ id, reason }) => ({
        url: `/expenses/${id}/not-verified`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: (_r, _e, { id, tripId }) => VERIFICATION_WIDE(id, tripId),
    }),

    /**
     * The claimant hands a finished trip expense to its verifying levels.
     *
     * What `submit` is for every other expense, and it invalidates the same
     * breadth: the row leaves the claimant's Saved tile, appears on the trip's
     * table for its markers, and both timelines gain a milestone.
     */
    markExpenseReady: builder.mutation<
      ExpenseDetail,
      { id: string; tripId?: string | null }
    >({
      query: ({ id }) => ({ url: `/expenses/${id}/ready`, method: 'POST' }),
      invalidatesTags: (_r, _e, { id, tripId }) => VERIFICATION_WIDE(id, tripId),
    }),

    /**
     * Take an unmarked expense back to `DRAFT` to change it.
     *
     * Refused by the server the moment any level has marked it — the claimant
     * editing under a standing mark is what `PENDING_VERIFICATION` exists to
     * prevent, so this is not a client-side rule to re-check, just a button the
     * server's `can_unready` withdraws.
     */
    unreadyExpense: builder.mutation<
      ExpenseDetail,
      { id: string; tripId?: string | null }
    >({
      query: ({ id }) => ({ url: `/expenses/${id}/ready`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, { id, tripId }) => VERIFICATION_WIDE(id, tripId),
    }),

    // ─── Receipts (§10) ──────────────────────────────────────────────────────
    getReceipts: builder.query<{ items: unknown[]; total: number }, string>({
      query: (expenseId) => ({ url: `/receipts/expense/${expenseId}` }),
      providesTags: (_r, _e, id) => [{ type: 'Receipt', id }],
    }),

    uploadReceipt: builder.mutation<unknown, { expenseId: string; file: File }>({
      query: ({ expenseId, file }) => {
        const form = new FormData()
        form.append('file', file)
        return { url: `/receipts/expense/${expenseId}`, method: 'POST', body: form }
      },
      invalidatesTags: (_r, _e, { expenseId }) => [
        { type: 'Receipt', id: expenseId },
        { type: 'Expense', id: expenseId },
      ],
    }),

    /**
     * Short-TTL presigned URL. Call at click time, never at render time — a URL
     * minted on page load is dead by the time a slow reader clicks it (§10.2).
     */
    getReceiptDownloadUrl: builder.mutation<
      { id: string; filename: string; content_type: string; url: string; expires_in: number },
      string
    >({
      query: (receiptId) => ({ url: `/receipts/${receiptId}/download` }),
    }),

    deleteReceipt: builder.mutation<void, { receiptId: string; expenseId: string }>({
      query: ({ receiptId }) => ({ url: `/receipts/${receiptId}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, { expenseId }) => [
        { type: 'Receipt', id: expenseId },
        { type: 'Expense', id: expenseId },
      ],
    }),

    // ─── History / comments — subject-typed, one shape for all three ─────────
    getTimeline: builder.query<
      TimelineResponse,
      { subjectType: SubjectType; subjectId: string }
    >({
      query: ({ subjectType, subjectId }) => ({
        url: `/history/${subjectType}/${subjectId}`,
      }),
      providesTags: (_r, _e, { subjectId }) => [{ type: 'Timeline', id: subjectId }],
    }),

    getComments: builder.query<
      CommentResponse[],
      { subjectType: SubjectType; subjectId: string }
    >({
      query: ({ subjectType, subjectId }) => ({
        url: '/comments',
        params: { subject_type: subjectType, subject_id: subjectId },
      }),
      transformResponse: (res: unknown): CommentResponse[] =>
        Array.isArray(res)
          ? (res as CommentResponse[])
          : (((res as Record<string, unknown>)?.items ?? []) as CommentResponse[]),
      providesTags: (_r, _e, { subjectId }) => [{ type: 'Comment', id: subjectId }],
    }),

    createComment: builder.mutation<CommentResponse, CommentCreatePayload>({
      query: (body) => ({ url: '/comments', method: 'POST', body }),
      invalidatesTags: (_r, _e, { subject_id }) => [{ type: 'Comment', id: subject_id }],
    }),

    deleteComment: builder.mutation<void, { commentId: string; subjectId: string }>({
      query: ({ commentId }) => ({ url: `/comments/${commentId}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, { subjectId }) => [{ type: 'Comment', id: subjectId }],
    }),

    // ─── Trips (§8) ──────────────────────────────────────────────────────────
    getTrips: builder.query<PageResult<TripRow>, TripListParams>({
      query: (params) => ({ url: '/trips', params }),
      providesTags: ['TripList'],
    }),

    getTripSummary: builder.query<
      TripSummaryResponse,
      Omit<TripListParams, 'page' | 'page_size'>
    >({
      query: (params) => ({ url: '/trips/summary', params }),
      providesTags: ['TripSummary'],
    }),

    getTripCalendar: builder.query<
      TripCalendarResponse,
      Omit<TripListParams, 'page' | 'page_size'> & { card_limit?: number }
    >({
      query: (params) => ({ url: '/trips/calendar', params }),
      providesTags: ['TripCalendar'],
    }),

    /** Non-closed trips the caller owns. Status drives the form's gating note. */
    getSelectableTrips: builder.query<TripPickerRow[], void>({
      query: () => ({ url: '/trips/selectable' }),
      transformResponse: (res: unknown): TripPickerRow[] =>
        Array.isArray(res)
          ? (res as TripPickerRow[])
          : (((res as Record<string, unknown>)?.items ?? []) as TripPickerRow[]),
      providesTags: ['TripPicker'],
    }),

    getTrip: builder.query<TripDetail, string>({
      query: (id) => ({ url: `/trips/${id}` }),
      providesTags: (_r, _e, id) => [{ type: 'Trip', id }],
    }),

    createTrip: builder.mutation<TripDetail, TripCreatePayload>({
      query: (body) => ({ url: '/trips', method: 'POST', body }),
      invalidatesTags: ['TripList', 'TripSummary', 'TripCalendar', 'TripPicker'],
    }),

    updateTrip: builder.mutation<
      TripDetail,
      { id: string; body: Partial<TripCreatePayload> }
    >({
      query: ({ id, body }) => ({ url: `/trips/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Trip', id },
        'TripList',
        'TripSummary',
        'TripCalendar',
        'TripPicker',
      ],
    }),

    deleteTrip: builder.mutation<TripDeleteResponse, string>({
      query: (id) => ({ url: `/trips/${id}`, method: 'DELETE' }),
      invalidatesTags: [
        'TripList',
        'TripSummary',
        'TripCalendar',
        'TripPicker',
        ...EXPENSE_WIDE,
      ],
    }),

    closeTrip: builder.mutation<TripDetail, string>({
      query: (id) => ({ url: `/trips/${id}/close`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Trip', id },
        { type: 'Timeline', id },
        'TripList',
        'TripSummary',
        'TripPicker',
      ],
    }),

    cloneTrip: builder.mutation<TripDetail, string>({
      query: (id) => ({ url: `/trips/${id}/clone`, method: 'POST' }),
      invalidatesTags: ['TripList', 'TripSummary', 'TripCalendar', 'TripPicker'],
    }),

    exportTrip: builder.query<TripExportResponse, string>({
      query: (id) => ({ url: `/trips/${id}/export` }),
    }),

    /**
     * Trip gate actions — the *same* chain as an expense (§5.1, §8.2).
     *
     * The wireframes draw only a trip's L1 stage (Approve / Reject) and no
     * Finance stage, no forward and no recall (§18 gap 12). Trips run the full
     * shared chain, so they get the full action set, over the same bodies.
     */
    submitTrip: builder.mutation<TripDetail, string>({
      query: (id) => ({ url: `/trips/${id}/submit`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [...TRIP_WIDE(id)],
    }),

    approveTrip: builder.mutation<TripDetail, { id: string; body: ApprovePayload }>({
      query: ({ id, body }) => ({ url: `/trips/${id}/approve`, method: 'POST', body }),
      // A trip reaching APPROVED makes its attached expenses submittable, so
      // the expense lists are stale from this moment on (§8.5).
      invalidatesTags: (_r, _e, { id }) => [...TRIP_WIDE(id), ...EXPENSE_WIDE],
    }),

    rejectTrip: builder.mutation<TripDetail, { id: string; body: RejectPayload }>({
      query: ({ id, body }) => ({ url: `/trips/${id}/reject`, method: 'POST', body }),
      // A rejected trip strands its attached expenses — they cannot be
      // submitted until detached or re-pointed, so their rows change too.
      invalidatesTags: (_r, _e, { id }) => [...TRIP_WIDE(id), ...EXPENSE_WIDE],
    }),

    sendBackTrip: builder.mutation<TripDetail, { id: string; body: SendBackPayload }>({
      query: ({ id, body }) => ({ url: `/trips/${id}/send-back`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [...TRIP_WIDE(id), ...EXPENSE_WIDE],
    }),

    forwardTrip: builder.mutation<TripDetail, { id: string; body: ForwardPayload }>({
      query: ({ id, body }) => ({ url: `/trips/${id}/forward`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [...TRIP_WIDE(id)],
    }),

    recallTrip: builder.mutation<TripDetail, string>({
      query: (id) => ({ url: `/trips/${id}/recall`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [...TRIP_WIDE(id)],
    }),

    /**
     * Settle every fully-verified expense under one trip, in one action.
     *
     * The body is `mark_paid`'s, because this *is* mark-paid — one payment
     * reference against a batch — and the records land on `SETTLED` like any
     * other settlement, tagged bulk-approved rather than carrying a status of
     * their own.
     *
     * Invalidation is deliberately blunt. The batch touches an unknown set of
     * expenses, so there are no ids to name: the bare `Expense` and `Timeline`
     * tags drop every cached expense detail and every rail, expense and trip
     * alike. The alternative — invalidating only what the response happened to
     * settle — leaves a *skipped* row's cached detail claiming it is still
     * awaiting a mark that the run has just told us about.
     */
    bulkSettleTrip: builder.mutation<
      BulkSettleResponse,
      { id: string; body: MarkPaidPayload }
    >({
      query: ({ id, body }) => ({
        url: `/trips/${id}/bulk-settle`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        'Expense',
        'Timeline',
        ...TRIP_WIDE(id),
        ...EXPENSE_WIDE,
        // Settling releases each claim's advance draw, so the balances on the
        // Advances page are stale from this moment on (§9.6).
        ...LEDGER_WIDE,
      ],
    }),

    // ─── Advances (§9) ───────────────────────────────────────────────────────
    getAdvances: builder.query<PageResult<AdvanceRow>, AdvanceListParams>({
      query: (params) => ({ url: '/advances', params }),
      providesTags: ['AdvanceList'],
    }),

    getAdvanceSummary: builder.query<
      AdvanceSummary,
      Omit<AdvanceListParams, 'page' | 'page_size'>
    >({
      query: (params) => ({ url: '/advances/summary', params }),
      providesTags: ['AdvanceSummary'],
    }),

    /**
     * Only ACTIVE advances with available balance. An APPROVED-but-undisbursed
     * advance is deliberately absent — approved is a promise, `available` is
     * zero, and drawing against unpaid money is what this split prevents (§9.3).
     */
    getSelectableAdvances: builder.query<SelectableAdvance[], void>({
      query: () => ({ url: '/advances/selectable' }),
      transformResponse: (res: unknown): SelectableAdvance[] =>
        Array.isArray(res)
          ? (res as SelectableAdvance[])
          : (((res as Record<string, unknown>)?.items ?? []) as SelectableAdvance[]),
      providesTags: ['AdvancePicker'],
    }),

    /** The caller's own advances with a non-zero balance, for Return Advance. */
    getReturnableAdvances: builder.query<SelectableAdvance[], void>({
      query: () => ({ url: '/advances/returnable' }),
      transformResponse: (res: unknown): SelectableAdvance[] =>
        Array.isArray(res)
          ? (res as SelectableAdvance[])
          : (((res as Record<string, unknown>)?.items ?? []) as SelectableAdvance[]),
      providesTags: ['AdvancePicker'],
    }),

    /**
     * Approver 1 = the reporting manager; Approver 2 = an L2 nomination (§9.3),
     * plus `chain_preview` — the whole ladder, resolved live.
     *
     * `forEmployeeId` asks about somebody else, which the allocation form needs:
     * the chain belongs to the employee being paid, so a preview resolved for
     * Finance would name Finance's own manager at the reporting-manager rung.
     * Finance-only server-side; the request form omits it and asks about itself.
     */
    getApproverCandidates: builder.query<
      ApproverCandidatesResponse,
      { forEmployeeId?: string } | void
    >({
      query: (args) => ({
        url: '/advances/approver-candidates',
        params: args?.forEmployeeId ? { for_employee_id: args.forEmployeeId } : undefined,
      }),
      providesTags: ['Directory'],
    }),

    /**
     * Who *this advance's* escalation would go to, resolved now.
     *
     * Read from the chain snapshotted on the record, not the org's live one: an
     * admin editing the settings page must not change where a request already in
     * flight would go. Empty when the record's chain has no escalation rung —
     * which is also when the button offering it should not be drawn.
     */
    getAdvanceEscalationCandidates: builder.query<ActorListResponse, string>({
      query: (id) => ({ url: `/advances/${id}/escalation-candidates` }),
      providesTags: ['Directory'],
    }),

    getAdvance: builder.query<AdvanceDetail, string>({
      query: (id) => ({ url: `/advances/${id}` }),
      providesTags: (_r, _e, id) => [{ type: 'Advance', id }],
    }),

    createAdvanceRequest: builder.mutation<AdvanceDetail, AdvanceRequestPayload>({
      query: (body) => ({ url: '/advances/requests', method: 'POST', body }),
      invalidatesTags: [...LEDGER_WIDE],
    }),

    createAdvanceAllocation: builder.mutation<AdvanceDetail, AdvanceAllocationPayload>({
      query: (body) => ({ url: '/advances/allocations', method: 'POST', body }),
      invalidatesTags: [...LEDGER_WIDE, 'AdvancePicker'],
    }),

    updateAdvance: builder.mutation<
      AdvanceDetail,
      { id: string; body: Partial<AdvanceRequestPayload> }
    >({
      query: ({ id, body }) => ({ url: `/advances/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'Advance', id }, ...LEDGER_WIDE],
    }),

    deleteAdvance: builder.mutation<void, string>({
      query: (id) => ({ url: `/advances/${id}`, method: 'DELETE' }),
      invalidatesTags: [...LEDGER_WIDE, 'AdvancePicker'],
    }),

    submitAdvance: builder.mutation<AdvanceDetail, string>({
      query: (id) => ({ url: `/advances/${id}/submit`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
      ],
    }),

    approveAdvance: builder.mutation<AdvanceDetail, { id: string; body: ApprovePayload }>({
      query: ({ id, body }) => ({ url: `/advances/${id}/approve`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
      ],
    }),

    rejectAdvance: builder.mutation<AdvanceDetail, { id: string; body: RejectPayload }>({
      query: ({ id, body }) => ({ url: `/advances/${id}/reject`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
      ],
    }),

    sendBackAdvance: builder.mutation<AdvanceDetail, { id: string; body: SendBackPayload }>({
      query: ({ id, body }) => ({ url: `/advances/${id}/send-back`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
      ],
    }),

    forwardAdvance: builder.mutation<AdvanceDetail, { id: string; body: ForwardPayload }>({
      query: ({ id, body }) => ({ url: `/advances/${id}/forward`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
      ],
    }),

    recallAdvance: builder.mutation<AdvanceDetail, string>({
      query: (id) => ({ url: `/advances/${id}/recall`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
      ],
    }),

    /** APPROVED → ACTIVE. Until this runs, `available` is zero (§9.3). */
    disburseAdvance: builder.mutation<
      AdvanceDetail,
      { id: string; body: DisbursementPayload }
    >({
      query: ({ id, body }) => ({ url: `/advances/${id}/disburse`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
        'AdvancePicker',
      ],
    }),

    returnAdvance: builder.mutation<
      AdvanceDetail,
      { id: string; body: AdvanceReturnPayload }
    >({
      query: ({ id, body }) => ({ url: `/advances/${id}/returns`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
        'AdvancePicker',
      ],
    }),

    closeAdvance: builder.mutation<AdvanceDetail, string>({
      query: (id) => ({ url: `/advances/${id}/close`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [
        { type: 'Advance', id },
        { type: 'Timeline', id },
        ...LEDGER_WIDE,
        'AdvancePicker',
      ],
    }),
  }),
})

export const {
  // config
  useGetExpenseTypesQuery,
  useGetExpenseCategoriesQuery,
  useGetPaymentModesQuery,
  // directory
  useGetApprovalChainQuery,
  useGetLevelCandidatesMutation,
  usePutApprovalChainMutation,
  useGetManagerCandidatesQuery,
  // expense lists
  useGetExpensesQuery,
  useGetExpenseSummaryQuery,
  useGetExpenseCalendarQuery,
  // expense record
  useGetExpenseQuery,
  useLazyGetExpenseQuery,
  useAttachExpenseToTripMutation,
  useCreateExpenseMutation,
  useUpdateExpenseMutation,
  useDeleteExpenseMutation,
  // expense gates
  useSubmitExpenseMutation,
  useApproveExpenseMutation,
  useRejectExpenseMutation,
  useSendBackExpenseMutation,
  useForwardExpenseMutation,
  useRecallExpenseMutation,
  useMarkExpensePaidMutation,
  usePreviewApprovedAmountMutation,
  useBulkMarkPaidMutation,
  // trip verification
  useVerifyExpenseMutation,
  useUnverifyExpenseMutation,
  useNotVerifyExpenseMutation,
  useMarkExpenseReadyMutation,
  useUnreadyExpenseMutation,
  // receipts
  useGetReceiptsQuery,
  useUploadReceiptMutation,
  useGetReceiptDownloadUrlMutation,
  useDeleteReceiptMutation,
  // history / comments
  useGetTimelineQuery,
  useGetCommentsQuery,
  useCreateCommentMutation,
  useDeleteCommentMutation,
  // trips
  useGetTripsQuery,
  useGetTripSummaryQuery,
  useGetTripCalendarQuery,
  useGetSelectableTripsQuery,
  useGetTripQuery,
  useCreateTripMutation,
  useUpdateTripMutation,
  useDeleteTripMutation,
  useCloseTripMutation,
  useCloneTripMutation,
  useLazyExportTripQuery,
  useSubmitTripMutation,
  useApproveTripMutation,
  useRejectTripMutation,
  useSendBackTripMutation,
  useForwardTripMutation,
  useRecallTripMutation,
  useBulkSettleTripMutation,
  // advances
  useGetAdvancesQuery,
  useGetAdvanceSummaryQuery,
  useGetSelectableAdvancesQuery,
  useGetReturnableAdvancesQuery,
  useGetApproverCandidatesQuery,
  useGetAdvanceEscalationCandidatesQuery,
  useGetAdvanceQuery,
  useCreateAdvanceRequestMutation,
  useCreateAdvanceAllocationMutation,
  useUpdateAdvanceMutation,
  useDeleteAdvanceMutation,
  useSubmitAdvanceMutation,
  useApproveAdvanceMutation,
  useRejectAdvanceMutation,
  useSendBackAdvanceMutation,
  useForwardAdvanceMutation,
  useRecallAdvanceMutation,
  useDisburseAdvanceMutation,
  useReturnAdvanceMutation,
  useCloseAdvanceMutation,
} = expenseApi
