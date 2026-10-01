import { EmptyState } from "@/components/shared/EmptyState";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Users,
  Search,
  Filter,
  X,
  Trash2,
  Upload,
  Download,
  Check,
  AlertTriangle,
  FileSpreadsheet,
  Loader2,
  Plus,
} from "lucide-react";
import { FileUploader } from "@/components/shared/FileUploader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import {
  useGetWorkCalendarEmployeesQuery,
  useSyncWorkCalendarEmployeesMutation,
  useLazyDownloadWorkCalendarBulkTemplateQuery,
  useValidateWorkCalendarBulkUploadMutation,
  useBulkAssignWorkCalendarEmployeesMutation,
  useGetShiftsQuery,
  useGetShiftAssignmentsQuery,
  useSyncShiftAssignmentsMutation,
  useLazyDownloadShiftAssignmentTemplateQuery,
  useValidateShiftAssignmentBulkUploadMutation,
  useBulkAssignShiftEmployeesMutation,
} from "@/store/api/lmsApi";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useGetDesignationsQuery,
} from "@/store/api/iamApi";
import type {
  WorkCalendarResponse,
  ShiftAssignment,
  ShiftAssignValidateRow,
} from "@/types/leave";
import { PageLoader } from "@/components/shared/PageLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";
import { useInfiniteEmployees } from "@/hooks/use-infinite-employees";
import { InfiniteScrollSentinel } from "@/components/shared/InfiniteScrollSentinel";
import { memberMatchesSearch, normalizeMember } from "@/lib/enriched-member";
import { BulkUploadEmployeesDialog } from "@/components/shared/BulkUploadEmployeesDialog";

interface Props {
  calendarData: WorkCalendarResponse;
  onClose: () => void;
  /** When set, hides the internal Cancel/Save footer (wizard provides its own). */
  wizardMode?: boolean;
  /** Called after a successful save in wizardMode instead of onClose, so the wizard can advance. */
  onSaved?: () => void;
  /** Notifies parent (the wizard) whenever the dirty flag flips, so the wizard
   *  can change its Next-button label/behavior. */
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export interface ManageCalendarEmployeesHandle {
  /** Persists the current pending state to the BE. Returns true on success. */
  triggerSave: () => Promise<boolean>;
}

// IAM may serialize as camelCase (userId) or snake_case (user_id); LMS stores
// the canonical user_id. Falling back to emp.id would be wrong because that's
// the IAM record id, not the user uuid — the join would never match.
const empUid = (emp: {
  userId?: string | null;
  user_id?: string | null;
  id: string;
}) => emp.userId ?? emp.user_id ?? emp.id;

// ─── Add Employees Dialog ─────────────────────────────────────────────────────

interface AddEmpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calBuIds: string[];
  calDeptIds: string[];
  existingMemberIds: Set<string>;
  onAdd: (userIds: string[]) => void;
}

function AddEmployeesDialog({
  open,
  onOpenChange,
  calBuIds,
  calDeptIds,
  existingMemberIds,
  onAdd,
}: AddEmpDialogProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedIds(new Set());
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(search.length >= 2 ? search : ""),
      400,
    );
    return () => clearTimeout(t);
  }, [search]);

  // Scope = the calendar's departments AND its business units, so a dept
  // shared across BUs doesn't surface employees from a BU outside this
  // calendar (matches the BU-aware backend resolver).
  const dialogEmployeeParams = useMemo(
    () => ({
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(calBuIds.length ? { business_unit_ids: calBuIds } : {}),
      department_ids: calDeptIds,
      is_active: true,
    }),
    [debouncedSearch, calBuIds, calDeptIds],
  );
  const { employees, isFetching, hasMore, loadMore } = useInfiniteEmployees(
    dialogEmployeeParams,
    { skip: !open },
  );

  const eligibleEmployees = useMemo(
    () => employees.filter((e) => !existingMemberIds.has(empUid(e))),
    [employees, existingMemberIds],
  );

  const toggleSelect = (uid: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const allSelected =
    eligibleEmployees.length > 0 &&
    eligibleEmployees.every((e) => selectedIds.has(empUid(e)));
  const toggleAll = (checked: boolean) => {
    if (checked)
      setSelectedIds(new Set(eligibleEmployees.map((e) => empUid(e))));
    else setSelectedIds(new Set());
  };

  const handleAdd = () => {
    onAdd(Array.from(selectedIds));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Add Employees</DialogTitle>
          <DialogDescription>
            Select employees to add to this work calendar.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, emp code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {isFetching && employees.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : eligibleEmployees.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {debouncedSearch
                  ? "No employees found matching your search."
                  : "All eligible employees are already assigned to this calendar."}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border overflow-x-auto bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(c) => toggleAll(!!c)}
                      />
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Department
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eligibleEmployees.map((emp) => {
                    const uid = empUid(emp);
                    return (
                      <TableRow
                        key={emp.id}
                        className={selectedIds.has(uid) ? "bg-primary/5" : ""}
                      >
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.has(uid)}
                            onCheckedChange={() => toggleSelect(uid)}
                          />
                        </TableCell>
                        <TableCell>
                          <p className="text-sm font-medium">
                            {emp.firstName} {emp.lastName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {emp.empCode} · {emp.workEmail}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {emp.departmentName ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <InfiniteScrollSentinel
            onLoadMore={loadMore}
            hasMore={hasMore}
            isFetching={isFetching}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="soft"
            onClick={handleAdd}
            disabled={selectedIds.size === 0}
          >
            Add{" "}
            {selectedIds.size > 0
              ? `${selectedIds.size} Employee${selectedIds.size !== 1 ? "s" : ""}`
              : "Employees"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk Shift Assign Dialog ─────────────────────────────────────────────────

interface BulkShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownloadTemplate: () => Promise<void>;
  onValidate: (file: File) => Promise<{
    rows: ShiftAssignValidateRow[];
    total_rows: number;
    valid_count: number;
    change_count?: number;
    error_count: number;
    duplicate_count: number;
    file_errors: string[];
  }>;
  onAssign: (assignments: ShiftAssignment[]) => Promise<{ updated: number }>;
}

type BulkStep = "select" | "preview" | "uploading" | "done";

const SHIFT_ACCEPT_TYPES = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

function BulkShiftDialog({
  open,
  onOpenChange,
  onDownloadTemplate,
  onValidate,
  onAssign,
}: BulkShiftDialogProps) {
  const [step, setStep] = useState<BulkStep>("select");
  const [file, setFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof onValidate>
  > | null>(null);
  const [selectedRowNums, setSelectedRowNums] = useState<Set<number>>(
    new Set(),
  );
  const [doneCount, setDoneCount] = useState(0);

  useEffect(() => {
    if (open) {
      setStep("select");
      setFile(null);
      setResult(null);
      setSelectedRowNums(new Set());
      setDoneCount(0);
    }
  }, [open]);

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      await onDownloadTemplate();
    } finally {
      setIsDownloading(false);
    }
  };

  const handleValidate = async () => {
    if (!file) return;
    setIsValidating(true);
    try {
      const res = await onValidate(file);
      setResult(res);
      setSelectedRowNums(
        new Set(
          res.rows
            .filter((r) => r.status === "valid" || r.status === "change")
            .map((r) => r.row_num),
        ),
      );
      setStep("preview");
    } catch (err) {
      toast.error(err, "Validation failed");
    } finally {
      setIsValidating(false);
    }
  };

  const handleAssign = async () => {
    if (!result) return;
    const toAssign = result.rows
      .filter(
        (r) =>
          (r.status === "valid" || r.status === "change") &&
          selectedRowNums.has(r.row_num) &&
          r.user_id &&
          r.shift_id,
      )
      .map((r) => ({ user_id: r.user_id!, shift_id: r.shift_id! }));
    if (toAssign.length === 0) return;
    setStep("uploading");
    try {
      const res = await onAssign(toAssign);
      setDoneCount(res.updated);
      setStep("done");
    } catch (err) {
      toast.error(err, "Assignment failed");
      setStep("preview");
    }
  };

  const selectableRows = useMemo(
    () =>
      result?.rows.filter(
        (r) => r.status === "valid" || r.status === "change",
      ) ?? [],
    [result],
  );
  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((r) => selectedRowNums.has(r.row_num));
  const toggleAll = () => {
    if (allSelected) {
      const next = new Set(selectedRowNums);
      selectableRows.forEach((r) => next.delete(r.row_num));
      setSelectedRowNums(next);
    } else {
      const next = new Set(selectedRowNums);
      selectableRows.forEach((r) => next.add(r.row_num));
      setSelectedRowNums(next);
    }
  };
  const toggleRow = (rowNum: number) => {
    setSelectedRowNums((prev) => {
      const next = new Set(prev);
      if (next.has(rowNum)) next.delete(rowNum);
      else next.add(rowNum);
      return next;
    });
  };

  // ── Step: SELECT ──────────────────────────────────────────────────────
  if (step === "select") {
    return (
      <>
        {isDownloading && <FullScreenLoader message="Generating template…" />}
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Import Shift Assignments</DialogTitle>
              <DialogDescription>
                Download the template (pre-filled with current assignments),
                edit the shifts, and upload.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 py-2">
              <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-icon-bg shrink-0">
                  <FileSpreadsheet className="h-5 w-5 text-icon" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    Shift Assignment Template
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Pre-filled with each employee's current shift
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  disabled={isDownloading}
                >
                  {isDownloading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  {isDownloading ? "Generating…" : "Download"}
                </Button>
              </div>

              <FileUploader
                value={file}
                onChange={setFile}
                accept={SHIFT_ACCEPT_TYPES}
                maxSizeMB={10}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="soft"
                onClick={handleValidate}
                disabled={!file || isValidating}
              >
                {isValidating ? (
                  <>
                    <Loader2 className="animate-spin" /> Validating…
                  </>
                ) : (
                  "Next: Review"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ── Step: PREVIEW ─────────────────────────────────────────────────────
  if (step === "preview" && result) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Review & Confirm</DialogTitle>
            <DialogDescription>
              {result.total_rows} row{result.total_rows === 1 ? "" : "s"}{" "}
              detected. "Moving" rows reassign an employee from their current
              shift.
            </DialogDescription>
          </DialogHeader>

          {/* Summary chips */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {result.valid_count > 0 && (
              <Badge
                variant="secondary"
                className="text-success border-success/30 gap-1"
              >
                <Check /> {result.valid_count} new
              </Badge>
            )}
            {(result.change_count ?? 0) > 0 && (
              <Badge
                variant="secondary"
                className="text-info border-info/30 gap-1"
              >
                <ArrowRight /> {result.change_count} moving
              </Badge>
            )}
            {result.error_count > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X /> {result.error_count} error
                {result.error_count === 1 ? "" : "s"}
              </Badge>
            )}
            {result.duplicate_count > 0 && (
              <Badge
                variant="secondary"
                className="text-warning border-warning/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {result.duplicate_count}{" "}
                same shift
              </Badge>
            )}
            <span className="text-sm text-muted-foreground ml-2">
              {selectedRowNums.size} selected
            </span>
          </div>

          {result.file_errors?.length > 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive shrink-0">
              <p className="font-medium">File errors:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.file_errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-hidden rounded-xl border">
            <div className="h-full overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                        disabled={selectableRows.length === 0}
                      />
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      #
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Emp Code
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Name
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Shift
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow
                      key={row.row_num}
                      className={cn(
                        row.status === "error" && "bg-destructive/5",
                        row.status === "duplicate" && "bg-warning/5",
                        row.status === "change" && "bg-info/5",
                      )}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedRowNums.has(row.row_num)}
                          onCheckedChange={() => toggleRow(row.row_num)}
                          disabled={
                            row.status !== "valid" && row.status !== "change"
                          }
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.row_num}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {row.emp_code || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.name || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.status === "change" ? (
                          <span className="flex items-center gap-1 text-info">
                            <span className="line-through opacity-60 text-muted-foreground">
                              {row.current_shift_name}
                            </span>
                            <ArrowRight className="size-3 shrink-0" />
                            <span className="font-medium">
                              {row.shift_name}
                            </span>
                          </span>
                        ) : (
                          row.shift_name || "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {row.status === "valid" && (
                          <Badge
                            variant="secondary"
                            className="text-success border-success/30 gap-1 h-5 px-1.5 text-[10px]"
                          >
                            <Check /> New
                          </Badge>
                        )}
                        {row.status === "change" && (
                          <Badge
                            variant="secondary"
                            className="text-info border-info/30 gap-1 h-5 px-1.5 text-[10px]"
                          >
                            <ArrowRight /> Moving
                          </Badge>
                        )}
                        {row.status === "error" && (
                          <span className="flex items-center gap-1">
                            <Badge
                              variant="secondary"
                              className="text-destructive border-destructive/30 gap-1 h-5 px-1.5 text-[10px]"
                            >
                              <X /> Error
                            </Badge>
                            <span className="text-[10px] text-destructive truncate">
                              {row.errors[0]}
                            </span>
                          </span>
                        )}
                        {row.status === "duplicate" && (
                          <Badge
                            variant="secondary"
                            className="text-warning border-warning/30 gap-1 h-5 px-1.5 text-[10px]"
                          >
                            Same shift
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {result.rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        No data rows in the file.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {selectableRows.length === 0 && result.rows.length > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning shrink-0">
              <AlertTriangle className="size-4 shrink-0" />
              No rows to assign. Fix the errors in your CSV and try again.
            </div>
          )}

          <DialogFooter className="shrink-0 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep("select")}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="soft"
              onClick={handleAssign}
              disabled={selectedRowNums.size === 0}
            >
              <Upload />
              Assign {selectedRowNums.size}{" "}
              {selectedRowNums.size === 1 ? "Row" : "Rows"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: UPLOADING ───────────────────────────────────────────────────
  if (step === "uploading") {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-sm">
          <div className="flex flex-col items-center justify-center gap-4 py-8">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">Assigning…</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Please wait while we update shift assignments.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: DONE ────────────────────────────────────────────────────────
  if (step === "done") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-success" />
              Import Complete
            </DialogTitle>
            <DialogDescription>
              {doneCount} shift assignment{doneCount === 1 ? "" : "s"} updated.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check /> {doneCount} updated
            </Badge>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              onClick={() => onOpenChange(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return null;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const ManageCalendarEmployees = forwardRef<
  ManageCalendarEmployeesHandle,
  Props
>(function ManageCalendarEmployeesImpl(
  { calendarData, onClose, wizardMode = false, onSaved, onHasChangesChange },
  ref,
) {
  const calendarId = (calendarData as any)._id ?? (calendarData as any).id;
  const calBuIds = (calendarData.business_units ?? []).map(
    (bu: any) => bu.id ?? bu._id ?? bu,
  ) as string[];
  const calDeptIds = (calendarData.departments ?? []).map(
    (d: any) => d.id ?? d._id ?? d,
  ) as string[];
  const confirm = useConfirm();

  // ── filters ──
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [buFilter, setBuFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [desgFilter, setDesgFilter] = useState("");
  const [shiftFilter, setShiftFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // ── dialogs ──
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [bulkEmpOpen, setBulkEmpOpen] = useState(false);
  const [bulkShiftOpen, setBulkShiftOpen] = useState(false);

  // ── local state: track membership + shift assignments independently ──
  const [localMemberIds, setLocalMemberIds] = useState<Set<string>>(new Set());
  const [serverMemberIds, setServerMemberIds] = useState<Set<string>>(
    new Set(),
  );
  const [shiftMap, setShiftMap] = useState<Record<string, string>>({}); // uid → shift_id
  const [serverShiftMap, setServerShiftMap] = useState<Record<string, string>>(
    {},
  );
  const [initialized, setInitialized] = useState(false);

  // ── queries ──
  const { data: calEmployees = [], isLoading: isLoadingCalEmps } =
    useGetWorkCalendarEmployeesQuery(calendarId);
  const { data: shifts = [], isLoading: isLoadingShifts } =
    useGetShiftsQuery(calendarId);
  const { data: existingAssignments = [], isLoading: isLoadingAssignments } =
    useGetShiftAssignmentsQuery(calendarId);
  const { data: allBusData = [] } = useGetBusinessUnitsQuery({
    is_active: true,
  });
  const { data: allDeptsData = [] } = useGetDepartmentsQuery(
    buFilter
      ? { business_unit_ids: [buFilter], is_active: true }
      : { is_active: true },
  );
  const { data: desgData = [] } = useGetDesignationsQuery(
    deptFilter ? { department_id: deptFilter, is_active: true } : undefined,
    { skip: !deptFilter },
  );

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(search.length >= 2 ? search : ""),
      400,
    );
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setDeptFilter("");
    setDesgFilter("");
  }, [buFilter]);
  useEffect(() => {
    setDesgFilter("");
  }, [deptFilter]);

  // ── initialize from server ──
  useEffect(() => {
    if (initialized || isLoadingCalEmps || isLoadingAssignments) return;
    const memberIds = new Set(calEmployees.map((e) => e.user_id));
    const sMap: Record<string, string> = {};
    existingAssignments.forEach((a) => {
      sMap[a.user_id] = a.shift_id;
    });
    setLocalMemberIds(new Set(memberIds));
    setServerMemberIds(new Set(memberIds));
    setShiftMap({ ...sMap });
    setServerShiftMap({ ...sMap });
    setInitialized(true);
  }, [
    calEmployees,
    existingAssignments,
    isLoadingCalEmps,
    isLoadingAssignments,
    initialized,
  ]);

  // Members already arrive enriched with name/dept/etc from the LMS, so the
  // table renders straight from them — no IAM fetch + client-side join (which
  // previously dropped any member past the fetch page). Filters run
  // client-side over this fixed member set.
  const buNameById = useMemo(
    () => new Map(allBusData.map((b) => [b.id, b.business_unit_name])),
    [allBusData],
  );
  const deptNameById = useMemo(
    () => new Map(allDeptsData.map((d) => [d.id, d.departmentName])),
    [allDeptsData],
  );
  const desgNameById = useMemo(
    () => new Map(desgData.map((d) => [d.id, d.designationName])),
    [desgData],
  );

  // Only members still in localMemberIds (removed-but-unsaved drop out), passing
  // the active search + BU/dept/designation filters.
  const tableEmployees = useMemo(() => {
    const buName = buFilter ? buNameById.get(buFilter) : undefined;
    const deptName = deptFilter ? deptNameById.get(deptFilter) : undefined;
    const desgName = desgFilter ? desgNameById.get(desgFilter) : undefined;
    return calEmployees
      .filter((e) => localMemberIds.has(e.user_id))
      .filter((e) => {
        if (!memberMatchesSearch(e, debouncedSearch)) return false;
        if (buName && e.business_unit_name !== buName) return false;
        if (deptName && e.department_name !== deptName) return false;
        if (desgName && e.designation_name !== desgName) return false;
        return true;
      })
      .map(normalizeMember);
  }, [
    calEmployees,
    localMemberIds,
    debouncedSearch,
    buFilter,
    deptFilter,
    desgFilter,
    buNameById,
    deptNameById,
    desgNameById,
  ]);

  // Apply shift filter on top, then sort: unassigned first
  const filteredEmployees = useMemo(() => {
    let list = tableEmployees;
    if (shiftFilter === "__unassigned__")
      list = tableEmployees.filter((e) => !shiftMap[empUid(e)]);
    else if (shiftFilter)
      list = tableEmployees.filter((e) => shiftMap[empUid(e)] === shiftFilter);
    return [...list].sort((a, b) => {
      const aAssigned = shiftMap[empUid(a)] ? 1 : 0;
      const bAssigned = shiftMap[empUid(b)] ? 1 : 0;
      return aAssigned - bAssigned;
    });
  }, [tableEmployees, shiftFilter, shiftMap]);

  // ── filter options ──
  const buOptions = useMemo<Option[]>(
    () =>
      allBusData
        .filter((bu) => calBuIds.includes(bu.id))
        .map((bu) => ({ label: bu.business_unit_name, value: bu.id })),
    [allBusData, calBuIds],
  );
  const deptOptions = useMemo<Option[]>(
    () =>
      allDeptsData
        .filter((d) => calDeptIds.includes(d.id))
        .map((d) => ({ label: deptLabel(d), value: d.id })),
    [allDeptsData, calDeptIds],
  );
  const desgOptions = useMemo<Option[]>(
    () => desgData.map((d) => ({ label: d.designationName, value: d.id })),
    [desgData],
  );
  const shiftOptions = useMemo<Option[]>(
    () => shifts.map((s) => ({ label: s.name, value: s._id })),
    [shifts],
  );

  const activeFilterCount = [
    buFilter,
    deptFilter,
    desgFilter,
    shiftFilter,
  ].filter(Boolean).length;
  const clearFilters = () => {
    setBuFilter("");
    setDeptFilter("");
    setDesgFilter("");
    setShiftFilter("");
  };

  // ── dirty check ──
  const hasChanges = useMemo(() => {
    if (localMemberIds.size !== serverMemberIds.size) return true;
    for (const id of localMemberIds) if (!serverMemberIds.has(id)) return true;
    for (const id of serverMemberIds) if (!localMemberIds.has(id)) return true;
    for (const uid of localMemberIds) {
      if ((shiftMap[uid] ?? "") !== (serverShiftMap[uid] ?? "")) return true;
    }
    return false;
  }, [localMemberIds, serverMemberIds, shiftMap, serverShiftMap]);

  // Notify the wizard parent whenever dirty flag flips, so it can change the
  // Next button label/behavior between "Save & Continue" and "Continue".
  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  const assignedToShiftCount = useMemo(
    () => Array.from(localMemberIds).filter((uid) => !!shiftMap[uid]).length,
    [localMemberIds, shiftMap],
  );

  const unassignedCount = localMemberIds.size - assignedToShiftCount;

  // ── handlers ──
  const handleAddEmployees = (userIds: string[]) => {
    setLocalMemberIds((prev) => new Set([...prev, ...userIds]));
  };

  const handleRemoveEmployee = (uid: string, empName: string) => {
    const shiftId = shiftMap[uid];
    const shiftName = shiftId
      ? shifts.find((s) => s._id === shiftId)?.name
      : null;
    confirm({
      title: `Remove ${empName}?`,
      description: shiftName
        ? `${empName} is assigned to "${shiftName}". Removing them from this calendar will also clear their shift assignment.`
        : `Remove ${empName} from this work calendar?`,
      variant: "destructive",
      confirmText: "Remove",
      onConfirm: () => {
        setLocalMemberIds((prev) => {
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
        setShiftMap((prev) => {
          const next = { ...prev };
          delete next[uid];
          return next;
        });
      },
    });
  };

  const handleShiftChange = (uid: string, shiftId: string) => {
    setShiftMap((prev) => ({ ...prev, [uid]: shiftId }));
  };

  // ── mutations ──
  const [syncEmployees, { isLoading: isSavingEmps }] =
    useSyncWorkCalendarEmployeesMutation();
  const [syncShiftAssignments, { isLoading: isSavingShifts }] =
    useSyncShiftAssignmentsMutation();
  const isSaving = isSavingEmps || isSavingShifts;

  const [downloadEmpTemplate] = useLazyDownloadWorkCalendarBulkTemplateQuery();
  const [validateEmpBulk] = useValidateWorkCalendarBulkUploadMutation();
  const [bulkAssignEmps] = useBulkAssignWorkCalendarEmployeesMutation();
  const [downloadShiftTemplate] = useLazyDownloadShiftAssignmentTemplateQuery();
  const [validateShiftBulk] = useValidateShiftAssignmentBulkUploadMutation();
  const [bulkAssignShifts] = useBulkAssignShiftEmployeesMutation();

  // The underlying persistence — no confirm dialog. Returns true on success.
  const persistChanges = useCallback(async (): Promise<boolean> => {
    try {
      const empResult = await syncEmployees({
        calendarId,
        body: { user_ids: Array.from(localMemberIds) },
      }).unwrap();

      const assignments = Object.entries(shiftMap)
        .filter(([uid, shiftId]) => localMemberIds.has(uid) && !!shiftId)
        .map(([uid, shiftId]) => ({ user_id: uid, shift_id: shiftId }));
      await syncShiftAssignments({
        calendarId,
        body: { assignments },
      }).unwrap();

      const parts: string[] = [];
      if ((empResult.added ?? 0) > 0) parts.push(`${empResult.added} added`);
      if ((empResult.removed ?? 0) > 0)
        parts.push(`${empResult.removed} removed`);
      toast.success(`Saved${parts.length ? ` — ${parts.join(", ")}` : ""}`);
      return true;
    } catch (err) {
      toast.error(err, "Failed to save changes");
      return false;
    }
  }, [
    calendarId,
    localMemberIds,
    shiftMap,
    syncEmployees,
    syncShiftAssignments,
  ]);

  const handleSave = () => {
    confirm({
      title: "Save Changes?",
      description: `Update employees and shift assignments for "${calendarData.name}".`,
      confirmText: "Save",
      onConfirm: async () => {
        const ok = await persistChanges();
        if (ok) {
          if (wizardMode && onSaved) onSaved();
          else onClose();
        }
      },
    });
  };

  // Expose a no-confirm save trigger so the wizard's footer button can call it directly.
  useImperativeHandle(
    ref,
    () => ({
      triggerSave: async () => {
        const ok = await persistChanges();
        if (ok && wizardMode && onSaved) onSaved();
        return ok;
      },
    }),
    [persistChanges, wizardMode, onSaved],
  );

  const handleClose = () => {
    if (hasChanges) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to leave?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: onClose,
      });
    } else {
      onClose();
    }
  };

  // Bulk employee
  const handleDownloadEmpTemplate = async () => {
    const res = await downloadEmpTemplate(calendarId).unwrap();
    const url = URL.createObjectURL(res);
    const a = document.createElement("a");
    a.href = url;
    a.download = "employee_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleValidateEmpBulk = async (file: File) =>
    validateEmpBulk({ calendarId, file }).unwrap();
  const handleBulkAssignEmps = async (userIds: string[]) => {
    const res = await bulkAssignEmps({
      calendarId,
      user_ids: userIds,
    }).unwrap();
    setLocalMemberIds((prev) => new Set([...prev, ...userIds]));
    setServerMemberIds((prev) => new Set([...prev, ...userIds]));
    return res;
  };

  // Bulk shifts
  const handleDownloadShiftTemplate = async () => {
    const res = await downloadShiftTemplate(calendarId).unwrap();
    const url = URL.createObjectURL(res);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shift_assignment_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleValidateShiftBulk = async (file: File) =>
    validateShiftBulk({ calendarId, file }).unwrap();
  const handleBulkAssignShifts = async (assignments: ShiftAssignment[]) => {
    const res = await bulkAssignShifts({ calendarId, assignments }).unwrap();
    assignments.forEach((a) => {
      setShiftMap((prev) => ({ ...prev, [a.user_id]: a.shift_id }));
      setServerShiftMap((prev) => ({ ...prev, [a.user_id]: a.shift_id }));
    });
    return res;
  };

  const isLoading = isLoadingCalEmps || isLoadingShifts || isLoadingAssignments;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3 flex-wrap">
          {!wizardMode && (
            <Button variant="ghost" size="icon-sm" onClick={handleClose}>
              <ArrowLeft />
            </Button>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold">Manage Employees & Shifts</h1>
            <p className="text-sm text-muted-foreground">{calendarData.name}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <Button
              size="sm"
              onClick={() => setAddDialogOpen(true)}
            >
              Add Employees
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkEmpOpen(true)}
            >
              <Upload /> Import Employees CSV
            </Button>
            {shifts.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBulkShiftOpen(true)}
              >
                <Upload /> Import Shifts CSV
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="px-6 py-3 space-y-3 border-b border-border">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-40 max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, emp code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant={showFilters ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter />
            Filters
            {activeFilterCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-1.5 size-5 p-0 justify-center text-[10px]"
              >
                {activeFilterCount}
              </Badge>
            )}
          </Button>
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X /> Clear
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary" className="text-xs gap-1.5">
              <Users />
              {localMemberIds.size} total
            </Badge>
            {shifts.length > 0 && (
              <>
                <Badge
                  variant="secondary"
                  className="text-xs bg-badge-active-bg text-badge-active-text"
                >
                  {assignedToShiftCount} with shift
                </Badge>
                {unassignedCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-xs bg-badge-pending-bg text-badge-pending-text"
                  >
                    {unassignedCount} unassigned
                  </Badge>
                )}
              </>
            )}
          </div>
        </div>

        {showFilters && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <SearchableSelect
              options={[
                { label: "All Business Units", value: "" },
                ...buOptions,
              ]}
              value={buFilter}
              onChange={(v) => setBuFilter(v as string)}
              placeholder="Business Unit"
              searchable={buOptions.length > 5}
            />
            <SearchableSelect
              options={[
                { label: "All Departments", value: "" },
                ...deptOptions,
              ]}
              value={deptFilter}
              onChange={(v) => setDeptFilter(v as string)}
              placeholder={buFilter ? "Department" : "Select BU first"}
              disabled={!buFilter}
              searchable={deptOptions.length > 5}
            />
            <SearchableSelect
              options={[
                { label: "All Designations", value: "" },
                ...desgOptions,
              ]}
              value={desgFilter}
              onChange={(v) => setDesgFilter(v as string)}
              placeholder={deptFilter ? "Designation" : "Select Dept first"}
              disabled={!deptFilter}
              searchable={desgOptions.length > 5}
            />
            <SearchableSelect
              options={[
                { label: "All Shifts", value: "" },
                { label: "No shift assigned", value: "__unassigned__" },
                ...shiftOptions,
              ]}
              value={shiftFilter}
              onChange={(v) => setShiftFilter(v as string)}
              placeholder="Filter by shift"
              searchable={false}
            />
          </div>
        )}
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <PageLoader message="Loading…" />
        ) : localMemberIds.size === 0 ? (
          <EmptyState
            icon={Users}
            title="No employees assigned"
            description="Add employees to this calendar to get started."
            action={
              <Button
                size="sm"
                onClick={() => setAddDialogOpen(true)}
              >
                <Plus /> Add Employees
              </Button>
            }
          />
        ) : isLoadingCalEmps && calEmployees.length === 0 ? (
          <PageLoader message="Loading employees…" />
        ) : filteredEmployees.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No employees match your filters"
            description="Try adjusting your search or filters."
          />
        ) : (
          <>
            {shifts.length === 0 && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm text-primary">
                <AlertTriangle className="size-4 shrink-0" />
                No shifts configured for this calendar. Add shifts first to
                assign employees to them.
              </div>
            )}
            <div className="rounded-xl border overflow-x-auto bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Department
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Designation
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-56">
                      Shift
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEmployees.map((emp) => {
                    const uid = empUid(emp);
                    const currentShiftId = shiftMap[uid] ?? "";
                    const serverShiftId = serverShiftMap[uid] ?? "";
                    const isShiftChanged = currentShiftId !== serverShiftId;
                    const prevShiftName = serverShiftId
                      ? shifts.find((s) => s._id === serverShiftId)?.name
                      : null;

                    return (
                      <TableRow
                        key={emp.id}
                        className={
                          isShiftChanged ? "bg-badge-pending-bg/60 950/20" : ""
                        }
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                              {emp.firstName?.charAt(0)}
                              {emp.lastName?.charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {emp.firstName} {emp.lastName}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {emp.empCode} · {emp.workEmail}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {emp.departmentName ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {emp.designationName ?? "—"}
                        </TableCell>
                        <TableCell>
                          {shifts.length === 0 ? (
                            <span className="text-sm text-muted-foreground">
                              —
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <SearchableSelect
                                options={[
                                  { label: "No Shift", value: "" },
                                  ...shiftOptions,
                                ]}
                                value={currentShiftId}
                                onChange={(v) =>
                                  handleShiftChange(uid, v as string)
                                }
                                placeholder="Select shift"
                                searchable={false}
                              />
                              {isShiftChanged && (
                                <p className="text-[10px] text-badge-pending-text flex items-center gap-1 pl-0.5">
                                  {prevShiftName ? (
                                    <>
                                      <span className="line-through opacity-70">
                                        {prevShiftName}
                                      </span>
                                      <ArrowRight className="size-2.5 shrink-0" />
                                    </>
                                  ) : null}
                                  <span>
                                    {currentShiftId
                                      ? "Changed"
                                      : "Removing assignment"}
                                  </span>
                                </p>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() =>
                              handleRemoveEmployee(
                                uid,
                                `${emp.firstName} ${emp.lastName}`,
                              )
                            }
                          >
                            <Trash2 />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="border-t border-border px-6 py-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {localMemberIds.size} employee{localMemberIds.size !== 1 ? "s" : ""}
          {shifts.length > 0 && (
            <>
              {" · "}
              <span
                className={
                  unassignedCount > 0 ? "text-warning" : "text-success"
                }
              >
                {assignedToShiftCount} assigned to a shift
              </span>
              {unassignedCount > 0 && ` · ${unassignedCount} without shift`}
            </>
          )}
        </p>
        {!wizardMode && (
          <div className="flex gap-3 shrink-0">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        )}
      </div>

      {/* ── Dialogs ── */}
      <AddEmployeesDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        calBuIds={calBuIds}
        calDeptIds={calDeptIds}
        existingMemberIds={localMemberIds}
        onAdd={handleAddEmployees}
      />
      <BulkUploadEmployeesDialog
        open={bulkEmpOpen}
        onOpenChange={(open) => {
          setBulkEmpOpen(open);
          if (!open) setInitialized(false);
        }}
        onDownloadTemplate={handleDownloadEmpTemplate}
        onValidate={handleValidateEmpBulk}
        onAssign={handleBulkAssignEmps}
        entityName="work calendar"
      />
      <BulkShiftDialog
        open={bulkShiftOpen}
        onOpenChange={setBulkShiftOpen}
        onDownloadTemplate={handleDownloadShiftTemplate}
        onValidate={handleValidateShiftBulk}
        onAssign={handleBulkAssignShifts}
      />
    </div>
  );
});
