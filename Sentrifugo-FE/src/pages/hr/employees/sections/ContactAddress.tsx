import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import {
  useCountryOptions,
  useStateOptions,
  useCityOptions,
} from '@/hooks/use-master-options'
import type { Address, EmployeeFormValues } from '@/types/employee'

interface Props {
  values: EmployeeFormValues
  onChange: <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => void
  errors: Partial<Record<string, string>>
}

export function ContactAddress({ values, onChange, errors }: Props) {

  function updateAddress(type: 'permanentAddress' | 'presentAddress', field: keyof Address, val: string) {
    const addr = { ...values[type], [field]: val }
    if (field === 'country') {
      addr.state = ''
      addr.city = ''
    } else if (field === 'state') {
      addr.city = ''
    }
    onChange(type, addr)
    if (type === 'permanentAddress' && values.sameAsPermanent) {
      onChange('presentAddress', { ...addr })
    }
  }

  function toggleSameAs(checked: boolean) {
    onChange('sameAsPermanent', checked)
    if (checked) {
      onChange('presentAddress', { ...values.permanentAddress })
    }
  }

  return (
    <div className="space-y-6">

      {/* ── Contact Info ──────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <h3 className="text-base font-semibold border-b pb-2">Contact Information</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-3">
            <Label>Personal Phone</Label>
            <Input placeholder="Personal phone number" value={values.personalPhone} onChange={(e) => onChange('personalPhone', e.target.value)} maxLength={20} />
            {errors.personalPhone && <p className="text-sm text-destructive">{errors.personalPhone}</p>}
          </div>
          <div className="space-y-3">
            <Label>Personal Email</Label>
            <Input type="email" placeholder="Personal email" value={values.personalEmail} onChange={(e) => onChange('personalEmail', e.target.value)} maxLength={100} />
            {errors.personalEmail && <p className="text-sm text-destructive">{errors.personalEmail}</p>}
          </div>
        </div>
      </div>

      {/* ── Permanent Address ─────────────────────────────────────────────── */}
      <AddressBlock
        title="Permanent Address"
        address={values.permanentAddress}
        onFieldChange={(f, v) => updateAddress('permanentAddress', f, v)}
        errorPrefix="permanentAddress"
        errors={errors}
      />

      {/* ── Same as permanent checkbox ────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="same-as-permanent"
          checked={values.sameAsPermanent}
          onCheckedChange={(v) => toggleSameAs(!!v)}
        />
        <label htmlFor="same-as-permanent" className="text-sm font-medium cursor-pointer">
          Present address is the same as permanent address
        </label>
      </div>

      {/* ── Present Address ───────────────────────────────────────────────── */}
      {!values.sameAsPermanent && (
        <AddressBlock
          title="Present Address"
          address={values.presentAddress}
          onFieldChange={(f, v) => updateAddress('presentAddress', f, v)}
          errorPrefix="presentAddress"
          errors={errors}
        />
      )}
    </div>
  )
}

// ─── Address block sub-component ──────────────────────────────────────────────

function AddressBlock({
  title,
  address,
  onFieldChange,
  errorPrefix,
  errors,
}: {
  title: string
  address: Address
  onFieldChange: (field: keyof Address, value: string) => void
  errorPrefix: string
  errors: Partial<Record<string, string>>
}) {
  const countryOptions = useCountryOptions()
  const stateOptions = useStateOptions(address.country)
  const cityOptions = useCityOptions(address.country, address.state)
  const err = (k: keyof Address) => errors[`${errorPrefix}.${k}`]

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold text-muted-foreground">{title}</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="sm:col-span-2 lg:col-span-3 space-y-3">
          <Label>Address Line 1</Label>
          <Input placeholder="Street address, P.O. box" value={address.addressLine1} onChange={(e) => onFieldChange('addressLine1', e.target.value)} maxLength={200} />
          {err('addressLine1') && <p className="text-sm text-destructive">{err('addressLine1')}</p>}
        </div>
        <div className="sm:col-span-2 lg:col-span-3 space-y-3">
          <Label>Address Line 2</Label>
          <Input placeholder="Apartment, suite, building" value={address.addressLine2} onChange={(e) => onFieldChange('addressLine2', e.target.value)} maxLength={200} />
        </div>
        <div className="space-y-3">
          <Label>Country</Label>
          <SearchableSelect options={countryOptions} value={address.country} onChange={(v) => onFieldChange('country', v as string)} placeholder="Select country" />
          {err('country') && <p className="text-sm text-destructive">{err('country')}</p>}
        </div>
        <div className="space-y-3">
          <Label>State</Label>
          <SearchableSelect
            options={stateOptions}
            value={address.state}
            onChange={(v) => onFieldChange('state', v as string)}
            placeholder={address.country ? 'Select state' : 'Select country first'}
            disabled={!address.country}
          />
          {err('state') && <p className="text-sm text-destructive">{err('state')}</p>}
        </div>
        <div className="space-y-3">
          <Label>City</Label>
          <SearchableSelect
            options={cityOptions}
            value={address.city}
            onChange={(v) => onFieldChange('city', v as string)}
            placeholder={address.state ? 'Select city' : 'Select state first'}
            disabled={!address.state}
          />
          {err('city') && <p className="text-sm text-destructive">{err('city')}</p>}
        </div>
        <div className="space-y-3">
          <Label>Postal Code</Label>
          <Input placeholder="Postal code" value={address.postalCode} onChange={(e) => onFieldChange('postalCode', e.target.value)} maxLength={10} />
          {err('postalCode') && <p className="text-sm text-destructive">{err('postalCode')}</p>}
        </div>
      </div>
    </div>
  )
}
