import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Search,
  Download,
  Pencil,
  Trash2,
  FolderKanban,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  useGetProjectsQuery,
  useDeleteProjectMutation,
  useGetClientsQuery,
  useImportProjectsMutation,
  useValidateProjectsMutation,
} from "@/store/api/timesheetApi";
import { toast } from "@/lib/toast";
import { downloadAuthed } from "@/lib/download";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { usePagedSelect } from "./usePagedSelect";
import type { ClientResponse } from "@/types/timesheet";
import { BulkImportDialog } from "@/components/shared/BulkImportDialog";
import type { BulkImportResult } from "@/components/shared/BulkImportDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import ProjectSetup from "./ProjectSetup";
import ProjectDetail from "./ProjectDetail";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const projectStatusVariant = (status: string) => {
  const map: Record<string, "active" | "inactive" | "inprogress" | "pending"> =
    {
      active: "active",
      inactive: "inactive",
      completed: "inprogress",
      on_hold: "pending",
    };
  return map[status] ?? "inactive";
};

const typeLabels: Record<string, string> = {
  time_and_materials: "Time & Materials",
  fixed_fee: "Fixed Fee",
  non_billable: "Non-Billable",
};

const formatDate = (d?: string | null) => {
  if (!d) return "-";
  const date = new Date(d);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${String(date.getDate()).padStart(2, "0")} ${months[date.getMonth()]} ${date.getFullYear()}`;
};

const ProjectDashboard = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [setupSheetOpen, setSetupSheetOpen] = useState(false);
  const [, setSetupEditId] = useState<string | undefined>(undefined);
  const [detailSheetId, setDetailSheetId] = useState<string | null>(null);

  const { data, isLoading } = useGetProjectsQuery({
    page,
    page_size: pageSize,
    q: search || undefined,
    status: statusFilter,
    client_id: clientFilter !== "all" ? clientFilter : undefined,
    project_type: typeFilter !== "all" ? typeFilter : undefined,
  });
  /**
   * Client filter options, paged and searched server-side.
   *
   * Was a flat `page_size: 100` fetch on every page load, which both hid the
   * 101st client from the filter and pulled the whole list down to render a
   * dropdown most people never open. 20 at a time, more on scroll, and the
   * search box queries the API rather than filtering what happened to load.
   */
  const clientPicker = usePagedSelect<ClientResponse>({
    useQuery: useGetClientsQuery,
    args: { status: "all" },
    toOption: (c) => ({ label: c.name, value: c.id }),
    pageSize: 20,
  });
  const [deleteProject] = useDeleteProjectMutation();
  const [importProjects] = useImportProjectsMutation();
  const [validateProjects] = useValidateProjectsMutation();

  const projects = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasActiveFilters =
    Boolean(search) ||
    statusFilter !== "active" ||
    clientFilter !== "all" ||
    typeFilter !== "all";

  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id).unwrap();
      toast.success("Project deleted");
      setDeleteConfirm(null);
    } catch (err) {
      toast.error(err, "Failed to delete project");
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}projects/template`,
        "project_import_template.xlsx",
      );
    } catch (err) {
      toast.error(err, "Couldn't download the template. Please try again.");
    }
  };

  const handleValidateProjects = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return validateProjects(formData).unwrap();
  };

  const handleImportProjects = async (
    file: File,
  ): Promise<BulkImportResult> => {
    const formData = new FormData();
    formData.append("file", file);
    return importProjects(formData).unwrap() as Promise<BulkImportResult>;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        subtitle="View and manage all projects"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Download />
              Import
            </Button>
            <Button
              onClick={() => {
                setSetupEditId(undefined);
                setSetupSheetOpen(true);
              }}
            >
              <Plus />
              Add Project
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
              placeholder="Search projects..."
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <SearchableSelect
            {...clientPicker.selectProps}
            // "All Clients" is a filter state, not a client, so it's prepended
            // rather than coming from the endpoint — and it has to survive
            // every page and search the picker loads.
            options={[
              { label: "All Clients", value: "all" },
              ...clientPicker.selectProps.options,
            ]}
            value={clientFilter}
            onChange={(v) => {
              setClientFilter(v as string);
              setPage(1);
            }}
            placeholder="All Clients"
            // No ✕: "All Clients" IS the cleared state, so clearing would only
            // leave the filter with no value at all.
            clearable={false}
            className="w-56"
          />
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
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="time_and_materials">
                Time & Materials
              </SelectItem>
              <SelectItem value="fixed_fee">Fixed Fee</SelectItem>
              <SelectItem value="non_billable">Non-Billable</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <PageLoader message="Loading projects…" />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={
              hasActiveFilters ? "No projects found" : "No projects assigned"
            }
            description={
              hasActiveFilters
                ? "No projects match the current filters."
                : // The list is scoped to the caller: non-admins only see projects
                  // they head, created, or manage as a resource.
                  "You'll see a project here once you're its project head, its creator, or assigned to it as a manager. Add one to get started."
            }
            action={
              <Button
                onClick={() => {
                  setSetupEditId(undefined);
                  setSetupSheetOpen(true);
                }}
              >
                <Plus />
                Add Project
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Project Name
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Client
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Project Head
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Start Date
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    End Date
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Currency
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <ContextMenu key={project.id}>
                    <ContextMenuTrigger asChild>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setDetailSheetId(project.id)}
                      >
                        <TableCell className="font-medium">
                          {project.name}
                        </TableCell>
                        {/* Names come denormalised on the project itself, so
                            the table paints from /projects alone. The old
                            id→name maps were also built from list endpoints
                            scoped to what the caller owns, which couldn't
                            cover every project they can see. */}
                        <TableCell className="text-muted-foreground">
                          {project.client_name ?? "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {/* Rendered as-is: a head whose IAM record is gone is
                              dropped from names, so it can be shorter than ids
                              and the two must not be zipped. */}
                          {project.project_head_names?.length
                            ? project.project_head_names.join(", ")
                            : "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(project.start_date)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(project.end_date)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            status={projectStatusVariant(
                              project.project_status,
                            )}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {typeLabels[project.project_type] ??
                            project.project_type}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {project.currency}
                        </TableCell>
                      </TableRow>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={() => {
                          setSetupEditId(project.id);
                          setSetupSheetOpen(true);
                        }}
                      >
                        <Pencil />
                        Edit
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => setDeleteConfirm(project.id)}
                      >
                        <Trash2 />
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </TableBody>
            </Table>
            <TablePagination
              currentPage={page}
              totalPages={Math.ceil(total / pageSize)}
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

      <Dialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete this project? This action cannot be
            undone.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        entityName="Projects"
        templateLabel="Project Template"
        templateDescription="Fill in project name, client, type, and dates"
        buildSections={(result) => {
          const pr =
            result as import("@/store/api/timesheetApi").ProjectsValidateResponse;
          const sections = [
            {
              label: "Projects",
              rows: pr.rows,
              total: pr.total,
              columns: [
                { key: "name", label: "Project Name" },
                { key: "client_name", label: "Client" },
              ],
            },
          ];
          if (pr.task_rows?.length) {
            sections.push({
              label: "Tasks",
              rows: pr.task_rows,
              total: pr.task_total ?? pr.task_rows.length,
              columns: [
                { key: "task_name", label: "Task Name" },
                { key: "project_name", label: "Project" },
              ],
            });
          }
          return sections;
        }}
        onDownloadTemplate={handleDownloadTemplate}
        onValidate={handleValidateProjects}
        onImport={handleImportProjects}
      />

      <Sheet
        open={setupSheetOpen}
        onOpenChange={(v) => {
          if (!v) setSetupSheetOpen(false);
        }}
      >
        <SheetContent className="w-[80vw] max-w-[80vw] flex flex-col p-0">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {setupSheetOpen && <ProjectSetup />}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={!!detailSheetId}
        onOpenChange={(v) => {
          if (!v) setDetailSheetId(null);
        }}
      >
        <SheetContent className="w-[80vw] max-w-[80vw] flex flex-col p-0">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailSheetId && (
              <ProjectDetail
                projectId={detailSheetId}
                onClose={() => setDetailSheetId(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default ProjectDashboard;
