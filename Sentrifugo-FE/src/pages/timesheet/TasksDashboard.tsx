import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Loader2,
  Plus,
  Search,
  Pencil,
  Trash2,
  Download,
  Upload,
  FileSpreadsheet,
  AlertCircle,
  AlertTriangle,
  CheckSquare,
} from "lucide-react";
import {
  useGetTasksQuery,
  useCreateTaskMutation,
  useUpdateTaskMutation,
  useDeleteTaskMutation,
  useImportTasksMutation,
  useValidateTasksMutation,
} from "@/store/api/timesheetApi";
import type { TaskCreate, TaskResponse } from "@/types/timesheet";
import { toast, extractErrorMessage, hasErrorCode } from "@/lib/toast";
import { downloadAuthed } from "@/lib/download";
import { BulkImportDialog } from "@/components/shared/BulkImportDialog";
import type { BulkImportResult } from "@/components/shared/BulkImportDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const TasksDashboard = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const [addDialog, setAddDialog] = useState(false);
  const [editDialog, setEditDialog] = useState<TaskResponse | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<TaskResponse | null>(null);
  // Set when the backend refuses the delete (TSM-032 timesheets exist,
  // TSM-014 assigned to projects) — both non-retryable
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [newTask, setNewTask] = useState<TaskCreate>({
    name: "",
    description: "",
    is_billable: true,
    is_global: false,
  });

  const { data, isLoading } = useGetTasksQuery({
    page,
    page_size: pageSize,
    q: search || undefined,
    status: statusFilter,
  });
  const [createTask, { isLoading: isCreating }] = useCreateTaskMutation();
  const [updateTask, { isLoading: isUpdating }] = useUpdateTaskMutation();
  const [deleteTask] = useDeleteTaskMutation();
  const [importTasks] = useImportTasksMutation();
  const [validateTasks] = useValidateTasksMutation();

  const tasks = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = data ? Math.ceil(data.total / data.page_size) : 1;

  const filteredTasks =
    typeFilter === "all"
      ? tasks
      : tasks.filter((t) =>
          typeFilter === "billable" ? t.is_billable : !t.is_billable,
        );

  const handleCreate = async () => {
    if (!newTask.name.trim()) return;
    try {
      await createTask(newTask).unwrap();
      toast.success("Task created");
      setAddDialog(false);
      setNewTask({
        name: "",
        description: "",
        is_billable: true,
        is_global: false,
      });
    } catch (err) {
      // These are shared tasks, so the name must be unique across the org
      toast.error(err, "Failed to create task");
    }
  };

  const handleUpdate = async () => {
    if (!editDialog) return;
    try {
      await updateTask({
        id: editDialog.id,
        body: {
          name: editDialog.name,
          description: editDialog.description,
          is_billable: editDialog.is_billable,
          is_global: editDialog.is_global,
        },
      }).unwrap();
      toast.success("Task updated");
      setEditDialog(null);
    } catch (err) {
      toast.error(err, "Failed to update task");
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setIsDeleting(true);
    setDeleteBlocked(null);
    try {
      await deleteTask(deleteConfirm.id).unwrap();
      toast.success("Task deleted");
      setDeleteConfirm(null);
    } catch (err) {
      // TSM-032 (timesheets exist) / TSM-014 (assigned to projects). Neither can
      // be forced — show the reason in place of the prompt, leave the row alone.
      if (hasErrorCode(err, "TSM-032", "TSM-014")) {
        setDeleteBlocked(
          extractErrorMessage(
            err,
            "This task is in use and cannot be deleted.",
          ),
        );
        return;
      }
      toast.error(err, "Failed to delete task");
    } finally {
      setIsDeleting(false);
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

  const handleExport = async () => {
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}tasks/export`,
        `tasks_export_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
    } catch (err) {
      toast.error(err, "Export failed. Please try again.");
    }
  };

  const handleValidateTasks = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return validateTasks({ formData }).unwrap();
  };

  const handleImportTasks = async (file: File): Promise<BulkImportResult> => {
    const formData = new FormData();
    formData.append("file", file);
    return importTasks({ formData }).unwrap() as Promise<BulkImportResult>;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        subtitle="Shared tasks, available to every project. Tasks created inside a project belong to that project and are managed there."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Download />
              Import
            </Button>
            <Button variant="outline" onClick={handleExport}>
              <Upload />
              Export Data
            </Button>
            <Button onClick={() => setAddDialog(true)}>
              <Plus />
              Add Task
            </Button>
          </div>
        }
      />

      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search tasks..."
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={typeFilter}
            onValueChange={(v) => {
              setTypeFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="billable">Billable</SelectItem>
              <SelectItem value="non_billable">Non-Billable</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <PageLoader message="Loading tasks…" />
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            icon={CheckSquare}
            title="No tasks found"
            description="Add a task to get started."
            action={
              <Button onClick={() => setAddDialog(true)}>
                <Plus />
                Add Task
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Task Name
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Description
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Global
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-medium">{task.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {task.description || "-"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={task.is_billable ? "active" : "inactive"}
                        activeLabel="Billable"
                        inactiveLabel="Non-Billable"
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {task.is_global ? "Yes" : "No"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={
                          task.status === "active" ? "active" : "inactive"
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label="Edit task"
                          onClick={() => setEditDialog({ ...task })}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label="Delete task"
                          onClick={() => setDeleteConfirm(task)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TablePagination
              currentPage={page}
              totalPages={totalPages}
              startIndex={total === 0 ? 0 : (page - 1) * pageSize + 1}
              endIndex={Math.min(page * pageSize, total)}
              total={total}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(s) => {
                setPageSize(s);
                setPage(1);
              }}
            />
          </>
        )}
      </div>

      {/* Add Task Dialog */}
      <Dialog open={addDialog} onOpenChange={setAddDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>
                Task Name <span className="text-destructive">*</span>
              </Label>
              <Input
                value={newTask.name}
                onChange={(e) =>
                  setNewTask((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="Enter task name"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={newTask.description ?? ""}
                onChange={(e) =>
                  setNewTask((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                placeholder="Optional description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={newTask.is_billable ? "billable" : "non_billable"}
                  onValueChange={(v) =>
                    setNewTask((prev) => ({
                      ...prev,
                      is_billable: v === "billable",
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="billable">Billable</SelectItem>
                    <SelectItem value="non_billable">Non-Billable</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Global</Label>
                <Select
                  value={newTask.is_global ? "yes" : "no"}
                  onValueChange={(v) =>
                    setNewTask((prev) => ({ ...prev, is_global: v === "yes" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">No</SelectItem>
                    <SelectItem value="yes">Yes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              autoFocus
              onClick={handleCreate}
              disabled={!newTask.name.trim() || isCreating}
            >
              {isCreating && <Loader2 className="animate-spin" />}
              Add Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Task Dialog */}
      <Dialog open={!!editDialog} onOpenChange={() => setEditDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Task</DialogTitle>
          </DialogHeader>
          {editDialog && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>
                  Task Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={editDialog.name}
                  onChange={(e) =>
                    setEditDialog((prev) =>
                      prev ? { ...prev, name: e.target.value } : null,
                    )
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={editDialog.description ?? ""}
                  onChange={(e) =>
                    setEditDialog((prev) =>
                      prev ? { ...prev, description: e.target.value } : null,
                    )
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select
                    value={editDialog.is_billable ? "billable" : "non_billable"}
                    onValueChange={(v) =>
                      setEditDialog((prev) =>
                        prev
                          ? { ...prev, is_billable: v === "billable" }
                          : null,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="billable">Billable</SelectItem>
                      <SelectItem value="non_billable">Non-Billable</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Global</Label>
                  <Select
                    value={editDialog.is_global ? "yes" : "no"}
                    onValueChange={(v) =>
                      setEditDialog((prev) =>
                        prev ? { ...prev, is_global: v === "yes" } : null,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="no">No</SelectItem>
                      <SelectItem value="yes">Yes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              autoFocus
              onClick={handleUpdate}
              disabled={!editDialog?.name?.trim() || isUpdating}
            >
              {isUpdating && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteConfirm(null);
            setDeleteBlocked(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle
                className={`size-5 ${deleteBlocked ? "text-destructive" : "text-warning"}`}
              />
              <DialogTitle>
                {deleteBlocked ? "Task can't be deleted" : "Delete Task"}
              </DialogTitle>
            </div>
          </DialogHeader>
          {deleteBlocked ? (
            <p className="text-sm text-muted-foreground">{deleteBlocked}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete{" "}
              <strong>{deleteConfirm?.name}</strong>? This will fail if the task
              is assigned to any project or already used in a timesheet.
            </p>
          )}
          <DialogFooter>
            {deleteBlocked ? (
              // Non-retryable — no second attempt offered
              <DialogClose asChild>
                <Button autoFocus>Close</Button>
              </DialogClose>
            ) : (
              <>
                <DialogClose asChild>
                  <Button variant="outline" autoFocus disabled={isDeleting}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={handleDelete}
                  disabled={isDeleting}
                >
                  {isDeleting && (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  )}
                  Delete
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
        templateDescription="Fill in task name, billable flag, and description"
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

export default TasksDashboard;
