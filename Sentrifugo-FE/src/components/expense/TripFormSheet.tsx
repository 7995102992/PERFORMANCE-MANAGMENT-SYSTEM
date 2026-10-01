/**
 * Add / Edit Trip (§8.3).
 *
 * The one thing this form has to get right is that **its required fields depend
 * on the trip type**, and that conditionality is enforced server-side by type
 * rather than by a schema predicate — a Domestic trip needs a state, an
 * International one needs a country and may declare a visa requirement.
 *
 * Fields are conditionally **rendered**, never rendered disabled (CLAUDE.md
 * §11): switching Domestic → International adds Country and the visa question,
 * switching back removes them. A greyed-out Country on a domestic trip reads as
 * a broken form rather than an inapplicable one.
 *
 * Project and client are pickers against the platform master here as everywhere
 * else (correction 10). They are a *default* the expense form pre-fills from,
 * never an override — the expense's own values always win (§8.3).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Field } from './FormField'
import {
  useCreateTripMutation,
  useGetTripQuery,
  useSubmitTripMutation,
  useUpdateTripMutation,
} from '@/store/api/expenseApi'
import {
  useGetCitiesQuery,
  useGetCountriesQuery,
  useGetStatesQuery,
} from '@/store/api/iamApi'
import { useProjectPicker } from '@/hooks/use-project-options'
import { toISODate } from '@/lib/expense-utils'
import type { TripType, VisaRequirement } from '@/types/expense'

interface FormState {
  name: string
  trip_type: TripType
  destination_city: string
  destination_country: string
  destination_state: string
  visa_required: VisaRequirement | ''
  project_id: string
  project_name: string
  client_id: string
  client_name: string
  from_date: string
  to_date: string
  description: string
}

const EMPTY: FormState = {
  name: '',
  trip_type: 'DOMESTIC',
  destination_city: '',
  destination_country: '',
  destination_state: '',
  visa_required: '',
  project_id: '',
  project_name: '',
  client_id: '',
  client_name: '',
  from_date: toISODate(new Date()),
  to_date: toISODate(new Date()),
  description: '',
}

const VISA_OPTIONS: { value: VisaRequirement; label: string }[] = [
  { value: 'YES', label: 'Yes' },
  { value: 'NO', label: 'No' },
  { value: 'NOT_SURE', label: 'Not sure' },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null creates a new trip; an id edits an existing one. */
  tripId?: string | null
  onSaved?: (tripId: string) => void
}

export function TripFormSheet({ open, onOpenChange, tripId, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  /**
   * The trip this sheet is writing to — the `tripId` prop until a Save mints one.
   *
   * Needed the moment Save became its own button. `tripId` is a prop and stays
   * null for the whole life of an *Add Trip* sheet, so a second Save would have
   * POSTed a second trip and left the person with duplicate drafts and no sign
   * of it. The first Save records the id here; every later write is a PATCH.
   */
  const [recordId, setRecordId] = useState<string | null>(tripId ?? null)
  const hydrated = useRef(false)

  const { data: existing } = useGetTripQuery(tripId!, { skip: !tripId || !open })
  const [createTrip, { isLoading: creating }] = useCreateTripMutation()
  const [updateTrip, { isLoading: updating }] = useUpdateTripMutation()
  const [submitTrip, { isLoading: submitting }] = useSubmitTripMutation()
  /** The draft write, whichever of create/update it turns out to be. */
  const saving = creating || updating

  const { data: countries = [] } = useGetCountriesQuery({ limit: 300 })
  // Admin routes -> the employee route; client narrows project.
  const { clientOptions, projectOptions, clientForProject } = useProjectPicker(form.client_id)

  const isInternational = form.trip_type === 'INTERNATIONAL'

  // States are scoped to the chosen country on an international trip. On a
  // domestic one the country is implied (the org's own), so the state master is
  // queried unscoped.
  const selectedCountry = countries.find((c) => c.name === form.destination_country)
  const { data: states = [] } = useGetStatesQuery(
    isInternational
      ? { country_id: selectedCountry?.id ?? null, limit: 300 }
      : { country_name: 'India', limit: 300 },
    { skip: isInternational && !selectedCountry },
  )

  // Cities are scoped to the chosen state, exactly as states are to the country.
  // No state chosen yet → nothing to list.
  const { data: cities = [] } = useGetCitiesQuery(
    { state_name: form.destination_state, limit: 300 },
    { skip: !form.destination_state },
  )

  // Fresh form each time the sheet opens for a new trip. The sheet is not
  // unmounted between opens, so there is no mount to reset on — this is the
  // "reset when a prop changes" case, and the state is local to the form.
  useEffect(() => {
    if (open && !tripId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(EMPTY)
      setErrors({})
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecordId(null)
    }
  }, [open, tripId])

  // Hydrate from the fetched record when editing — synchronising local form
  // state from an async external source. Guarded by a ref so a background
  // refetch cannot stamp over what the user has typed since it loaded.
  useEffect(() => {
    if (!open) {
      hydrated.current = false
      return
    }
    if (!tripId || !existing || hydrated.current) return
    hydrated.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm({
      name: existing.name ?? '',
      trip_type: existing.trip_type ?? 'DOMESTIC',
      destination_city: existing.destination_city ?? '',
      destination_country: existing.destination_country ?? '',
      destination_state: existing.destination_state ?? '',
      visa_required: existing.visa_required ?? '',
      project_id: existing.project_ref?.id ?? '',
      project_name: existing.project_ref?.name ?? '',
      client_id: existing.client_ref?.id ?? '',
      client_name: existing.client_ref?.name ?? '',
      from_date: existing.from_date ?? toISODate(new Date()),
      to_date: existing.to_date ?? toISODate(new Date()),
      description: existing.description ?? '',
    })
  }, [open, tripId, existing])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key as string]) return prev
      const next = { ...prev }
      delete next[key as string]
      return next
    })
  }

  const countryOptions = useMemo(
    () => countries.map((c) => ({ label: c.name, value: c.name })),
    [countries],
  )
  const stateOptions = useMemo(
    () => states.map((s) => ({ label: s.name, value: s.name })),
    [states],
  )
  const cityOptions = useMemo(
    () => cities.map((c) => ({ label: c.name, value: c.name })),
    [cities],
  )

  /**
   * Mirrors the server's per-type rule so the traveller sees the problem on the
   * field. The server is still the control — this only saves a round trip.
   */
  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!form.name.trim()) next.name = 'Trip name is required'
    if (!form.from_date) next.from_date = 'From date is required'
    if (!form.to_date) next.to_date = 'To date is required'
    if (form.from_date && form.to_date && form.to_date < form.from_date) {
      next.to_date = 'To date cannot be before the from date'
    }
    if (isInternational) {
      if (!form.destination_country) {
        next.destination_country = 'Destination country is required for an international trip'
      }
    } else if (!form.destination_state) {
      next.destination_state = 'Destination state is required for a domestic trip'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  /**
   * Write the draft and return its id.
   *
   * **This is what the Submit button used to do.** It called `createTrip` /
   * `updateTrip` and nothing else, so a trip left this sheet in `DRAFT` under a
   * button that said "Submitting…" — the write succeeded, the trip went nowhere
   * near an approver, and there was no Save button anywhere to explain that the
   * draft was all you had asked for. The two actions are separate now, and this
   * is the one the label always described.
   *
   * Returns the id so `handleSubmit` can reuse it as its create step rather than
   * keeping a second copy of the same payload mapping — the same arrangement
   * `ExpenseFormSheet` uses.
   *
   * @param opts.silent Suppress the toast, for when Submit's own toast follows.
   */
  const saveDraft = async (opts: { silent?: boolean } = {}): Promise<string | null> => {
    if (!validate()) return null
    const payload = {
      name: form.name.trim(),
      trip_type: form.trip_type,
      destination_city: form.destination_city.trim() || null,
      // A domestic trip's country is implied by the org, so it is never sent —
      // and its visa question does not exist.
      destination_country: isInternational ? form.destination_country || null : null,
      destination_state: form.destination_state || null,
      visa_required: isInternational ? (form.visa_required || null) : null,
      project_ref: form.project_id
        ? { id: form.project_id, name: form.project_name || null }
        : null,
      client_ref: form.client_id
        ? { id: form.client_id, name: form.client_name || null }
        : null,
      from_date: form.from_date,
      to_date: form.to_date,
      description: form.description.trim() || null,
    }

    try {
      let id = recordId
      if (id) {
        await updateTrip({ id, body: payload }).unwrap()
      } else {
        const created = await createTrip(payload).unwrap()
        id = created.id
        setRecordId(id)
      }
      // Stays open, and does NOT call `onSaved`. On this sheet that callback is
      // "I am finished, take me to the trip" — `TripList` answers it by opening
      // the detail drawer, and its edit mount also unmounts this sheet. Firing it
      // on a checkpoint would throw the person out of the form they are still
      // filling in. The list refreshes anyway: the create and update mutations
      // both invalidate `TripList`.
      if (!opts.silent) {
        toast.success(
          recordId ? 'Trip updated' : 'Saved as a draft — find it under Saved',
        )
      }
      return id
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not save this trip')
      return null
    }
  }

  /**
   * Persist whatever is on screen, then send the trip for approval.
   *
   * Silent on the draft write: a "Saved as a draft" toast a moment before
   * "Submitted for approval" is noise, and the second one is the answer to what
   * the person actually clicked.
   */
  const handleSubmit = async () => {
    const id = await saveDraft({ silent: true })
    if (!id) return
    try {
      await submitTrip(id).unwrap()
      toast.success('Trip submitted for approval')
      onSaved?.(id)
      onOpenChange(false)
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not submit this trip')
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{tripId ? 'Edit Trip' : 'Add Trip'}</SheetTitle>
          <SheetDescription>
            {existing?.display_id
              ? `Trip ID ${existing.display_id}`
              : 'A trip is authorised before travel, and gates the expenses filed under it'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Trip Name" required error={errors.name}>
              <Input
                className="h-9"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Acme rollout — Bangalore"
              />
            </Field>

            <Field label="Trip Type" required>
              <Select
                value={form.trip_type}
                onValueChange={(v) => {
                  const next = v as TripType
                  set('trip_type', next)
                  // Clear what no longer applies, so a domestic trip cannot
                  // carry a stale country or visa answer from an earlier edit.
                  if (next === 'DOMESTIC') {
                    set('destination_country', '')
                    set('visa_required', '')
                  }
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DOMESTIC">Domestic</SelectItem>
                  <SelectItem value="INTERNATIONAL">International</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {/* Country exists only on an international trip — a domestic one
                implies the org's own country (§8.3). */}
            {isInternational && (
              <Field
                label="Destination Country"
                required
                error={errors.destination_country}
              >
                <SearchableSelect
                  options={countryOptions}
                  value={form.destination_country}
                  onChange={(v) => {
                    set('destination_country', v as string)
                    // The state list is scoped to the country; a state (and its
                    // city) from the previous country would be nonsense.
                    set('destination_state', '')
                    set('destination_city', '')
                  }}
                  placeholder="Select Country"
                />
              </Field>
            )}

            <Field
              label="Destination State"
              required={!isInternational}
              error={errors.destination_state}
            >
              <SearchableSelect
                options={stateOptions}
                value={form.destination_state}
                onChange={(v) => {
                  set('destination_state', v as string)
                  // Cities are scoped to the state; a city from the previous
                  // state would be nonsense.
                  set('destination_city', '')
                }}
                placeholder={
                  isInternational && !form.destination_country
                    ? 'Choose a country first'
                    : 'Select State'
                }
                disabled={isInternational && !form.destination_country}
              />
            </Field>

            <Field label="Destination City" error={errors.destination_city}>
              <SearchableSelect
                options={cityOptions}
                value={form.destination_city}
                onChange={(v) => set('destination_city', v as string)}
                placeholder={
                  form.destination_state
                    ? 'Select City'
                    : 'Choose a state first'
                }
                disabled={!form.destination_state}
              />
            </Field>

            {/* Client first: a project belongs to exactly one client, so
                choosing the client narrows what follows. Both stay optional —
                a trip that belongs to no project is the common case. */}
            <Field label="Client">
              <SearchableSelect
                options={clientOptions}
                value={form.client_id}
                onChange={(v) => {
                  const id = v as string
                  set('client_id', id)
                  set('client_name', clientOptions.find((o) => o.value === id)?.label ?? '')
                  // The project must belong to the client. Cleared rather than
                  // left dangling, which would submit a pair that contradicts
                  // itself — the service stores both refs without cross-checking.
                  if (form.project_id && clientForProject(form.project_id) !== id) {
                    set('project_id', '')
                    set('project_name', '')
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
                  const id = v as string
                  set('project_id', id)
                  set('project_name', projectOptions.find((o) => o.value === id)?.label ?? '')
                  // Picking a project settles the client, so somebody who knows
                  // the project need not know which client it sits under.
                  const owner = id ? clientForProject(id) : null
                  if (owner) {
                    set('client_id', owner)
                    set('client_name', clientOptions.find((o) => o.value === owner)?.label ?? '')
                  }
                }}
                placeholder="Any project"
              />
            </Field>

            <Field label="From Date" required error={errors.from_date}>
              <DatePicker
                value={form.from_date}
                onChange={(v) => set('from_date', v)}
              />
            </Field>

            <Field label="To Date" required error={errors.to_date}>
              <DatePicker
                value={form.to_date}
                onChange={(v) => set('to_date', v)}
                min={form.from_date || undefined}
              />
            </Field>

            {/* A flag on an authorisation, not a visa workflow (§8.8). */}
            {isInternational && (
              <Field label="Is Visa Required?">
                <Select
                  value={form.visa_required}
                  onValueChange={(v) => set('visa_required', v as VisaRequirement)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    {VISA_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            <div className="col-span-2 space-y-2">
              <Label>Add Description</Label>
              <Textarea
                className="min-h-[80px] resize-none"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* The same three-button bar `ExpenseFormSheet` ends on, in the same
            order: leave, checkpoint, commit. */}
        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => void saveDraft()}
              disabled={saving || submitting}
            >
              {saving && !submitting ? 'Saving…' : 'Save'}
            </Button>
            <Button
              className="bg-[#EAE6FF] text-foreground hover:bg-[#EAE6FF]/90"
              onClick={handleSubmit}
              disabled={saving || submitting}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function errorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  return null
}
