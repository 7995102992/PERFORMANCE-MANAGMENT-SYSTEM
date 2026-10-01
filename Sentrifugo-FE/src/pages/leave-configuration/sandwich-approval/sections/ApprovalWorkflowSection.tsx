import { useFormContext, Controller, useFieldArray } from 'react-hook-form'
import { Trash2, ChevronRight } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SectionCard } from '../../leave-entitlement/shared/SectionCard'
import type { SandwichApprovalFormValues } from '../schema'

export function ApprovalWorkflowSection() {
  const { control, watch, setValue, formState: { errors } } = useFormContext<SandwichApprovalFormValues>()
  const approvalRequired = watch('approval.approval_required')
  const approvalLevels = watch('approval.approval_levels')
  const levelsOperator = watch('approval.levels_operator')

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'approval.approval_levels',
  })

  const addLevel = () => {
    if (fields.length >= 2) return
    append({ level: fields.length + 1 })
    if (fields.length === 1) {
      setValue('approval.levels_operator', 'OR')
    }
  }

  const removeLevel = (index: number) => {
    remove(index)
    if (fields.length - 1 < 2) {
      setValue('approval.levels_operator', null)
    }
  }

  const approvalErrors = errors.approval as
    | Record<string, { message?: string; root?: { message?: string } } | undefined>
    | undefined
  const operatorError = approvalErrors?.levels_operator?.message
  const levelsError =
    approvalErrors?.approval_levels?.message ?? approvalErrors?.approval_levels?.root?.message

  return (
    <SectionCard
      title="Approval Workflow"
      description="Configure the multi-level approval chain for leave requests under this plan."
    >
      <div className="space-y-6">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-semibold">Allow HR to act on requests</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Users with the HR permission can approve or reject leave requests under this plan.
              </p>
            </div>
            <Controller
              control={control}
              name="approval.allow_hr_to_act"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label="Allow HR to act on leave requests"
                />
              )}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-semibold">Allow HR to view requests</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Users with the HR permission can see leave requests under this plan.
              </p>
            </div>
            <Controller
              control={control}
              name="approval.allow_hr_to_view"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label="Allow HR to view leave requests"
                />
              )}
            />
          </div>
        </div>

        <div className="border-t border-border pt-5">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-semibold">Require Approval</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Leave requests will go through the configured approval chain before being approved.
              </p>
            </div>
            <Controller
              control={control}
              name="approval.approval_required"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label="Require approval for leave requests"
                />
              )}
            />
          </div>
        </div>

        {approvalRequired && (
          <div className="border-t border-border pt-5 space-y-4">
            {fields.length === 0 ? (
              <div className={`flex flex-col items-center justify-center py-10 border border-dashed rounded-lg bg-muted/20 ${levelsError ? 'border-destructive' : 'border-border'}`}>
                <p className="text-sm text-muted-foreground font-medium">Add your first approval level</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Configure who approves leave requests and in what order.
                </p>
                {levelsError && (
                  <p className="text-xs text-destructive mt-2">{levelsError}</p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {fields.map((field, index) => (
                  <div key={field.id}>
                    <ApprovalLevelCard index={index} onRemove={() => removeLevel(index)} />
                    {index === 0 && fields.length === 2 && (
                      <div className="flex items-center gap-3 px-2 py-2">
                        <div className="flex-1 h-px bg-border" />
                        <div className="space-y-1">
                          <Controller
                            control={control}
                            name="approval.levels_operator"
                            render={({ field: f }) => (
                              <Select
                                value={f.value ?? ''}
                                onValueChange={(v) => f.onChange(v as 'AND' | 'OR')}
                                defaultValue='OR'
                              >
                                <SelectTrigger className="h-8 w-28 text-xs font-semibold" aria-label="Levels operator">
                                  <SelectValue placeholder="Operator"/>
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="AND">AND (both)</SelectItem>
                                  <SelectItem value="OR">OR (either)</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          />
                          {operatorError && (
                            <p className="text-xs text-destructive">{operatorError}</p>
                          )}
                        </div>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {fields.length > 0 && (
              <div className="border-t border-border pt-5">
                <p className="text-xs font-semibold mb-3 text-foreground">Approval Chain Preview</p>
                <div className="flex flex-wrap items-center gap-2">
                  {approvalLevels.map((level, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <div className="px-3 py-1.5 bg-primary/10 text-primary rounded-md text-xs font-semibold">
                        Level {index + 1}
                      </div>
                      {index < approvalLevels.length - 1 && (
                        <>
                          {levelsOperator && (
                            <span className="text-xs font-bold text-muted-foreground">{levelsOperator}</span>
                          )}
                          {/* <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" /> */}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {fields.length < 2 && (
              <Button
                type="button"
                variant="default"
                onClick={addLevel}
                aria-label="Add new approval level"
              >
                Add New Level
              </Button>
            )}


          </div>
        )}
      </div>
    </SectionCard>
  )
}

function ApprovalLevelCard({
  index,
  onRemove,
}: {
  index: number
  onRemove: () => void
}) {
  const { control } = useFormContext<SandwichApprovalFormValues>()

  return (
    <div
      className="border border-border rounded-lg p-4 space-y-4"
      role="group"
      aria-label={`Approval level ${index + 1}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold uppercase tracking-wide">
          Level {index + 1} Manager
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive transition-colors"
          aria-label={`Remove level ${index + 1}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
