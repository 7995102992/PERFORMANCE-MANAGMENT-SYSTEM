import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { DatePicker } from '@/components/shared/DatePicker'
import { useAppSelector } from '@/store'
import { useMasterData } from '@/hooks/queries/use-master-data'
import type { EmployeeFormValues } from '@/modules/org-setup/types/employee'

function parseLocalDate(iso: string): Date | undefined {
  if (!iso) return undefined
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function calculateAge(dob: string): string {
  if (!dob) return ''
  const [y, m, d] = dob.split('-').map(Number)
  const birth = new Date(y, m - 1, d)
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--
  }
  return age >= 0 ? String(age) : ''
}

interface Props {
  values: EmployeeFormValues
  onChange: <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => void
  errors: Partial<Record<string, string>>
}

export function PersonalDetails({ values, onChange, errors }: Props) {
  const orgId = useAppSelector((s) => s.organisation.savedOrganisation?.id)
  const { data: genderOptions = [] } = useMasterData('GENDERS', orgId)
  const { data: maritalOptions = [] } = useMasterData('MARITAL_STATUSES', orgId)
  const age = calculateAge(values.dob)

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold border-b pb-2">Personal Details</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

        <div className="space-y-3">
          <Label>Date of Birth</Label>
          <DatePicker
            value={parseLocalDate(values.dob)}
            onChange={(d) => onChange('dob', d ? formatDate(d) : '')}
            maxDate={new Date()}
            placeholder="Select date"
          />
          {errors.dob && <p className="text-sm text-destructive">{errors.dob}</p>}
        </div>

        <div className="space-y-3">
          <Label>Age</Label>
          <Input value={age} readOnly disabled placeholder="Auto-calculated" />
        </div>

        <div className="space-y-3">
          <Label>Gender <span className="text-destructive">*</span></Label>
          <SearchableSelect options={genderOptions} value={values.gender} onChange={(v) => onChange('gender', v)} placeholder="Select gender" searchable={false} />
          {errors.gender && <p className="text-sm text-destructive">{errors.gender}</p>}
        </div>

        <div className="space-y-3">
          <Label>Marital Status <span className="text-destructive">*</span></Label>
          <SearchableSelect options={maritalOptions} value={values.maritalStatus} onChange={(v) => onChange('maritalStatus', v)} placeholder="Select status" searchable={false} />
          {errors.maritalStatus && <p className="text-sm text-destructive">{errors.maritalStatus}</p>}
        </div>

      </div>

      <div className="space-y-3 pb-1">
        <Label>About Me</Label>
        <Textarea
          placeholder="A short bio — interests, background, specialties..."
          value={values.aboutMe}
          onChange={(e) => onChange('aboutMe', e.target.value)}
          maxLength={2000}
          rows={3}
        />
        <p className="min-h-4 text-right text-xs text-muted-foreground">{values.aboutMe.length}/2000</p>
      </div>
    </div>
  )
}
