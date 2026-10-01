import { useFormContext, Controller } from 'react-hook-form'
import { Info } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

export function ClubbingSection() {
  const { control, watch } = useFormContext<EntitlementFormValues>()
  const enabled = watch('clubbing.enabled')

  return (
    <SectionCard
      title="Clubbing with Other Leave Types"
      description="Allow or restrict combining this leave type with other leave types in a single request."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Allow Clubbing</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employees can combine this leave with other leave types.
            </p>
          </div>
          <Controller
            control={control}
            name="clubbing.enabled"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {enabled && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-muted/40 border border-border">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Restricted leave type combinations are managed in the individual leave type settings.
              Enable or disable clubbing on each leave type to control pairing.
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  )
}
