import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TablePagination } from "@/components/shared/TablePagination";
import { ProjectStepper } from "@/components/shared/ProjectStepper";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { DatePicker } from "@/components/ui/date-picker";
import type { DateRange } from "react-day-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Plus,
  Search,
  Trash2,
  CalendarDays,
  Pencil,
  Check,
  X,
  UserCog,
  Users,
  FolderOpen,
  AlertTriangle,
} from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAppSelector, useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import {
  useGetProjectQuery,
  useGetProjectResourcesQuery,
  useCreateResourceMutation,
  useUpdateResourceMutation,
  useDeleteResourceMutation,
  useGetClientQuery,
  useGetProjectTasksQuery,
} from "@/store/api/timesheetApi";
import { useGetEmployeesQuery } from "@/store/api/iamApi";
import type { EmployeeCompact } from "@/store/api/iamApi";
import type {
  ProjectTaskResponse,
  ResourceAssignmentResponse,
  AllocationStatus,
} from "@/types/timesheet";
import { toast, extractErrorMessage, hasErrorCode } from "@/lib/toast";

// Format a Date as YYYY-MM-DD using LOCAL components (toISOString would shift
// the calendar's local-midnight back a day in timezones ahead of UTC).
const toLocalYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface SelectedEmployee {
  id: string;
  user_id?: string;
  name: string;
  department: string;
  emp_code?: string;
  tab: "managers" | "employees";
}

/**
 * GET /projects/{id}/resources returns one row per task, so an employee on three
 * tasks appears three times. The UI treats an employee's rows as one assignment
 * — which is also how PUT behaves — so they are grouped on user_id here.
 */
interface GroupedResource {
  userId: string;
  userName: string;
  department: string;
  role: string | null;
  billableRate: number | null;
  startDate?: string | null;
  endDate?: string | null;
  /** null task_id on any row means the whole project */
  isProjectLevel: boolean;
  taskIds: string[];
  rows: ResourceAssignmentResponse[];
  /** Any row id identifies the employee for PUT */
  anyRowId: string;
  /**
   * Removal closes the employee's whole allocation, so every row shares the
   * status. Defaults to "allocated" for payloads predating the field.
   */
  allocationStatus: AllocationStatus;
  removalComment: string | null;
}

interface EditDialogState {
  resourceId: string;
  userId: string;
  userName: string;
  role: "manager" | "employee";
  billableRate: string;
  scope: "project" | "tasks";
  taskIds: string[];
  initialScope: "project" | "tasks";
  initialTaskIds: string[];
  /** TSM-006 — a chosen task isn't linked to the project */
  taskError: string | null;
}

const sameIdSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

const ProjectResources = () => {
  const navigate = useNavigate();
  const { projectId } = useParams({ strict: false }) as { projectId: string };

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: project, error: projectError } = useGetProjectQuery(projectId);
  // Projects are scoped to the caller — a 404 means deleted or not yours
  const projectNotFound =
    (projectError as { status?: number } | undefined)?.status === 404;

  // Topbar breadcrumb leaf: Timesheet › Projects › <this>. Step 3 of the same
  // wizard as Project Setup, so it names the project the same way.
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch(setBreadcrumbDetail(project?.name ?? "Resources"));
    return () => {
      dispatch(setBreadcrumbDetail(null));
    };
  }, [dispatch, project?.name]);

  const { data: resourcesData, isLoading } = useGetProjectResourcesQuery({
    projectId,
    page,
    page_size: pageSize,
  });
  const { data: projectTasks } = useGetProjectTasksQuery({ projectId });
  // Kept for the resource picker's business-unit / department scoping below —
  // the client's name now comes off the project payload.
  const { data: client } = useGetClientQuery(project?.client_id ?? "", {
    skip: !project?.client_id,
  });
  const clientName = project?.client_name ?? "-";

  // Scope the resource picker to the client's business units / departments
  const belongsToFilter = useMemo<{
    department_ids?: string[];
    business_unit_ids?: string[];
  }>(() => {
    const filter: { department_ids?: string[]; business_unit_ids?: string[] } =
      {};
    if (client?.business_unit_ids?.length)
      filter.business_unit_ids = client.business_unit_ids;
    if (client?.department_ids?.length)
      filter.department_ids = client.department_ids;
    return filter;
  }, [client]);
  const [createResource, { isLoading: isCreating }] =
    useCreateResourceMutation();
  const [updateResource] = useUpdateResourceMutation();
  const [deleteResource, { isLoading: isDeleting }] =
    useDeleteResourceMutation();
  const [roleFilter, setRoleFilter] = useState<
    "all" | "managers" | "employees"
  >("all");
  // Removal targets the whole employee — one DELETE per assignment row they hold
  const [deleteConfirm, setDeleteConfirm] = useState<GroupedResource | null>(
    null,
  );
  const [deleteComment, setDeleteComment] = useState("");
  // Last day they can still log time. Defaults to today = "remove now".
  const [deleteEndDate, setDeleteEndDate] = useState<string>(
    toLocalYMD(new Date()),
  );
  // Inline row edit is limited to the allocation date range; everything else
  // (role, rate, task selection) lives in the edit dialog.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDialog, setEditDialog] = useState<EditDialogState | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Add Resources dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [dialogTab, setDialogTab] = useState<"managers" | "employees">(
    "managers",
  );
  const sheetScrollRef = useRef<HTMLDivElement>(null);
  const [dialogSearch, setDialogSearch] = useState("");
  const [debouncedDialogSearch, setDebouncedDialogSearch] = useState("");
  const [selectedEmployees, setSelectedEmployees] = useState<
    SelectedEmployee[]
  >([]);
  // Add dialog task scope: "project" submits task_ids: [], "tasks" submits the
  // ticked list. Never both — see ResourceAssignmentCreate.
  const [assignScope, setAssignScope] = useState<"project" | "tasks">(
    "project",
  );
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [addTaskError, setAddTaskError] = useState<string | null>(null);
  // 409 — the employee already has one of these tasks; edit, don't re-add
  const [addConflict, setAddConflict] = useState<string | null>(null);

  const user = useAppSelector((s) => s.auth.user);
  const orgId = user?.organisation_id || project?.organisation_id || "";

  const {
    data: dialogEmployees,
    isFetching: fetchingDialogEmployees,
    isError: dialogSearchError,
  } = useGetEmployeesQuery(
    {
      search: debouncedDialogSearch || undefined,
      // The list now fills the sheet height — 20 left most of it empty
      limit: 50,
      ...(orgId ? { organisation_id: orgId } : {}),
      ...belongsToFilter,
    },
    { skip: !orgId || !addDialogOpen },
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDialogSearch(dialogSearch), 300);
    return () => clearTimeout(timer);
  }, [dialogSearch]);

  const resources = resourcesData?.items ?? [];
  /**
   * Only a LIVE allocation blocks re-adding someone. Removed people stay in the
   * list now, and adding them again is how you bring them back — it reopens the
   * same allocation rather than creating a duplicate, and the API only 409s for
   * someone still allocated. Filtering on mere presence would leave them
   * permanently unpickable.
   */
  const allocatedUserIds = new Set(
    resources
      .filter((r) => (r.allocation_status ?? "allocated") === "allocated")
      .map((r) => r.user_id),
  );
  /** Previously released from this project — selecting them reopens it */
  const releasedUserIds = new Set(
    resources
      .filter((r) => (r.allocation_status ?? "allocated") !== "allocated")
      .map((r) => r.user_id),
  );

  const MANAGER_ROLES = ["manager", "lead", "project_manager", "team_lead"];

  const taskName = (taskId: string) => {
    const pt = (projectTasks ?? []).find((t) => t.task_id === taskId);
    return pt?.task_name ?? pt?.task?.name ?? taskId;
  };

  // One row per employee, carrying their whole task set
  const groupedResources: GroupedResource[] = (() => {
    const byUser = new Map<string, GroupedResource>();
    for (const r of resources) {
      const existing = byUser.get(r.user_id);
      if (existing) {
        existing.rows.push(r);
        if (r.task_id) existing.taskIds.push(r.task_id);
        else existing.isProjectLevel = true;
        continue;
      }
      byUser.set(r.user_id, {
        userId: r.user_id,
        userName: r.user_name ?? r.user_id,
        department: r.department ?? "-",
        role: r.role ?? null,
        billableRate: r.billable_rate ?? null,
        startDate: r.start_date,
        endDate: r.end_date,
        isProjectLevel: !r.task_id,
        taskIds: r.task_id ? [r.task_id] : [],
        rows: [r],
        anyRowId: r._id,
        allocationStatus: r.allocation_status ?? "allocated",
        removalComment: r.removal_comment ?? null,
      });
    }
    return [...byUser.values()];
  })();

  const filteredResources = groupedResources.filter((g) => {
    const isManager = MANAGER_ROLES.includes((g.role ?? "").toLowerCase());
    if (roleFilter === "managers" && !isManager) return false;
    if (roleFilter === "employees" && isManager) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      g.userName.toLowerCase().includes(q) ||
      (g.role ?? "").toLowerCase().includes(q) ||
      g.taskIds.some((id) => taskName(id).toLowerCase().includes(q))
    );
  });

  // Dialog: filter out already-selected and already-assigned employees
  const selectedIds = new Set(selectedEmployees.map((s) => s.user_id ?? s.id));
  const availableEmployees = (dialogEmployees ?? []).filter(
    (e) =>
      !allocatedUserIds.has(e.user_id ?? e.id) &&
      !selectedIds.has(e.user_id ?? e.id),
  );

  const handleSelectEmployee = (emp: EmployeeCompact) => {
    setSelectedEmployees((prev) => [
      ...prev,
      {
        id: emp.id,
        user_id: emp.user_id ?? undefined,
        name: `${emp.first_name} ${emp.last_name}`.trim(),
        department: emp.department_name ?? "-",
        emp_code: emp.emp_code,
        tab: dialogTab,
      },
    ]);
  };

  const handleRemoveSelected = (id: string) => {
    setSelectedEmployees((prev) =>
      prev.filter((s) => (s.user_id ?? s.id) !== id),
    );
  };

  const handleAddToProject = async () => {
    setAddTaskError(null);
    setAddConflict(null);
    if (assignScope === "tasks" && selectedTaskIds.length === 0) {
      setAddTaskError(
        "Select at least one task, or assign to the whole project.",
      );
      return;
    }

    const failures: string[] = [];
    for (const emp of selectedEmployees) {
      const isManager = emp.tab === "managers";
      const userId = emp.user_id ?? emp.id;
      try {
        await createResource({
          projectId,
          body: {
            user_id: userId,
            role: isManager ? "manager" : undefined,
            // [] = project level (all tasks)
            task_ids: assignScope === "tasks" ? selectedTaskIds : [],
            is_billable: true,
            allocation_percentage: 100,
          },
        }).unwrap();
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (hasErrorCode(err, "TSM-006")) {
          setAddTaskError(
            extractErrorMessage(
              err,
              "One of the selected tasks isn't linked to this project.",
            ),
          );
          return;
        }
        if (status === 409) {
          // Only a LIVE allocation conflicts — adding a removed person reopens
          // theirs instead of erroring, so this really is a duplicate.
          setAddConflict(
            `${emp.name} is already assigned to this project. Close this panel and use Edit on their row to change which tasks they cover.`,
          );
          return;
        }
        failures.push(emp.name);
        toast.error(err, `Failed to add ${emp.name}`);
      }
    }

    if (failures.length === selectedEmployees.length) return;
    toast.success(
      selectedEmployees.length - failures.length === 1
        ? "Resource added"
        : `${selectedEmployees.length - failures.length} resources added`,
    );
    setSelectedEmployees([]);
    setDialogSearch("");
    setAssignScope("project");
    setSelectedTaskIds([]);
    setAddDialogOpen(false);
  };

  const handleOpenEdit = (g: GroupedResource) => {
    const scope: "project" | "tasks" = g.isProjectLevel ? "project" : "tasks";
    setEditDialog({
      resourceId: g.anyRowId,
      userId: g.userId,
      userName: g.userName,
      role: MANAGER_ROLES.includes((g.role ?? "").toLowerCase())
        ? "manager"
        : "employee",
      billableRate: g.billableRate != null ? String(g.billableRate) : "",
      scope,
      taskIds: [...g.taskIds],
      initialScope: scope,
      initialTaskIds: [...g.taskIds],
      taskError: null,
    });
  };

  const handleSaveEdit = async () => {
    if (!editDialog) return;
    const d = editDialog;
    if (d.scope === "tasks" && d.taskIds.length === 0) {
      setEditDialog({
        ...d,
        taskError: "Select at least one task, or switch to the whole project.",
      });
      return;
    }

    // Only send task_ids when the selection actually changed — omitting it
    // leaves the task set untouched, sending [] would silently convert the
    // employee to project level.
    const scopeChanged = d.scope !== d.initialScope;
    const tasksChanged =
      d.scope === "tasks" && !sameIdSet(d.taskIds, d.initialTaskIds);
    const taskSelection: { task_ids?: string[] } =
      scopeChanged || tasksChanged
        ? { task_ids: d.scope === "project" ? [] : d.taskIds }
        : {};

    setIsSavingEdit(true);
    try {
      await updateResource({
        projectId,
        resourceId: d.resourceId,
        body: {
          ...taskSelection,
          // Manager → "manager"; employee has no role
          role: d.role === "manager" ? "manager" : null,
          billable_rate: d.billableRate ? Number(d.billableRate) : null,
        },
      }).unwrap();
      toast.success("Resource updated");
      setEditDialog(null);
    } catch (err) {
      if (hasErrorCode(err, "TSM-006")) {
        setEditDialog({
          ...d,
          taskError: extractErrorMessage(
            err,
            "One of the selected tasks isn't linked to this project.",
          ),
        });
        return;
      }
      toast.error(err, "Failed to update resource");
    } finally {
      setIsSavingEdit(false);
    }
  };

  /**
   * Ends the person's engagement on the project from a date. This is not a
   * delete: they keep logging time up to and including end_date, then the row
   * stays in the list marked removed and refuses further edits.
   *
   * One call is enough — removal closes the employee's whole allocation on the
   * project, every task row included — so this posts against any one of them.
   * Shortening an allocation is Update, not Remove.
   */
  const handleDelete = async (g: GroupedResource) => {
    const comment = deleteComment.trim();
    if (!comment || !deleteEndDate) return;
    try {
      await deleteResource({
        projectId,
        resourceId: g.anyRowId,
        comment,
        end_date: deleteEndDate,
      }).unwrap();
      toast.success(
        `${g.userName}'s allocation ends ${formatDate(deleteEndDate)}`,
      );
      setDeleteConfirm(null);
      setDeleteComment("");
      setDeleteEndDate(toLocalYMD(new Date()));
    } catch (err) {
      // TSM-037 — already removed; the row should not have offered the action
      toast.error(err, "Failed to remove resource");
    }
  };

  // Field-only edit — task_ids is deliberately absent so the task set is left as is
  const handleAllocationSave = async (
    g: GroupedResource,
    range: DateRange | undefined,
  ) => {
    try {
      await updateResource({
        projectId,
        resourceId: g.anyRowId,
        body: {
          start_date: range?.from ? toLocalYMD(range.from) : null,
          end_date: range?.to ? toLocalYMD(range.to) : null,
        },
      }).unwrap();
    } catch (err) {
      // TSM-037 — the allocation was closed; the row should not have offered
      // this. Refetch happens via tag invalidation on the next successful call.
      toast.error(err, "Failed to update allocation dates");
    }
  };

  const goToStep = (stepNum: number) => {
    if (stepNum === 1)
      navigate({
        to: "/timesheet/projects/$projectId/edit",
        params: { projectId },
      });
    else if (stepNum === 2)
      navigate({
        to: "/timesheet/projects/$projectId/tasks",
        params: { projectId },
      });
  };

  /**
   * Allocation used to stop at the project's end date, which put projects
   * finishing next year out of reach for anything longer. It now runs to the
   * same horizon the project Start/End Date fields use (5 years out, see
   * ProjectSetup), extended further if the project itself ends beyond that.
   */
  const allocationMaxDate = useMemo(() => {
    const fiveYearsOut = new Date(new Date().getFullYear() + 5, 11, 31);
    const projectEnd = project?.end_date
      ? new Date(project.end_date)
      : undefined;
    return projectEnd && projectEnd > fiveYearsOut ? projectEnd : fiveYearsOut;
  }, [project?.end_date]);

  // The year dropdown only appears when both nav bounds are known, and without
  // a floor react-day-picker falls back to today-100y. Projects missing a start
  // date get a one-year lookback instead of a century of options.
  const allocationMinMonth = useMemo(
    () =>
      project?.start_date
        ? new Date(project.start_date)
        : new Date(new Date().getFullYear() - 1, 0, 1),
    [project?.start_date],
  );

  const formatDate = (d?: string | null) => {
    if (!d) return "";
    return new Date(d)
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
      .replace(/ /g, "-");
  };

  if (projectNotFound) {
    return (
      <RecordNotFound
        entity="project"
        backLabel="Back to Projects"
        onBack={() => navigate({ to: "/timesheet/projects" })}
      />
    );
  }

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className="hover:text-foreground cursor-pointer"
          onClick={() => navigate({ to: "/timesheet/projects" })}
        >
          Timesheet
        </span>
        <span>/</span>
        <span className="text-foreground font-medium">Projects</span>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-foreground">
          {project?.name ?? "New Project"}
        </h1>
        {clientName && (
          <p className="text-sm text-muted-foreground mt-0.5">{clientName}</p>
        )}
      </div>

      {/* Stepper */}
      <ProjectStepper currentStep={3} projectId={projectId} />

      {/* Resources Table */}
      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar: search + role filter */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search"
              className="pl-9 h-9"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-1">
            {(["all", "managers", "employees"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRoleFilter(tab)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  roleFilter === tab
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {tab === "all"
                  ? "All"
                  : tab === "managers"
                    ? "Managers"
                    : "Employees"}
              </button>
            ))}
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Employee Name
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Assigned To
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Allocation
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Billing Role
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Billing Rate (Hourly)
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Exit Comment
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : (
              <>
                {filteredResources.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center py-8 text-muted-foreground"
                    >
                      No resources assigned yet.
                    </TableCell>
                  </TableRow>
                )}
                {filteredResources.map((g) => (
                  <TableRow
                    key={g.userId}
                    // Past its end date the row is history — mute it, but keep
                    // "ending" at full strength since they're still logging time
                    className={
                      g.allocationStatus === "removed"
                        ? "opacity-60 bg-muted/20"
                        : undefined
                    }
                  >
                    <TableCell className="font-medium">{g.userName}</TableCell>
                    <TableCell>
                      {g.isProjectLevel ? (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-pill bg-primary/10 text-primary">
                          <FolderOpen className="size-3" />
                          All Tasks
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {g.taskIds.map((id) => (
                            <span
                              key={id}
                              className="text-xs px-2 py-0.5 rounded-pill bg-muted text-foreground"
                            >
                              {taskName(id)}
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {editingId === g.userId ? (
                        <DateRangePicker
                          className="h-8 text-xs"
                          value={{
                            from: g.startDate
                              ? new Date(g.startDate)
                              : undefined,
                            to: g.endDate ? new Date(g.endDate) : undefined,
                          }}
                          onChange={(range) => handleAllocationSave(g, range)}
                          min={
                            project?.start_date
                              ? new Date(project.start_date)
                              : undefined
                          }
                          max={allocationMaxDate}
                          startMonth={allocationMinMonth}
                          endMonth={allocationMaxDate}
                          captionLayout="dropdown"
                          placeholder="Set dates"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEditingId(g.userId)}
                          disabled={g.allocationStatus !== "allocated"}
                          title={
                            g.allocationStatus !== "allocated"
                              ? "Removed allocations can't be edited"
                              : undefined
                          }
                          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground disabled:cursor-default"
                        >
                          <CalendarDays className="w-4 h-4" />
                          {/* Name the missing end of the range rather than
                              leaving a dangling dash */}
                          <span className="text-xs">
                            {g.startDate ? formatDate(g.startDate) : "Start"} –{" "}
                            {g.endDate ? formatDate(g.endDate) : "End"}
                          </span>
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {g.role ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {g.billableRate != null ? g.billableRate : "—"}
                    </TableCell>
                    <TableCell
                      className="text-sm text-muted-foreground max-w-[220px]"
                      title={g.removalComment ?? undefined}
                    >
                      {g.removalComment ? (
                        <span className="italic line-clamp-2">
                          "{g.removalComment}"
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {editingId === g.userId && (
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Done editing dates"
                          >
                            <Check />
                          </button>
                        )}
                        {/* A closed allocation is final — the API refuses both
                            calls with TSM-037, so don't offer them */}
                        <button
                          onClick={() => handleOpenEdit(g)}
                          disabled={g.allocationStatus !== "allocated"}
                          className="text-primary hover:text-primary/80 disabled:opacity-40 disabled:hover:text-primary"
                          title={
                            g.allocationStatus === "allocated"
                              ? "Edit assignment"
                              : "Removed allocations can't be edited — add them again to reopen"
                          }
                        >
                          <Pencil />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(g)}
                          disabled={g.allocationStatus !== "allocated"}
                          className="text-muted-foreground hover:text-destructive disabled:opacity-40 disabled:hover:text-muted-foreground"
                          title={
                            g.allocationStatus === "allocated"
                              ? "End allocation"
                              : "Already removed"
                          }
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            )}
          </TableBody>
        </Table>

        {/* Pagination — only when more than one page */}
        {(resourcesData?.total ?? 0) > pageSize && (
          <div className="flex items-center justify-end px-4 py-3 text-sm text-muted-foreground border-t">
            <TablePagination
              currentPage={page}
              totalPages={Math.max(
                1,
                Math.ceil((resourcesData?.total ?? 0) / pageSize),
              )}
              startIndex={(page - 1) * pageSize + 1}
              endIndex={Math.min(page * pageSize, resourcesData?.total ?? 0)}
              total={resourcesData?.total ?? 0}
              pageSize={pageSize}
              onPageChange={(p) => setPage(p)}
              onPageSizeChange={(s) => {
                setPageSize(s);
                setPage(1);
              }}
            />
          </div>
        )}

        {/* + Add Resource link */}
        <div className="px-4 py-3 border-t">
          <button
            onClick={() => {
              setSelectedEmployees([]);
              setDialogSearch("");
              setDialogTab("managers");
              setAssignScope("project");
              setSelectedTaskIds([]);
              setAddTaskError(null);
              setAddConflict(null);
              setAddDialogOpen(true);
            }}
            className="flex items-center gap-1 text-sm text-primary font-medium hover:text-primary/80"
          >
            <Plus />
            Add Resource
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => navigate({ to: "/timesheet/projects" })}
        >
          Cancel
        </Button>
        <Button
          onClick={() => {
            const isManager = (r: (typeof resources)[0]) =>
              MANAGER_ROLES.includes((r.role ?? "").toLowerCase());

            // Departments that have at least one manager assigned
            const managerDepts = new Set(
              resources
                .filter(isManager)
                .map((r) => (r.department ?? "").trim().toLowerCase()),
            );

            // Every unique department among the employees must have a manager
            const uncovered = new Map<string, string>();
            resources
              .filter((r) => !isManager(r))
              .forEach((r) => {
                const dept = (r.department ?? "").trim();
                if (!managerDepts.has(dept.toLowerCase())) {
                  uncovered.set(dept.toLowerCase(), dept || "Unassigned");
                }
              });

            if (uncovered.size > 0) {
              toast.error(
                `Please add at least one manager for L1 approvals in: ${[
                  ...uncovered.values(),
                ].join(", ")}.`,
              );
              return;
            }
            navigate({
              to: "/timesheet/projects/$projectId",
              params: { projectId },
            });
          }}
        >
          Save
        </Button>
      </div>

      {/* Add Resources Sheet */}
      <Sheet open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Add Resources</SheetTitle>
            <SheetDescription>
              Search and assign employees or managers to this project
            </SheetDescription>
          </SheetHeader>

          {/* Controls keep their natural height; the results list takes the
              rest of the sheet so the employee list fills the screen. */}
          <div
            ref={sheetScrollRef}
            className="flex-1 min-h-0 flex flex-col gap-5 px-6 py-4"
          >
            {/* Tabs */}
            <Tabs
              value={dialogTab}
              onValueChange={(v) => {
                setDialogTab(v as "managers" | "employees");
                setDialogSearch("");
                setDebouncedDialogSearch("");
                sheetScrollRef.current?.scrollTo({
                  top: 0,
                  behavior: "smooth",
                });
              }}
              className="shrink-0"
            >
              <TabsList>
                <TabsTrigger value="managers" className="gap-2">
                  <UserCog className="size-4" />
                  Managers
                </TabsTrigger>
                <TabsTrigger value="employees" className="gap-2">
                  <Users />
                  Employees
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Assign to the whole project, or to a set of tasks */}
            <TaskScopePicker
              scope={assignScope}
              taskIds={selectedTaskIds}
              tasks={projectTasks ?? []}
              projectName={project?.name}
              error={addTaskError}
              onScopeChange={(s) => {
                setAssignScope(s);
                setAddTaskError(null);
              }}
              onTaskIdsChange={(ids) => {
                setSelectedTaskIds(ids);
                setAddTaskError(null);
              }}
            />

            {addConflict && (
              <div className="shrink-0 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <AlertTriangle className="size-4 shrink-0 text-destructive mt-0.5" />
                <p className="text-xs text-destructive">{addConflict}</p>
              </div>
            )}

            {/* Search */}
            <div className="relative shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name"
                className="pl-9"
                value={dialogSearch}
                onChange={(e) => setDialogSearch(e.target.value)}
              />
            </div>

            {/* Selected Resources — capped so it can't crowd out the list */}
            {selectedEmployees.length > 0 && (
              <div className="shrink-0 border-t pt-4 max-h-[30%] overflow-y-auto">
                <p className="text-sm font-semibold text-foreground mb-3">
                  Selected Resources ({selectedEmployees.length})
                </p>
                <div className="flex flex-wrap gap-3">
                  {selectedEmployees.map((emp) => (
                    <div
                      key={emp.user_id ?? emp.id}
                      className="flex items-start gap-2 rounded-xl px-4 py-3 border border-border bg-primary/10"
                    >
                      <div className="w-8 h-8 rounded-full bg-muted-foreground/20 flex items-center justify-center text-xs font-semibold text-foreground">
                        {emp.name.charAt(0)}
                      </div>
                      <div className="text-sm">
                        <p className="font-medium text-foreground">
                          {emp.name}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {emp.tab}
                        </p>
                        {emp.emp_code && (
                          <p className="text-xs text-muted-foreground">
                            {emp.emp_code}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          handleRemoveSelected(emp.user_id ?? emp.id)
                        }
                        className="text-muted-foreground hover:text-foreground ml-1"
                      >
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <EmployeeSearchResults
              key={dialogTab}
              employees={availableEmployees}
              fetching={fetchingDialogEmployees}
              onSelect={handleSelectEmployee}
              isError={dialogSearchError}
              returningUserIds={releasedUserIds}
            />
          </div>

          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddToProject}
              disabled={selectedEmployees.length === 0 || isCreating}
            >
              {isCreating && <Loader2 className="animate-spin" />}
              Add
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirm Dialog */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirm(null);
            setDeleteComment("");
            setDeleteEndDate(toLocalYMD(new Date()));
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-5 text-warning" />
              <DialogTitle>End allocation</DialogTitle>
            </div>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteConfirm?.userName}'s allocation to{" "}
            {project?.name ?? "this project"} will close
            {deleteConfirm && !deleteConfirm.isProjectLevel
              ? `, across all ${deleteConfirm.rows.length} of their task assignments`
              : ""}
            . This can't be undone — to shorten their dates instead, use Edit.
          </p>

          <div className="space-y-2">
            <Label>
              Last working day <span className="text-destructive">*</span>
            </Label>
            <DatePicker
              value={deleteEndDate}
              onChange={setDeleteEndDate}
              min={project?.start_date?.slice(0, 10)}
              placeholder="Pick a date"
            />
            <p className="text-xs text-muted-foreground">
              They can log time up to and including this date.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delete-comment">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="delete-comment"
              className="resize-none min-h-[80px]"
              placeholder="e.g., rolling off the project"
              maxLength={1000}
              value={deleteComment}
              onChange={(e) => setDeleteComment(e.target.value)}
            />
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              disabled={!deleteComment.trim() || !deleteEndDate || isDeleting}
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
            >
              {isDeleting && <Loader2 className="animate-spin" />}
              End allocation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Assignment Dialog — applies to the employee's whole assignment */}
      <Dialog
        open={editDialog !== null}
        onOpenChange={(open) => {
          if (!open && !isSavingEdit) setEditDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Edit assignment — {editDialog?.userName}</DialogTitle>
          </DialogHeader>

          {editDialog && (
            <div className="space-y-4 py-2">
              {/* Update vs Remove: shortening someone's dates is an edit and
                  keeps the row live. Remove is the end-of-engagement action and
                  can't be undone. */}
              <p className="text-xs text-muted-foreground">
                To shorten their engagement, set the end date on the row rather
                than removing them — removal is final.
              </p>
              <TaskScopePicker
                scope={editDialog.scope}
                taskIds={editDialog.taskIds}
                tasks={projectTasks ?? []}
                projectName={project?.name}
                error={editDialog.taskError}
                onScopeChange={(s) =>
                  setEditDialog({ ...editDialog, scope: s, taskError: null })
                }
                onTaskIdsChange={(ids) =>
                  setEditDialog({
                    ...editDialog,
                    taskIds: ids,
                    taskError: null,
                  })
                }
              />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Billing Role</Label>
                  <Select
                    value={editDialog.role}
                    onValueChange={(v) =>
                      setEditDialog({
                        ...editDialog,
                        role: v as "manager" | "employee",
                      })
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="employee">Employee</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-rate">Billing Rate (Hourly)</Label>
                  <Input
                    id="edit-rate"
                    type="number"
                    min="0"
                    step="0.01"
                    className="h-9"
                    value={editDialog.billableRate}
                    onChange={(e) =>
                      setEditDialog({
                        ...editDialog,
                        billableRate: e.target.value,
                      })
                    }
                    placeholder="e.g., 75.00"
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                The billable flag on a timesheet entry comes from this
                assignment, not from the task.
              </p>
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isSavingEdit}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleSaveEdit} disabled={isSavingEdit}>
              {isSavingEdit && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/**
 * Whole-project vs specific-tasks picker. "Whole project" submits task_ids: [],
 * which the backend reads as "can log time against every task in the project".
 */
function TaskScopePicker({
  scope,
  taskIds,
  tasks,
  projectName,
  error,
  onScopeChange,
  onTaskIdsChange,
}: {
  scope: "project" | "tasks";
  taskIds: string[];
  tasks: ProjectTaskResponse[];
  projectName?: string;
  error: string | null;
  onScopeChange: (scope: "project" | "tasks") => void;
  onTaskIdsChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onTaskIdsChange(
      taskIds.includes(id) ? taskIds.filter((t) => t !== id) : [...taskIds, id],
    );

  return (
    <div className="space-y-2">
      <Label>Assign to</Label>
      <div className="space-y-2">
        {(
          [
            [
              "project",
              `Whole project${projectName ? ` — ${projectName}` : ""}`,
              "Can log time against every task in the project",
            ],
            [
              "tasks",
              "Specific tasks",
              "Can only log time against the tasks ticked below",
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={value}
            type="button"
            onClick={() => onScopeChange(value)}
            className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
              scope === value
                ? "border-primary/40 bg-primary/5"
                : "hover:bg-muted/50"
            }`}
          >
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>

      {scope === "tasks" && (
        <div
          className={`rounded-lg border max-h-48 overflow-y-auto divide-y ${
            error ? "border-destructive" : ""
          }`}
        >
          {tasks.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              This project has no tasks yet. Add tasks first, or assign to the
              whole project.
            </p>
          ) : (
            tasks.map((pt) => (
              <label
                key={pt.task_id}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50"
              >
                <Checkbox
                  checked={taskIds.includes(pt.task_id)}
                  onCheckedChange={() => toggle(pt.task_id)}
                />
                <span className="text-sm text-foreground">
                  {pt.task_name ?? pt.task?.name ?? pt.task_id}
                </span>
              </label>
            ))
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {scope === "tasks" && !error && taskIds.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {taskIds.length} task{taskIds.length === 1 ? "" : "s"} selected
        </p>
      )}
    </div>
  );
}

function EmployeeSearchResults({
  employees,
  fetching,
  onSelect,
  isError,
  returningUserIds,
}: {
  employees: EmployeeCompact[];
  fetching: boolean;
  onSelect: (emp: EmployeeCompact) => void;
  isError?: boolean;
  /** Previously removed from this project — adding them reopens the allocation */
  returningUserIds?: Set<string>;
}) {
  // Takes whatever height the sheet has left over, so the list fills the screen
  // instead of stopping at a fixed cap with dead space beneath it.
  if (fetching) {
    return (
      <div className="flex-1 min-h-0 flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 min-h-0 text-center py-8 text-sm text-destructive">
        Failed to search employees. Please try again.
      </div>
    );
  }

  if (employees.length === 0) {
    return (
      <div className="flex-1 min-h-0 text-center py-8 text-sm text-muted-foreground">
        No resources found.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 space-y-1 overflow-y-auto">
      {employees.map((emp) => (
        <button
          key={emp.id}
          type="button"
          className="w-full text-left px-3 py-2 rounded-xl hover:bg-muted flex items-center justify-between"
          onClick={() => onSelect(emp)}
        >
          <div>
            <p className="text-sm font-medium text-foreground">
              {emp.first_name} {emp.last_name}
              {returningUserIds?.has(emp.user_id ?? emp.id) && (
                <span className="ml-2 rounded-pill bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                  Previously on this project
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {[emp.emp_code, emp.department_name, emp.designation_name]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Plus className="w-4 h-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

export default ProjectResources;
