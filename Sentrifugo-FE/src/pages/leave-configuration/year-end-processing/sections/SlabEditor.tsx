import { Controller, useFormContext, useFieldArray } from 'react-hook-form'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { YearEndFormValues } from '../schema'

export function SlabEditor() {
  const { control } = useFormContext<YearEndFormValues>()
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'payout_carry_config.slab_rules',
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Slab Rules</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Define balance slabs and their payout / carry-forward day values.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => append({ min_balance: 0, payout_value: 0, carry_forward_value: 0 })}
        >
          Add Slab
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="flex items-center justify-center py-6 border border-dashed rounded-xl text-xs text-muted-foreground">
          No slabs defined. Click "Add Slab" to configure payout and carry rules.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 px-1">
            <Label className="text-xs font-semibold">Min Balance (days)</Label>
            <Label className="text-xs font-semibold">Payout (days)</Label>
            <Label className="text-xs font-semibold">Carry Forward (days)</Label>
            <span />
          </div>
          {fields.map((field, index) => (
            <div key={field.id} className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 items-start">
              <Controller
                control={control}
                name={`payout_carry_config.slab_rules.${index}.min_balance`}
                render={({ field: f, fieldState }) => (
                  <div>
                    <Input
                      type="number"
                      min={0}
                      value={f.value}
                      onChange={(e) => f.onChange(parseFloat(e.target.value) || 0)}
                      className={`h-9 text-sm ${fieldState.error ? 'border-destructive' : ''}`}
                      aria-label={`Slab ${index + 1} minimum balance`}
                    />
                    {fieldState.error && (
                      <p className="text-xs text-destructive mt-0.5">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
              <Controller
                control={control}
                name={`payout_carry_config.slab_rules.${index}.payout_value`}
                render={({ field: f, fieldState }) => (
                  <div>
                    <Input
                      type="number"
                      min={0}
                      value={f.value}
                      onChange={(e) => f.onChange(parseFloat(e.target.value) || 0)}
                      className={`h-9 text-sm ${fieldState.error ? 'border-destructive' : ''}`}
                      aria-label={`Slab ${index + 1} payout value`}
                    />
                    {fieldState.error && (
                      <p className="text-xs text-destructive mt-0.5">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
              <Controller
                control={control}
                name={`payout_carry_config.slab_rules.${index}.carry_forward_value`}
                render={({ field: f, fieldState }) => (
                  <div>
                    <Input
                      type="number"
                      min={0}
                      value={f.value}
                      onChange={(e) => f.onChange(parseFloat(e.target.value) || 0)}
                      className={`h-9 text-sm ${fieldState.error ? 'border-destructive' : ''}`}
                      aria-label={`Slab ${index + 1} carry forward value`}
                    />
                    {fieldState.error && (
                      <p className="text-xs text-destructive mt-0.5">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-9 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => remove(index)}
                aria-label={`Remove slab ${index + 1}`}
              >
                <Trash2  />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
