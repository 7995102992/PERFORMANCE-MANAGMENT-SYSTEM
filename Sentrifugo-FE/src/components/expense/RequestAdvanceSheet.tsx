/**
 * Request Advance (§9.3) — the employee-initiated origin.
 *
 * **The form asks for no approvers.** It used to carry two pickers — the first
 * rung, and a nomination for the optional rung above it — each constrained to a
 * server-supplied candidate list so an employee could not route their own
 * advance to a friendly peer. The approval chain in settings now answers the
 * whole question: its first rung resolves the reporting manager from the record,
 * and every rung above resolves to a role, a permission, or the people the admin
 * named. Asking the requester to restate that per request left two sources for
 * one routing decision, able to disagree.
 *
 * The fields are still accepted by the API and still validated when sent, so an
 * older client is refused rather than quietly misrouted; this form simply no
 * longer sends them.
 *
 * **It does still say where the request goes.** Not asking is not the same as
 * not telling: the pickers were the only place the destination was ever named,
 * and the record cannot name it either until after submit. `ApprovalRoutePreview`
 * reads the org's live chain, resolved for this requester.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { Field } from './FormField'
import { ApprovalRoutePreview } from './ApprovalRoutePreview'
import {
  useCreateAdvanceRequestMutation,
  useGetApproverCandidatesQuery,
  useSubmitAdvanceMutation,
} from '@/store/api/expenseApi'
import { useProjectPicker } from '@/hooks/use-project-options'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RequestAdvanceSheet({ open, onOpenChange }: Props) {
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [clientId, setClientId] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)

  // Admin routes -> the employee route; client narrows project.
  const { clientOptions, projectOptions, clientForProject } = useProjectPicker(clientId)

  const [createRequest, { isLoading: creating }] = useCreateAdvanceRequestMutation()
  const [submitAdvance, { isLoading: submitting }] = useSubmitAdvanceMutation()

  /**
   * Where this request will go, since the form no longer asks.
   *
   * Skipped while the sheet is closed: it resolves the org's chain against the
   * live directory, which is not work to do for a drawer nobody has opened.
   */
  const { data: route, isLoading: routeLoading } = useGetApproverCandidatesQuery(undefined, {
    skip: !open,
  })

  const reset = () => {
    setTitle('')
    setAmount('')
    setProjectId('')
    setClientId('')
    setDescription('')
    setSubmitAttempted(false)
  }

  const close = () => {
    reset()
    onOpenChange(false)
  }

  const valid = Boolean(title.trim() && amount && Number(amount) > 0)

  const save = async (thenSubmit: boolean) => {
    try {
      const created = await createRequest({
        title: title.trim(),
        amount,
        description: description.trim() || null,
        project_ref: projectId ? { id: projectId } : null,
        client_ref: clientId ? { id: clientId } : null,
      }).unwrap()

      if (thenSubmit) {
        await submitAdvance(created.id).unwrap()
        toast.success('Advance request submitted for approval')
      } else {
        toast.success('Advance request saved')
      }
      close()
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not raise this advance request')
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <SheetContent className="flex flex-col p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>Request Advance</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Advance Name"
              required
              error={submitAttempted && !title.trim() ? 'Advance name is required' : undefined}
            >
              <Input
                className="h-9"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter Advance Name"
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

            <Field
              label="Amount"
              required
              error={submitAttempted && (!amount || Number(amount) <= 0) ? 'Valid amount is required' : undefined}
            >
              <Input
                className="h-9"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Enter Amount"
              />
            </Field>

            <div className="col-span-2 space-y-2">
              <Label htmlFor="adv-description">Add Description</Label>
              <Textarea
                id="adv-description"
                className="min-h-[80px] resize-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this advance for?"
              />
            </div>
          </div>

          {/* Below the fields and above the footer: the last thing read before
              Submit is pressed, which is when it matters. */}
          <ApprovalRoutePreview
            levels={route?.chain_preview}
            approvalRequired={route?.approval_required ?? true}
            loading={routeLoading}
          />
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button
            className="bg-primary/10 text-foreground hover:bg-primary/15"
            disabled={creating || submitting}
            onClick={() => {
              setSubmitAttempted(true)
              if (valid) save(true)
            }}
          >
            {submitting ? 'Submitting…' : 'Submit'}
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
