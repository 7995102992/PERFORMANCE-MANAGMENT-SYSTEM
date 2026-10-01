import { useFormContext, Controller } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

const OPTIONS = [
  {
    value: 'not_required',
    label: 'Not Required',
    description: 'Employees do not need to provide a reason.',
  },
  {
    value: 'optional',
    label: 'Optional',
    description: 'Employees may optionally provide a reason.',
  },
  {
    value: 'mandatory',
    label: 'Mandatory',
    description: 'Employees must provide a reason for every request.',
  },
] as const

export function CommentRequirementSection() {
  const { control } = useFormContext<EntitlementFormValues>()

  return (
    <SectionCard
      title="Comment / Reason Requirement"
      description="Control whether employees must provide a reason when applying for leave."
    >
      <div className="space-y-2">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Comment Policy
        </Label>
        <Controller
          control={control}
          name="comment_requirement.mode"
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="grid gap-2"
            >
              {OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border cursor-pointer hover:bg-muted/30 transition-colors"
                >
                  <RadioGroupItem value={opt.value} id={`comment-${opt.value}`} />
                  <div>
                    <span className="text-sm font-medium">{opt.label}</span>
                    <p className="text-xs text-muted-foreground">{opt.description}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          )}
        />
      </div>
    </SectionCard>
  )
}
