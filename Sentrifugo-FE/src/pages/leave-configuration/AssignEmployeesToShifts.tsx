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
  Upload,
  Users,
  Search,
  Filter,
  X,
  Download,
  Check,
  AlertTriangle,
  FileSpreadsheet,
  Loader2,
  ArrowRight,
  Clock,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
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
import { FileUploader } from "@/components/shared/FileUploader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import {
  useGetShiftAssignmentsQuery,
  useSyncShiftAssignmentsMutation,
  useLazyDownloadShiftAssignmentTemplateQuery,
  useValidateShiftAssignmentBulkUploadMutation,
  useBulkAssignShiftEmployeesMutation,
  useGetShiftsQuery,
  useGetWorkCalendarEmployeesQuery,
} from "@/store/api/lmsApi";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useGetDesignationsQuery,
} from "@/store/api/iamApi";
import {
  memberMatchesSearch,
  normalizeMember,
  type NormalizedMember,
} from "@/lib/enriched-member";
import type {
  WorkCalendarResponse,
  ShiftAssignment,
  ShiftAssignValidateRow,
} from "@/types/leave";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";

interface Props {
  calendarData: WorkCalendarResponse;
  onClose: () => void;
  /** Hide the internal back-arrow + Save button (wizard provides its own). */
  wizardMode?: boolean;
  /** Called after a successful save in wizardMode so the wizard can advance. */
  onSaved?: () => void;
  /** Notifies the wizard parent when the dirty flag flips. */
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export interface AssignEmployeesToShiftsHandle {
  /** Persists pending shift assignments. Returns true on success. */
  triggerSave: () => Promise<boolean>;
}

const empUid = (emp: {
  userId?: string | null;
  user_id?: string | null;
  id: string;
}) => emp.userId ?? emp.user_id ?? emp.id;

// ─── Bulk Shift Assign Dialog ─────────────────────────────────────────────────

interface BulkShiftAssignDialogProps {
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

function BulkShiftAssignDialog({
  open,
  onOpenChange,
  onDownloadTemplate,
  onValidate,
  onAssign,
}: BulkShiftAssignDialogProps) {
  const [step, setStep] = useState<BulkStep>("select");
  const [file, setFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [result, setResult] = useState<
    ReturnType<typeof onValidate> extends Promise<infer R> ? R : never | null
  >(null as any);
  const [selectedRowNums, setSelectedRowNums] = useState<Set<number>>(
    new Set(),
  );
  const [doneCount, setDoneCount] = useState(0);

  useEffect(() => {
    if (open) {
      setStep("select");
      setFile(null);
      setResult(undefined as any);
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
      const preSelected = new Set(
        res.rows
          .filter((r) => r.status === "valid" || r.status === "change")
          .map((r) => r.row_num),
      );
      setSelectedRowNums(preSelected);
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
      toast.success(
        `${res.updated} shift assignment${res.updated !== 1 ? "s" : ""} updated`,
      );
    } catch (err) {
      toast.error(err, "Assignment failed");
      setStep("preview");
    }
  };

  const actionableRows = useMemo(
    () =>
      result?.rows.filter(
        (r) => r.status === "valid" || r.status === "change",
      ) ?? [],
    [result],
  );
  const allSelected =
    actionableRows.length > 0 &&
    actionableRows.every((r) => selectedRowNums.has(r.row_num));

  const toggleAll = () => {
    if (allSelected) {
      const next = new Set(selectedRowNums);
      actionableRows.forEach((r) => next.delete(r.row_num));
      setSelectedRowNums(next);
    } else {
      const next = new Set(selectedRowNums);
      actionableRows.forEach((r) => next.add(r.row_num));
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

  const changeCount =
    result?.change_count ??
    result?.rows.filter((r) => r.status === "change").length ??
    0;

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
                Download the template, fill it with employee codes and shift
                names, and upload.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 py-2">
              <div className="flex items-center gap-3 rounded-xl border bg-muted p-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-icon-bg shrink-0">
                  <FileSpreadsheet className="h-5 w-5 text-icon" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    Shift Assignment Template
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Match employees by emp code, assign shift by name
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

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {result.valid_count > 0 && (
              <Badge
                variant="secondary"
                className="text-success border-success/30 gap-1"
              >
                <Check /> {result.valid_count} new
              </Badge>
            )}
            {changeCount > 0 && (
              <Badge
                variant="secondary"
                className="text-info border-info/30 gap-1"
              >
                <ArrowRight /> {changeCount} moving
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
                already assigned
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
                        disabled={actionableRows.length === 0}
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
                        {row.status === "change" && row.current_shift_name ? (
                          <span className="flex items-center gap-1 text-info">
                            <span className="line-through opacity-60 text-muted-foreground">
                              {row.current_shift_name}
                            </span>
                            <ArrowRight className="size-3 shrink-0" />
                            <span className="font-medium">
                              {row.shift_name || "—"}
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
                            Already assigned
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

          {actionableRows.length === 0 && result.rows.length > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning shrink-0">
              <AlertTriangle className="size-4 shrink-0" />
              No valid rows to assign. Fix the errors in your CSV and try again.
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

const UNASSIGNED_COL = "__unassigned__";

export const AssignEmployeesToShifts = forwardRef<
  AssignEmployeesToShiftsHandle,
  Props
>(function AssignEmployeesToShiftsImpl(
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
  const [showFilters, setShowFilters] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // ── local assignment state: user_id → shift_id | '' ──
  const [assignMap, setAssignMap] = useState<Record<string, string>>({});
  const [initialized, setInitialized] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());

  // ── queries ──
  const { data: calEmployees = [], isLoading: isLoadingCalEmps } =
    useGetWorkCalendarEmployeesQuery(calendarId, {
      refetchOnMountOrArgChange: true,
    });
  const { data: shifts = [], isLoading: isLoadingShifts } =
    useGetShiftsQuery(calendarId);
  const {
    data: existingAssignments = [],
    isLoading: isLoadingAssignments,
    isFetching: isFetchingAssignments,
  } = useGetShiftAssignmentsQuery(calendarId, {
    refetchOnMountOrArgChange: true,
  });
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

  // The calendar's members already arrive enriched with name/dept/etc from the
  // LMS, so the board renders straight from them — no IAM fetch + client-side
  // join (which previously dropped any member past the fetch page). Filters run
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

  const filteredMembers = useMemo(() => {
    const buName = buFilter ? buNameById.get(buFilter) : undefined;
    const deptName = deptFilter ? deptNameById.get(deptFilter) : undefined;
    const desgName = desgFilter ? desgNameById.get(desgFilter) : undefined;
    return calEmployees.filter((e) => {
      if (!memberMatchesSearch(e, debouncedSearch)) return false;
      if (buName && e.business_unit_name !== buName) return false;
      if (deptName && e.department_name !== deptName) return false;
      if (desgName && e.designation_name !== desgName) return false;
      return true;
    });
  }, [
    calEmployees,
    debouncedSearch,
    buFilter,
    deptFilter,
    desgFilter,
    buNameById,
    deptNameById,
    desgNameById,
  ]);

  const calendarEmployees = useMemo(
    () => filteredMembers.map(normalizeMember),
    [filteredMembers],
  );

  // Keyed over ALL members (not just the filtered set) so drag/lookup never
  // misses a member that a filter is currently hiding.
  const empByUid = useMemo(() => {
    const m: Record<string, NormalizedMember> = {};
    calEmployees.forEach((e) => {
      m[e.user_id] = normalizeMember(e);
    });
    return m;
  }, [calEmployees]);

  // ── initialize assignMap from server (after fresh fetch settles) ──
  useEffect(() => {
    if (initialized || isLoadingAssignments || isFetchingAssignments) return;
    const map: Record<string, string> = {};
    existingAssignments.forEach((a) => {
      map[a.user_id] = a.shift_id;
    });
    setAssignMap(map);
    setInitialized(true);
  }, [
    existingAssignments,
    isLoadingAssignments,
    isFetchingAssignments,
    initialized,
  ]);

  // ── server snapshot for dirty detection ──
  const serverAssignMap = useMemo(() => {
    const m: Record<string, string> = {};
    existingAssignments.forEach((a) => {
      m[a.user_id] = a.shift_id;
    });
    return m;
  }, [existingAssignments]);

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
  const shiftNameMap = useMemo(
    () => Object.fromEntries(shifts.map((s) => [s._id, s.name])),
    [shifts],
  );

  const hasActiveFilters = !!(buFilter || deptFilter || desgFilter);
  const clearFilters = () => {
    setBuFilter("");
    setDeptFilter("");
    setDesgFilter("");
  };

  // ── columns: one per shift + Unassigned, with their visible uids ──
  const columns = useMemo(() => {
    const cols: Array<{ id: string; name: string; uids: string[] }> = [
      { id: UNASSIGNED_COL, name: "Unassigned", uids: [] },
      ...shifts.map((s) => ({ id: s._id, name: s.name, uids: [] as string[] })),
    ];
    const byId: Record<string, { id: string; name: string; uids: string[] }> =
      {};
    cols.forEach((c) => {
      byId[c.id] = c;
    });

    for (const emp of calendarEmployees) {
      const uid = empUid(emp);
      const sid = assignMap[uid] ?? "";
      const col = sid && byId[sid] ? byId[sid] : byId[UNASSIGNED_COL];
      col.uids.push(uid);
    }
    return cols;
  }, [shifts, calendarEmployees, assignMap]);

  // ── dirty check + counts ──
  const hasChanges = useMemo(() => {
    const keys = new Set([
      ...Object.keys(assignMap),
      ...Object.keys(serverAssignMap),
    ]);
    for (const k of keys) {
      if ((assignMap[k] ?? "") !== (serverAssignMap[k] ?? "")) return true;
    }
    return false;
  }, [assignMap, serverAssignMap]);

  const pendingCount = useMemo(() => {
    const keys = new Set([
      ...Object.keys(assignMap),
      ...Object.keys(serverAssignMap),
    ]);
    let n = 0;
    for (const k of keys)
      if ((assignMap[k] ?? "") !== (serverAssignMap[k] ?? "")) n++;
    return n;
  }, [assignMap, serverAssignMap]);

  const assignedCount = Object.values(assignMap).filter(Boolean).length;

  // ── selection helpers ──
  const toggleSelectUid = useCallback((uid: string) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const toggleSelectColumn = useCallback((uids: string[], checked: boolean) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (checked) uids.forEach((uid) => next.add(uid));
      else uids.forEach((uid) => next.delete(uid));
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedUids(new Set()), []);

  // Apply a shift to every selected uid in local assignMap (Save persists to server).
  const applyShiftToSelection = useCallback(
    (shiftId: string) => {
      if (selectedUids.size === 0) return;
      setAssignMap((prev) => {
        const next = { ...prev };
        selectedUids.forEach((uid) => {
          next[uid] = shiftId;
        });
        return next;
      });
      const label = shiftId ? (shiftNameMap[shiftId] ?? "shift") : "Unassigned";
      toast.success(`${selectedUids.size} → ${label}. Save to persist.`);
      clearSelection();
    },
    [selectedUids, shiftNameMap, clearSelection],
  );

  // ── drag-and-drop ──
  // Activate after a 5px move so plain clicks still toggle selection.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const [draggingUid, setDraggingUid] = useState<string | null>(null);
  const handleDragStart = (e: DragStartEvent) => {
    setDraggingUid(String(e.active.id));
  };
  const handleDragEnd = (e: DragEndEvent) => {
    setDraggingUid(null);
    if (!e.over) return;
    const draggedUid = String(e.active.id);
    const dropColumnId = String(e.over.id);
    const targetShiftId = dropColumnId === UNASSIGNED_COL ? "" : dropColumnId;

    // If the dragged card is part of the current multi-selection, move
    // every selected uid together. Otherwise just move the one card.
    const uidsToMove = selectedUids.has(draggedUid)
      ? Array.from(selectedUids)
      : [draggedUid];

    setAssignMap((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const uid of uidsToMove) {
        if ((next[uid] ?? "") !== targetShiftId) {
          next[uid] = targetShiftId;
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // After a multi-move, clear the selection — those cards are no longer
    // "the staged batch", they're in their new home.
    if (uidsToMove.length > 1) clearSelection();
  };

  // ── mutations ──
  const [syncShiftAssignments, { isLoading: isSaving }] =
    useSyncShiftAssignmentsMutation();
  const [downloadTemplate] = useLazyDownloadShiftAssignmentTemplateQuery();
  const [validateBulk] = useValidateShiftAssignmentBulkUploadMutation();
  const [bulkAssign] = useBulkAssignShiftEmployeesMutation();

  // Underlying persistence — no confirm dialog. Returns true on success.
  const persistAssignments = useCallback(async (): Promise<boolean> => {
    try {
      const assignments = Object.entries(assignMap)
        .filter(([, shiftId]) => !!shiftId)
        .map(([userId, shiftId]) => ({
          user_id: userId,
          shift_id: shiftId,
        }));
      const result = await syncShiftAssignments({
        calendarId,
        body: { assignments },
      }).unwrap();
      toast.success(
        `${result.updated} shift assignment${result.updated !== 1 ? "s" : ""} saved`,
      );
      return true;
    } catch (err) {
      toast.error(err, "Failed to save shift assignments");
      return false;
    }
  }, [assignMap, calendarId, syncShiftAssignments]);

  const handleSave = () => {
    if (!hasChanges) return;
    confirm({
      title: "Save shift assignments?",
      description: `${pendingCount} change${pendingCount !== 1 ? "s" : ""} will be saved to "${calendarData.name}".`,
      confirmText: "Save",
      onConfirm: async () => {
        const ok = await persistAssignments();
        if (ok) {
          if (wizardMode && onSaved) onSaved();
          else onClose();
        }
      },
    });
  };

  // Expose a no-confirm save trigger so the wizard's Finish button can call it directly.
  useImperativeHandle(
    ref,
    () => ({
      triggerSave: async () => {
        const ok = await persistAssignments();
        if (ok && wizardMode && onSaved) onSaved();
        return ok;
      },
    }),
    [persistAssignments, wizardMode, onSaved],
  );

  // Notify wizard parent whenever dirty state flips.
  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  const handleClose = () => {
    if (hasChanges) {
      confirm({
        title: "Discard changes?",
        description: `You have ${pendingCount} unsaved change${pendingCount !== 1 ? "s" : ""}. Leave anyway?`,
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: onClose,
      });
    } else {
      onClose();
    }
  };

  const handleDownloadTemplate = async () => {
    const result = await downloadTemplate(calendarId).unwrap();
    const url = URL.createObjectURL(result);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shift_assignment_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleBulkValidate = async (file: File) =>
    validateBulk({ calendarId, file }).unwrap();

  const handleBulkAssign = async (assignments: ShiftAssignment[]) => {
    const result = await bulkAssign({ calendarId, assignments }).unwrap();
    assignments.forEach((a) => {
      setAssignMap((prev) => ({ ...prev, [a.user_id]: a.shift_id }));
    });
    setBulkOpen(false);
    return result;
  };

  const isLoading = isLoadingCalEmps || isLoadingShifts || isLoadingAssignments;

  // Filter the cards inside each column by the current search query
  // (search/filters already constrained `allEmployees`; this just hides empty placeholders).
  const moveOptions = useMemo<Option[]>(
    () => [...shiftOptions, { label: "Unassigned", value: "" }],
    [shiftOptions],
  );

  if (calendarData.is_active === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-4 text-center p-8">
        <AlertTriangle className="size-10 text-badge-pending-text" />
        <p className="text-lg font-semibold">This calendar is inactive</p>
        <p className="text-sm text-muted-foreground">
          Activate it to assign employees to shifts.
        </p>
        <Button variant="outline" onClick={onClose}>
          Go Back
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {isSaving && <FullScreenLoader message="Saving shift assignments…" />}
      {/* Header */}
      <div className="border-b border-border bg-background px-6 py-3">
        <div className="flex items-center gap-3">
          {!wizardMode && (
            <Button variant="ghost" size="icon-sm" onClick={handleClose}>
              <ArrowLeft />
            </Button>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold leading-tight truncate">
              Shift Assignments
            </h1>
            <p className="text-xs text-muted-foreground truncate">
              {calendarData.name}
            </p>
          </div>
          <Badge variant="secondary" className="text-xs gap-1.5">
            <Users />
            {assignedCount} of {calendarEmployees.length} assigned
          </Badge>
          <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
            <Upload /> Import CSV
          </Button>
          {!wizardMode && (
            <Button
              variant="soft"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              size="sm"
            >
              {isSaving
                ? "Saving…"
                : hasChanges
                  ? `Save ${pendingCount} change${pendingCount !== 1 ? "s" : ""}`
                  : "Saved"}
            </Button>
          )}
        </div>
      </div>

      {/* Search + Filters */}
      <div className="px-6 py-3 border-b border-border bg-background space-y-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, emp code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Button
            variant={showFilters ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter />
            Filters
            {hasActiveFilters && (
              <Badge
                variant="secondary"
                className="ml-1.5 size-5 p-0 justify-center text-[10px]"
              >
                {[buFilter, deptFilter, desgFilter].filter(Boolean).length}
              </Badge>
            )}
          </Button>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X /> Clear
            </Button>
          )}
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          </div>
        )}
      </div>

      {/* Board */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <FullScreenLoader message="Loading…" />
        ) : shifts.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No shifts configured"
            description="Create shifts on this work calendar before assigning employees."
          />
        ) : calEmployees.length === 0 && !isLoadingCalEmps ? (
          <EmptyState
            icon={Users}
            title="No employees on this calendar"
            description="Add employees via Manage Employees first."
          />
        ) : calendarEmployees.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No employees match your filters"
            description="Try adjusting your search or filters."
          />
        ) : (
          <DndContext
            sensors={dndSensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDraggingUid(null)}
          >
            <div className="h-full overflow-x-auto px-6 py-4">
              <div className="flex gap-4 h-full min-w-min">
                {columns.map((col) => (
                  <ShiftColumn
                    key={col.id}
                    column={col}
                    empByUid={empByUid}
                    serverAssignMap={serverAssignMap}
                    selectedUids={selectedUids}
                    onToggleSelect={toggleSelectUid}
                    onToggleSelectAll={(checked) =>
                      toggleSelectColumn(col.uids, checked)
                    }
                    isUnassigned={col.id === UNASSIGNED_COL}
                  />
                ))}
              </div>
            </div>
            <DragOverlay>
              {draggingUid && empByUid[draggingUid] ? (
                <div className="relative">
                  <EmployeeCard
                    emp={empByUid[draggingUid]}
                    isSelected={false}
                    isDirty={false}
                    onToggle={() => {}}
                    dragOverlay
                  />
                  {selectedUids.has(draggingUid) && selectedUids.size > 1 && (
                    <Badge className="absolute -top-2 -right-2 size-6 p-0 justify-center text-[11px] font-bold border-2 border-background shadow-md">
                      +{selectedUids.size - 1}
                    </Badge>
                  )}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
        {isFetchingAssignments && calEmployees.length > 0 && (
          <div className="absolute top-32 right-8 z-10 flex items-center gap-2 rounded-full bg-background border px-3 py-1.5 shadow-sm text-xs text-muted-foreground">
            <Loader2 className="animate-spin" /> updating…
          </div>
        )}
      </div>

      {/* Selection action bar */}
      {selectedUids.size > 0 && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-30 px-4">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border bg-background shadow-xl px-4 py-2">
            <span className="text-sm font-medium">
              {selectedUids.size} selected
            </span>
            <div className="h-5 w-px bg-border" />
            <div className="w-56">
              <SearchableSelect
                options={moveOptions}
                value=""
                onChange={(v) => applyShiftToSelection(v as string)}
                placeholder="Move to…"
                searchable={moveOptions.length > 5}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={clearSelection}
              title="Clear selection"
            >
              <X />
            </Button>
          </div>
        </div>
      )}

      <BulkShiftAssignDialog
        open={bulkOpen}
        onOpenChange={(open) => {
          setBulkOpen(open);
          if (!open) setInitialized(false);
        }}
        onDownloadTemplate={handleDownloadTemplate}
        onValidate={handleBulkValidate}
        onAssign={handleBulkAssign}
      />
    </div>
  );
});

// ─── Shift Column ─────────────────────────────────────────────────────────────

interface ShiftColumnProps {
  column: { id: string; name: string; uids: string[] };
  empByUid: Record<string, any>;
  serverAssignMap: Record<string, string>;
  selectedUids: Set<string>;
  onToggleSelect: (uid: string) => void;
  onToggleSelectAll: (checked: boolean) => void;
  isUnassigned: boolean;
}

function ShiftColumn({
  column,
  empByUid,
  serverAssignMap,
  selectedUids,
  onToggleSelect,
  onToggleSelectAll,
  isUnassigned,
}: ShiftColumnProps) {
  const presentUids = column.uids.filter((uid) => !!empByUid[uid]);
  const allSelected =
    presentUids.length > 0 && presentUids.every((uid) => selectedUids.has(uid));
  const someSelected = presentUids.some((uid) => selectedUids.has(uid));

  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div className="flex flex-col w-72 shrink-0 rounded-xl border bg-background">
      {/* Column header */}
      <div
        className={`flex items-center gap-2 px-3 py-2.5 border-b ${isUnassigned ? "bg-table-header" : "bg-primary/5"}`}
      >
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(checked) => onToggleSelectAll(checked === true)}
          aria-label={`Select all in ${column.name}`}
          disabled={presentUids.length === 0}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{column.name}</p>
        </div>
        <Badge
          variant={isUnassigned ? "outline" : "secondary"}
          className="text-xs"
        >
          {presentUids.length}
        </Badge>
      </div>

      {/* Cards — droppable target */}
      <div
        ref={setNodeRef}
        className={`flex-1 overflow-y-auto p-2 space-y-1.5 min-h-[200px] transition-colors ${
          isOver
            ? "bg-primary/10 ring-2 ring-primary/40 ring-inset rounded-b-lg"
            : ""
        }`}
      >
        {presentUids.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic">
            {isOver
              ? "Drop here"
              : isUnassigned
                ? "Everyone assigned"
                : "No one in this shift"}
          </div>
        ) : (
          presentUids.map((uid) => {
            const emp = empByUid[uid];
            const isSelected = selectedUids.has(uid);
            const serverShift = serverAssignMap[uid] ?? "";
            const currentColShift = isUnassigned ? "" : column.id;
            const isDirty = serverShift !== currentColShift;
            return (
              <EmployeeCard
                key={uid}
                emp={emp}
                isSelected={isSelected}
                isDirty={isDirty}
                onToggle={() => onToggleSelect(uid)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Employee Card ────────────────────────────────────────────────────────────

interface EmployeeCardProps {
  emp: any;
  isSelected: boolean;
  isDirty: boolean;
  onToggle: () => void;
  /** When rendered inside `<DragOverlay>` we skip useDraggable and drop interactivity. */
  dragOverlay?: boolean;
}

function EmployeeCard({
  emp,
  isSelected,
  isDirty,
  onToggle,
  dragOverlay = false,
}: EmployeeCardProps) {
  const uid = empUid(emp);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: uid,
    disabled: dragOverlay,
  });
  // Hide the source card while it's mid-drag — the DragOverlay carries it visually.
  const hideWhileDragging = isDragging && !dragOverlay;
  // PointerSensor activates at 5px movement, so plain clicks still fire onToggle.
  // We spread the drag listeners on the whole card so users can grab it anywhere
  // (not just a grip icon).
  const dragProps = dragOverlay ? {} : { ...attributes, ...listeners };
  return (
    <div
      ref={dragOverlay ? undefined : setNodeRef}
      role="checkbox"
      aria-checked={isSelected}
      tabIndex={0}
      onClick={dragOverlay ? undefined : onToggle}
      onKeyDown={(e) => {
        if (dragOverlay) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      {...dragProps}
      className={`group w-full flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isSelected
          ? "border-primary bg-primary/10"
          : "border-transparent bg-muted hover:bg-muted/80"
      } ${dragOverlay ? "shadow-lg ring-2 ring-primary cursor-grabbing" : "cursor-grab active:cursor-grabbing"} ${
        hideWhileDragging ? "opacity-30" : ""
      }`}
    >
      <Checkbox
        checked={isSelected}
        onCheckedChange={onToggle}
        // Stop pointer events so clicking the checkbox doesn't initiate a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${emp.firstName} ${emp.lastName}`}
        disabled={dragOverlay}
      />
      <div className="size-7 rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-[10px] shrink-0">
        {emp.firstName?.charAt(0)}
        {emp.lastName?.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">
          {emp.firstName} {emp.lastName}
        </p>
        <p className="text-[10px] text-muted-foreground truncate">
          {emp.departmentName ?? emp.empCode ?? ""}
        </p>
      </div>
      {isDirty && (
        <span
          className="size-1.5 rounded-full bg-badge-pending-bg0 shrink-0"
          title="Unsaved change"
        />
      )}
    </div>
  );
}
