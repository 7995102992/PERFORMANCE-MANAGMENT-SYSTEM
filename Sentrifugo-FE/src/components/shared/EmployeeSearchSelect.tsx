import { useState } from 'react'
import { SearchableSelect, type Option } from '@/components/shared/SearchableSelect'
import { useGetEmployeesQuery } from '@/store/api/iamApi'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import type { EmployeeResponse } from '@/types/iam'

interface EmployeeSearchSelectProps {
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Option label; defaults to "First Last (CODE)". */
  formatLabel?: (e: EmployeeResponse) => string
  /** Static options pinned above the employee results (e.g. "Not Applicable"). */
  prependOptions?: Option[]
  /** Exclude one employee from the results (e.g. the employee being edited). */
  excludeUserId?: string
}

const defaultLabel = (e: EmployeeResponse) => `${e.firstName} ${e.lastName} (${e.empCode})`

/**
 * Employee picker backed by the server-side search API. Only working
 * (employment-status-active) employees are listed; typing searches the whole
 * org by name / email / emp code instead of filtering the loaded page.
 */
export function EmployeeSearchSelect({
  value,
  onChange,
  placeholder = 'Select employee',
  disabled,
  className,
  formatLabel = defaultLabel,
  prependOptions = [],
  excludeUserId,
}: EmployeeSearchSelectProps) {
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 300)

  const { data: employees = [] } = useGetEmployeesQuery({
    limit: 1000,
    employment_status: 'active',
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  })

  const options: Option[] = [
    ...prependOptions,
    ...employees
      .filter((e) => !excludeUserId || e.userId !== excludeUserId)
      .map((e) => ({ label: formatLabel(e), value: e.userId ?? '' })),
  ]

  return (
    <SearchableSelect
      options={options}
      value={value}
      onChange={(v) => {
        setSearch('')
        onChange(v as string)
      }}
      onSearchChange={setSearch}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
    />
  )
}
