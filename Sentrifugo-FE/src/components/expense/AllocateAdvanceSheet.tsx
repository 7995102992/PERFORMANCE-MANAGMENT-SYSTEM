/**
 * Allocate Advance (§9.4) — Finance raising an advance in an employee's name.
 *
 * **It runs the org's approval chain**, exactly as an employee's own request
 * does. Who signs it, how many rungs it has and whether it needs approval at all
 * come from *Settings → Advances*; none of that is a property of the button that
 * raised it. `ApprovalRoutePreview` shows the route before it is committed, for
 * the same reason it shows on the request form: nobody should commit money
 * without being told where it goes.
 *
 * **So there are no payment fields.** There used to be, and Payment Mode was
 * required here and nowhere else, because an allocation was created already
 * `ACTIVE` — the allocating manager was taken to be authoriser and disburser at
 * once, and the form recorded a payment that had supposedly already happened.
 * With a chain in front of it nothing has been paid at the moment this is
 * submitted. The advance becomes drawable through *Disburse* once it clears,
 * the same door a requested advance goes through.
 *
 * **Anyone in the organisation except yourself.** It was direct reports only,
 * checked against the IAM reporting edge. Finance reports nobody, so keeping
 * that would have left this form able to pay only the handful of people who
 * happen to report into Finance. Self-allocation is still refused server-side —
 * raising money for yourself is self-approval wearing another form — and the
 * picker drops you from its own list rather than letting you find out on submit.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { ApprovalRoutePreview } from './ApprovalRoutePreview'
import { Field } from './FormField'
import { useAppSelector } from '@/store'
import {
  useCreateAdvanceAllocationMutation,
  useGetApproverCandidatesQuery,
} from '@/store/api/expenseApi'
import { useGetEmployeesQuery } from '@/store/api/iamApi'
import { useProjectPicker } from '@/hooks/use-project-options'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AllocateAdvanceSheet({ open, onOpenChange }: Props) {
  const [employeeId, setEmployeeId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [clientId, setClientId] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const currentUser = useAppSelector((s) => s.auth.user)
  const { data: employees = [], isLoading: employeesLoading } =
    useGetEmployeesQuery({ limit: 1000 })
  // Admin routes -> the employee route; client narrows project.
  const { clientOptions, projectOptions, clientForProject } = useProjectPicker(clientId)

  // Resolved for the employee being paid, not for Finance: the chain's first
  // rung is usually their reporting manager. Skipped until one is chosen, so the
  // preview appears with a route in it rather than flashing an empty one.
  const { data: candidates, isFetching: candidatesLoading } =
    useGetApproverCandidatesQuery(
      { forEmployeeId: employeeId },
      { skip: !open || !employeeId },
    )

  const [allocate, { isLoading: allocating }] = useCreateAdvanceAllocationMutation()

  /**
   * Everyone in the organisation, less the caller.
   *
   * The old list derived direct reports from the employee pool's `l1ManagerId`
   * edge, which is dead weight now: Finance is not anybody's L1 and the server
   * stopped checking. Self is still filtered out, so the one refusal the server
   * does make is not reachable from the picker.
   */
  const people = useMemo(() => {
    const me = currentUser?.id ? String(currentUser.id) : null
    return employees
      .filter((e) => {
        const own = [e.id, e.userId, e.user_id].filter(Boolean).map(String)
        return !me || !own.includes(me)
      })
      .map((e) => ({
        label: [e.firstName ?? e.first_name, e.lastName ?? e.last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || (e.workEmail ?? e.id),
        value: String(e.userId ?? e.user_id ?? e.id),
      }))
  }, [employees, currentUser])

  const reset = () => {
    setEmployeeId('')
    setProjectId('')
    setClientId('')
    setAmount('')
    setDescription('')
    setErrors({})
  }

  const close = () => {
    reset()
    onOpenChange(false)
  }

  /** Drop a field's error as soon as it is corrected. */
  const clearError = (key: string) =>
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })

  /** Required-field check, surfaced on the fields rather than by a dead button. */
  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!employeeId) next.employeeId = 'Employee is required'
    if (!amount || Number(amount) <= 0) next.amount = 'Valid amount is required'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const save = async () => {
    if (!validate()) return
    try {
      await allocate({
        employee_id: employeeId,
        amount,
        description: description.trim() || null,
        project_ref: projectId ? { id: projectId } : null,
        client_ref: clientId ? { id: clientId } : null,
      }).unwrap()
      toast.success('Advance raised and sent for approval')
      close()
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not raise this advance')
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <SheetContent className="flex w-[520px] flex-col p-0 sm:max-w-[560px]">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>Allocate Advance</SheetTitle>
          <SheetDescription>
            Raises an advance in the employee&apos;s name and sends it through
            your organisation&apos;s approval chain. It becomes drawable once it
            is approved and you record the disbursement.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Employee"
              required
              className="col-span-2"
              error={errors.employeeId}
              hint="You cannot allocate an advance to yourself."
            >
              <SearchableSelect
                options={people}
                value={employeeId}
                onChange={(v) => {
                  setEmployeeId(v as string)
                  clearError('employeeId')
                }}
                placeholder={employeesLoading ? 'Loading…' : 'Select Employee'}
                emptyMessage="No employees found"
                loading={employeesLoading}
              />
            </Field>

            <Field label="Client">
              <SearchableSelect
                options={clientOptions}
                value={clientId}
                onChange={(v) => {
                  const next = v as string
                  setClientId(next)
                  // The project must belong to the client. Cleared rather than
                  // left dangling, which would submit a pair that contradicts
                  // itself — and the service stores refs without cross-checking.
                  if (projectId && clientForProject(projectId) !== next) setProjectId('')
                }}
                placeholder="Any client"
              />
            </Field>

            <Field label="Project">
              <SearchableSelect
                options={projectOptions}
                value={projectId}
                onChange={(v) => {
                  const next = v as string
                  setProjectId(next)
                  // Picking a project settles the client, so somebody who knows
                  // the project need not know which client it sits under.
                  const owner = next ? clientForProject(next) : null
                  if (owner) setClientId(owner)
                }}
                placeholder="Any project"
              />
            </Field>

            <Field label="Amount" required error={errors.amount}>
              <Input
                className="h-9"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  clearError('amount')
                }}
                placeholder="Enter Amount"
              />
            </Field>

            <div className="col-span-2 space-y-2">
              <Label htmlFor="alloc-description">Add Description</Label>
              <Textarea
                id="alloc-description"
                className="min-h-[80px] resize-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          {/* The chain resolved for this org, before there is a record to ask.
              Phrased for a third party: the approvers are the *employee's*, and
              Finance raising it is not being asked to confirm its own route. */}
          <ApprovalRoutePreview
            levels={candidates?.chain_preview}
            approvalRequired={candidates?.approval_required}
            loading={candidatesLoading}
            heading="This advance will go to"
          />
        </div>

        <div className="flex items-center justify-between border-t px-6 py-4">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            className="bg-[#EAE6FF] text-foreground hover:bg-[#EAE6FF]/90"
            disabled={allocating}
            onClick={save}
          >
            {allocating ? 'Raising…' : 'Allocate'}
          </Button>
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
