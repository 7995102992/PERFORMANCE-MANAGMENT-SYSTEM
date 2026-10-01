import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  Search,
  X,
  Filter,
  ArrowLeft,
  Users,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useGetDesignationsQuery,
} from "@/store/api/iamApi";
import { useInfiniteEmployees } from "@/hooks/use-infinite-employees";
import { InfiniteScrollSentinel } from "@/components/shared/InfiniteScrollSentinel";
import {
  useGetWorkCalendarEmployeesQuery,
  useGetWorkCalendarCrossAssignmentsQuery,
  useGetShiftAssignmentsQuery,
  useSyncWorkCalendarEmployeesMutation,
  useLazyDownloadWorkCalendarBulkTemplateQuery,
  useValidateWorkCalendarBulkUploadMutation,
  useBulkAssignWorkCalendarEmployeesMutation,
} from "@/store/api/lmsApi";
import { BulkUploadEmployeesDialog } from "@/components/shared/BulkUploadEmployeesDialog";
import type { WorkCalendarResponse } from "@/types/leave";
import { PageLoader } from "@/components/shared/PageLoader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { deptLabel } from "@/lib/utils";

type AssignmentFilter = "all" | "assigned" | "not_assigned";

interface Props {
  calendarData: WorkCalendarResponse;
  onClose: () => void;
  /** Hide the internal Cancel/Save footer + back-arrow (wizard owns navigation). */
  wizardMode?: boolean;
  /** Called after a successful save in wizardMode so the wizard can advance. */
  onSaved?: () => void;
  /** Notifies the wizard parent when the dirty flag flips. */
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export interface AddEmployeesToCalendarHandle {
  /** Persists the current pending state to the BE. Returns true on success. */
  triggerSave: () => Promise<boolean>;
}

const empUid = (emp: {
  userId?: string | null;
  user_id?: string | null;
  id: string;
}) => emp.userId ?? emp.user_id ?? emp.id;

export const AddEmployeesToCalendar = forwardRef<
  AddEmployeesToCalendarHandle,
  Props
>(function AddEmployeesToCalendarImpl(
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

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [buFilter, setBuFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [desgFilter, setDesgFilter] = useState("");
  const [assignmentFilter, setAssignmentFilter] =
    useState<AssignmentFilter>("all");
  const [showFilters, setShowFilters] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // ── server state ──
  // refetchOnMountOrArgChange forces a fresh fetch every time this dialog opens,
  // so checkbox state never lags behind a recent sync/bulk-assign from another flow.
  const {
    data: assignedEntries = [],
    isLoading: isLoadingAssigned,
    isFetching: isFetchingAssigned,
  } = useGetWorkCalendarEmployeesQuery(calendarId, {
    refetchOnMountOrArgChange: true,
  });
  const assignedUserIds = useMemo(
    () => new Set(assignedEntries.map((e) => e.user_id)),
    [assignedEntries],
  );

  // Shift assignments for this calendar — used to warn the user when removing
  // employees who currently hold a shift (the BE cascade-deletes those, so we
  // surface the count up-front).
  const { data: shiftAssignments = [] } =
    useGetShiftAssignmentsQuery(calendarId);

  // ─── Cross-calendar assignment lookup ───────────────────────
  // Fetch all work calendars, then for every *other* active calendar fetch its
  // Members of every OTHER active calendar (same org) in one call — the LMS
  // batches it, so no per-calendar fan-out. Grouped into uid -> [calendar
  // names] for the "already on calendar X" warning.
  const { data: crossData } = useGetWorkCalendarCrossAssignmentsQuery(
    calendarId,
    { skip: !calendarId },
  );

  const otherCalendarEmployeeMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const it of crossData?.items ?? []) {
      const name = it.scope_name ?? "";
      const existing = map.get(it.user_id);
      if (existing) existing.push(name);
      else map.set(it.user_id, [name]);
    }
    return map;
  }, [crossData]);

  // Initialize selection ONLY after the in-flight fetch settles, so we never seed
  // selectedIds from stale cache and then have the refetch silently overwritten.
  useEffect(() => {
    if (initialized || isLoadingAssigned || isFetchingAssigned) return;
    setSelectedIds(new Set(assignedEntries.map((e) => e.user_id)));
    setInitialized(true);
  }, [isLoadingAssigned, isFetchingAssigned, assignedEntries, initialized]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(search.length >= 2 ? search : ""),
      400,
    );
    return () => clearTimeout(t);
  }, [search]);

  // Reset cascading filters
  useEffect(() => {
    setDeptFilter("");
    setDesgFilter("");
  }, [buFilter]);
  useEffect(() => {
    setDesgFilter("");
  }, [deptFilter]);

  // ── filter data ──
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

  // Scope = the calendar's departments AND its business units. A department
  // shared across BUs would otherwise pull in employees from a BU that isn't
  // on this calendar, so by default we constrain to the calendar's own BUs
  // (matches the BU-aware backend resolver). Picking a BU in the dropdown
  // narrows further to that one BU.
  const employeeParams = useMemo(
    () => ({
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(buFilter
        ? { business_unit_ids: [buFilter] }
        : calBuIds.length
          ? { business_unit_ids: calBuIds }
          : {}),
      department_ids: deptFilter ? [deptFilter] : calDeptIds,
      ...(desgFilter ? { designation_ids: [desgFilter] } : {}),
      is_active: true,
    }),
    [debouncedSearch, buFilter, deptFilter, desgFilter, calDeptIds, calBuIds],
  );

  const { employees, isFetching, hasMore, loadMore } =
    useInfiniteEmployees(employeeParams);

  // Apply assignment filter, then sort by tier:
  //   0 = unassigned (not on this calendar, not on another)
  //   1 = assigned to this calendar
  //   2 = assigned to another calendar
  const tierOf = (id: string) => {
    if (otherCalendarEmployeeMap.has(id)) return 2;
    if (assignedUserIds.has(id)) return 1;
    return 0;
  };
  const filteredEmployees = useMemo(() => {
    let list = employees;
    if (assignmentFilter === "assigned")
      list = employees.filter((e) => assignedUserIds.has(empUid(e)));
    else if (assignmentFilter === "not_assigned")
      list = employees.filter((e) => !assignedUserIds.has(empUid(e)));
    return [...list].sort((a, b) => tierOf(empUid(a)) - tierOf(empUid(b)));
  }, [employees, assignmentFilter, assignedUserIds, otherCalendarEmployeeMap]);

  const hasActiveFilters = !!(buFilter || deptFilter || desgFilter);
  const clearFilters = () => {
    setBuFilter("");
    setDeptFilter("");
    setDesgFilter("");
  };

  // ── selection ──
  const toggleSelect = (id: string) => {
    if (otherCalendarEmployeeMap.has(id)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableEmployees = useMemo(
    () =>
      filteredEmployees.filter((e) => !otherCalendarEmployeeMap.has(empUid(e))),
    [filteredEmployees, otherCalendarEmployeeMap],
  );

  const toggleAll = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) selectableEmployees.forEach((e) => next.add(empUid(e)));
      else selectableEmployees.forEach((e) => next.delete(empUid(e)));
      return next;
    });
  };

  const allSelected =
    selectableEmployees.length > 0 &&
    selectableEmployees.every((e) => selectedIds.has(empUid(e)));

  const hasChanges = useMemo(() => {
    if (selectedIds.size !== assignedUserIds.size) return true;
    for (const id of selectedIds) if (!assignedUserIds.has(id)) return true;
    return false;
  }, [selectedIds, assignedUserIds]);

  // ── mutations ──
  const [syncEmployees, { isLoading: isSaving }] =
    useSyncWorkCalendarEmployeesMutation();
  const [downloadTemplate] = useLazyDownloadWorkCalendarBulkTemplateQuery();
  const [validateBulk] = useValidateWorkCalendarBulkUploadMutation();
  const [bulkAssign] = useBulkAssignWorkCalendarEmployeesMutation();

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

  // Underlying persistence — no confirm dialog. Returns true on success.
  const persistChanges = async (): Promise<boolean> => {
    try {
      const result = await syncEmployees({
        calendarId,
        body: { user_ids: Array.from(selectedIds) },
      }).unwrap();
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.removed > 0) parts.push(`${result.removed} removed`);
      toast.success(
        `Employees updated${parts.length ? ` — ${parts.join(", ")}` : ""}`,
      );
      return true;
    } catch (err) {
      toast.error(err, "Failed to update employee assignments");
      return false;
    }
  };

  const handleSave = () => {
    if (!hasChanges) return;

    // Compute the diff vs. server state so the confirmation can spell out
    // exactly what will change — including how many shift assignments will
    // be cascade-deleted for employees being unassigned.
    const toAddCount = Array.from(selectedIds).filter(
      (id) => !assignedUserIds.has(id),
    ).length;
    const removedUserIds = Array.from(assignedUserIds).filter(
      (id) => !selectedIds.has(id),
    );
    const toRemoveCount = removedUserIds.length;
    const removedSet = new Set(removedUserIds);
    const cascadedShiftAssignmentCount = shiftAssignments.filter((a) =>
      removedSet.has(a.user_id),
    ).length;

    const bits: string[] = [];
    if (toAddCount > 0)
      bits.push(
        `${toAddCount} employee${toAddCount !== 1 ? "s" : ""} will be added`,
      );
    if (toRemoveCount > 0)
      bits.push(
        `${toRemoveCount} employee${toRemoveCount !== 1 ? "s" : ""} will be unassigned`,
      );
    let summary = bits.length ? `${bits.join(" and ")}. ` : "";
    if (cascadedShiftAssignmentCount > 0) {
      summary += `${cascadedShiftAssignmentCount} shift assignment${cascadedShiftAssignmentCount !== 1 ? "s" : ""} for the unassigned employees will also be removed. `;
    }
    const description = `${summary}This updates the employee assignments for "${calendarData.name}".`;

    confirm({
      title: "Save Employee Assignments?",
      description,
      confirmText: "Save",
      ...(toRemoveCount > 0 ? { variant: "destructive" as const } : {}),
      onConfirm: async () => {
        const ok = await persistChanges();
        if (ok) {
          if (wizardMode && onSaved) onSaved();
          else onClose();
        }
      },
    });
  };

  // Expose a no-confirm save trigger so the wizard's Next button can call it directly.
  useImperativeHandle(ref, () => ({
    triggerSave: async () => {
      const ok = await persistChanges();
      if (ok && wizardMode && onSaved) onSaved();
      return ok;
    },
  }));

  // Notify wizard parent whenever dirty state flips.
  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  const handleDownloadTemplate = async () => {
    const result = await downloadTemplate(calendarId).unwrap();
    const url = URL.createObjectURL(result);
    const a = document.createElement("a");
    a.href = url;
    a.download = "employee_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleBulkValidate = async (file: File) =>
    validateBulk({ calendarId, file }).unwrap();

  const handleBulkAssign = async (userIds: string[]) => {
    const result = await bulkAssign({ calendarId, user_ids: userIds }).unwrap();
    return result;
  };

  const assignedCount = assignedUserIds.size;

  // Live counts derived from current view + current selection (update as the user clicks)
  const visibleTotal = filteredEmployees.length;
  const visibleAssignedLive = useMemo(
    () => filteredEmployees.filter((e) => selectedIds.has(empUid(e))).length,
    [filteredEmployees, selectedIds],
  );
  const visibleNotAssigned = visibleTotal - visibleAssignedLive;

  if (calendarData.is_active === false) {
    return (
      <EmptyState
        variant="warning"
        icon={AlertTriangle}
        title="This calendar is inactive"
        description="Activate it to manage employees."
        action={
          <Button variant="outline" onClick={onClose}>
            Go Back
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          {!wizardMode && (
            <Button variant="ghost" size="icon-sm" onClick={handleClose}>
              <ArrowLeft />
            </Button>
          )}
          <div className="flex-1">
            <h1 className="text-xl font-bold">Manage Employees</h1>
            <p className="text-sm text-muted-foreground">
              {calendarData.name} — Check employees to assign, uncheck to
              remove.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
            <Upload /> Bulk Import
          </Button>
          {assignedCount > 0 && (
            <Badge variant="secondary" className="text-xs gap-1.5">
              <Users />
              {assignedCount} assigned
            </Badge>
          )}
        </div>
      </div>

      {/* Search + Filters */}
      <div className="px-6 py-4 space-y-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, emp code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex bg-muted p-1 rounded-xl text-xs font-medium">
            <button
              onClick={() => setAssignmentFilter("all")}
              className={`px-3 py-1.5 rounded-md transition-colors ${assignmentFilter === "all" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              All
            </button>
            <button
              onClick={() => setAssignmentFilter("assigned")}
              className={`px-3 py-1.5 rounded-md transition-colors ${assignmentFilter === "assigned" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              Assigned
            </button>
            <button
              onClick={() => setAssignmentFilter("not_assigned")}
              className={`px-3 py-1.5 rounded-md transition-colors ${assignmentFilter === "not_assigned" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              Not Assigned
            </button>
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
              placeholder="Select Business Unit"
              searchable={buOptions.length > 5}
            />
            <SearchableSelect
              options={[
                { label: "All Departments", value: "" },
                ...deptOptions,
              ]}
              value={deptFilter}
              onChange={(v) => setDeptFilter(v as string)}
              placeholder={buFilter ? "Select Department" : "Select BU first"}
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
              placeholder={
                deptFilter ? "Select Designation" : "Select Dept first"
              }
              disabled={!deptFilter}
              searchable={desgOptions.length > 5}
            />
          </div>
        )}
      </div>

      {/* Employee Table */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {(isFetching && employees.length === 0) || isLoadingAssigned ? (
          <PageLoader message="Loading employees…" />
        ) : filteredEmployees.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No employees found"
            description="Try adjusting your filters or search."
          />
        ) : (
          <div className="rounded-xl border overflow-x-auto bg-card">
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) => toggleAll(!!checked)}
                    />
                  </TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Designation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEmployees.map((emp) => {
                  const isOnOtherCalendar = otherCalendarEmployeeMap.has(
                    empUid(emp),
                  );
                  return (
                    <TableRow
                      key={emp.id}
                      className={
                        isOnOtherCalendar
                          ? "opacity-50"
                          : selectedIds.has(empUid(emp))
                            ? "bg-primary/5"
                            : ""
                      }
                    >
                      <TableCell>
                        <Checkbox
                          checked={
                            !isOnOtherCalendar && selectedIds.has(empUid(emp))
                          }
                          onCheckedChange={() => toggleSelect(empUid(emp))}
                          disabled={isOnOtherCalendar}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs">
                            {emp.firstName?.charAt(0)}
                            {emp.lastName?.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-medium">
                                {emp.firstName} {emp.lastName}
                              </p>
                              {isOnOtherCalendar && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="outline"
                                        className="text-[10px] h-5 px-2 gap-1 cursor-default bg-warning/10 text-warning border-warning/40 font-semibold"
                                      >
                                        <AlertTriangle className="size-3" />
                                        On:{" "}
                                        {
                                          otherCalendarEmployeeMap.get(
                                            empUid(emp),
                                          )![0]
                                        }
                                        {otherCalendarEmployeeMap.get(
                                          empUid(emp),
                                        )!.length > 1 &&
                                          ` +${otherCalendarEmployeeMap.get(empUid(emp))!.length - 1}`}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      <span>
                                        Also assigned to:{" "}
                                        {otherCalendarEmployeeMap
                                          .get(empUid(emp))!
                                          .join(", ")}
                                      </span>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
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

      {/* Footer */}
      <div className="border-t border-border px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm text-muted-foreground flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span>
            <span className="font-medium text-foreground">{visibleTotal}</span>{" "}
            total
          </span>
          <span className="text-border">·</span>
          <span>
            <span className="font-medium text-foreground">
              {visibleAssignedLive}
            </span>{" "}
            assigned
          </span>
          <span className="text-border">·</span>
          <span>
            <span className="font-medium text-foreground">
              {visibleNotAssigned}
            </span>{" "}
            not assigned
          </span>
          <span className="text-border">·</span>
          <span className="text-xs">
            {assignedCount} currently saved on calendar
          </span>
        </div>
        {!wizardMode && (
          <div className="flex gap-3">
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

      <BulkUploadEmployeesDialog
        open={bulkOpen}
        onOpenChange={(open) => {
          setBulkOpen(open);
          if (!open) {
            // Force the init effect to reseed selection from the
            // refetched server data, not from a stale local snapshot
            // that was current before the bulk-assign succeeded.
            setSelectedIds(new Set());
            setInitialized(false);
          }
        }}
        onDownloadTemplate={handleDownloadTemplate}
        onValidate={handleBulkValidate}
        onAssign={handleBulkAssign}
        entityName="work calendar"
      />
    </div>
  );
});
