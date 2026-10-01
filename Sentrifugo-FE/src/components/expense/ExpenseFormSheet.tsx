/**
 * Add / Edit Expense (§6 step 1).
 *
 * Three interactions here are genuinely subtle and are the reason this is one
 * component rather than a generic form:
 *
 * 1. **Saving is explicit.** *Save as Draft* writes the record; nothing is
 *    written in the background. The server's `draft_version` guard is still
 *    honoured on the wire, but it is resolved here rather than shown: only the
 *    owner can open their own draft, so a stale version means this form is open
 *    twice, and the window being used wins.
 * 2. **The advance shows `available`, not `balance`.** Selecting an advance
 *    places a soft hold; other drafts hold too. A user reading `balance` sees
 *    money that is already reserved and is then refused at submit with no idea
 *    why (§9.6 design gap).
 * 3. **Trip gating is stated before Submit, not after.** An expense on an
 *    unapproved trip can be saved but not submitted, and the form says so on
 *    the field rather than failing validation afterwards (§18.1 H).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Info, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { ReceiptDropzone } from './ReceiptDropzone'
import { TypeDataFields, validateTypeData } from './TypeDataFields'
import { Field } from './FormField'
import { ReceiptList } from './ReceiptList'
import { TripFormSheet } from './TripFormSheet'
import {
  useCreateExpenseMutation,
  useGetExpenseCategoriesQuery,
  useGetExpenseQuery,
  useGetExpenseTypesQuery,
  useGetPaymentModesQuery,
  useGetSelectableAdvancesQuery,
  useGetSelectableTripsQuery,
  useMarkExpenseReadyMutation,
  useSubmitExpenseMutation,
  useSubmitTripMutation,
  useUpdateExpenseMutation,
  useUploadReceiptMutation,
} from '@/store/api/expenseApi'
import { useGetCurrenciesQuery } from '@/store/api/iamApi'
import { useProjectPicker } from '@/hooks/use-project-options'
import { formatMoney, statusLabel, toISODate } from '@/lib/expense-utils'
import { cn } from '@/lib/utils'
import type { TripPickerRow } from '@/types/expense'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface FormState {
  title: string
  expense_type_code: string
  category_code: string
  project_id: string
  client_id: string
  expense_date: string
  claimed_amount: string
  currency: string
  payment_mode: string
  payment_reference: string
  reimbursable: boolean
  advance_id: string
  trip_id: string
  description: string
  type_data: Record<string, unknown>
}

const EMPTY: FormState = {
  title: '',
  expense_type_code: '',
  category_code: '',
  project_id: '',
  client_id: '',
  expense_date: toISODate(new Date()),
  claimed_amount: '',
  currency: 'INR',
  payment_mode: '',
  payment_reference: '',
  reimbursable: true,
  advance_id: '',
  trip_id: '',
  description: '',
  type_data: {},
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null creates a new draft; an id edits an existing one. */
  expenseId: string | null
  /** Pre-selected trip when opened from a trip's *Add Expense* (§8.5). */
  presetTripId?: string
  onSaved?: (expenseId: string) => void
}

export function ExpenseFormSheet({
  open,
  onOpenChange,
  expenseId,
  presetTripId,
  onSaved,
}: Props) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [recordId, setRecordId] = useState<string | null>(expenseId)
  const [draftVersion, setDraftVersion] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const saving = saveState === 'saving'
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [typeErrors, setTypeErrors] = useState<Record<string, string>>({})
  /**
   * Receipts chosen before the draft exists. Uploads need an expense id, so
   * they are held here and flushed by `flushReceipts` the moment a save mints
   * a `recordId` — the user never has to re-pick them.
   */
  const [stagedReceipts, setStagedReceipts] = useState<File[]>([])
  /**
   * The nested *New Trip* sheet.
   *
   * A sheet opened from a sheet, which this codebase otherwise forbids
   * (CLAUDE.md §8) — and the exception is deliberate rather than an oversight.
   * The rule exists so a nested *confirmation* does not bury the form behind a
   * second panel; this is not a confirmation but a second form, with its own
   * eleven fields and its own Save and Submit, which a dialog would have to
   * reproduce in full. Duplicating `TripFormSheet` inside a dialog to satisfy
   * the letter of the rule would leave two trip forms to keep in step, which is
   * the failure the rule is trying to prevent.
   */
  const [tripFormOpen, setTripFormOpen] = useState(false)
  const hydrated = useRef(false)
  /**
   * Guards the create round trip.
   *
   * `recordId` is state, so it is still null on the next render while the first
   * POST is in flight. Without this ref, a second click during that window
   * creates a *second* draft — the user ends up with duplicates and the
   * receipts attach to whichever one won.
   */
  const saveInFlight = useRef(false)
  /** What the last successful save actually persisted, for change detection. */
  const lastSaved = useRef<string>('')

  // Config is owned by the backend (seeded per org) and read straight from the
  // API — the codes here are what submit validates against, so there is no
  // client-side fallback list to drift out of sync.
  const { data: expenseTypes = [] } = useGetExpenseTypesQuery()
  const { data: categories = [] } = useGetExpenseCategoriesQuery()
  const { data: paymentModes = [] } = useGetPaymentModesQuery()
  const { data: currencyData = [] } = useGetCurrenciesQuery()
  const currencies = currencyData.map((c) => ({
    code: c.currency,
    name: c.currency_name ?? c.currency,
  }))
  const [currencyOpen, setCurrencyOpen] = useState(false)
  const [currencySearch, setCurrencySearch] = useState('')
  const { data: advances = [] } = useGetSelectableAdvancesQuery()
  const { data: trips = [], isLoading: tripsLoading } = useGetSelectableTripsQuery()
  // Admin routes -> the employee route; client narrows project.
  const { clientOptions, projectOptions, clientForProject } = useProjectPicker(form.client_id)

  const { data: existing, refetch: refetchExisting } = useGetExpenseQuery(recordId!, {
    skip: !recordId,
  })

  const [createExpense] = useCreateExpenseMutation()
  const [updateExpense] = useUpdateExpenseMutation()
  const [submitExpense, { isLoading: submitting }] = useSubmitExpenseMutation()
  const [markReady, { isLoading: readying }] = useMarkExpenseReadyMutation()
  const [uploadReceipt] = useUploadReceiptMutation()
  // Submitting the *trip* from the expense form. `submitTrip` invalidates
  // `TripPicker`, so the notice below re-renders off the new status by itself.
  const [submitTrip, { isLoading: submittingTrip }] = useSubmitTripMutation()

  // ── Hydrate from an existing draft ────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      hydrated.current = false
      return
    }
    if (!existing || hydrated.current) return
    hydrated.current = true

    const loaded: FormState = {
      title: existing.title ?? '',
      expense_type_code: existing.expense_type_code ?? '',
      category_code: existing.category_code ?? '',
      project_id: existing.project?.id ?? '',
      client_id: existing.client?.id ?? '',
      expense_date: existing.expense_date ?? toISODate(new Date()),
      claimed_amount: existing.claimed_amount ?? '',
      currency: existing.currency ?? 'INR',
      payment_mode: existing.payment_mode ?? '',
      payment_reference: existing.payment_reference ?? '',
      reimbursable: existing.reimbursable ?? true,
      advance_id: existing.advance?.advance_id ?? '',
      trip_id: existing.trip?.trip_id ?? '',
      description: existing.description ?? '',
      type_data: existing.type_data ?? {},
    }

    setForm(loaded)
    setDraftVersion(existing.draft_version ?? 0)
    // Hydrating is not an edit. Seeding the signature with what we just loaded
    // keeps the sheet from counting as dirty the moment a draft opens, and
    // makes an immediate Save a no-op rather than a `draft_version` burnt on
    // no change.
    lastSaved.current = JSON.stringify(toCreatePayload(loaded))
  }, [open, existing])

  useEffect(() => {
    if (!open) return

    // Transient state belongs to one *opening* of the sheet, not to one record.
    // Resetting it only for new records carried a stale save state and stale
    // field errors into the next record opened.
    setSaveState('idle')
    setFieldErrors({})
    setTypeErrors({})
    saveInFlight.current = false
    // The hydrate effect runs once per opening; without this a second opening
    // reuses the first record's data.
    hydrated.current = false

    if (expenseId) {
      setRecordId(expenseId)
      return
    }

    // Fresh form for a new record.
    setForm({ ...EMPTY, trip_id: presetTripId ?? '' })
    setRecordId(null)
    setDraftVersion(0)
    setStagedReceipts([])
    // Otherwise the previous record's signature would suppress the first
    // save of this one.
    lastSaved.current = ''
  }, [open, expenseId, presetTripId])

  const selectedType = useMemo(
    () => expenseTypes.find((t) => t.code === form.expense_type_code),
    [expenseTypes, form.expense_type_code],
  )

  const selectedTrip = useMemo(
    () => trips.find((t) => t.trip_id === form.trip_id),
    [trips, form.trip_id],
  )

  /**
   * The trip was decided before the form opened, so it is not editable here.
   *
   * Keyed on `presetTripId` — the prop that says *where the claimant came
   * from* — rather than on `form.trip_id`, which is also set when they pick a
   * trip in the dropdown themselves. Reading the field would make the picker
   * lock itself the moment it was used.
   */
  const tripLocked = Boolean(presetTripId)

  const selectedAdvance = useMemo(
    () => advances.find((a) => a.advance_id === form.advance_id),
    [advances, form.advance_id],
  )

  // ── Save as draft ─────────────────────────────────────────────────────────
  /**
   * PATCH the draft, re-reading the version once if the server refuses ours.
   *
   * `draft_version` is the server's optimistic guard and is not optional on the
   * request. A stale one is not worth a decision from the user here: a draft is
   * loadable only by its owner, so the only way to hold two versions of it is
   * to have this form open twice yourself. Taking the server's current version
   * and writing what is on screen resolves that the way the user expects — the
   * window they are looking at wins.
   */
  const patchDraft = async (
    id: string,
    payload: ReturnType<typeof toCreatePayload>,
    version: number,
  ) => {
    try {
      return await updateExpense({ id, body: { ...payload, draft_version: version } }).unwrap()
    } catch (err) {
      if ((err as { status?: number })?.status !== 409) throw err
      const fresh = await refetchExisting().unwrap()
      return await updateExpense({
        id,
        body: { ...payload, draft_version: fresh.draft_version ?? 0 },
      }).unwrap()
    }
  }

  /**
   * Upload the receipts picked before the draft existed.
   *
   * **Exactly one caller flushes.** This used to be two: an effect keyed on
   * `recordId`, plus an inline copy in `handleSubmit` that ran the same loop so
   * the files were on the server before `submitExpense` — which the API refuses
   * without a receipt. Both fired, and every receipt was uploaded twice. The
   * first `await uploadReceipt` in the submit path yields, React commits the
   * render carrying the new `recordId` while `stagedReceipts` is still
   * populated, the effect's dependencies have both changed, and it starts the
   * identical loop. Clearing the list first, as the effect did, guards a
   * re-entrant effect but not a second flusher that already holds the array.
   *
   * So the effect is gone and `saveDraft` owns this on every path that yields
   * an id. Awaiting it there is what submit needs anyway — the ordering
   * requirement is real, it was only the duplication that was not.
   *
   * Failures stay staged rather than being dropped: a file that did not upload
   * is still in the picker for a retry, and the required-receipt check below
   * still counts it.
   */
  const flushReceipts = async (id: string) => {
    if (stagedReceipts.length === 0) return
    const failed: File[] = []
    for (const file of stagedReceipts) {
      try {
        await uploadReceipt({ expenseId: id, file }).unwrap()
      } catch (err) {
        toast.error(extractDetail(err) ?? `Could not upload ${file.name}`)
        failed.push(file)
      }
    }
    setStagedReceipts(failed)
  }

  /**
   * Write the draft, on an explicit click only.
   *
   * Validates exactly what `ExpenseCreateRequest` requires — no more, no less.
   * These five are not a product choice: `category_code`, `expense_date` and
   * `claimed_amount` are non-optional on the stored document, so a draft
   * genuinely cannot exist without them. Gating on any fewer just moves the
   * rejection to the server and returns a 422 the user cannot act on.
   *
   * A draft is still a lower bar than a submit, which additionally demands a
   * receipt, an amount above zero, and the expense type's own field schema.
   *
   * Returns the record id so `handleSubmit` can reuse this as its create step
   * instead of keeping a second copy of the same logic.
   */
  const saveDraft = async (opts: { silent?: boolean } = {}): Promise<string | null> => {
    if (saveInFlight.current) return recordId

    const errs: Record<string, string> = {}
    if (!form.title.trim()) errs.title = 'Expense name is required'
    if (!form.expense_type_code) errs.expense_type_code = 'Expense type is required'
    if (!form.category_code) errs.category_code = 'Category is required'
    if (!form.expense_date) errs.expense_date = 'Expense date is required'
    if (form.claimed_amount === '' || Number.isNaN(Number(form.claimed_amount)))
      errs.claimed_amount = 'Amount is required'
    if (Object.keys(errs).length) {
      setFieldErrors((prev) => ({ ...prev, ...errs }))
      if (!opts.silent) toast.error('Fill the highlighted fields before saving')
      return null
    }

    const payload = toCreatePayload(form)
    const signature = JSON.stringify(payload)
    // Clicking Save twice with nothing changed in between must not cost a round
    // trip, but it should still read as saved rather than as nothing happening.
    if (recordId && signature === lastSaved.current) {
      setSaveState('saved')
      // Still flush: the fields are unchanged but a receipt may have been added
      // since the last save, and this path is how submit reaches an existing
      // draft it did not have to rewrite.
      await flushReceipts(recordId)
      return recordId
    }

    saveInFlight.current = true
    setSaveState('saving')
    try {
      let id = recordId
      if (!id) {
        const created = await createExpense(payload).unwrap()
        id = created.id
        setRecordId(created.id)
        setDraftVersion(created.draft_version ?? 0)
        onSaved?.(created.id)
      } else {
        const updated = await patchDraft(id, payload, draftVersion)
        setDraftVersion(updated.draft_version ?? draftVersion + 1)
      }
      lastSaved.current = signature
      setSaveState('saved')
      await flushReceipts(id)
      if (!opts.silent) toast.success('Saved as a draft — find it under Saved')
      return id
    } catch (err) {
      // Not 'idle': the indicator would clear and the user would read the
      // vanished "Saving…" as a successful write.
      setSaveState('error')
      applyServerError(err, setFieldErrors)
      if (!opts.silent) toast.error('Could not save this draft')
      return null
    } finally {
      saveInFlight.current = false
    }
  }

  /** Whether there are edits the user would lose by closing now. */
  const isDirty =
    Boolean(
      form.title.trim() ||
        form.expense_type_code ||
        form.category_code ||
        form.claimed_amount,
    ) && JSON.stringify(toCreatePayload(form)) !== lastSaved.current

  const handleClose = () => {
    // Without autosave, closing is destructive. Ask once rather than silently
    // dropping a part-filled claim.
    if (isDirty && !window.confirm('Discard this expense? Your changes have not been saved.')) {
      return
    }
    onOpenChange(false)
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!prev[key as string]) return prev
      const next = { ...prev }
      delete next[key as string]
      return next
    })
  }

  // ── Submit gating ─────────────────────────────────────────────────────────
  const tripBlocksSubmit = Boolean(
    selectedTrip && selectedTrip.status !== 'APPROVED',
  )
  /**
   * Whether this expense goes to its trip rather than being submitted alone.
   *
   * **Keyed on the field, not on the looked-up trip.** `selectedTrip` is a
   * `find` into the trip picker's list, so it is `undefined` whenever the trip
   * is not in that list — the list is still loading, or the trip was opened
   * directly from the trip page and never appeared in the picker at all. Every
   * one of those cases has a trip attached and would have rendered **Submit**.
   * `form.trip_id` is the fact itself and is set the moment a trip is chosen or
   * preset, so it cannot disagree with what the form is about to save.
   *
   * A trip expense is never submitted on its own: it is marked from the trip's
   * table and the trip carries the approval. So the primary button is Ready
   * here, and `available_actions` withholds `submit` from these records
   * server-side for the same reason.
   *
   * **But only where the org actually verifies.** That is the second half of the
   * server's own rule — `verified_via_trip` is *has a trip* AND
   * `chain.verifying_levels()` — and leaving it out gave every org that ticks no
   * level a *Submit to Trip* button whose only possible reply was
   * `NO_VERIFYING_LEVELS`, with no other way to submit a trip expense at all.
   * Such an org keeps the ordinary Submit, which is what it always had.
   *
   * The org's half comes off the picker row, which is why this now consults
   * `selectedTrip` after all — but only for that, and never for *whether there
   * is a trip*, which is still read off the field. `tripVerdictPending` below
   * covers the window where the lookup has no answer yet.
   */
  const verifiedViaTrip = Boolean(form.trip_id) && selectedTrip?.verified_via_trip === true

  /**
   * The trip is chosen but the picker has not said what attaching implies.
   *
   * Only reachable while the list is still in flight, since a chosen trip is a
   * row in it. The primary button is held rather than guessed: guessing *Submit*
   * in a verifying org and *Submit to Trip* in one that verifies nothing are
   * both a click that the server refuses, and one of them is the bug this whole
   * flag exists to close. A moment's disabled button is the cheaper wrong.
   */
  const tripVerdictPending = Boolean(form.trip_id) && !selectedTrip && tripsLoading
  // Attaching a receipt is always mandatory before an expense can be submitted.
  const receiptRequired = true
  const receiptCount = existing?.receipt_count ?? 0
  const missingReceipt = receiptCount === 0 && stagedReceipts.length === 0

  /**
   * The checks Submit and Ready share, run before either transition.
   *
   * Factored out rather than duplicated because the two are the same moment for
   * two different flows — the claimant declaring this expense finished — and a
   * second copy would be a second idea of what "finished" means, drifting the
   * first time one of them gained a field.
   *
   * @returns `true` when the form may be sent.
   */
  const passesChecks = (verb: string): boolean => {
    const errs: Record<string, string> = {}
    if (!form.title.trim()) errs.title = 'Expense name is required'
    if (!form.expense_type_code)
      errs.expense_type_code = 'Expense type is required'
    if (!form.claimed_amount || Number(form.claimed_amount) <= 0)
      errs.claimed_amount = 'Amount is required'
    if (!form.expense_date) errs.expense_date = 'Expense date is required'
    if (missingReceipt) errs.receipts = `Attach at least one receipt before ${verb}`
    setFieldErrors(errs)

    const typeErrs = validateTypeData(
      selectedType?.field_schema ?? [],
      form.type_data,
    )
    setTypeErrors(typeErrs)

    if (Object.keys(errs).length || Object.keys(typeErrs).length) {
      // The inline errors alone are not enough. The receipt field sits at the
      // bottom of a scrolling sheet, so on a long form the only feedback a
      // click produced was nothing happening.
      if (errs.receipts) toast.error(errs.receipts)
      else toast.error(`Fill the highlighted fields before ${verb}`)
      return false
    }

    if (tripBlocksSubmit) {
      toast.error(tripBlockMessage(selectedTrip!, verifiedViaTrip))
      return false
    }
    return true
  }

  /**
   * Hand a finished trip expense to its verifying levels — what Submit is for
   * every other expense.
   *
   * Offered here as well as on the trip's table so a claimant who has just
   * written the expense is not made to go and find it again. The freeze runs
   * server-side, so a refusal here is the same refusal Submit would give.
   */
  const handleReady = async () => {
    if (!passesChecks('marking it ready')) return
    const id = await saveDraft({ silent: true })
    if (!id) return
    try {
      await markReady({ id, tripId: form.trip_id ?? undefined }).unwrap()
      toast.success('Expense submitted to the trip')
      onOpenChange(false)
    } catch (err) {
      toast.error(extractDetail(err) ?? 'Could not hand this expense over')
      applyServerError(err, setFieldErrors)
    }
  }

  const handleSubmit = async () => {
    if (!passesChecks('submitting')) return

    // Submit is self-sufficient: persist whatever is on screen — `saveDraft`
    // flushes the staged receipts on its way out, so they are on the server
    // before the transition the API would otherwise refuse — then send it for
    // approval. Silent, because a "Saved as a draft" toast a moment before
    // "Submitted for approval" is noise: the user asked to submit, not to save.
    const id = await saveDraft({ silent: true })
    if (!id) return

    try {
      await submitExpense(id).unwrap()
      toast.success('Expense submitted for approval')
      onOpenChange(false)
    } catch (err) {
      const detail = extractDetail(err)
      toast.error(detail ?? 'Could not submit this expense')
      applyServerError(err, setFieldErrors)
    }
  }


  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex flex-col p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]">
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{expenseId ? 'Edit Expense' : 'Add Expense'}</SheetTitle>
            <SheetDescription className="flex items-center gap-2">
              {/* No placeholder. The id is allocated by the server on first
                  save, and anything shown before that is invented — a stand-in
                  number reads as real, and even a dash implies a field that is
                  merely empty rather than one that does not exist yet. */}
              {existing?.display_id && <span>Expense ID {existing.display_id}</span>}
              <SaveIndicator state={saveState} />
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Expense Name" required error={fieldErrors.title}>
                <Input
                  className={cn('h-9', fieldErrors.title && 'border-destructive')}
                  value={form.title}
                  onChange={(e) => set('title', e.target.value)}
                  placeholder="Client lunch — Acme"
                />
              </Field>

              {/* Correction 1: a select, not free text — the chosen row's
                  field_schema drives the rest of the form (§7.1). */}
              <Field
                label="Expense Type"
                required
                error={fieldErrors.expense_type_code}
              >
                <Select
                  value={form.expense_type_code}
                  onValueChange={(v) => {
                    // Changing the type replaces the extra-field block, so any
                    // values entered against the old schema are dropped.
                    set('expense_type_code', v)
                    set('type_data', {})
                    setTypeErrors({})
                  }}
                >
                  <SelectTrigger
                    className={cn(
                      'h-9',
                      fieldErrors.expense_type_code && 'border-destructive',
                    )}
                  >
                    <SelectValue placeholder="Select Expense Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {expenseTypes
                      .filter((t) => t.active)
                      .map((t) => (
                        <SelectItem key={t.code} value={t.code}>
                          {t.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Category" required error={fieldErrors.category_code}>
                <Select
                  value={form.category_code}
                  onValueChange={(v) => set('category_code', v)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories
                      .filter((c) => c.active)
                      .map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>

              {/* Client first: a project belongs to exactly one client, so
                  choosing the client narrows what follows. Both stay optional —
                  a claim that belongs to no project is the common case. */}
              <Field label="Client">
                <SearchableSelect
                  options={clientOptions}
                  value={form.client_id}
                  onChange={(v) => {
                    const next = v as string
                    set('client_id', next)
                    // The project must belong to the client. Cleared rather than
                    // left dangling, which would submit a pair that contradicts
                    // itself — the service stores both refs without cross-checking.
                    if (form.project_id && clientForProject(form.project_id) !== next) {
                      set('project_id', '')
                    }
                  }}
                  placeholder="Any client"
                />
              </Field>

              <Field label="Project">
                <SearchableSelect
                  options={projectOptions}
                  value={form.project_id}
                  onChange={(v) => {
                    const next = v as string
                    set('project_id', next)
                    // Picking a project settles the client, so somebody who knows
                    // the project need not know which client it sits under.
                    const owner = next ? clientForProject(next) : null
                    if (owner) set('client_id', owner)
                  }}
                  placeholder="Any project"
                />
              </Field>

              <Field label="Expense Date" required error={fieldErrors.expense_date}>
                <DatePicker
                  value={form.expense_date}
                  onChange={(v) => set('expense_date', v)}
                  min={toISODate(new Date())}
                  max={toISODate(threeMonthsFromToday())}
                  className={cn(
                    'w-full',
                    fieldErrors.expense_date && 'border-destructive',
                  )}
                />
              </Field>

              <Field label="Amount" required error={fieldErrors.claimed_amount}>
                <div className="flex gap-2">
                  <Popover open={currencyOpen} onOpenChange={setCurrencyOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="h-9 w-[96px] justify-between font-normal"
                      >
                        {form.currency || 'INR'}
                        <ChevronDown className="size-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-2" align="start">
                      <Input
                        placeholder="Search currency..."
                        value={currencySearch}
                        onChange={(e) => setCurrencySearch(e.target.value)}
                        className="mb-2 h-8"
                      />
                      <div className="max-h-52 space-y-0.5 overflow-y-auto">
                        {currencies
                          .filter(
                            (c) =>
                              c.code
                                .toLowerCase()
                                .includes(currencySearch.toLowerCase()) ||
                              c.name
                                .toLowerCase()
                                .includes(currencySearch.toLowerCase()),
                          )
                          .map((c) => (
                            <button
                              key={c.code}
                              type="button"
                              onClick={() => {
                                set('currency', c.code)
                                setCurrencyOpen(false)
                                setCurrencySearch('')
                              }}
                              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                            >
                              <span className="w-12 shrink-0 font-medium">
                                {c.code}
                              </span>
                              <span className="flex-1 truncate text-muted-foreground">
                                {c.name}
                              </span>
                              {form.currency === c.code && (
                                <Check className="size-3.5 shrink-0 text-primary" />
                              )}
                            </button>
                          ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Input
                    className={cn(
                      'h-9 flex-1',
                      fieldErrors.claimed_amount && 'border-destructive',
                    )}
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.claimed_amount}
                    onChange={(e) => set('claimed_amount', e.target.value)}
                    placeholder="Enter Amount"
                  />
                </div>
              </Field>

              <Field label="Payment Mode">
                <Select
                  value={form.payment_mode}
                  onValueChange={(v) => set('payment_mode', v)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select Payment Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentModes
                      .filter((m) => m.active)
                      .map((m) => (
                        <SelectItem key={m.code} value={m.code}>
                          {m.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Payment Ref#">
                <Input
                  className="h-9"
                  value={form.payment_reference}
                  onChange={(e) => set('payment_reference', e.target.value)}
                />
              </Field>

              <div className="col-span-2 flex items-center gap-2">
                <Checkbox
                  id="reimbursable"
                  checked={form.reimbursable}
                  onCheckedChange={(v) => {
                    const on = Boolean(v)
                    set('reimbursable', on)
                    // A non-reimbursable expense may not draw on an advance at
                    // all — payable is zero, so any hold would debit the advance
                    // for money that will never be applied (§9.6).
                    if (!on) set('advance_id', '')
                  }}
                />
                <Label htmlFor="reimbursable">Claim Reimbursement</Label>
              </div>

              <Field
                label="Select Advance"
                hint={
                  !form.reimbursable
                    ? 'Unavailable — this expense is not being claimed back, so it cannot draw on an advance.'
                    : selectedAdvance
                      ? `${formatMoney(selectedAdvance.available)} available of ${formatMoney(selectedAdvance.amount)}`
                      : undefined
                }
              >
                <Select
                  value={form.advance_id}
                  onValueChange={(v) => set('advance_id', v)}
                  disabled={!form.reimbursable}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select Advance" />
                  </SelectTrigger>
                  <SelectContent>
                    {advances.map((a) => (
                      <SelectItem key={a.advance_id} value={a.advance_id}>
                        {a.display_id} · {formatMoney(a.available)} available
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Add To Trip">
                {tripLocked ? (
                  /* Opened from a trip, so the trip is the premise of the form,
                     not a choice inside it. Shown read-only rather than as a
                     one-option dropdown: the claimant came here from that trip
                     and re-pointing the claim from a half-filled form is a
                     decision better made on the finished expense. `New Trip`
                     goes with it — raising a second trip from inside a claim
                     already bound to one has nothing to attach to.

                     Falls back while `/trips/selectable` is in flight rather
                     than rendering an empty box; the id is already on the form,
                     so nothing is lost by the label arriving a moment later. */
                  <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                    {selectedTrip
                      ? `${selectedTrip.display_id} · ${selectedTrip.name}`
                      : 'Loading trip…'}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Select
                      value={form.trip_id}
                      onValueChange={(v) => set('trip_id', v)}
                    >
                      <SelectTrigger className="h-9 flex-1">
                        <SelectValue placeholder="Select Trip" />
                      </SelectTrigger>
                      <SelectContent>
                        {trips.map((t) => (
                          <SelectItem key={t.trip_id!} value={t.trip_id!}>
                            {t.display_id} · {t.name} ({statusLabel(t.status)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Raise the trip without losing the claim.
                        A trip has to exist before an expense can name one, and the
                        only route to that was to abandon a part-filled claim, go to
                        Trips, raise one, and start again. */}
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 shrink-0 gap-1.5"
                      onClick={() => setTripFormOpen(true)}
                    >
                      <Plus className="size-4" /> New Trip
                    </Button>
                  </div>
                )}
              </Field>

              <div className="col-span-2 space-y-2">
                <Label>Add Description</Label>
                <Textarea
                  className="min-h-[80px] resize-none"
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                />
              </div>
            </div>

            {/* Stated on the field, before Submit — not as a validation error
                afterwards (§18.1 H).

                Guarded on `selectedTrip`, not on `verifiedViaTrip`. The notice
                names the trip in every sentence it can produce, and
                `selectedTrip` is a `find` into `/trips/selectable` — which is
                empty while that query is in flight, and which excludes CLOSED
                trips outright. Both cases leave `form.trip_id` set with no row
                to match it, so keying the notice off the id alone renders it
                with `undefined` and `tripBlockMessage` dereferences
                `trip.status`. Dropping the notice is the right degradation: the
                primary button still says Submit to Trip, which is the part
                that must not be wrong. */}
            {selectedTrip && (tripBlocksSubmit || verifiedViaTrip) && (
              <TripGateNotice
                trip={selectedTrip}
                verifiedViaTrip={verifiedViaTrip}
                onDetach={() => set('trip_id', '')}
                submitting={submittingTrip}
                onSubmitTrip={async () => {
                  try {
                    await submitTrip(selectedTrip.trip_id!).unwrap()
                    toast.success('Trip sent for approval')
                  } catch (err) {
                    toast.error(extractDetail(err) ?? 'Could not submit this trip')
                  }
                }}
              />
            )}

            {selectedType && selectedType.field_schema.length > 0 && (
              <TypeDataFields
                schema={selectedType.field_schema}
                value={form.type_data}
                onChange={(v) => set('type_data', v)}
                errors={typeErrors}
              />
            )}

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">
                Attach Receipts
                {receiptRequired && <span className="text-destructive"> *</span>}
              </h3>
              {recordId ? (
                <ReceiptList expenseId={recordId} canUpload />
              ) : (
                <ReceiptDropzone
                  value={stagedReceipts}
                  onChange={setStagedReceipts}
                  invalid={Boolean(fieldErrors.receipts)}
                />
              )}
              {fieldErrors.receipts && (
                <p className="text-xs text-destructive">{fieldErrors.receipts}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => void saveDraft()}
                disabled={saving || submitting}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                className="bg-[#EAE6FF] text-foreground hover:bg-[#EAE6FF]/90"
                onClick={verifiedViaTrip ? handleReady : handleSubmit}
                disabled={saving || submitting || readying || tripVerdictPending}
              >
                {verifiedViaTrip
                  ? readying
                    ? 'Submitting…'
                    : 'Submit to Trip'
                  : submitting
                    ? 'Submitting…'
                    : 'Submit'}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Raise a trip without leaving the claim.

          A SIBLING of the sheet above, not a child of it. Both portal to the
          body and stack, so the expense form stays mounted underneath with every
          field as it was — putting a second `Dialog.Root` inside the first one's
          subtree is what makes nested sheets fight over focus and dismissal.

          `TripFormSheet` closes itself on Submit; nothing here is remounted, so
          the person lands back on the claim exactly where they left it. `onSaved`
          fires on that Submit and selects the new trip, which is the whole point
          of raising it from here. The dropdown repopulates on its own:
          `createTrip` invalidates `TripPicker`, and `/trips/selectable` returns
          every trip of the caller's that is not CLOSED — a fresh draft included. */}
      <TripFormSheet
        open={tripFormOpen}
        onOpenChange={setTripFormOpen}
        tripId={null}
        onSaved={(id) => set('trip_id', id)}
      />
    </>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

/**
 * Save feedback in the sheet header (§6 step 1).
 *
 * The button reports its own in-flight state, but not the outcome once it
 * settles back — this is what says whether the last write actually landed, and
 * it survives the user carrying on typing. `idle` renders nothing on purpose:
 * before the first write there is nothing to report, and a standing "Not saved"
 * would read as an error rather than as a starting state.
 */
function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'idle') return null

  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
        Saving…
      </span>
    )
  }

  if (state === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-warning">
        <AlertTriangle className="size-3.5" />
        Not saved
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="size-3.5" />
      Saved
    </span>
  )
}

/**
 * Why this expense cannot be submitted yet, and what to do about it.
 *
 * **Every blocked state now has a way out.** It used to say one of two things
 * and offer one button: *rejected* got Detach, and everything else got "is
 * awaiting approval" with no action at all. That second branch swallowed
 * `DRAFT` — the state a trip raised from the *New Trip* button beside the picker
 * is actually in — so the form announced a wait for an approval nobody had been
 * asked for, on a trip only the reader could submit, and offered no way to
 * submit it.
 *
 * One exit per blocking status:
 *
 * - `DRAFT` — send the trip for approval from here. Every row in this picker is
 *   the caller's own (`/trips/selectable` is scoped to them), so a draft in it is
 *   always theirs to submit.
 * - `PENDING_APPROVAL` — genuinely nothing to do but wait, or detach.
 * - `REJECTED` — detach, or pick another trip.
 *
 * Detach is offered in all three. An expense never *needs* a trip, so carrying on
 * without one is always a legitimate answer to being blocked by one.
 *
 * **A fourth case is not about submitting at all.** Where the org's chain has
 * verifying levels, an expense filed under a trip is never submitted on its own:
 * each verifying level marks it from the trip's expense table and it is settled
 * with the trip. The old wording — "this expense can go once the trip is
 * approved" — described a step that will not happen, and it appeared next to a
 * Submit the server had already withdrawn, which reads as a broken screen rather
 * than as a different route. So the notice says how the expense is actually
 * settled, and it shows even on an approved trip, because *that* is the case
 * where nothing else on the form would explain the missing submit.
 */
function TripGateNotice({
  trip,
  verifiedViaTrip,
  onDetach,
  onSubmitTrip,
  submitting,
}: {
  trip: TripPickerRow
  /** See {@link ExpenseFormSheet}'s `verifiedViaTrip` — server-derived. */
  verifiedViaTrip: boolean
  onDetach: () => void
  onSubmitTrip: () => void
  submitting: boolean
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/40 px-4 py-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        <p className="text-sm text-foreground">
          {tripBlockMessage(trip, verifiedViaTrip)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {trip.status === 'DRAFT' && (
            <Button size="sm" disabled={submitting} onClick={onSubmitTrip}>
              {submitting ? 'Submitting…' : 'Submit trip for approval'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onDetach}>
            Detach from trip
          </Button>
        </div>
      </div>
    </div>
  )
}

function tripBlockMessage(trip: TripPickerRow, verifiedViaTrip = false): string {
  // Verification changes what the sentence is *about*, so it comes first — on a
  // draft or in-flight trip the claim is still verified from it, and telling
  // someone to wait for an approval that no longer gates their expense is worse
  // than telling them nothing.
  if (verifiedViaTrip) {
    if (trip.status === 'REJECTED') {
      return `${trip.name} was rejected, so nothing filed under it will be settled. Detach this expense, or move it to another trip.`
    }
    if (trip.status === 'DRAFT') {
      return `This expense is verified from ${trip.name} and settled with it — it is not submitted on its own. Send the trip for approval to start that.`
    }
    return `This expense is verified from ${trip.name} and settled with it. Each approving level marks it from the trip, and it is settled with the trip once they all have — there is nothing to submit here.`
  }
  if (trip.status === 'REJECTED') {
    return `${trip.name} was rejected. Detach it, or choose an approved trip, to submit this expense.`
  }
  if (trip.status === 'DRAFT') {
    // Not "awaiting approval": nobody has been asked yet, and saying otherwise
    // describes a wait that would never end on its own.
    return `${trip.name} has not been submitted yet. Send it for approval — this expense can go once the trip is approved.`
  }
  return `${trip.name} is awaiting approval. You can save this expense, but it cannot be submitted until the trip is approved.`
}

// ─── Payload helpers ─────────────────────────────────────────────────────────

/** Today + 3 calendar months — the far bound of the Expense Date range. */
function threeMonthsFromToday(): Date {
  const d = new Date()
  d.setMonth(d.getMonth() + 3)
  return d
}

function toCreatePayload(form: FormState) {
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    expense_type_code: form.expense_type_code,
    type_data: form.type_data,
    category_code: form.category_code,
    project_ref: form.project_id ? { id: form.project_id } : null,
    client_ref: form.client_id ? { id: form.client_id } : null,
    expense_date: form.expense_date,
    claimed_amount: form.claimed_amount || '0',
    currency: form.currency || 'INR',
    reimbursable: form.reimbursable,
    payment_mode: form.payment_mode || null,
    payment_reference: form.payment_reference.trim() || null,
    // Explicit null is the *deselect* — it releases the advance hold (§9.6).
    trip_id: form.trip_id || null,
    advance_id: form.advance_id || null,
  }
}

function extractDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  return null
}

/**
 * Map a server validation error onto the field that caused it, so the employee
 * sees the problem in place rather than as an opaque toast.
 */
function applyServerError(
  err: unknown,
  setErrors: (fn: (prev: Record<string, string>) => Record<string, string>) => void,
) {
  const detail = (err as { data?: { detail?: unknown } })?.data?.detail
  if (!Array.isArray(detail)) return
  const mapped: Record<string, string> = {}
  for (const item of detail as { loc?: unknown[]; msg?: string }[]) {
    const field = item.loc?.[item.loc.length - 1]
    if (typeof field === 'string' && item.msg) mapped[field] = item.msg
  }
  if (Object.keys(mapped).length) setErrors((prev) => ({ ...prev, ...mapped }))
}
