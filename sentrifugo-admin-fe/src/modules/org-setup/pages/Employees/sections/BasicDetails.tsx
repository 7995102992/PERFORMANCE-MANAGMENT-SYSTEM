import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EmployeeFormValues } from '@/modules/org-setup/types/employee'

interface Props {
  values: EmployeeFormValues
  onChange: <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => void
  errors: Partial<Record<string, string>>
  isEdit?: boolean
}

export function BasicDetails({ values, onChange, errors, isEdit }: Props) {
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold border-b pb-2">Basic Details</h3>
      <p className="text-xs text-muted-foreground -mt-2">
        Employee Code is auto-generated from the selected Business Unit's prefix.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

        <div className="space-y-3">
          <Label>First Name <span className="text-destructive">*</span></Label>
          <Input
            placeholder="First name"
            value={values.firstName}
            onChange={(e) => onChange('firstName', e.target.value)}
            maxLength={50}
          />
          {errors.firstName && <p className="text-sm text-destructive">{errors.firstName}</p>}
        </div>

        <div className="space-y-3">
          <Label>Middle Name</Label>
          <Input
            placeholder="Middle name"
            value={values.middleName}
            onChange={(e) => onChange('middleName', e.target.value)}
            maxLength={50}
          />
        </div>

        <div className="space-y-3">
          <Label>Last Name <span className="text-destructive">*</span></Label>
          <Input
            placeholder="Last name"
            value={values.lastName}
            onChange={(e) => onChange('lastName', e.target.value)}
            maxLength={50}
          />
          {errors.lastName && <p className="text-sm text-destructive">{errors.lastName}</p>}
        </div>

        <div className="space-y-3">
          <Label>Work Email <span className="text-destructive">*</span></Label>
          <Input
            type="email"
            placeholder="e.g. john@company.com"
            value={values.workEmail}
            onChange={(e) => onChange('workEmail', e.target.value)}
            maxLength={100}
            disabled={isEdit}
          />
          {errors.workEmail && <p className="text-sm text-destructive">{errors.workEmail}</p>}
        </div>

      </div>
    </div>
  )
}
