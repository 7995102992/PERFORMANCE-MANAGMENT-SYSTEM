import { useState, useMemo, useEffect } from "react";
import { formatDateTimeIST } from "@/lib/format-ist";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus,
  Loader2,
  Users,
  ClipboardList,
  BarChart3,
  Clock,
  DollarSign,
  Search,
  Check,
  Pencil,
  MoreHorizontal,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import { toast } from "@/lib/toast";
import {
  useGetProjectQuery,
  useGetProjectTasksQuery,
  useGetProjectResourcesQuery,
  useGetTasksQuery,
  useAssignProjectTaskMutation,
  useGetClientQuery,
  useGetProjectSummaryReportQuery,
  useGetProjectTimelineQuery,
  useDeleteProjectMutation,
} from "@/store/api/timesheetApi";
import { PageLoader } from "@/components/shared/PageLoader";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { StatusBadge } from "@/components/shared/StatusBadge";

const formatDate = (d?: string | null) => {
  if (!d) return "NA";
  return new Date(d)
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    })
    .replace(/ /g, "-");
};

const formatAllocation = (start?: string | null, end?: string | null) => {
  if (!start && !end) return "NA";
  const fmt = (d: string) =>
    new Date(d)
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
      .replace(/ /g, "-");
  return `${start ? fmt(start) : "–"} to ${end ? fmt(end) : "–"}`;
};

const typeLabels: Record<string, string> = {
  time_and_materials: "Time & Material",
  fixed_fee: "Fixed Fee",
  non_billable: "Non-Billable",
};

const statusLabels: Record<string, string> = {
  active: "Initiated",
  inactive: "Inactive",
  completed: "Completed",
  on_hold: "On Hold",
};

const timelineLabel = (
  action: string,
  actor: string,
  details: Record<string, string>,
) => {
  switch (action) {
    case "project_created":
      return {
        title: "Project Created",
        description: details.project_name
          ? `Project "${details.project_name}" was created`
          : null,
      };
    case "task_assigned":
      return {
        title: "Task Assigned",
        description: details.task_name
          ? `"${details.task_name}" was assigned to the project`
          : null,
      };
    case "task_removed":
      return {
        title: "Task Removed",
        description: details.task_name
          ? `"${details.task_name}" was removed from the project`
          : null,
      };
    case "resource_assigned":
      return {
        title: "Resource Assigned",
        description: `${actor} assigned a team member`,
      };
    case "resource_removed":
      return {
        title: "Resource Removed",
        description: `A team member was removed by ${actor}`,
      };
    case "timesheet_submitted":
      return {
        title: "Timesheet Submitted",
        description: `${actor} submitted a timesheet (${details.total_hours ?? "?"} hrs, week of ${details.week_start ?? "?"})`,
      };
    case "timesheet_resubmitted":
      return {
        title: "Timesheet Resubmitted",
        description: `${actor} resubmitted a timesheet (${details.total_hours ?? "?"} hrs)`,
      };
    case "timesheet_approved":
      return {
        title: "Timesheet Approved",
        description: `${actor} approved a timesheet (${details.role ?? ""} level)`,
      };
    case "timesheet_rejected":
      return {
        title: "Timesheet Rejected",
        description: `${actor} rejected a timesheet${details.comments ? `: "${details.comments}"` : ""}`,
      };
    default:
      return {
        title: action
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        description: null,
      };
  }
};

const timelineDotClass = (action: string) => {
  if (action.includes("rejected")) return "bg-destructive";
  if (action.includes("approved")) return "bg-success";
  if (action.includes("submitted") || action.includes("resubmitted"))
    return "bg-primary";
  if (action.includes("removed")) return "bg-badge-pending-text";
  return "bg-foreground";
};

const ProjectDetail = ({
  projectId: projectIdProp,
  onClose,
}: { projectId?: string; onClose?: () => void } = {}) => {
  const navigate = useNavigate();
  // When shown inside the dashboard's detail sheet, close it BEFORE navigating —
  // otherwise Radix's open dialog leaves `pointer-events:none` on <body> and the
  // destination page is frozen.
  const go = ((opts: Parameters<typeof navigate>[0]) => {
    onClose?.();
    navigate(opts);
  }) as typeof navigate;
  // Works both as a full route (id from URL) and inside the dashboard's detail
  // sheet (id passed as a prop, since the URL has no projectId there).
  const params = useParams({ strict: false }) as { projectId?: string };
  const projectId = projectIdProp ?? params.projectId ?? "";
  const search = useSearch({ strict: false }) as { tab?: string };
  const [activeTab, setActiveTab] = useState(search.tab ?? "overview");
  const [addTaskDialog, setAddTaskDialog] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<
    Map<string, { estimated_hours: string; billable_rate: string }>
  >(new Map());
  const [taskSearch, setTaskSearch] = useState("");
  const [addExpenseDialog, setAddExpenseDialog] = useState(false);
  const [expenseForm, setExpenseForm] = useState({
    name: "",
    date: "",
    amount: "",
    notes: "",
  });

  const {
    data: project,
    isLoading,
    error: projectError,
  } = useGetProjectQuery(projectId, {
    skip: !projectId,
  });

  // Topbar breadcrumb leaf: Timesheet › Projects › <this>.
  //
  // Only when this IS the page. Rendered inside the dashboard's detail sheet
  // the id arrives as a prop and the URL is some other page — writing the crumb
  // there would rename that page's breadcrumb to this project.
  const breadcrumbDispatch = useAppDispatch();
  const ownsBreadcrumb = !projectIdProp;
  useEffect(() => {
    if (!ownsBreadcrumb) return;
    breadcrumbDispatch(setBreadcrumbDetail(project?.name ?? "Project"));
    return () => {
      breadcrumbDispatch(setBreadcrumbDetail(null));
    };
  }, [breadcrumbDispatch, ownsBreadcrumb, project?.name]);

  const { data: projectTasks } = useGetProjectTasksQuery(
    { projectId },
    { skip: !projectId },
  );
  const { data: resourcesData } = useGetProjectResourcesQuery(
    { projectId },
    { skip: !projectId },
  );
  const { data: allTasks } = useGetTasksQuery({
    page: 1,
    page_size: 100,
    status: "active",
  });
  // Just this project's client, and only for the contact person — the client's
  // NAME rides on the project payload. Listing 100 clients to find one was both
  // wasteful and scoped to what the caller owns, so it could miss.
  const { data: client } = useGetClientQuery(project?.client_id ?? "", {
    skip: !project?.client_id,
  });
  const { data: reportData } = useGetProjectSummaryReportQuery({});
  const { data: timelineData } = useGetProjectTimelineQuery(
    { projectId, limit: 50 },
    { skip: !projectId },
  );

  const [assignTask, { isLoading: isAssigningTask }] =
    useAssignProjectTaskMutation();
  const [deleteProject, { isLoading: isDeleting }] = useDeleteProjectMutation();
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const handleDelete = async () => {
    try {
      await deleteProject(projectId).unwrap();
      go({ to: "/timesheet/projects" });
    } catch (err) {
      toast.error(err);
    }
  };

  // The resources payload already carries user_name / department, so there's no
  // separate employee lookup — this map only exists to name timeline actors.
  const empMap = useMemo(() => {
    const map = new Map<string, { name: string; department: string }>();
    for (const r of resourcesData?.items ?? []) {
      map.set(r.user_id, {
        name: r.user_name ?? r.user_id,
        department: r.department ?? "NA",
      });
    }
    return map;
  }, [resourcesData]);

  const clientName = project?.client_name ?? "NA";
  const clientPOC = client?.contact_person ?? "NA";
  const tasks = projectTasks ?? [];
  const resources = resourcesData?.items ?? [];
  const availableTasks = (allTasks?.items ?? []).filter(
    (t) => !tasks.some((pt) => pt.task_id === t._id),
  );

  const projectReport = (reportData ?? []).find(
    (r) => r.project_id === projectId,
  );
  const totalHours = projectReport?.total_hours ?? 0;
  const totalDays = projectReport?.total_days ?? 0;
  const billableHours = projectReport?.billable_hours ?? 0;
  const nonBillableHours = projectReport?.non_billable_hours ?? 0;
  const budgetHours = project?.budget_hours ?? 0;
  const estimatedAmount = project?.billable_rate
    ? project.billable_rate_type === "per_day"
      ? totalDays * project.billable_rate
      : billableHours * project.billable_rate
    : 0;
  const budgetCostPercent = project?.budget_cost
    ? Math.min(100, Math.round((estimatedAmount / project.budget_cost) * 100))
    : project?.budget_hours
      ? Math.min(100, Math.round((totalHours / project.budget_hours) * 100))
      : 0;

  const handleAssignTasks = async () => {
    if (selectedTasks.size === 0) return;
    try {
      await Promise.all(
        Array.from(selectedTasks.entries()).map(([taskId, vals]) =>
          assignTask({
            projectId,
            body: {
              task_id: taskId,
              estimated_hours: vals.estimated_hours
                ? parseFloat(vals.estimated_hours)
                : null,
              billable_rate: vals.billable_rate
                ? parseFloat(vals.billable_rate)
                : null,
            },
          }).unwrap(),
        ),
      );
      toast.success(
        selectedTasks.size === 1
          ? "Task added to project"
          : `${selectedTasks.size} tasks added to project`,
      );
      setAddTaskDialog(false);
      setSelectedTasks(new Map());
      setTaskSearch("");
    } catch (err) {
      toast.error(err, "Failed to add tasks to project");
    }
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTasks((prev) => {
      const next = new Map(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.set(taskId, { estimated_hours: "", billable_rate: "" });
      return next;
    });
  };

  const updateTaskField = (
    taskId: string,
    field: "estimated_hours" | "billable_rate",
    value: string,
  ) => {
    setSelectedTasks((prev) => {
      const next = new Map(prev);
      const entry = next.get(taskId);
      if (entry) next.set(taskId, { ...entry, [field]: value });
      return next;
    });
  };

  const filteredAvailableTasks = availableTasks.filter(
    (t) =>
      !taskSearch || t.name.toLowerCase().includes(taskSearch.toLowerCase()),
  );

  // Projects are scoped to the caller — a 404 here means deleted or not yours
  if ((projectError as { status?: number } | undefined)?.status === 404) {
    return (
      <RecordNotFound
        entity="project"
        backLabel="Back to Projects"
        onBack={() => go({ to: "/timesheet/projects" })}
      />
    );
  }

  if (isLoading || !project) {
    return <PageLoader message="Loading project..." />;
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Project title + code + actions */}
      <div className="flex items-start justify-between gap-3 pr-10">
        <div className="flex items-start gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {project.name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {project.description || ""}
            </p>
          </div>
          {project.code && (
            <span className="text-sm font-mono text-muted-foreground bg-muted px-3 py-1 rounded">
              {project.code}
            </span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <MoreHorizontal /> Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() =>
                go({
                  to: "/timesheet/projects/$projectId/edit",
                  params: { projectId },
                })
              }
            >
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteConfirm(true)}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Info cards - Row 1 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            icon: <Users />,
            label: "Client",
            value: clientName,
          },
          {
            icon: <Users />,
            label: "Client POC",
            value: clientPOC,
          },
          {
            icon: <BarChart3 className="w-4 h-4" />,
            label: "Project Type",
            value: typeLabels[project.project_type] ?? project.project_type,
          },
          {
            icon: <DollarSign className="w-4 h-4" />,
            label: "Budget",
            sublabel:
              project.budget_cost != null
                ? "Total Project Cost"
                : project.budget_hours != null
                  ? "Total Project Hours"
                  : null,
            value:
              project.budget_cost != null
                ? `${project.currency} ${project.budget_cost.toLocaleString()}`
                : project.budget_hours != null
                  ? `${project.budget_hours} hrs`
                  : "—",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="flex items-start gap-3 p-4 rounded-xl border bg-card"
          >
            <div className="shrink-0 text-muted-foreground mt-0.5">
              {card.icon}
            </div>
            <div>
              {"sublabel" in card && card.sublabel ? (
                <p className="text-xs text-muted-foreground">{card.sublabel}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{card.label}</p>
              )}
              <p className="text-sm font-semibold text-foreground">
                {card.value}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Info cards - Row 2 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            icon: <Clock className="w-4 h-4" />,
            label: "Start Date",
            value: formatDate(project.start_date),
          },
          {
            icon: <Clock className="w-4 h-4" />,
            label: "End Date",
            value: formatDate(project.end_date),
          },
          {
            icon: <Clock className="w-4 h-4" />,
            label: "Estimated Hours",
            value: budgetHours ? `${budgetHours} Hours` : "NA",
          },
          {
            icon: <BarChart3 className="w-4 h-4" />,
            label: "Status",
            value:
              statusLabels[project.project_status] ?? project.project_status,
          },
        ].map((card) => (
          <div
            key={card.label}
            className="flex items-start gap-3 p-4 rounded-xl border bg-card"
          >
            <div className="shrink-0 text-muted-foreground mt-0.5">
              {card.icon}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className="text-sm font-semibold text-foreground">
                {card.value}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Overall Project Progress */}
      {/* <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">
            Overall Project Progress
          </h3>
          <span className="text-sm font-semibold text-foreground">
            {progressPercent}% Complete
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-2">
          <div
            className="bg-primary rounded-full h-2 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs text-muted-foreground">
            {progressPercent}% Completed
          </span>
          <span className="text-xs text-muted-foreground">Target 100%</span>
        </div>
      </div> */}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview" className="gap-2">
            <BarChart3 className="size-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="team" className="gap-2">
            <Users />
            Team
          </TabsTrigger>
          <TabsTrigger value="tasks" className="gap-2">
            <ClipboardList className="size-4" />
            Tasks
          </TabsTrigger>
          {/* <TabsTrigger value="timeline" className="gap-2">
            <Clock className="size-4" />
            Timeline
          </TabsTrigger> */}
          {/* <TabsTrigger value="expenses" className="gap-2">
            <DollarSign className="size-4" />
            Expenses
          </TabsTrigger> */}
          {/* <TabsTrigger value="settings" className="gap-2">
            <Settings className="size-4" />
            Settings
          </TabsTrigger> */}
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6 mt-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl border bg-card px-5 py-4">
              <p className="text-xs text-muted-foreground mb-1">Total hours</p>
              <p className="text-3xl font-bold text-foreground">
                {totalHours.toFixed(2)}
              </p>
              <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                <p>Billable: {billableHours.toFixed(2)}</p>
                <p>Non-billable: {nonBillableHours.toFixed(2)}</p>
              </div>
            </div>
            <div className="rounded-xl border bg-card px-5 py-4">
              <p className="text-xs text-muted-foreground mb-1">
                Budget remaining ({budgetCostPercent}%)
              </p>
              <p
                className={`text-3xl font-bold ${budgetCostPercent > 100 ? "text-destructive" : "text-foreground"}`}
              >
                {budgetCostPercent}%
              </p>
              <div className="mt-3 w-full bg-muted rounded-full h-1.5">
                <div
                  className={`rounded-full h-1.5 ${budgetCostPercent > 100 ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${Math.min(100, budgetCostPercent)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1 text-right">
                Target 100%
              </p>
            </div>
            <div className="rounded-xl border bg-card px-5 py-4">
              <p className="text-xs text-muted-foreground mb-1">
                Internal costs
              </p>
              <p className="text-3xl font-bold text-foreground">N/A</p>
            </div>
            <div className="rounded-xl border bg-card px-5 py-4">
              <p className="text-xs text-muted-foreground mb-1">
                Estimated amount
              </p>
              <p className="text-3xl font-bold text-foreground">
                {`${project.currency} ${estimatedAmount.toFixed(2)}`}
              </p>
            </div>
          </div>
        </TabsContent>

        {/* Team Tab */}
        <TabsContent value="team" className="mt-6">
          <div className="flex items-center justify-end mb-4">
            <Button
              size="sm"
              onClick={() =>
                go({
                  to: "/timesheet/projects/$projectId/resources",
                  params: { projectId },
                })
              }
            >
              <Users /> Manage Team
            </Button>
          </div>
          {resources.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground rounded-xl border bg-card">
              <Users className="w-10 h-10 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm">No team members assigned yet.</p>
              <Button
                variant="link"
                className="mt-2"
                onClick={() =>
                  go({
                    to: "/timesheet/projects/$projectId/resources",
                    params: { projectId },
                  })
                }
              >
                <Plus />
                Add Resources
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border overflow-x-auto bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Employee Name
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Allocation
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Billing Role
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Billing Rate (Hourly)
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resources.map((r) => {
                    return (
                      <TableRow key={r._id}>
                        <TableCell className="font-medium">
                          {r.user_name ?? r.user_id}
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatAllocation(r.start_date, r.end_date)}
                        </TableCell>
                        <TableCell>{r.role ?? "NA"}</TableCell>
                        <TableCell>
                          {r.billable_rate != null ? r.billable_rate : "NA"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Tasks Tab */}
        <TabsContent value="tasks" className="mt-6">
          {tasks.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground rounded-xl border bg-card">
              <ClipboardList className="w-10 h-10 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm">No tasks assigned yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {tasks.map((pt) => (
                <div
                  key={pt._id}
                  className="rounded-xl border bg-card px-5 py-4"
                >
                  <div className="flex items-center gap-2 mb-3">
                    <ClipboardList className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-semibold text-foreground">
                      {pt.task_name ?? pt.task?.name ?? pt.task_id}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Estimated Hours
                      </p>
                      <p className="text-sm font-semibold">
                        {pt.estimated_hours ?? "NA"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Billable Rate ({project.currency})
                      </p>
                      <p className="text-sm font-semibold">
                        {pt.billable_rate != null
                          ? `${project.currency} ${pt.billable_rate}`
                          : "NA"}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <StatusBadge
                      status={
                        (pt.is_billable ?? pt.task?.is_billable)
                          ? "active"
                          : "inactive"
                      }
                      activeLabel="Billable"
                      inactiveLabel="Non-Billable"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Timeline Tab */}
        <TabsContent value="timeline" className="mt-6">
          <div className="rounded-xl border bg-card p-6">
            <div className="relative border-l-2 border-border ml-4 space-y-6">
              {(timelineData ?? []).length > 0 ? (
                (timelineData ?? []).map((entry, idx) => {
                  const actor = empMap.get(entry.actor_id);
                  const actorName = actor?.name ?? entry.actor_id;
                  const details = entry.details as Record<string, string>;
                  const label = timelineLabel(entry.action, actorName, details);
                  return (
                    <div key={idx} className="relative pl-8">
                      <div
                        className={`absolute -left-[9px] top-1 w-4 h-4 rounded-full border-2 border-card ${timelineDotClass(entry.action)}`}
                      />
                      <p className="text-sm font-semibold text-foreground">
                        {label.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDateTimeIST(entry.timestamp)}
                      </p>
                      {label.description && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {label.description}
                        </p>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="pl-8 py-6 text-sm text-muted-foreground">
                  No activity recorded yet. Events will appear here as the
                  project progresses.
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="mt-6">
          <div className="rounded-xl border bg-card p-6">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  Project Type
                </p>
                <p className="text-sm font-medium">
                  {typeLabels[project.project_type] ?? project.project_type}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Currency</p>
                <p className="text-sm font-medium">{project.currency}</p>
              </div>
            </div>
            <div className="mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => go({ to: "/timesheet/settings" })}
              >
                <Pencil /> Edit Project Settings
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* Expenses Tab */}
        <TabsContent value="expenses" className="mt-6">
          <div className="flex items-center justify-end mb-4">
            <Button size="sm" onClick={() => setAddExpenseDialog(true)}>
              <Plus /> Add Expense
            </Button>
          </div>
          <div className="text-center py-12 text-muted-foreground rounded-xl border bg-card">
            <DollarSign className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-sm">No expenses recorded yet</p>
          </div>
        </TabsContent>
      </Tabs>

      {/* Add Tasks Dialog (bulk) */}
      <Dialog
        open={addTaskDialog}
        onOpenChange={(o) => {
          setAddTaskDialog(o);
          if (!o) {
            setSelectedTasks(new Map());
            setTaskSearch("");
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Tasks to Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                className="pl-9"
                value={taskSearch}
                onChange={(e) => setTaskSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {filteredAvailableTasks.length} available · {selectedTasks.size}{" "}
                selected
              </span>
              {filteredAvailableTasks.length > 0 && (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    const allIds = filteredAvailableTasks.map((t) => t._id!);
                    const allSelected = allIds.every((id) =>
                      selectedTasks.has(id),
                    );
                    setSelectedTasks((prev) => {
                      const next = new Map(prev);
                      if (allSelected) allIds.forEach((id) => next.delete(id!));
                      else
                        allIds.forEach((id) =>
                          next.set(id!, {
                            estimated_hours: "",
                            billable_rate: "",
                          }),
                        );
                      return next;
                    });
                  }}
                >
                  {filteredAvailableTasks.every((t) =>
                    selectedTasks.has(t._id!),
                  )
                    ? "Deselect all"
                    : "Select all"}
                </button>
              )}
            </div>
            <div className="max-h-[400px] overflow-y-auto border rounded-md divide-y">
              {filteredAvailableTasks.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground text-center">
                  No tasks available
                </p>
              ) : (
                filteredAvailableTasks.map((t) => {
                  const checked = selectedTasks.has(t._id!);
                  const vals = selectedTasks.get(t._id!);
                  return (
                    <div
                      key={t._id}
                      className={`${checked ? "bg-primary/5" : ""}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleTaskSelection(t._id!)}
                        className="flex items-center justify-between w-full px-3 py-2 text-sm text-left hover:bg-muted"
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center ${checked ? "bg-primary border-primary" : "border-border"}`}
                          >
                            {checked && (
                              <Check className="w-3 h-3 text-white" />
                            )}
                          </div>
                          <span className="font-medium">{t.name}</span>
                        </div>
                        {t.is_billable && (
                          <span className="text-xs text-success">Billable</span>
                        )}
                      </button>
                      {checked && vals && (
                        <div className="px-3 pb-3 pt-1 flex gap-3">
                          <div className="flex-1">
                            <label className="text-xs text-muted-foreground">
                              Estimated Hours
                            </label>
                            <Input
                              type="number"
                              min="0"
                              step="0.5"
                              placeholder="0"
                              className="h-8 text-sm mt-0.5"
                              value={vals.estimated_hours}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateTaskField(
                                  t._id!,
                                  "estimated_hours",
                                  e.target.value,
                                )
                              }
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-xs text-muted-foreground">
                              Billable Rate ({project.currency})
                            </label>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="0.00"
                              className="h-8 text-sm mt-0.5"
                              value={vals.billable_rate}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateTaskField(
                                  t._id!,
                                  "billable_rate",
                                  e.target.value,
                                )
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={handleAssignTasks}
              disabled={selectedTasks.size === 0 || isAssigningTask}
            >
              {isAssigningTask && <Loader2 className="animate-spin" />}
              Add {selectedTasks.size > 0 ? `(${selectedTasks.size})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-5 text-warning" />
              <DialogTitle>Delete project?</DialogTitle>
            </div>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete this project? This action cannot be
            undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() => setDeleteConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="animate-spin" />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Expense Dialog */}
      <Dialog open={addExpenseDialog} onOpenChange={setAddExpenseDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Expense</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Expense Name *
              </label>
              <Input
                value={expenseForm.name}
                onChange={(e) =>
                  setExpenseForm((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="Expense name"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Date *
                </label>
                <Input
                  type="date"
                  value={expenseForm.date}
                  onChange={(e) =>
                    setExpenseForm((prev) => ({
                      ...prev,
                      date: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Amount *
                </label>
                <Input
                  type="number"
                  value={expenseForm.amount}
                  onChange={(e) =>
                    setExpenseForm((prev) => ({
                      ...prev,
                      amount: e.target.value,
                    }))
                  }
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Notes
              </label>
              <Textarea
                value={expenseForm.notes}
                onChange={(e) =>
                  setExpenseForm((prev) => ({ ...prev, notes: e.target.value }))
                }
                rows={2}
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={
                !expenseForm.name || !expenseForm.date || !expenseForm.amount
              }
            >
              Add Expense
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProjectDetail;
