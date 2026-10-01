/**
 * The date window, as one control (§12.1).
 *
 * The month stepper can only ever ask about one month. This asks about a span,
 * which is the question anyone reconciling a quarter is actually holding — and
 * the question a list that opens on "all time" needs an answer to before it can
 * be narrowed at all.
 *
 * Every option resolves to the same `month_from` / `month_to` pair the stepper
 * produces: the window was always arbitrary on the server, only the client
 * insisted on whole months, so nothing there changes.
 *
 * It matches on the record's own date — `expense_date` for an expense, the
 * trip's **start** date for a trip — so a trip running March into April is a
 * March trip to its list.
 */
import { DatePicker } from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DATE_PRESET_LABELS,
  type DatePreset,
} from '@/hooks/use-expense-list-state'

interface Props {
  preset: DatePreset
  fromDate: string
  toDate: string
  /** The list state's `patch`, narrowed to the three keys this owns. */
  onPatch: (next: {
    datePreset?: DatePreset
    fromDate?: string
    toDate?: string
  }) => void
  /** Width of the preset trigger; the two date inputs are fixed. */
  className?: string
}

export function DateWindowFilter({
  preset,
  fromDate,
  toDate,
  onPatch,
  className = 'w-[150px]',
}: Props) {
  return (
    <>
      <Select
        value={preset}
        onValueChange={(v) => {
          const next = v as DatePreset
          // Leaving `custom` drops its dates, so re-picking it later opens empty
          // rather than silently re-applying a window from last week.
          onPatch(
            next === 'custom'
              ? { datePreset: next }
              : { datePreset: next, fromDate: '', toDate: '' },
          )
        }}
      >
        <SelectTrigger className={`h-9 ${className}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((key) => (
            <SelectItem key={key} value={key}>
              {DATE_PRESET_LABELS[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* The two ends, inline, only under Custom — so the row stays one line for
          the five presets that need no input. */}
      {preset === 'custom' && (
        <>
          <DatePicker
            value={fromDate}
            max={toDate || undefined}
            placeholder="From"
            className="w-[140px]"
            onChange={(v) => onPatch({ fromDate: v })}
          />
          <DatePicker
            value={toDate}
            min={fromDate || undefined}
            placeholder="To"
            className="w-[140px]"
            onChange={(v) => onPatch({ toDate: v })}
          />
        </>
      )}
    </>
  )
}
