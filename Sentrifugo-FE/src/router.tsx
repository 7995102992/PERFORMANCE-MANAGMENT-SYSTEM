import {
  createRouter,
  createRoute,
  createRootRoute,
  redirect,
  Outlet,
} from "@tanstack/react-router";
import { store } from "./store";
import { AdminLayout } from "./layouts/AdminLayout";
import { Login } from "./pages/Login";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { ActivateAccount } from "./pages/ActivateAccount";
import { AzureCallback } from "./pages/AzureCallback";
import { EmployeeDashboard } from "./pages/dashboard/EmployeeDashboard";
import LeaveType from "./pages/leave-configuration/LeaveType";
import LeavePlan from "./pages/leave-configuration/LeavePlan";
import WorkCalendar from "./pages/leave-configuration/WorkCalendar";
import AddWorkCalendar from "./pages/leave-configuration/AddWorkCalendar";
import EditWorkCalendar from "./pages/leave-configuration/EditWorkCalendar";
import HolidayCalendar from "./pages/leave-configuration/HolidayCalendar";
import AddHolidayPlan from "./pages/leave-configuration/AddHolidayPlan";
import AddHoliday from "./pages/leave-configuration/AddHoliday";
import EditHoliday from "./pages/leave-configuration/EditHoliday";
import EditHolidayPlan from "./pages/leave-configuration/EditHolidayPlan";
import EmployeeLeaveManagement from "./pages/leave-configuration/EmployeeLeaveManagement";
import ManagerLeaveManagement from "./pages/leave-configuration/ManagerLeaveManagement";
import MyHolidays from "./pages/leave-configuration/MyHolidays";
import Profile from "./pages/Profile";
import EmployeeFlow from "./pages/exit/EmployeeFlow";
import ManagerFlow from "./pages/exit/ManagerFlow";
import HRFlow from "./pages/exit/HRFlow";
import ITAdminFlow from "./pages/exit/ITAdminFlow";
import AdminFlow from "./pages/exit/AdminFlow";
import FinanceFlow from "./pages/exit/FinanceFlow";
import ExitConfiguration from "./pages/exit/ExitConfiguration";

// Service Request pages
import { CategoryList } from "./pages/service-request/category/CategoryList";
import { RequestTypeList } from "./pages/service-request/request-type/RequestTypeList";
import { WorkflowList } from "./pages/service-request/workflow/WorkflowList";
import { RequestQueue } from "./pages/service-request/request-processing/RequestQueue";
import { ApprovalQueue } from "./pages/service-request/request-processing/ApprovalQueue";
import { Dashboard } from "./pages/service-request/Dashboard";
import { MyRequestList } from "./pages/service-request/MyRequestList";
import { EmployeeRequestsList } from "./pages/service-request/EmployeeRequestsList";

// Expense Management pages
import { MyExpenses } from "./pages/expenses/MyExpenses";
import { TeamExpenses } from "./pages/expenses/TeamExpenses";
import { EmployeeTrips } from "./pages/expenses/EmployeeTrips";
import { EmployeeAdvances } from "./pages/expenses/EmployeeAdvances";
import { EmployeeExpenses } from "./pages/expenses/EmployeeExpenses";
import { TripList } from "./pages/expenses/TripList";
import { TeamTrips } from "./pages/expenses/TeamTrips";
import { MyAdvances } from "./pages/expenses/MyAdvances";
import { TeamAdvances } from "./pages/expenses/TeamAdvances";
import { ExpenseSettings } from "./pages/expenses/ExpenseSettings";

// Timesheet pages
import Clients from "./pages/timesheet/Clients";
import ProjectHeadsPage from "./pages/timesheet/ProjectHeadsPage";
import ClientForm from "./pages/timesheet/ClientForm";
import ProjectDashboard from "./pages/timesheet/ProjectDashboard";
import ProjectSetup from "./pages/timesheet/ProjectSetup";
import ProjectDetail from "./pages/timesheet/ProjectDetail";
import TasksDashboard from "./pages/timesheet/TasksDashboard";
import ProjectTasks from "./pages/timesheet/ProjectTasks";
import ProjectResources from "./pages/timesheet/ProjectResources";
import EmployeeTimesheet from "./pages/timesheet/EmployeeTimesheet";
import TimesheetEntry from "./pages/timesheet/TimesheetEntry";
import ManagerApproval from "./pages/timesheet/ManagerApproval";
import Reports from "./pages/timesheet/Reports";
import TimesheetSettings from "./pages/timesheet/TimesheetSettings";
import ClientReviewDashboard from "./pages/timesheet/ClientReviewDashboard";
import ClientActivityHistory from "./pages/timesheet/ClientActivityHistory";
import ClientApproval from "./pages/timesheet/ClientApproval";

// Analytics & Reports
import AnalyticsLanding from "./pages/analytics/AnalyticsLanding";
import ManagerDashboard from "./pages/analytics/ManagerDashboard";
import HRDashboard from "./pages/analytics/HRDashboard";
import AnalyticsComingSoon from "./pages/analytics/AnalyticsComingSoon";
import WorkforceOverview from "./pages/analytics/WorkforceOverview";
import MDDashboard from "./pages/analytics/MDDashboard";
import CFODashboard from "./pages/analytics/CFODashboard";
import ReportsPage from "./pages/analytics/ReportsPage";
import EmployeeTimesheetAnalytics from "./pages/analytics/EmployeeTimesheetAnalytics";
import ManagerTimesheetAnalytics from "./pages/analytics/ManagerTimesheetAnalytics";
import HRTimesheetAnalytics from "./pages/analytics/HRTimesheetAnalytics";
import MDTimesheetAnalytics from "./pages/analytics/MDTimesheetAnalytics";
import CFOTimesheetAnalytics from "./pages/analytics/CFOTimesheetAnalytics";
import MyTicketsServiceRequestAnalytics from "./pages/analytics/service-request/MyTicketsServiceRequestAnalytics";
import ExecutorServiceRequestAnalytics from "./pages/analytics/service-request/ExecutorServiceRequestAnalytics";
import ApproverServiceRequestAnalytics from "./pages/analytics/service-request/ApproverServiceRequestAnalytics";
import TeamServiceRequestAnalytics from "./pages/analytics/service-request/TeamServiceRequestAnalytics";
import OrgServiceRequestAnalytics from "./pages/analytics/service-request/OrgServiceRequestAnalytics";
// Employee Journey pages
import MyJourney from "./pages/employee-journey/MyJourney";
import TeamJourney from "./pages/employee-journey/TeamJourney";
// Policies & Documents
import PoliciesDocuments from "./pages/policies-documents/PoliciesDocuments";
// Announcements
import AnnouncementList from "./pages/announcements/AnnouncementList";
import AnnouncementDetail from "./pages/announcements/AnnouncementDetail";
import MyAnnouncements from "./pages/announcements/MyAnnouncements";
import MyAnnouncementDetail from "./pages/announcements/MyAnnouncementDetail";
import Organogram from "./pages/organisation/Organogram";
import EmployeeDirectory from "./pages/organisation/EmployeeDirectory";
import {
  GatedNewPayroll,
  GatedBulkPayslipUpload,
  GatedEmployeePayroll,
  GatedMyPayroll,
} from "./pages/payroll/gatedRoutes";
// Reports
import LeaveReport from "./pages/reports/LeaveReport";

// Attendance
import MyAttendance from "./pages/attendance/MyAttendance";
import ManagerAttendance from "./pages/attendance/ManagerAttendance";
import HRAttendance from "./pages/attendance/HRAttendance";

// HR
import { EmployeesListPage } from "./pages/hr/employees/EmployeesListPage";
import { EmployeeForm } from "./pages/hr/employees/EmployeeForm";
import EmployeeLeaveReportPage from "./pages/hr/leave-reports/EmployeeLeaveReportPage";

// PMS
import PmsCycleList from "./pages/pms/cycle/PmsCycleList";
import InitiateAppraisal from "./pages/pms/cycle/InitiateAppraisal";
import CycleActivated from "./pages/pms/cycle/CycleActivated";
import GoalTemplateList from "./pages/pms/configuration/goal-templates/GoalTemplateList";
import GoalTemplateWizard from "./pages/pms/configuration/goal-templates/GoalTemplateWizard";
import KraMaster from "./pages/pms/configuration/kra-master/KraMaster";
import KpiMaster from "./pages/pms/configuration/kpi-master/KpiMaster";
import CompetencyMaster from "./pages/pms/configuration/competency-master/CompetencyMaster";
import RatingScale from "./pages/pms/configuration/rating-scale/RatingScale";
import PmsComingSoon from "./pages/pms/PmsComingSoon";

// Settings
import OrganisationSettings from "./pages/settings/OrganisationSettings";

// Root route
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// Auth routes (no sidebar/topbar)
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
  beforeLoad: () => {
    const { accessToken } = store.getState().auth;
    if (accessToken) {
      throw redirect({ to: "/" });
    }
  },
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPassword,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: ResetPassword,
});

const activateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activate",
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: ActivateAccount,
});

const azureCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/callback",
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : "",
    state: typeof search.state === "string" ? search.state : "",
    error: typeof search.error === "string" ? search.error : "",
    error_description: typeof search.error_description === "string" ? search.error_description : "",
  }),
  component: AzureCallback,
});

const clientApprovalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/client-approval",
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
    timesheet_id: typeof search.timesheet_id === "string" ? search.timesheet_id : undefined,
    action: (["approve","reject","approve_all","reject_all"].includes(search.action as string)
      ? search.action
      : "approve") as "approve" | "reject" | "approve_all" | "reject_all",
  }),
  component: ClientApproval,
});

// Admin layout route - all authenticated routes nest under this
const adminLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "admin",
  component: AdminLayout,
  beforeLoad: () => {
    if (!store.getState().auth.accessToken) {
      throw redirect({ to: "/login" });
    }
  },
});

// Protected child routes
const indexRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/",
  // Client-only users are redirected to /timesheet/client-review once at login
  // (see Login.tsx). They can still navigate to / freely afterwards, so no
  // forced redirect here.
  component: EmployeeDashboard,
});

const aboutRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/about",
  component: () => (
    <div className="p-4">
      <h2 className="text-lg font-semibold">About Page</h2>
      <p className="text-muted-foreground">This is a placeholder page.</p>
    </div>
  ),
});

// Placeholder for sidebar menu items
const PlaceholderPage = ({ title }: { title: string }) => (
  <div className="p-4">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="text-muted-foreground">This page is under construction.</p>
  </div>
);

// ─── Service Request Routes ───────────────────────────────────

const srCategoryListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/category/list",
  component: CategoryList,
});

const srTypeListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/type/list",
  component: RequestTypeList,
});

const srApprovalsListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/approvals/list",
  component: WorkflowList,
});

const srQueueListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/queue/list",
  component: RequestQueue,
});

const srApprovalQueueListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/approval-queue/list",
  component: ApprovalQueue,
});

const srDashboardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/dashboard",
  component: Dashboard,
});

const srMyRequestsListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/my-requests/list",
  component: MyRequestList,
});

const srEmployeeRequestsListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/employee-requests/list",
  component: EmployeeRequestsList,
});

const holidayCalendarRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/holiday-calendar",
  component: HolidayCalendar,
});

const addHolidayPlanRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/holiday-calendar/add-plan",
  validateSearch: (s: Record<string, unknown>) => ({
    step: typeof s.step === "string" ? Number(s.step) : typeof s.step === "number" ? s.step : undefined,
  }),
  component: AddHolidayPlan,
});

const setupHolidayPlanRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/holiday-calendar/$planId/setup",
  validateSearch: (s: Record<string, unknown>) => ({
    step: typeof s.step === "string" ? Number(s.step) : typeof s.step === "number" ? s.step : undefined,
  }),
  component: AddHolidayPlan,
});

const editHolidayPlanRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/holiday-calendar/$planId/edit-plan",
  component: EditHolidayPlan,
});

const addHolidayRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/holiday-calendar/$planId/add-holiday",
  component: AddHoliday,
});

const editHolidayRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/holiday-calendar/$planId/edit-holiday/$holidayId",
  component: EditHoliday,
});

const workCalendarRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/work-calendar",
  component: WorkCalendar,
});

const addWorkCalendarRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/work-calendar/add",
  validateSearch: (s: Record<string, unknown>) => ({
    step: typeof s.step === "string" ? Number(s.step) : typeof s.step === "number" ? s.step : undefined,
  }),
  component: AddWorkCalendar,
});

const setupWorkCalendarRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/work-calendar/$calendarId/setup",
  validateSearch: (s: Record<string, unknown>) => ({
    step: typeof s.step === "string" ? Number(s.step) : typeof s.step === "number" ? s.step : undefined,
  }),
  component: AddWorkCalendar,
});

const editWorkCalendarRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/work-calendar/$calendarId/edit",
  component: EditWorkCalendar,
});

const employeeLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/employee-leave-management",
  validateSearch: (search: Record<string, unknown>) => ({
    view:
      search.view === "all" || search.view === "detail"
        ? (search.view as "all" | "detail")
        : undefined,
    leaveId: typeof search.leaveId === "string" ? search.leaveId : undefined,
    from: search.from === "all" ? ("all" as const) : undefined,
  }),
  component: EmployeeLeaveManagement,
});

const managerLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/manager-leave-management",
  // `?view=true&leave_id=<id>` opens the request detail drawer. `request` is the
  // legacy param used by the approval-pending / escalated-to-HR emails and is
  // rewritten to the pair above on arrival.
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: "true"; leave_id?: string; request?: string } => ({
    view: search.view === "true" || search.view === true ? "true" : undefined,
    leave_id: typeof search.leave_id === "string" ? search.leave_id : undefined,
    request: typeof search.request === "string" ? search.request : undefined,
  }),
  component: ManagerLeaveManagement,
});

const myHolidaysRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-management/my-holidays",
  component: MyHolidays,
});

const exitEmployeeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/employee",
  component: EmployeeFlow,
});

const exitManagerRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/manager",
  component: ManagerFlow,
});

const exitHRRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/hr",
  component: HRFlow,
});

const exitITRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/it",
  validateSearch: (search: Record<string, unknown>) => ({
    requestId: typeof search.requestId === "string" ? search.requestId : undefined,
  }),
  component: ITAdminFlow,
});

const exitAdminRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/admin",
  validateSearch: (search: Record<string, unknown>) => ({
    requestId: typeof search.requestId === "string" ? search.requestId : undefined,
  }),
  component: AdminFlow,
});

const exitConfigurationRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/configuration",
  component: ExitConfiguration,
});

const exitFinanceRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/exit/finance",
  validateSearch: (search: Record<string, unknown>) => ({
    requestId: typeof search.requestId === "string" ? search.requestId : undefined,
  }),
  component: FinanceFlow,
});

const leaveTypeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-configuration/leave-type",
  component: LeaveType,
});

const leavePlanRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/leave-configuration/leave-plan",
  validateSearch: (search: Record<string, unknown>) => ({
    planId: typeof search.planId === "string" ? search.planId : undefined,
    step:
      typeof search.step === "string"
        ? Number(search.step)
        : typeof search.step === "number"
          ? search.step
          : 0,
  }),
  component: LeavePlan,
});

const profileRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/profile",
  component: Profile,
});

// ─── Timesheet Routes ─────────────────────────────────────────

const tsClientsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/clients",
  component: Clients,
});

const tsClientNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/clients/new",
  component: ClientForm,
});

const tsClientEditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/clients/$clientId/edit",
  component: ClientForm,
});

const tsProjectHeadsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/project-heads",
  validateSearch: (search: Record<string, unknown>) => ({
    new: typeof search.new === "string" ? search.new : undefined,
  }),
  component: ProjectHeadsPage,
});

const tsProjectsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/projects",
  component: ProjectDashboard,
});

const tsProjectSetupRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/projects/setup",
  component: ProjectSetup,
});

const tsProjectDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/projects/$projectId",
  component: ProjectDetail,
});

const tsTasksRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/tasks",
  component: TasksDashboard,
});

const tsProjectTasksRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/projects/$projectId/tasks",
  component: ProjectTasks,
});

const tsProjectResourcesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/projects/$projectId/resources",
  component: ProjectResources,
});

const tsProjectEditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/projects/$projectId/edit",
  component: ProjectSetup,
});

const tsMyTimesheetRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/my-timesheet",
  component: EmployeeTimesheet,
});

const tsTimesheetEntryRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/my-timesheet/entry",
  component: TimesheetEntry,
});

const tsManagerApprovalRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/manager-approval",
  component: ManagerApproval,
});

const tsEmployeeTimesheetsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/employee-timesheets",
  component: ManagerApproval,
});

const tsReportsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/reports",
  component: Reports,
});

const tsSettingsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/settings",
  component: TimesheetSettings,
});


// My Analytics
const analyticsLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/leave",
  component: AnalyticsLanding,
});
const analyticsSRRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/analytics",
  component: MyTicketsServiceRequestAnalytics,
});
const analyticsTimeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/time",
  component: EmployeeTimesheetAnalytics,
});
const analyticsExitRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/exit",
  component: AnalyticsComingSoon,
});
const analyticsWorkforceRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/workforce",
  component: WorkforceOverview,
});

// Manager Analytics
const analyticsManagerLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/manager/leave",
  component: ManagerDashboard,
});
const analyticsManagerSRRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/analytics/team",
  component: TeamServiceRequestAnalytics,
});
const analyticsManagerTimeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/manager/time",
  component: ManagerTimesheetAnalytics,
});
const analyticsManagerExitRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/manager/exit",
  component: AnalyticsComingSoon,
});

// MD Analytics
const analyticsMDLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/md/leave",
  component: MDDashboard,
});
const analyticsMDSRRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/analytics/org",
  component: OrgServiceRequestAnalytics,
});
const analyticsMDTimeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/md/time",
  component: MDTimesheetAnalytics,
});
const analyticsMDExitRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/md/exit",
  component: AnalyticsComingSoon,
});

// HR Analytics
const analyticsHRLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/hr/leave",
  component: HRDashboard,
});
const analyticsHRSRRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/analytics/approver",
  component: ApproverServiceRequestAnalytics,
});
const analyticsHRTimeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/hr/time",
  component: HRTimesheetAnalytics,
});
const analyticsHRExitRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/hr/exit",
  component: AnalyticsComingSoon,
});

// CFO Analytics
const analyticsCFOLeaveRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/cfo/leave",
  component: CFODashboard,
});
const analyticsCFOSRRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/service-request/analytics/executor",
  component: ExecutorServiceRequestAnalytics,
});
const analyticsCFOTimeRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/cfo/time",
  component: CFOTimesheetAnalytics,
});
const analyticsCFOExitRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/analytics/cfo/exit",
  component: AnalyticsComingSoon,
});

// Reports
const reportsDashboardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/reports",
  component: ReportsPage,
});
const tsClientReviewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/client-review",
  component: ClientReviewDashboard,
});

const leaveReportRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/reports/leave",
  component: LeaveReport,
});

// ─── Attendance Routes ──────────────────────────────────────
const myAttendanceRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/attendance/my-attendance",
  component: MyAttendance,
});

const managerAttendanceRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/attendance/manager",
  component: ManagerAttendance,
});

const hrAttendanceRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/attendance/hr",
  component: HRAttendance,
});

// ─── HR Routes ──────────────────────────────────────────────
// Same screens the admin portal serves at /employees/*, against the same
// IAM endpoints — a record created here is the record created there.

const hrEmployeesListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/hr/employees/list",
  component: EmployeesListPage,
});

const hrLeaveReportsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/hr/leave-reports",
  component: EmployeeLeaveReportPage,
});

const hrEmployeeCreateRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/hr/employees/create",
  // `id` present → edit; `id` + `view` → read-only detail. Absent → create.
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" ? search.id : undefined,
    view: search.view === true || search.view === "true" ? true : undefined,
  }),
  component: EmployeeForm,
});

const settingsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/settings/organisation",
  component: OrganisationSettings,
});

// ─── Employee Journey Routes ──────────────────────────────────

const myJourneyRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/employee-journey/my-journey",
  component: MyJourney,
});

const teamJourneyRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/employee-journey/team-journey",
  component: TeamJourney,
});

const policiesDocumentsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/policies-documents",
  component: PoliciesDocuments,
});

// PMS Cycle — list, 4-step wizard (new / edit), read-only view, activation result.
const pmsCycleListRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/pms/cycle",
  component: PmsCycleList,
});

const pmsCycleNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/pms/cycle/new",
  component: () => <InitiateAppraisal />,
});

const pmsCycleViewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/pms/cycle/$cycleId",
  component: () => <InitiateAppraisal readOnly />,
});

const pmsCycleEditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/pms/cycle/$cycleId/edit",
  component: () => <InitiateAppraisal />,
});

const pmsCycleActivatedRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/pms/cycle/$cycleId/activated",
  component: CycleActivated,
});

// PMS Configuration - masters, rating scale and goal templates.
const pmsRoute = <P extends string>(path: P, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => adminLayoutRoute, path, component });

const pmsGoalTemplatesRoute = pmsRoute("/pms/configuration/goal-templates", () => <GoalTemplateList />);
const pmsGoalTemplateNewRoute = pmsRoute("/pms/configuration/goal-templates/new", () => <GoalTemplateWizard />);
const pmsGoalTemplateViewRoute = pmsRoute("/pms/configuration/goal-templates/$templateId", () => <GoalTemplateWizard readOnly />);
const pmsGoalTemplateEditRoute = pmsRoute("/pms/configuration/goal-templates/$templateId/edit", () => <GoalTemplateWizard />);
const pmsKraMasterRoute = pmsRoute("/pms/configuration/kra-master", () => <KraMaster />);
const pmsKpiMasterRoute = pmsRoute("/pms/configuration/kpi-master", () => <KpiMaster />);
const pmsCompetencyMasterRoute = pmsRoute("/pms/configuration/competency-master", () => <CompetencyMaster />);
const pmsRatingScaleRoute = pmsRoute("/pms/configuration/rating-scale", () => <RatingScale />);

// Menu entries whose screens are not designed yet.
const pmsPlaceholderRoutes = [
  "my-goals",
  "self-appraisal",
  "goal-approvals",
  "target-revisions",
  "mid-year-review",
  "team-appraisal",
  "appraisal-history",
  "lock-access",
  "cycle-closure",
].map((slug) => pmsRoute(`/pms/${slug}`, () => <PmsComingSoon />));

const announcementsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/announcements",
  component: AnnouncementList,
});

// Read-only detail for a published announcement (admin side).
const announcementDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/announcements/$announcementId",
  component: AnnouncementDetail,
});

// Employee-facing announcement feed — read-only. Everything the dashboard card
// shows the top 5 of. Declared before the detail route so the literal path is
// not shadowed by the `$announcementId` parameter.
const myAnnouncementsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/my-announcements",
  component: MyAnnouncements,
});

// Employee-facing announcement — read-only, reached from the dashboard card or
// the feed above.
const myAnnouncementDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/my-announcements/$announcementId",
  component: MyAnnouncementDetail,
});

const organogramRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/organisation/organogram",
  component: Organogram,
});

const employeeDirectoryRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/organisation/employee-directory",
  component: EmployeeDirectory,
});

const tsActivityHistoryRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/timesheet/activity-history",
  component: ClientActivityHistory,
});

// ─── Payroll Routes ──────────────────────────────────

const newPayrollRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/payroll/new",
  component: GatedNewPayroll,
});

const bulkPayslipUploadRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/payroll/bulk",
  component: GatedBulkPayslipUpload,
});

const employeePayrollRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/payroll/employee",
  component: GatedEmployeePayroll,
});

const myPayrollRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/payroll/my",
  component: GatedMyPayroll,
});

// ─── Expense Management Routes ────────────────────────────────
// Three list scopes are three routes, not one parameterised list: their
// permissions and row sets genuinely differ (HLD §12.6). Detail is a single
// full-page route for every role — the drawer is retired, because it cannot
// host the timeline or the comment thread (§12.6 correction 13).

const expenseMyRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/my",
  component: MyExpenses,
});

const expenseTeamRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/team",
  component: TeamExpenses,
});

const expenseEmployeeTripsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/trips/employees",
  component: EmployeeTrips,
});

const expenseEmployeeAdvancesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/advances/employees",
  component: EmployeeAdvances,
});

const expenseEmployeesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/employees",
  component: EmployeeExpenses,
});

const expenseTripsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/trips",
  component: TripList,
});

/**
 * The old full-page trip view, kept as a redirect only.
 *
 * `pages/expenses/TripDetail.tsx` was a second rendering of a trip that drifted
 * four releases behind `TripDetailSheet` — it had no approval chain, no
 * timeline, no gate actions, no verification column, no bulk settle and no
 * comments — and nothing in the app navigated to it. Rather than maintain two
 * screens for one record, the URL now opens the drawer over the trip list, so
 * an old bookmark still lands on the trip and lands on the *complete* one.
 */
const expenseTripDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/trips/$tripId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/expenses/trips",
      search: { trip: (params as { tripId: string }).tripId },
    });
  },
});

const expenseTeamTripsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/team-trips",
  component: TeamTrips,
});

const expenseAdvancesMyRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/advances/my",
  component: MyAdvances,
});

const expenseAdvancesTeamRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/advances/team",
  component: TeamAdvances,
});

const expenseSettingsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/settings",
  component: ExpenseSettings,
});



/**
 * The old full-page expense view, kept as a redirect only — the twin of
 * `expenseTripDetailRoute` above, removed for the same reasons.
 *
 * `pages/expenses/ExpenseDetail.tsx` had no `ApprovalLadder`, which made it the
 * one surface in the module where a stuck chain's `blocked_reason` appeared
 * nowhere at all: it passed a `context` to `GateActionBar` without one, and had
 * no ladder to fall back on. It also carried none of the verification actions.
 * Nothing in the app linked to it. The drawer over the list is the complete
 * screen, so an old bookmark now opens that.
 *
 * Declared last so the literal paths above are never read as a record id.
 */
const expenseDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/expenses/$expenseId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/expenses/my",
      search: { expense: (params as { expenseId: string }).expenseId },
    });
  },
});

// Route tree
const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  activateRoute,
  azureCallbackRoute,
  clientApprovalRoute,
  adminLayoutRoute.addChildren([
    indexRoute,
    aboutRoute,
    // Expense Management — literal paths before the $expenseId catch-all.
    expenseMyRoute,
    expenseTeamRoute,
    expenseEmployeesRoute,
    expenseEmployeeTripsRoute,
    expenseEmployeeAdvancesRoute,
    expenseTripsRoute,
    expenseTeamTripsRoute,
    expenseTripDetailRoute,
    expenseAdvancesMyRoute,
    expenseAdvancesTeamRoute,
    expenseSettingsRoute,
    expenseDetailRoute,
    srCategoryListRoute,
    srTypeListRoute,
    srApprovalsListRoute,
    srQueueListRoute,
    srApprovalQueueListRoute,
    srDashboardRoute,
    srMyRequestsListRoute,
    srEmployeeRequestsListRoute,
    leaveTypeRoute,
    leavePlanRoute,
    profileRoute,
    holidayCalendarRoute,
    addHolidayPlanRoute,
    setupHolidayPlanRoute,
    editHolidayPlanRoute,
    addHolidayRoute,
    editHolidayRoute,
    workCalendarRoute,
    addWorkCalendarRoute,
    setupWorkCalendarRoute,
    editWorkCalendarRoute,
    employeeLeaveRoute,
    managerLeaveRoute,
    myHolidaysRoute,
    // Timesheet routes
    tsClientsRoute,
    tsClientNewRoute,
    tsProjectHeadsRoute,
    tsClientEditRoute,
    tsProjectsRoute,
    tsTasksRoute,
    tsProjectSetupRoute,
    tsProjectDetailRoute,
    tsProjectTasksRoute,
    tsProjectResourcesRoute,
    tsProjectEditRoute,
    tsMyTimesheetRoute,
    tsTimesheetEntryRoute,
    tsManagerApprovalRoute,
    tsEmployeeTimesheetsRoute,
    tsReportsRoute,
    tsSettingsRoute,
    analyticsLeaveRoute,
    analyticsSRRoute,
    analyticsTimeRoute,
    analyticsExitRoute,
    analyticsWorkforceRoute,
    analyticsManagerLeaveRoute,
    analyticsManagerSRRoute,
    analyticsManagerTimeRoute,
    analyticsManagerExitRoute,
    analyticsMDLeaveRoute,
    analyticsMDSRRoute,
    analyticsMDTimeRoute,
    analyticsMDExitRoute,
    analyticsHRLeaveRoute,
    analyticsHRSRRoute,
    analyticsHRTimeRoute,
    analyticsHRExitRoute,
    analyticsCFOLeaveRoute,
    analyticsCFOSRRoute,
    analyticsCFOTimeRoute,
    analyticsCFOExitRoute,
    reportsDashboardRoute,
    tsClientReviewRoute,
    tsActivityHistoryRoute,
    settingsRoute,
    myJourneyRoute,
    teamJourneyRoute,
    policiesDocumentsRoute,
    pmsCycleListRoute,
    pmsCycleNewRoute,
    pmsCycleViewRoute,
    pmsCycleEditRoute,
    pmsCycleActivatedRoute,
    pmsGoalTemplatesRoute,
    pmsGoalTemplateNewRoute,
    pmsGoalTemplateViewRoute,
    pmsGoalTemplateEditRoute,
    pmsKraMasterRoute,
    pmsKpiMasterRoute,
    pmsCompetencyMasterRoute,
    pmsRatingScaleRoute,
    ...pmsPlaceholderRoutes,
    announcementsRoute,
    announcementDetailRoute,
    myAnnouncementsRoute,
    myAnnouncementDetailRoute,
    organogramRoute,
    employeeDirectoryRoute,
    newPayrollRoute,
    bulkPayslipUploadRoute,
    employeePayrollRoute,
    myPayrollRoute,
    leaveReportRoute,
    exitEmployeeRoute,
    exitManagerRoute,
    exitHRRoute,
    exitITRoute,
    exitAdminRoute,
    exitFinanceRoute,
    exitConfigurationRoute,
    // Attendance
    myAttendanceRoute,
    managerAttendanceRoute,
    hrAttendanceRoute,
    // HR
    hrEmployeesListRoute,
    hrEmployeeCreateRoute,
    hrLeaveReportsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
