import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TablePagination } from "@/components/shared/TablePagination";
import { FileDropZone } from "@/components/shared/FileDropZone";
import {
  Loader2,
  Plus,
  Search,
  Download,
  Upload,
  FileSpreadsheet,
  AlertCircle,
  AlertTriangle,
  Pencil,
  Trash2,
  Check,
  ChevronDown,
} from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import {
  useGetProjectQuery,
  useGetProjectTasksQuery,
  useGetTasksQuery,
  useAssignProjectTaskMutation,
  useUpdateProjectTaskMutation,
  useRemoveProjectTaskMutation,
  useImportTasksMutation,
  useValidateTasksMutation,
} from "@/store/api/timesheetApi";
import type { ValidateRow } from "@/store/api/timesheetApi";
import { toast, extractErrorMessage, hasErrorCode } from "@/lib/toast";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  TaskCreate,
  TaskResponse,
  ProjectTaskResponse,
} from "@/types/timesheet";
import { downloadAuthed } from "@/lib/download";
import { ProjectStepper } from "@/components/shared/ProjectStepper";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { BulkImportDialog } from "@/components/shared/BulkImportDialog";
import type { BulkImportResult } from "@/components/shared/BulkImportDialog";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const ProjectTasks = () => {
  const navigate = useNavigate();
  const { projectId } = useParams({ strict: false }) as { projectId: string };

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 400);
  }, []);

  const { data: project, error: projectError } = useGetProjectQuery(projectId);
  // Projects are scoped to the caller — a 404 means deleted or not yours
  const projectNotFound =
    (projectError as { status?: number } | undefined)?.status === 404;

  // Topbar breadcrumb leaf: Timesheet › Projects › <this>. Step 2 of the same
  // wizard as Project Setup, so it names the project the same way.
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch(setBreadcrumbDetail(project?.name ?? "Tasks"));
    return () => {
      dispatch(setBreadcrumbDetail(null));
    };
  }, [dispatch, project?.name]);

  const { data: projectTasks, isLoading: loadingTasks } =
    useGetProjectTasksQuery({ projectId, q: debouncedSearch || undefined });
  const { data: frequentTasksData, refetch: refetchFrequentTasks } =
    useGetTasksQuery({
      page: 1,
      page_size: 200,
      status: "active",
      is_frequent: true,
    });
  const frequentTasks = frequentTasksData?.items ?? [];

  const [assignTask] = useAssignProjectTaskMutation();
  const [updateProjectTask] = useUpdateProjectTaskMutation();
  const [removeTask] = useRemoveProjectTaskMutation();
  // No POST /tasks here any more — the project endpoint creates and links in one call
  const [importTasks, { isLoading: isImporting }] = useImportTasksMutation();
  const [validateTasks, { isLoading: isValidating }] =
    useValidateTasksMutation();

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [addTaskDialog, setAddTaskDialog] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [importOpen, setImportOpen] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<{
    taskId: string;
    name: string;
  } | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  // Set when the backend refuses the removal (TSM-033) — non-retryable
  const [removeBlocked, setRemoveBlocked] = useState<string | null>(null);

  const [addTaskTab, setAddTaskTab] = useState<"new" | "frequent">("new");
  const [newTask, setNewTask] = useState<TaskCreate>({
    name: "",
    description: "",
    is_billable: true,
    is_global: false,
  });
  const [taskEstimatedHours, setTaskEstimatedHours] = useState("");
  const [taskBillableRate, setTaskBillableRate] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [frequentTaskName, setFrequentTaskName] = useState("");
  const [selectedFrequentTask, setSelectedFrequentTask] =
    useState<TaskResponse | null>(null);
  const [frequentComboOpen, setFrequentComboOpen] = useState(false);
  const [addTaskErrors, setAddTaskErrors] = useState<Record<string, string>>(
    {},
  );
  const [isAddingTask, setIsAddingTask] = useState(false);

  useEffect(() => {
    if (selectedFrequentTask) {
      setTaskNotes(
        selectedFrequentTask.notes ?? selectedFrequentTask.description ?? "",
      );
      setTaskEstimatedHours(
        selectedFrequentTask.estimated_hours != null
          ? String(selectedFrequentTask.estimated_hours)
          : "",
      );
      setTaskBillableRate(
        selectedFrequentTask.billable_rate != null
          ? String(selectedFrequentTask.billable_rate)
          : "",
      );
      setNewTask((prev) => ({
        ...prev,
        is_billable: selectedFrequentTask.is_billable,
      }));
    }
  }, [selectedFrequentTask]);

  // Mirrors the New Task form: name + description + hours/rate + billable.
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    taskId: string;
    taskName: string;
    name: string;
    is_billable: boolean;
    estimated_hours: string;
    billable_rate: string;
    notes: string;
  }>({
    open: false,
    taskId: "",
    taskName: "",
    name: "",
    is_billable: true,
    estimated_hours: "",
    billable_rate: "",
    notes: "",
  });
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const openEditDialog = (pt: ProjectTaskResponse) => {
    setEditErrors({});
    const name = pt.task_name ?? pt.task?.name ?? pt.task_id;
    setEditDialog({
      open: true,
      taskId: pt.task_id,
      taskName: name,
      name,
      is_billable: pt.is_billable ?? pt.task?.is_billable ?? true,
      estimated_hours:
        pt.estimated_hours != null ? String(pt.estimated_hours) : "",
      billable_rate: pt.billable_rate != null ? String(pt.billable_rate) : "",
      notes: pt.notes ?? "",
    });
  };

  const handleEditSave = async () => {
    const errs: Record<string, string> = {};
    const name = editDialog.name.trim();
    if (!name) errs.name = "Task name is required";
    else if (name.length > 255) errs.name = "Max 255 characters";
    if (!editDialog.notes.trim()) errs.description = "Description is required";
    setEditErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setIsSavingEdit(true);
    try {
      await updateProjectTask({
        projectId,
        taskId: editDialog.taskId,
        body: {
          name,
          is_billable: editDialog.is_billable,
          estimated_hours: editDialog.estimated_hours
            ? Number(editDialog.estimated_hours)
            : null,
          billable_rate: editDialog.billable_rate
            ? Number(editDialog.billable_rate)
            : null,
          notes: editDialog.notes.trim(),
        },
      }).unwrap();
      toast.success("Task updated");
      // ProjectTask + Task tags are invalidated, so the reopened dialog reads
      // the canonical values straight from the refetched list
      setEditDialog((prev) => ({ ...prev, open: false }));
    } catch (err) {
      // 409 is a name clash, so it belongs on the field. The endpoint can also
      // 409 when is_global/is_frequent promote a project-owned task to shared
      // and the name is taken organisation-wide — this dialog never sends those
      // flags, but the handler covers it if they're ever added here.
      if ((err as { status?: number })?.status === 409) {
        setEditErrors({
          name: extractErrorMessage(err, "Task with this name already exists"),
        });
        return;
      }
      toast.error(err, "Failed to update task");
    } finally {
      setIsSavingEdit(false);
    }
  };

  const tasks = projectTasks ?? [];

  const filteredTasks = tasks.filter((pt) => {
    const isBillable = pt.is_billable ?? true;
    const matchesType =
      typeFilter === "all" ||
      (typeFilter === "billable" && isBillable) ||
      (typeFilter === "non_billable" && !isBillable);
    return matchesType;
  });

  const totalItems = filteredTasks.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedTasks = filteredTasks.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, totalItems);

  const resetAddTaskForm = () => {
    setAddTaskTab("new");
    setNewTask({
      name: "",
      description: "",
      is_billable: true,
      is_global: false,
    });
    setTaskEstimatedHours("");
    setTaskBillableRate("");
    setTaskNotes("");
    setFrequentTaskName("");
    setSelectedFrequentTask(null);
    setFrequentComboOpen(false);
    setAddTaskErrors({});
  };

  const handleAddTask = async () => {
    const errs: Record<string, string> = {};
    if (addTaskTab === "frequent") {
      if (!frequentTaskName.trim()) errs.name = "Task Name is required";
    } else {
      if (!newTask.name.trim()) errs.name = "Task Name is required";
    }
    if (!taskNotes.trim()) errs.description = "Description is required";
    setAddTaskErrors(errs);
    if (Object.keys(errs).length > 0) return;
    // Shared numeric fields — the endpoint takes them for both shapes
    const perProject = {
      estimated_hours: taskEstimatedHours ? Number(taskEstimatedHours) : null,
      billable_rate: taskBillableRate ? Number(taskBillableRate) : null,
      notes: taskNotes || null,
    };

    setIsAddingTask(true);
    try {
      if (addTaskTab === "frequent" && selectedFrequentTask) {
        // Picked from the shared/frequent list → link it
        await assignTask({
          projectId,
          body: { task_id: selectedFrequentTask.id, ...perProject },
        }).unwrap();
      } else {
        // Create in one call. A plain task belongs to this project, so another
        // project may already use the name; ticking global/frequent makes it a
        // shared task and brings back organisation-wide name uniqueness.
        const isFrequent = addTaskTab === "frequent";
        await assignTask({
          projectId,
          body: {
            name: isFrequent ? frequentTaskName.trim() : newTask.name.trim(),
            description: newTask.description || null,
            is_billable: newTask.is_billable,
            is_global: newTask.is_global,
            is_frequent: isFrequent,
            ...perProject,
          },
        }).unwrap();
        if (isFrequent || newTask.is_global) refetchFrequentTasks();
      }
      toast.success("Task added to project");
      setAddTaskDialog(false);
      resetAddTaskForm();
    } catch (err) {
      // 409 is now only possible against a shared task or another task in THIS
      // project — a name another project owns is fine. When the clash comes
      // from making the task shared, say so; that's the part users won't guess.
      if ((err as { status?: number })?.status === 409) {
        const detail = extractErrorMessage(
          err,
          "A task with this name already exists",
        );
        const madeShared = addTaskTab === "frequent" || newTask.is_global;
        setAddTaskErrors({
          name: madeShared
            ? `${detail} Frequently-used and global tasks are shared across the organisation, so their names must be unique. Add it as a normal task to keep it to this project.`
            : detail,
        });
        return;
      }
      toast.error(err, "Failed to add task");
    } finally {
      setIsAddingTask(false);
    }
  };

  const handleRemoveTask = async () => {
    if (!removeConfirm) return;
    setIsRemoving(true);
    setRemoveBlocked(null);
    try {
      await removeTask({ projectId, taskId: removeConfirm.taskId }).unwrap();
      toast.success("Task removed from project");
      setRemoveConfirm(null);
    } catch (err) {
      // TSM-033: timesheets already logged against this task. Non-retryable —
      // show the reason in place of the confirm prompt, leave the row alone.
      if (hasErrorCode(err, "TSM-033")) {
        setRemoveBlocked(
          extractErrorMessage(
            err,
            "This task is used by existing timesheets and cannot be removed.",
          ),
        );
        return;
      }
      toast.error(err, "Failed to remove task from project");
    } finally {
      setIsRemoving(false);
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}tasks/template`,
        "task_import_template.xlsx",
      );
    } catch (err) {
      toast.error(err, "Couldn't download the template. Please try again.");
    }
  };

  const handleExportTasks = async () => {
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}projects/${projectId}/tasks/export`,
        "project_tasks_export.xlsx",
      );
    } catch (err) {
      toast.error(err, "Export failed. Please try again.");
    }
  };

  const handleValidateTasks = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return validateTasks({ formData, projectId }).unwrap();
  };

  const handleImportTasks = async (file: File): Promise<BulkImportResult> => {
    const formData = new FormData();
    formData.append("file", file);
    return importTasks({
      formData,
      projectId,
    }).unwrap() as Promise<BulkImportResult>;
  };

  const goToStep = (stepNum: number) => {
    if (stepNum === 1)
      navigate({
        to: "/timesheet/projects/$projectId/edit",
        params: { projectId },
      });
    else if (stepNum === 3)
      navigate({
        to: "/timesheet/projects/$projectId/resources",
        params: { projectId },
      });
  };

  const handleSaveAndNext = () => {
    navigate({
      to: "/timesheet/projects/$projectId/resources",
      params: { projectId },
    });
  };

  const currencySymbol =
    project?.currency === "INR"
      ? "₹"
      : project?.currency === "EUR"
        ? "€"
        : project?.currency === "GBP"
          ? "£"
          : `${project?.currency} `;

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
    <div className="space-y-6 max-w-6xl mx-auto">
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

      {/* Stepper */}
      <ProjectStepper currentStep={2} projectId={projectId} />

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search Tasks"
            className="pl-9"
            value={searchQuery}
            onChange={(e) => {
              handleSearchChange(e.target.value);
              setCurrentPage(1);
            }}
          />
        </div>
        <Select
          value={typeFilter}
          onValueChange={(v) => {
            setTypeFilter(v);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All Tasks" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tasks</SelectItem>
            <SelectItem value="billable">Billable</SelectItem>
            <SelectItem value="non_billable">Non-Billable</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Download />
          Import Tasks
        </Button>
        <Button variant="outline" onClick={handleExportTasks}>
          <Upload />
          Export Data
        </Button>
        <Button onClick={() => setAddTaskDialog(true)}>
          <Plus />
          Add Task
        </Button>
      </div>

      {/* Tasks Table */}
      <div className="rounded-xl border overflow-x-auto bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Task
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Estimated Hours
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Billable Rate
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Type
              </TableHead>
              <TableHead className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadingTasks ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12">
                  <Loader2 className="size-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : paginatedTasks.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-12 text-muted-foreground text-sm"
                >
                  No tasks found. Click "Add Task" to create one.
                </TableCell>
              </TableRow>
            ) : (
              paginatedTasks.map((pt) => {
                const task = pt.task;
                return (
                  <TableRow key={pt._id}>
                    <TableCell className="font-medium text-sm">
                      {pt.task_name ?? task?.name ?? pt.task_id}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {pt.estimated_hours ? `${pt.estimated_hours} hrs` : "-"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {pt.billable_rate
                        ? `${currencySymbol}${pt.billable_rate}`
                        : "-"}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs px-2 py-0.5 rounded-pill bg-muted text-foreground">
                          {pt.is_billable ? "Billable" : "Non-Billable"}
                        </span>
                        {pt.is_time_off && (
                          <span className="text-xs px-2 py-0.5 rounded-pill bg-info/10 text-info">
                            Time Off
                          </span>
                        )}
                        {pt.is_global && (
                          <span className="text-xs px-2 py-0.5 rounded-pill bg-primary/10 text-primary">
                            Global
                          </span>
                        )}
                        {pt.is_frequent && (
                          <span className="text-xs px-2 py-0.5 rounded-pill bg-success/10 text-success">
                            Frequent
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => openEditDialog(pt)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() =>
                            setRemoveConfirm({
                              taskId: pt.task_id,
                              name: pt.task_name ?? task?.name ?? "this task",
                            })
                          }
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        {totalItems > 0 && (
          <TablePagination
            currentPage={safePage}
            totalPages={totalPages}
            startIndex={startIndex}
            endIndex={endIndex}
            total={totalItems}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setCurrentPage(1);
            }}
          />
        )}
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
          variant="outline"
          onClick={() =>
            navigate({
              to: "/timesheet/projects/$projectId",
              params: { projectId },
            })
          }
        >
          Save
        </Button>
        <Button onClick={handleSaveAndNext}>Save &amp; Next</Button>
      </div>

      {/* Add Task Dialog */}
      <Dialog
        open={addTaskDialog}
        onOpenChange={(open) => {
          setAddTaskDialog(open);
          if (!open) resetAddTaskForm();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Task</DialogTitle>
          </DialogHeader>

          {/* Tabs */}
          <div className="flex border-b">
            <button
              type="button"
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                addTaskTab === "new"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setAddTaskTab("new")}
            >
              New Task
            </button>
            <button
              type="button"
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                addTaskTab === "frequent"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setAddTaskTab("frequent")}
            >
              Frequently Used Tasks
            </button>
          </div>

          <div className="space-y-4 py-2">
            {addTaskTab === "new" ? (
              <>
                <p className="text-base font-semibold text-foreground">
                  New Task
                </p>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Task Name <span className="text-destructive">*</span>
                  </label>
                  <Input
                    value={newTask.name}
                    onChange={(e) => {
                      setNewTask((prev) => ({ ...prev, name: e.target.value }));
                      setAddTaskErrors((prev) => {
                        const { name: _, ...rest } = prev;
                        return rest;
                      });
                    }}
                    placeholder="e.g., Develop new user authentication"
                    className={addTaskErrors.name ? "border-destructive" : ""}
                  />
                  {addTaskErrors.name && (
                    <p className="text-sm text-destructive">
                      {addTaskErrors.name}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Description <span className="text-destructive">*</span>
                  </label>
                  <Textarea
                    value={taskNotes}
                    onChange={(e) => {
                      setTaskNotes(e.target.value);
                      setAddTaskErrors((prev) => {
                        const { description: _, ...rest } = prev;
                        return rest;
                      });
                    }}
                    placeholder="Add any specific instructions or details..."
                    className={`resize-none min-h-[80px] ${addTaskErrors.description ? "border-destructive" : ""}`}
                    rows={3}
                  />
                  {addTaskErrors.description && (
                    <p className="text-sm text-destructive">
                      {addTaskErrors.description}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">
                      Estimated Hours{" "}
                      <span className="text-muted-foreground">(Optional)</span>
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={taskEstimatedHours}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                        setTaskEstimatedHours(raw);
                      }}
                      placeholder="e.g., 8"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">
                      Billable Rate{" "}
                      <span className="text-muted-foreground">(Optional)</span>
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={taskBillableRate}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                        setTaskBillableRate(raw);
                      }}
                      placeholder="e.g., 75.00"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">
                    Billable
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setNewTask((prev) => ({
                        ...prev,
                        is_billable: !prev.is_billable,
                      }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${newTask.is_billable ? "bg-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${newTask.is_billable ? "translate-x-6" : "translate-x-1"}`}
                    />
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-base font-semibold text-foreground">
                  Frequently Used Tasks
                </p>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Task Name <span className="text-destructive">*</span>
                  </label>
                  <div className="relative">
                    <div
                      className={`flex items-center border rounded-md px-3 h-9 bg-transparent ${addTaskErrors.name ? "border-destructive" : "border-input"}`}
                    >
                      <input
                        value={frequentTaskName}
                        onFocus={() => setFrequentComboOpen(true)}
                        onChange={(e) => {
                          setFrequentTaskName(e.target.value);
                          setSelectedFrequentTask(null);
                          setFrequentComboOpen(true);
                          setAddTaskErrors((prev) => {
                            const { name: _, ...rest } = prev;
                            return rest;
                          });
                        }}
                        onBlur={() =>
                          setTimeout(() => setFrequentComboOpen(false), 150)
                        }
                        placeholder="e.g., Code Review, Design..."
                        className="flex-1 text-sm bg-transparent outline-none"
                      />
                      <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                    </div>
                    {frequentComboOpen && (
                      <div className="absolute z-50 w-full mt-1 border rounded-md bg-popover text-popover-foreground shadow-md">
                        <div className="max-h-48 overflow-y-auto p-1">
                          {frequentTasks.filter(
                            (t) =>
                              !frequentTaskName ||
                              t.name
                                .toLowerCase()
                                .includes(frequentTaskName.toLowerCase()),
                          ).length === 0 ? (
                            <p className="text-sm text-muted-foreground px-2 py-3 text-center">
                              {frequentTaskName
                                ? `"${frequentTaskName}" will be created as a new frequent task`
                                : "No frequently used tasks yet"}
                            </p>
                          ) : (
                            frequentTasks
                              .filter(
                                (t) =>
                                  !frequentTaskName ||
                                  t.name
                                    .toLowerCase()
                                    .includes(frequentTaskName.toLowerCase()),
                              )
                              .map((t) => (
                                <button
                                  key={t.id}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    setFrequentTaskName(t.name);
                                    setSelectedFrequentTask(t);
                                    setFrequentComboOpen(false);
                                    setAddTaskErrors((prev) => {
                                      const { name: _, ...rest } = prev;
                                      return rest;
                                    });
                                  }}
                                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-muted text-left"
                                >
                                  <span>{t.name}</span>
                                  {selectedFrequentTask?.id === t.id && (
                                    <Check className="size-3.5 text-primary shrink-0" />
                                  )}
                                </button>
                              ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {addTaskErrors.name && (
                    <p className="text-sm text-destructive">
                      {addTaskErrors.name}
                    </p>
                  )}
                  {selectedFrequentTask ? (
                    <p className="text-xs text-muted-foreground">
                      Existing frequent task selected — will be assigned
                      directly.
                    </p>
                  ) : frequentTaskName.trim() ? (
                    <p className="text-xs text-muted-foreground">
                      No match — will be saved as a new frequently used task.
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Description <span className="text-destructive">*</span>
                  </label>
                  <Textarea
                    value={taskNotes}
                    onChange={(e) => {
                      setTaskNotes(e.target.value);
                      setAddTaskErrors((prev) => {
                        const { description: _, ...rest } = prev;
                        return rest;
                      });
                    }}
                    placeholder="Add any specific details..."
                    className={`resize-none min-h-[80px] ${addTaskErrors.description ? "border-destructive" : ""}`}
                    rows={2}
                  />
                  {addTaskErrors.description && (
                    <p className="text-sm text-destructive">
                      {addTaskErrors.description}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">
                      Estimated Hours{" "}
                      <span className="text-muted-foreground">(Optional)</span>
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={taskEstimatedHours}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                        setTaskEstimatedHours(raw);
                      }}
                      placeholder="e.g., 8"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">
                      Billable Rate{" "}
                      <span className="text-muted-foreground">(Optional)</span>
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={taskBillableRate}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                        setTaskBillableRate(raw);
                      }}
                      placeholder="e.g., 75.00"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">
                    Billable
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setNewTask((prev) => ({
                        ...prev,
                        is_billable: !prev.is_billable,
                      }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${newTask.is_billable ? "bg-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${newTask.is_billable ? "translate-x-6" : "translate-x-1"}`}
                    />
                  </button>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleAddTask} disabled={isAddingTask}>
              {isAddingTask && <Loader2 className="animate-spin" />}
              Add Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Project Task Dialog */}
      <Dialog
        open={editDialog.open}
        onOpenChange={(open) => setEditDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Task — {editDialog.taskName}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Task Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={editDialog.name}
                onChange={(e) => {
                  setEditDialog((prev) => ({ ...prev, name: e.target.value }));
                  setEditErrors((prev) => {
                    const { name: _, ...rest } = prev;
                    return rest;
                  });
                }}
                maxLength={255}
                placeholder="e.g., Develop new user authentication"
                className={editErrors.name ? "border-destructive" : ""}
              />
              {editErrors.name && (
                <p className="text-sm text-destructive">{editErrors.name}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Description <span className="text-destructive">*</span>
              </label>
              <Textarea
                value={editDialog.notes}
                onChange={(e) => {
                  setEditDialog((prev) => ({ ...prev, notes: e.target.value }));
                  setEditErrors((prev) => {
                    const { description: _, ...rest } = prev;
                    return rest;
                  });
                }}
                placeholder="Add any specific instructions or details..."
                className={`resize-none min-h-[80px] ${editErrors.description ? "border-destructive" : ""}`}
                rows={3}
              />
              {editErrors.description && (
                <p className="text-sm text-destructive">
                  {editErrors.description}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Estimated Hours{" "}
                  <span className="text-muted-foreground">(Optional)</span>
                </label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editDialog.estimated_hours}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                    setEditDialog((prev) => ({
                      ...prev,
                      estimated_hours: raw,
                    }));
                  }}
                  placeholder="e.g., 8"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Billable Rate{" "}
                  <span className="text-muted-foreground">(Optional)</span>
                </label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editDialog.billable_rate}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                    setEditDialog((prev) => ({ ...prev, billable_rate: raw }));
                  }}
                  placeholder="e.g., 75.00"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                Billable
              </label>
              <button
                type="button"
                role="switch"
                aria-checked={editDialog.is_billable}
                onClick={() =>
                  setEditDialog((prev) => ({
                    ...prev,
                    is_billable: !prev.is_billable,
                  }))
                }
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${editDialog.is_billable ? "bg-primary" : "bg-muted"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${editDialog.is_billable ? "translate-x-6" : "translate-x-1"}`}
                />
              </button>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isSavingEdit}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleEditSave} disabled={isSavingEdit}>
              {isSavingEdit && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Task confirmation */}
      <Dialog
        open={removeConfirm !== null}
        onOpenChange={(open) => {
          if (!open && !isRemoving) {
            setRemoveConfirm(null);
            setRemoveBlocked(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle
                className={`size-5 ${removeBlocked ? "text-destructive" : "text-warning"}`}
              />
              <DialogTitle>
                {removeBlocked
                  ? "Task can't be removed"
                  : "Remove task from project?"}
              </DialogTitle>
            </div>
          </DialogHeader>
          {removeBlocked ? (
            <p className="text-sm text-muted-foreground">{removeBlocked}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              "{removeConfirm?.name}" will no longer be available for time entry
              on {project?.name ?? "this project"}. Tasks already used in a
              submitted timesheet cannot be removed.
            </p>
          )}
          <DialogFooter>
            {removeBlocked ? (
              // Non-retryable — no second attempt offered
              <DialogClose asChild>
                <Button autoFocus>Close</Button>
              </DialogClose>
            ) : (
              <>
                <DialogClose asChild>
                  <Button variant="outline" autoFocus disabled={isRemoving}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={handleRemoveTask}
                  disabled={isRemoving}
                >
                  {isRemoving && (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  )}
                  Remove
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        entityName="Tasks"
        templateLabel="Task Template"
        templateDescription="Fill in task name and billable flag"
        buildSections={(result) => [
          {
            label: "",
            rows: result.rows,
            total: result.total,
            columns: [
              { key: "name", label: "Task Name" },
              { key: "is_billable", label: "Billable" },
            ],
          },
        ]}
        onDownloadTemplate={handleDownloadTemplate}
        onValidate={handleValidateTasks}
        onImport={handleImportTasks}
      />
    </div>
  );
};

export default ProjectTasks;
