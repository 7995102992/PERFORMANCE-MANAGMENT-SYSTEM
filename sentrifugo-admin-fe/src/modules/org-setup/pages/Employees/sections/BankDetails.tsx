import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EmployeeFormValues } from '@/modules/org-setup/types/employee'

interface Props {
  values: EmployeeFormValues
  onChange: <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => void
  errors?: Partial<Record<string, string>>
}

export function BankDetails({ values, onChange, errors = {} }: Props) {
  const bank = values.bankDetails

  function handleField(field: keyof typeof bank, val: string) {
    onChange('bankDetails', { ...bank, [field]: val })
  }

  return (
    <div className="space-y-4">
      <div className="border-b pb-2">
        <h3 className="text-base font-semibold">Bank Details</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Required for payroll processing.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-3">
          <Label>Account Holder Name</Label>
          <Input
            placeholder="As per bank records"
            value={bank.accountHolderName}
            onChange={(e) => handleField('accountHolderName', e.target.value)}
            maxLength={100}
          />
          {errors.bankAccountHolderName && <p className="text-sm text-destructive">{errors.bankAccountHolderName}</p>}
        </div>

        <div className="space-y-3">
          <Label>Bank Name</Label>
          <Input
            placeholder="e.g. State Bank of India"
            value={bank.bankName}
            onChange={(e) => handleField('bankName', e.target.value)}
            maxLength={100}
          />
        </div>

        <div className="space-y-3">
          <Label>Account Number</Label>
          <Input
            placeholder="9–18 digit account number"
            value={bank.accountNumber}
            onChange={(e) => handleField('accountNumber', e.target.value.replace(/\D/g, ''))}
            maxLength={18}
          />
          {errors.bankAccountNumber && <p className="text-sm text-destructive">{errors.bankAccountNumber}</p>}
        </div>

        <div className="space-y-3">
          <Label>IFSC Code</Label>
          <Input
            placeholder="e.g. SBIN0001234"
            value={bank.ifscCode}
            onChange={(e) => handleField('ifscCode', e.target.value.toUpperCase())}
            maxLength={11}
          />
          {errors.bankIfscCode && <p className="text-sm text-destructive">{errors.bankIfscCode}</p>}
        </div>
      </div>
    </div>
  )
}
