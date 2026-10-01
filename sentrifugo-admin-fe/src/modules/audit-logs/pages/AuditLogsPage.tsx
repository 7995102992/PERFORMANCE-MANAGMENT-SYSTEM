import { useMemo, useState } from "react"
import { Filter, RotateCcw, Search, AlertCircle } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DatePicker } from "@/components/shared/DatePicker"
import { TablePagination } from "@/components/shared/TablePagination"
import { useAuditLogs, useAuditFacets } from "@/hooks/queries/use-audit-logs"
import type { AuditLogQuery } from "@/types/audit-log"

const ANY = "__any__" // Select can't hold an empty-string value; sentinel for "no filter"

type Filters = {
  action_type: string
  target_entity_type: string
  status: string
  module: string
  action: string
  field_name: string
  user_email: string
  user_role: string
  ip_address: string
  search: string
}

const EMPTY: Filters = {
  action_type: "",
  target_entity_type: "",
  status: "",
  module: "",
  action: "",
  field_name: "",
  user_email: "",
  user_role: "",
  ip_address: "",
  search: "",
}

function startOfDay(d?: Date) {
  if (!d) return undefined
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c.toISOString()
}
function endOfDay(d?: Date) {
  if (!d) return undefined
  const c = new Date(d)
  c.setHours(23, 59, 59, 999)
  return c.toISOString()
}

const COLUMNS = [
  "Action", "Action Type", "Module", "Target Entity Type", "Target Entity Name",
  "Field Name", "Old Value", "New Value", "Status", "Failure Reason",
  "User Name", "User Email", "User Role", "User ID", "Timestamp (UTC)",
  "Source", "User Agent", "IP Address",
]

function cell(v: string | null | undefined) {
  return v && String(v).trim() ? v : "—"
}

export function AuditLogsPage() {
  // draft = what's in the inputs; applied = what the query actually uses.
  const [draft, setDraft] = useState<Filters>(EMPTY)
  const [applied, setApplied] = useState<Filters>(EMPTY)
  const [fromDate, setFromDate] = useState<Date | undefined>()
  const [toDate, setToDate] = useState<Date | undefined>()
  const [appliedRange, setAppliedRange] = useState<{ from?: string; to?: string }>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: facets } = useAuditFacets()

  const query = useMemo<AuditLogQuery>(() => {
    const f = applied
    return {
      start_time: appliedRange.from,
      end_time: appliedRange.to,
      action_type: f.action_type || undefined,
      target_entity_type: f.target_entity_type || undefined,
      status: f.status || undefined,
      module: f.module || undefined,
      action: f.action || undefined,
      field_name: f.field_name || undefined,
      user_email: f.user_email || undefined,
      user_role: f.user_role || undefined,
      ip_address: f.ip_address || undefined,
      search: f.search || undefined,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }
  }, [applied, appliedRange, page, pageSize])

  const { data, isLoading, isError, error } = useAuditLogs(query)

  const rows = data?.data ?? []
  const total = data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const startIndex = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endIndex = Math.min(page * pageSize, total)

  function apply() {
    setApplied(draft)
    setAppliedRange({ from: startOfDay(fromDate), to: endOfDay(toDate) })
    setPage(1)
    setAdvancedOpen(false)
  }
  function reset() {
    setDraft(EMPTY)
    setApplied(EMPTY)
    setFromDate(undefined)
    setToDate(undefined)
    setAppliedRange({})
    setPage(1)
  }

  const set = (k: keyof Filters) => (v: string) =>
    setDraft((p) => ({ ...p, [k]: v === ANY ? "" : v }))

  // A Select needs a non-empty value; map "" → ANY sentinel.
  const sel = (k: keyof Filters) => (draft[k] === "" ? ANY : draft[k])

  return (
    <div className="p-5 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          Review actions performed across your organisation.
        </p>
      </div>

      {/* ── Primary filter bar ─────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label="Action Type" placeholder="All Actions"
            value={sel("action_type")} onChange={set("action_type")}
            options={facets?.action_types ?? []}
          />
          <FilterSelect
            label="Resource Type" placeholder="All Resources"
            value={sel("target_entity_type")} onChange={set("target_entity_type")}
            options={facets?.entity_types ?? []}
          />
          <FilterSelect
            label="Status" placeholder="All Statuses"
            value={sel("status")} onChange={set("status")}
            options={facets?.statuses ?? ["success", "failed"]}
          />
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">From</label>
            <DatePicker value={fromDate} onChange={setFromDate} placeholder="dd-mm-yyyy" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">To</label>
            <DatePicker value={toDate} onChange={setToDate} placeholder="dd-mm-yyyy" />
          </div>
          <div className="flex items-end gap-2 sm:col-span-2">
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw className="size-4" /> Reset
            </Button>
            <Button size="sm" onClick={apply}>Apply Filters</Button>
            <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <DialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
                <Filter className="size-4" /> More Filters
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Advanced Filters</DialogTitle>
                </DialogHeader>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FilterSelect
                    label="Module" placeholder="All Modules"
                    value={sel("module")} onChange={set("module")}
                    options={facets?.modules ?? []}
                  />
                  <FilterSelect
                    label="Action" placeholder="All"
                    value={sel("action")} onChange={set("action")}
                    options={facets?.actions ?? []}
                  />
                  <TextFilter label="Field Name" value={draft.field_name} onChange={set("field_name")} />
                  <TextFilter label="User Email" value={draft.user_email} onChange={set("user_email")} />
                  <TextFilter label="User Role" value={draft.user_role} onChange={set("user_role")} />
                  <TextFilter label="IP Address" value={draft.ip_address} onChange={set("ip_address")} />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDraft({ ...EMPTY, search: draft.search })}>
                    Clear Advanced Filters
                  </Button>
                  <Button onClick={apply}>Apply Advanced Filters</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search logs..."
            value={draft.search}
            onChange={(e) => setDraft((p) => ({ ...p, search: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && apply()}
          />
        </div>
      </div>

      {/* ── Results table ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <span className="text-sm font-medium">Total Records: {total}</span>
        </div>

        {isError ? (
          <div className="flex items-center gap-2 p-8 text-sm text-destructive">
            <AlertCircle className="size-4" />
            {(error as Error)?.message || "Failed to load audit logs."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((c) => (
                    <TableHead key={c} className="whitespace-nowrap text-xs">{c}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="h-24 text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="h-24 text-center text-muted-foreground">
                      No audit logs found for the selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r, i) => (
                    <TableRow key={`${r.correlation_id ?? "row"}-${i}`}>
                      <TableCell className="whitespace-nowrap">{cell(r.action)}</TableCell>
                      <TableCell className="whitespace-nowrap capitalize">{cell(r.action_type)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.module)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.target_entity_type)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.target_entity_name)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.field_names?.length ? r.field_names.join(", ") : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.old_value)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.new_value)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant={r.status === "failed" ? "destructive" : "default"}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.failure_reason)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.user_name)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.user_email)}</TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.user_role)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{cell(r.user_id)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.timestamp ? new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19) : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{cell(r.source)}</TableCell>
                      <TableCell className="whitespace-nowrap max-w-[200px] truncate" title={r.user_agent ?? ""}>
                        {cell(r.user_agent)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{cell(r.ip_address)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        <TablePagination
          currentPage={page}
          totalPages={totalPages}
          startIndex={startIndex}
          endIndex={endIndex}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
        />
      </div>
    </div>
  )
}

// ─── Small filter sub-components ───────────────────────────────────────────────

function FilterSelect({
  label, placeholder, value, onChange, options,
}: {
  label: string; placeholder: string; value: string
  onChange: (v: string) => void; options: string[]
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o} className="capitalize">{o}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function TextFilter({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={`Enter ${label}`} />
    </div>
  )
}
