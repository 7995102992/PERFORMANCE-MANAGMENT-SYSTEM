import { useState } from "react";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, BarChart3, Users, FolderKanban, Clock } from "lucide-react";
import {
  useGetProjectSummaryReportQuery,
  useGetEmployeeSummaryReportQuery,
  useGetClientsQuery,
  useGetProjectsQuery,
  useGetApprovalDashboardQuery,
} from "@/store/api/timesheetApi";
import { PageHeader } from "@/components/shared/PageHeader";

// Status bar colors for data visualization � intentionally hardcoded per-status for chart clarity
const PROJECT_STATUS_COLORS: Record<string, string> = {
  active: "bg-success",
  on_hold: "bg-badge-pending-text",
  completed: "bg-primary",
  inactive: "bg-muted-foreground",
};

const APPROVAL_STATUS_COLORS = [
  { label: "Submitted", key: "submitted", colorClass: "bg-primary" },
  { label: "Approved (L1)", key: "l1_approved", colorClass: "bg-success" },
  { label: "Rejected (L1)", key: "l1_rejected", colorClass: "bg-destructive" },
  {
    label: "Client Approved",
    key: "client_approved",
    colorClass: "bg-success",
  },
  {
    label: "Not Submitted",
    key: "not_submitted",
    colorClass: "bg-muted-foreground",
  },
];

const Reports = () => {
  const [activeTab, setActiveTab] = useState("overview");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [projectFilter, setProjectFilter] = useState<string>("");

  const { data: dashboard } = useGetApprovalDashboardQuery();
  const { data: projectSummary, isLoading: isProjectLoading } =
    useGetProjectSummaryReportQuery(
      clientFilter ? { client_id: clientFilter } : {},
    );
  const { data: employeeSummary, isLoading: isEmployeeLoading } =
    useGetEmployeeSummaryReportQuery(
      projectFilter ? { project_id: projectFilter } : {},
    );
  const { data: clientsData } = useGetClientsQuery({
    page: 1,
    page_size: 100,
    status: "active",
  });
  const { data: projectsData } = useGetProjectsQuery({
    page: 1,
    page_size: 100,
    status: "active",
  });

  const clients = clientsData?.items ?? [];
  const projects = projectsData?.items ?? [];

  const totalProjects = projects.length;
  const activeProjects = projects.filter(
    (p) => p.project_status === "active",
  ).length;
  const pendingApprovals = dashboard
    ? dashboard.submitted + dashboard.resubmitted
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="View and analyze project and timesheet metrics"
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
          <div>
            <p className="text-xs text-muted-foreground font-medium">
              Total Projects
            </p>
            <p className="text-2xl font-bold text-foreground">
              {totalProjects}
            </p>
          </div>
          <FolderKanban className="size-8 shrink-0 text-muted-foreground" />
        </div>
        <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
          <div>
            <p className="text-xs text-muted-foreground font-medium">
              Active Projects
            </p>
            <p className="text-2xl font-bold text-foreground">
              {activeProjects}
            </p>
          </div>
          <BarChart3 className="size-8 shrink-0 text-muted-foreground" />
        </div>
        <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
          <div>
            <p className="text-xs text-muted-foreground font-medium">
              Pending Approvals
            </p>
            <p className="text-2xl font-bold text-foreground">
              {pendingApprovals}
            </p>
          </div>
          <Clock className="size-8 shrink-0 text-muted-foreground" />
        </div>
        <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
          <div>
            <p className="text-xs text-muted-foreground font-medium">
              Active Clients
            </p>
            <p className="text-2xl font-bold text-foreground">
              {clients.length}
            </p>
          </div>
          <Users className="size-8 shrink-0 text-muted-foreground" />
        </div>
      </div>

      {/* Report Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview" className="gap-2">
            <BarChart3 className="size-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="project-summary" className="gap-2">
            <FolderKanban className="size-4" />
            Project Summary
          </TabsTrigger>
          <TabsTrigger value="employee-summary" className="gap-2">
            <Users />
            Employee Summary
          </TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">
                Project Status Distribution
              </h3>
              <div className="space-y-3">
                {["active", "on_hold", "completed", "inactive"].map(
                  (status) => {
                    const count = projects.filter(
                      (p) => p.project_status === status,
                    ).length;
                    const pct =
                      totalProjects > 0 ? (count / totalProjects) * 100 : 0;
                    return (
                      <div key={status}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-foreground capitalize">
                            {status.replace("_", " ")}
                          </span>
                          <span className="font-medium text-foreground">
                            {count}
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div
                            className={`h-2 rounded-full ${PROJECT_STATUS_COLORS[status] ?? "bg-muted-foreground"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">
                Approval Status
              </h3>
              {dashboard ? (
                <div className="space-y-3">
                  {APPROVAL_STATUS_COLORS.map((item) => {
                    const value =
                      (dashboard as unknown as Record<string, number>)[
                        item.key
                      ] ?? 0;
                    const pct = dashboard.total
                      ? (value / dashboard.total) * 100
                      : 0;
                    return (
                      <div key={item.label}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-foreground">{item.label}</span>
                          <span className="font-medium text-foreground">
                            {value}
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div
                            className={`h-2 rounded-full ${item.colorClass}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Project Summary */}
        <TabsContent value="project-summary">
          <div className="rounded-xl border overflow-x-auto bg-card">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold text-foreground">
                Project Summary
              </h3>
              <Select
                value={clientFilter || "all"}
                onValueChange={(v) => setClientFilter(v === "all" ? "" : v)}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="All clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clients</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isProjectLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Project
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Total Hours
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Billable Hours
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Non-Billable
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Resources
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(projectSummary ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No data available
                      </TableCell>
                    </TableRow>
                  ) : (
                    (projectSummary ?? []).map((item) => (
                      <TableRow key={item.project_id}>
                        <TableCell className="font-medium">
                          {item.project_name ?? item.project_id}
                        </TableCell>
                        <TableCell>{item.total_hours}</TableCell>
                        <TableCell>{item.billable_hours}</TableCell>
                        <TableCell>{item.non_billable_hours}</TableCell>
                        <TableCell>{item.resource_count}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>

        {/* Employee Summary */}
        <TabsContent value="employee-summary">
          <div className="rounded-xl border overflow-x-auto bg-card">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold text-foreground">
                Employee Summary
              </h3>
              <Select
                value={projectFilter || "all"}
                onValueChange={(v) => setProjectFilter(v === "all" ? "" : v)}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isEmployeeLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Total Hours
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Billable Hours
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Non-Billable
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Submitted
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Approved
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(employeeSummary ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No data available
                      </TableCell>
                    </TableRow>
                  ) : (
                    (employeeSummary ?? []).map((item) => (
                      <TableRow key={item.user_id}>
                        <TableCell className="font-medium">
                          {item.user_name ?? item.user_id}
                        </TableCell>
                        <TableCell>{item.total_hours}</TableCell>
                        <TableCell>{item.billable_hours}</TableCell>
                        <TableCell>{item.non_billable_hours}</TableCell>
                        <TableCell>{item.submitted_count}</TableCell>
                        <TableCell>{item.approved_count}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Reports;
