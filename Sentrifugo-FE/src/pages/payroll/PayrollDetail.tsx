import { cn } from '@/lib/utils'
import type { Payslip, PayslipEarnings, PayslipDeductions } from '@/types/payroll'
import { inr, amountOrDash } from './format'

const EARNING_ROWS: [string, keyof PayslipEarnings][] = [
  ['Basic Salary', 'basic_salary'],
  ['HRA', 'hra'],
  ['Uniform Allowance', 'uniform_allowance'],
  ['Telephone / Mobile', 'telephone_or_mobile'],
  ['Magazines', 'magazines'],
  ['LTA', 'LTA'],
  ['Retention Incentive', 'retention_incentive'],
  ['Arrears', 'arrears'],
  ['Incentive / Project Allowance', 'incentive_or_project_allowwance'],
]

const DEDUCTION_ROWS: [string, keyof PayslipDeductions][] = [
  ['Income Tax', 'income_tax'],
  ['Provident Fund', 'provident_fund'],
  ['Professional Tax', 'professional_tax'],
  ['ESI', 'esi'],
  ['Other Deductions', 'other_deductions'],
  ['Salary Advance', 'salary_advance'],
  ['Health Insurance', 'health_insurance_premium'],
  ['GMC Premium', 'gmc_premium'],
]

interface PayrollDetailProps {
  row: Payslip
  gender: string
  /** Extra identifier fields shown before PF/UAN (e.g. name, emp id, designation). */
  leadingFields?: { label: string; value: string }[]
}

/** Expanded payslip breakdown — earnings, deductions, attendance/identity, totals. */
export function PayrollDetail({ row, gender, leadingFields }: PayrollDetailProps) {
  return (
    <div className="space-y-5 border-t bg-muted/20 px-6 py-5">
      {/* Identifiers (PF/UAN masked server-side) */}
      <div className="flex flex-wrap gap-x-12 gap-y-2">
        {leadingFields?.map((f) => (
          <Field key={f.label} label={f.label} value={f.value} />
        ))}
        <Field label="PF No" value={row.pf_no || '—'} />
        <Field label="UAN No" value={row.uan_number || '—'} />
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        {/* Earnings */}
        <div>
          <div className="mb-2 flex items-center justify-between border-b pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Earnings</span>
            <span>Amount</span>
          </div>
          <dl className="space-y-1.5">
            {EARNING_ROWS.filter(([, key]) => Number(row.earnings[key]) > 0).map(([label, key]) => (
              <div key={key} className="flex items-center justify-between text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground">{amountOrDash(row.earnings[key])}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Deductions */}
        <div>
          <div className="mb-2 flex items-center justify-between border-b pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Deductions</span>
            <span>Amount</span>
          </div>
          <dl className="space-y-1.5">
            {DEDUCTION_ROWS.filter(([, key]) => Number(row.deductions[key]) > 0).map(([label, key]) => (
              <div key={key} className="flex items-center justify-between text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground">{amountOrDash(row.deductions[key])}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Attendance & identity */}
        <dl className="space-y-1.5 md:pt-7">
          <MetaRow label="Standard Days" value={String(row.standard_days)} />
          <MetaRow label="Days Worked" value={String(row.days_worked)} />
          <MetaRow label="PAN No" value={row.pan_no || '—'} />
          <MetaRow label="Gender" value={gender} />
          <MetaRow label="Bank Acc No" value={row.account_no || '—'} />
        </dl>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-1 gap-8 border-t pt-3 md:grid-cols-3">
        <Total label="Total Earnings" value={inr(row.earnings.total)} />
        <Total label="Total Deductions" value={inr(row.deductions.total)} />
        <Total label="Net Amount" value={inr(row.net_amount)} strong />
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  )
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className={cn('text-foreground', strong ? 'text-base font-bold' : 'font-semibold')}>{value}</span>
    </div>
  )
}
