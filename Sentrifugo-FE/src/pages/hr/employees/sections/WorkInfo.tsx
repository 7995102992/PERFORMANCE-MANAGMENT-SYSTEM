import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { EmployeeSearchSelect } from '@/components/shared/EmployeeSearchSelect'
import { DatePicker } from '@/components/shared/DatePicker'
import { useAppSelector } from '@/store'
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useGetDesignationsQuery,
  useGetRolesQuery,
} from '@/store/api/iamApi'
import { useMasterOptions, useCurrencyOptions } from '@/hooks/use-master-options'
import { useAutoSelectSingleOption } from '@/hooks/use-auto-select-single'
import { WORK_TYPE_OPTIONS } from '@/types/employee'
import type { EmployeeFormValues } from '@/types/employee'
import type { CtcHistoryEntry, EmployeeResponse } from '@/types/iam'

function parseLocalDate(iso: string): Date | undefined {
  if (!iso) return undefined
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

interface Props {
  values: EmployeeFormValues
  onChange: <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => void
  errors: Partial<Record<string, string>>
  editingEmployeeId?: string | null
  /** Prior CTC revisions (read-only), newest-last. */
  ctcHistory?: CtcHistoryEntry[]
}

export function WorkInfo({ values, onChange, errors, editingEmployeeId, ctcHistory }: Props) {
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id) ?? undefined

  // Master data from API
  const sourceOptions = useMasterOptions('SOURCES_OF_HIRE', orgId)
  const empTypeOptions = useMasterOptions('EMPLOYMENT_TYPES', orgId)
  // include inactive statuses (Exit / Retired / Terminated / Absconded) so HR can set
  // ended-employment states here; Leave service excludes them via its own filter.
  const empStatusOptions = useMasterOptions('EMPLOYMENT_STATUSES', orgId, true)
  // Allocation / resourcing state (Allocated to Project / Bench / Long Leave) —
  // separate from the employment lifecycle status. Mandatory.
  const projectStatusOptions = useMasterOptions('PROJECT_STATUSES', orgId)
  const currencyOptions = useCurrencyOptions()

  // BU list
  const { data: remoteBUs = [] } = useGetBusinessUnitsQuery({ is_active: true })
  const buOptions = remoteBUs.map((bu) => ({ label: bu.business_unit_name, value: bu.id }))

  // Departments — filtered by selected BU
  const { data: remoteDepts = [] } = useGetDepartmentsQuery(
    values.businessUnit ? { business_unit_ids: [values.businessUnit] } : {},
  )
  const deptOptions = remoteDepts.map((d) => ({
    label: d.departmentName,
    value: d.id,
    description: d.businessUnitNames?.length ? d.businessUnitNames.join(', ') : undefined,
  }))

  // Designations — org-level (just job titles; roles are separate now).
  // limit must cover the whole org's designations: the select resolves the
  // saved ID to a label from this list, and a missing entry renders as a raw ID.
  const { data: remoteDesigs = [] } = useGetDesignationsQuery({ limit: 1000, is_active: true })
  const designationOptions = remoteDesigs.map((d) => ({ label: d.designationName, value: d.id }))

  // Roles (policies) — assigned directly to the employee. Mandatory.
  const { data: roles = [] } = useGetRolesQuery()
  const roleOptions = roles
    .filter((r) => r.is_active !== false)
    .map((r) => ({ label: r.name, value: r.id }))

  // L1/L2 manager selects — server-searched, active employees only, excluding
  // the employee being edited. "Not Applicable" is an explicit choice for
  // employees with no manager.
  const NOT_APPLICABLE = 'not-applicable'
  const managerSelectProps = {
    prependOptions: [{ label: 'Not Applicable', value: NOT_APPLICABLE }],
    excludeUserId: editingEmployeeId ?? undefined,
    formatLabel: (e: EmployeeResponse) => `${e.firstName} ${e.lastName} - ${e.workEmail} - ${e.empCode}`,
  }

  // Single-BU org → lock the BU picker (one fixed BU). Either way, when only one
  // option exists we auto-fill it (BU → Department → Designation cascade).
  const singleBuMode = buOptions.length === 1
  useAutoSelectSingleOption({
    value: values.businessUnit,
    options: buOptions,
    onSelect: (v) => onChange('businessUnit', v),
  })
  useAutoSelectSingleOption({
    value: values.department,
    options: deptOptions,
    onSelect: (v) => onChange('department', v),
  })
  useAutoSelectSingleOption({
    value: values.designation,
    options: designationOptions,
    onSelect: (v) => onChange('designation', v),
  })

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold border-b pb-2">Work Information</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* ── Organisation ── */}
        <div className="col-span-full">
          <h4 className="text-xs font-semibold text-label uppercase tracking-wide">Organisation</h4>
        </div>

        <div className="space-y-3">
          <Label>Business Unit <span className="text-destructive">*</span></Label>
          <SearchableSelect
            options={buOptions}
            value={values.businessUnit}
            onChange={(v) => {
              onChange('businessUnit', v as string)
              onChange('department', '')
            }}
            placeholder="Select business unit"
            // Locked after creation: the employee code is derived from the BU and is
            // never regenerated, so changing the BU would desync the code.
            disabled={singleBuMode || !!editingEmployeeId}
          />
          {editingEmployeeId && (
            <p className="text-xs text-muted-foreground">
              Business unit can't be changed — the employee code is generated from it.
            </p>
          )}
          {errors.businessUnit && <p className="text-sm text-destructive">{errors.businessUnit}</p>}
        </div>

        <div className="space-y-3">
          <Label>Department <span className="text-destructive">*</span></Label>
          <SearchableSelect
            options={deptOptions}
            value={values.department}
            onChange={(v) => onChange('department', v as string)}
            placeholder={values.businessUnit ? 'Select department' : 'Select business unit first'}
            disabled={!values.businessUnit}
          />
          {errors.department && <p className="text-sm text-destructive">{errors.department}</p>}
          {(() => {
            const selectedDept = remoteDepts.find((d) => d.id === values.department)
            if (!selectedDept?.primaryBusinessUnit || !values.businessUnit) return null
            if (selectedDept.primaryBusinessUnit === values.businessUnit) return null
            const primaryBuName = selectedDept.primaryBusinessUnitData?.businessUnitName || 'another BU'
            return (
              <p className="text-xs text-warning mt-1">
                This department's primary BU is <strong>{primaryBuName}</strong>. Employee code will use the selected BU's prefix.
              </p>
            )
          })()}
        </div>

        <div className="space-y-3">
          <Label>Designation <span className="text-destructive">*</span></Label>
          <SearchableSelect
            options={designationOptions}
            value={values.designation}
            onChange={(v) => onChange('designation', v as string)}
            placeholder="Select designation"
          />
          {errors.designation && <p className="text-sm text-destructive">{errors.designation}</p>}
        </div>

        <div className="space-y-3">
          <Label>Role <span className="text-destructive">*</span></Label>
          <SearchableSelect
            options={roleOptions}
            value={values.role}
            onChange={(v) => onChange('role', v as string)}
            placeholder={roleOptions.length === 0 ? 'No roles available' : 'Select role'}
            disabled={roleOptions.length === 0}
          />
          {errors.role && <p className="text-sm text-destructive">{errors.role}</p>}
        </div>

        {/* ── Employment ── */}
        <div className="col-span-full border-t pt-4">
          <h4 className="text-xs font-semibold text-label uppercase tracking-wide">Employment</h4>
        </div>

        <div className="space-y-3">
          <Label>Employment Type <span className="text-destructive">*</span></Label>
          {/* Locked after creation: the employee code's type letter (F/C/I) is derived
              from this and the code is never regenerated, so changing it would desync. */}
          <SearchableSelect options={empTypeOptions} value={values.employmentType} onChange={(v) => onChange('employmentType', v as string)} placeholder="Select type" searchable={false} disabled={!!editingEmployeeId} />
          {editingEmployeeId && (
            <p className="text-xs text-muted-foreground">
              Employment type can't be changed — the employee code is generated from it.
            </p>
          )}
          {errors.employmentType && <p className="text-sm text-destructive">{errors.employmentType}</p>}
          {(() => {
            const selectedBu = remoteBUs.find((bu) => bu.id === values.businessUnit)
            const selectedType = empTypeOptions.find((o) => o.value === values.employmentType)
            if (!selectedBu?.emp_code_prefix || !selectedType) return null
            const typeKey = selectedType.label?.toLowerCase().replace(/\s+/g, '-') || ''
            const letter = { 'full-time': 'F', 'contract': 'C', 'internship': 'I' }[typeKey]
            if (!letter) return null
            return (
              <p className="text-xs text-muted-foreground mt-1">
                Employee code format: <code className="bg-muted px-1 py-0.5 rounded text-[11px]">{selectedBu.emp_code_prefix}-{letter}-xxx</code>
              </p>
            )
          })()}
        </div>

        <div className="space-y-3">
          <Label>Employment Status <span className="text-destructive">*</span></Label>
          <SearchableSelect options={empStatusOptions} value={values.employmentStatus} onChange={(v) => onChange('employmentStatus', v as string)} placeholder="Select status" searchable={false} />
          {errors.employmentStatus && <p className="text-sm text-destructive">{errors.employmentStatus}</p>}
        </div>

        <div className="space-y-3">
          <Label>Work Type <span className="text-destructive">*</span></Label>
          <SearchableSelect options={WORK_TYPE_OPTIONS} value={values.workType} onChange={(v) => onChange('workType', v as string)} placeholder="Select work type" searchable={false} />
          {errors.workType && <p className="text-sm text-destructive">{errors.workType}</p>}
        </div>

        <div className="space-y-3">
          <Label>Project Status <span className="text-destructive">*</span></Label>
          <SearchableSelect options={projectStatusOptions} value={values.projectStatus} onChange={(v) => onChange('projectStatus', v as string)} placeholder="Select project status" searchable={false} />
          {errors.projectStatus && <p className="text-sm text-destructive">{errors.projectStatus}</p>}
        </div>

        <div className="space-y-3">
          <Label>Date of Joining</Label>
          <DatePicker
            value={parseLocalDate(values.dateOfJoining)}
            onChange={(d) => onChange('dateOfJoining', d ? formatDate(d) : '')}
            maxDate={new Date()}
            placeholder="Select date"
          />
          {errors.dateOfJoining && <p className="text-sm text-destructive">{errors.dateOfJoining}</p>}
        </div>

        <div className="space-y-3">
          <Label>Date of Exit</Label>
          <DatePicker
            value={parseLocalDate(values.dateOfExit)}
            onChange={(d) => onChange('dateOfExit', d ? formatDate(d) : '')}
            minDate={parseLocalDate(values.dateOfJoining)}
            maxDate={new Date()}
            placeholder="Select date"
          />
          {errors.dateOfExit && <p className="text-sm text-destructive">{errors.dateOfExit}</p>}
        </div>

        <div className="space-y-3">
          <Label>Work Phone</Label>
          <Input placeholder="Work phone number" value={values.workPhone} onChange={(e) => onChange('workPhone', e.target.value)} maxLength={20} />
          {errors.workPhone && <p className="text-sm text-destructive">{errors.workPhone}</p>}
        </div>

        <div className="space-y-3">
          <Label>Work Phone Extension</Label>
          <Input placeholder="e.g. 123" value={values.workPhoneExtension} onChange={(e) => onChange('workPhoneExtension', e.target.value)} maxLength={10} />
        </div>

        {/* ── Reporting & Experience ── */}
        <div className="col-span-full border-t pt-4">
          <h4 className="text-xs font-semibold text-label uppercase tracking-wide">Reporting &amp; Experience</h4>
        </div>

        <div className="space-y-3">
          <Label>L1 Manager</Label>
          <EmployeeSearchSelect
            {...managerSelectProps}
            value={values.l1Manager}
            onChange={(v) => onChange('l1Manager', v)}
            placeholder="Select L1 manager"
          />
          {errors.l1Manager && <p className="text-sm text-destructive">{errors.l1Manager}</p>}
        </div>

        <div className="space-y-3">
          <Label>L2 Manager</Label>
          <EmployeeSearchSelect
            {...managerSelectProps}
            value={values.l2Manager}
            onChange={(v) => onChange('l2Manager', v)}
            placeholder="Select L2 manager"
          />
          {errors.l2Manager && <p className="text-sm text-destructive">{errors.l2Manager}</p>}
        </div>

        <div className="space-y-3">
          <Label>Source of Hire</Label>
          <SearchableSelect options={sourceOptions} value={values.sourceOfHire} onChange={(v) => onChange('sourceOfHire', v as string)} placeholder="Select source" />
        </div>

        <div className="space-y-3">
          <Label>Current Experience (yrs)</Label>
          <Input
            type="number"
            placeholder="0"
            value={values.currentExp}
            readOnly
            tabIndex={-1}
            className="bg-muted/50 cursor-not-allowed"
          />
          <p className="text-xs text-muted-foreground">Auto-calculated from Date of Joining.</p>
          {errors.currentExp && <p className="text-sm text-destructive">{errors.currentExp}</p>}
        </div>

        <div className="space-y-3">
          <Label>Total Experience (yrs)</Label>
          <Input type="number" placeholder="0" value={values.totalExp} onChange={(e) => onChange('totalExp', e.target.value)} min={0} step="0.1" />
          {errors.totalExp && <p className="text-sm text-destructive">{errors.totalExp}</p>}
        </div>

        <div className="space-y-3">
          <Label>Seat Location</Label>
          <Input placeholder="e.g. Floor 3, Desk 12" value={values.seatLocation} onChange={(e) => onChange('seatLocation', e.target.value)} maxLength={50} />
        </div>

        {/* ── Compensation ── */}
        <div className="col-span-full border-t pt-4">
          <h4 className="text-xs font-semibold text-label uppercase tracking-wide">Compensation</h4>
        </div>

        <div className="space-y-3">
          <Label>Currency</Label>
          <SearchableSelect
            options={currencyOptions}
            value={values.currency}
            onChange={(v) => onChange('currency', v as string)}
            placeholder="Select currency"
          />
          {errors.currency && <p className="text-sm text-destructive">{errors.currency}</p>}
        </div>

        <div className="space-y-3">
          <Label>CTC (Annual)</Label>
          <Input
            type="number"
            placeholder="0"
            value={values.ctc}
            onChange={(e) => onChange('ctc', e.target.value)}
            min={0}
            step="0.01"
          />
          {errors.ctc && <p className="text-sm text-destructive">{errors.ctc}</p>}
          {ctcHistory && ctcHistory.length > 0 && (
            <div className="mt-2 rounded-md border border-border bg-muted/30 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">CTC revision history</p>
              <ul className="space-y-1">
                {[...ctcHistory].reverse().map((h, i) => {
                  const amount = h.amount ?? h.value
                  return (
                    <li key={i} className="flex justify-between text-sm text-muted-foreground">
                      <span>{amount != null ? `${h.currency ?? values.currency ?? ''} ${amount.toLocaleString()}`.trim() : '—'}</span>
                      <span>{h.updatedOn ? `updated ${h.updatedOn.slice(0, 10)}` : ''}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
