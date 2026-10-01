import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  ClipboardList,
  Settings,
  Ticket,
  Wrench,
  Clock,
  BarChart3,
  LogOut,
  FileBarChart,
  Wallet,
  CalendarCheck,
  Receipt,
  Building2,
  Users,
} from "lucide-react";

export type Permission = string;

export type MenuItem = {
  key: string;
  label: string;
  path?: string;
  icon?: LucideIcon;
  permission?: Permission;
  // Disjunction: the item renders when the user holds ANY of these codes in the
  // resolved module. For entries several roles reach by different routes — the
  // expense module's `Team Expenses` serves both the reporting manager and the
  // management (L2) approver, who has no nav entry of their own.
  anyPermission?: Permission[];
  // Overrides the parent group's module for this item's permission check.
  // Lets one Analytics group host leaves from different modules.
  moduleKey?: string;
  minRole?: string;
  // SR analytics persona key. When set, the item's visibility is driven by the
  // backend `/analytics/roles` entitlement (grant OR derived) instead of a
  // static `permission` — see AppSidebar.
  analyticsRole?: string;
  // Gates the item purely on the `/me` payslip_admin flag (New / Employee
  // Payslip), independent of role/module permissions.
  requiresPayslipAdmin?: boolean;
  // Renders a live count next to the label. A key rather than a number, so this
  // file stays a static declaration and AppSidebar owns the fetching — and so
  // the query only runs for users the item survived permission filtering for.
  badge?: MenuBadgeKey;
  children?: MenuItem[];
};

/** Counts the sidebar knows how to fetch. See `NavBadge` in AppSidebar. */
export type MenuBadgeKey = "sr_pending_assignment" | "sr_awaiting_my_approval";

export type MenuGroup = {
  key: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  moduleKey?: string; // API permission module key; defaults to key when absent
  permission?: Permission;
  requiredRole?: string;
  hideForAdmin?: boolean;
  forceExpand?: boolean;
  children: MenuItem[];
};

export type MenuSection = {
  sectionTitle: string;
  requiredRole?: string;
  collapsible?: boolean;
  groups: MenuGroup[];
};

export const sidebarMenuConfig: MenuSection[] = [
  {
    sectionTitle: "Main",
    groups: [
      {
        key: "dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        // Single child + no forceExpand → rendered as a standalone link (see
        // SingleMenuItem in AppSidebar).
        children: [{ key: "dashboard-home", label: "Overview", path: "/" }],
      },
    ],
  },
  {
    sectionTitle: "Modules",
    groups: [
      {
        key: "organization",
        label: "Organization",
        icon: Building2,
        children: [
          {
            key: "my-journey",
            label: "My Journey",
            path: "/employee-journey/my-journey",
          },
          {
            key: "team-journey",
            label: "Team Journey",
            path: "/employee-journey/team-journey",
            minRole: "manager",
          },
          {
            key: "policies-documents",
            label: "Policies & Docs",
            path: "/policies-documents",
          },
          {
            key: "announcements",
            label: "Announcements",
            path: "/announcements",
            permission: "manage_announcements",
            moduleKey: "core_hr",
          },
          {
            key: "organogram",
            label: "Organogram",
            path: "/organisation/organogram",
          },
          {
            key: "employee-directory",
            label: "Employee Directory",
            path: "/organisation/employee-directory",
          },
        ],
      },
      {
        key: "hr",
        label: "HR",
        icon: Users,
        moduleKey: "core_hr",
        // The IAM /employees/ endpoints are HR-only — a manager or plain
        // employee gets a silent 403 on load. `resource_management` is the
        // levelled grant behind them: holding it at any level (viewer included)
        // is enough to open the list, and the page itself decides what is
        // editable from the level. Was `create_resource`, which also gates the
        // rest of Core HR's master data and so could not express "read-only".
        permission: "resource_management",
        forceExpand: true,
        children: [
          {
            key: "hr-employees",
            label: "Employees",
            path: "/hr/employees/list",
          },
          {
            // IAM grants this under `leave_management` (Leave & Attendance), not
            // the group's `core_hr`, so the item names its own module — matching
            // what the leave service enforces on /reports/employee-leave*.
            key: "hr-leave-reports",
            label: "Leave Reports",
            path: "/hr/leave-reports",
            moduleKey: "leave_management",
            permission: "view_employee_reports",
          },
        ],
      },
      {
        key: "leave-configuration",
        label: "Leave Setup",
        icon: Settings,
        moduleKey: "leave_management",
        permission: "leave_configuration",
        children: [
          {
            key: "holiday-calendar",
            label: "Holiday Calendar",
            path: "/leave-management/holiday-calendar",
            permission: "holiday_plan",
          },
          {
            key: "work-calendar",
            label: "Work Calendar",
            path: "/leave-management/work-calendar",
            permission: "work_calendar",
          },
          {
            key: "leave-type",
            label: "Leave Types",
            path: "/leave-configuration/leave-type",
            permission: "leave_types",
          },
          {
            key: "leave-plan",
            label: "Leave Plan",
            path: "/leave-configuration/leave-plan",
            permission: "leave_plan",
          },
        ],
      },
      {
        key: "leave-management",
        label: "Leave & Holiday",
        icon: ClipboardList,
        moduleKey: "leave_management",
        hideForAdmin: true,
        children: [
          {
            key: "employee-leave-management",
            label: "My Leaves",
            path: "/leave-management/employee-leave-management",
            permission: "leave_request",
          },
          {
            key: "manager-leave-management",
            label: "Leave Requests",
            path: "/leave-management/manager-leave-management",
            permission: "manage_leave_request",
          },
          {
            // Read-only view of the holiday plan the employee is assigned to.
            // Gated on leave_request (not holiday_plan, which is the admin
            // capability for authoring plans) so every employee can see it.
            key: "my-holidays",
            label: "Holidays",
            path: "/leave-management/my-holidays",
            permission: "leave_request",
          },
        ],
      },
      // {
      //   key: "timesheet-management",
      //   label: "Timesheet",
      //   icon: Clock,
      //   children: [
      //     { key: "employee-timesheet", label: "My Timesheet", path: "/timesheet/my-timesheet" },
      //     { key: "pending-timesheets", label: "Pending Approval", path: "/timesheet/pending" },
      //     { key: "approved-timesheets", label: "Approved Timesheets", path: "/timesheet/approved" },
      //     { key: "manager-approval", label: "Manager Approval", path: "/timesheet/manager-approval" },
      //   ],
      // },
      // {
      //   key: "timesheet-admin",
      //   label: "Timesheet Configurator",
      //   icon: FolderKanban,
      //   children: [
      //     { key: "ts-clients", label: "Clients", path: "/timesheet/clients" },
      //     { key: "ts-projects", label: "Projects", path: "/timesheet/projects" },
      //     { key: "ts-reports", label: "Reports", path: "/timesheet/reports" },
      //     { key: "ts-settings", label: "Settings", path: "/timesheet/settings" },
      //   ],
      // },
      {
        key: "attendance",
        label: "Attendance",
        icon: CalendarCheck,
        moduleKey: "leave_management",
        hideForAdmin: true,
        children: [
          {
            key: "my-attendance",
            label: "My Attendance",
            path: "/attendance/my-attendance",
            permission: "my_attendance",
          },
          {
            key: "manager-attendance",
            label: "Manager",
            path: "/attendance/manager",
            permission: "manager_attendance",
          },
          {
            key: "hr-attendance",
            label: "HR",
            path: "/attendance/hr",
            permission: "hr_attendance",
          },
        ],
      },
      {
        key: "service-request",
        label: "Service Tickets",
        icon: Ticket,
        moduleKey: "service_request",
        children: [
          {
            key: "sr-my-requests",
            label: "My Tickets",
            path: "/service-request/my-requests/list",
            // The base employee grant: raising (POST /requests) and
            // /requests/my-export both sit behind it, and it's the floor every
            // SR persona builds on.
            permission: "raise_request",
          },
          // "Employee Tickets" (/service-request/employee-requests/list) is
          // deliberately absent. "To Execute" below is a strict superset of it:
          // that page merges ?executor_user_id=me with the same
          // ?for_my_department=true&status=pending_assignment query this one
          // ran, so every row is still reachable — plus the tickets you are
          // executing outside your own categories, which this page could not
          // show. Its xlsx export moved to To Execute with it.
          //
          // Hidden rather than deleted: router.tsx still registers the route,
          // so existing links keep working and restoring the entry is a
          // one-line change.
          {
            // The executor queue: tickets where I am the assignee. Without this
            // entry the page had no navigable route at all — it was reachable
            // only from the org-admin dashboard — so anyone reassigned a ticket
            // could open it by link but never find it in the app. "Employee
            // Tickets" does not cover it: that view is department-scoped, and a
            // roster executor may sit outside the ticket's department.
            key: "sr-execute-queue",
            label: "To Execute",
            path: "/service-request/queue/list",
            permission: "execute_request",
            // Unassigned tickets in the caller's roster scope. The page folds
            // these into "Total Assigned" and has no card of its own for them,
            // so without this nobody knows a ticket is sitting unclaimed until
            // they open the page.
            badge: "sr_pending_assignment",
          },
          {
            // Once carried the "To Execute" label while pointing here, which was
            // wrong — this page is ApprovalQueue and lists PENDING APPROVALS,
            // not assignments. Assignments now live under "To Execute" above.
            key: "sr-approval-queue",
            label: "Team Tickets",
            path: "/service-request/approval-queue/list",
            // The screen behind this is the approvals queue — it reads
            // GET /requests/pending-approvals, which the API gates on
            // approve_request. Was `minRole: "manager"`, which let any manager
            // in regardless of the grant and 403'd them on load.
            permission: "approve_request",
            // Only the actionable subset. The page's other five cards (team,
            // approved, escalated, urgent, all) are context rather than a to-do
            // list, and badging their union would leave a number that never
            // reaches zero — which is a number people stop reading.
            badge: "sr_awaiting_my_approval",
          },
        ],
      },
      {
        key: "service-request-config",
        label: "Service Ticket Setup",
        icon: Wrench,
        moduleKey: "service_request",
        requiredRole: "admin",
        children: [
          {
            key: "sr-categories",
            label: "Categories",
            path: "/service-request/category/list",
          },
          {
            key: "sr-types",
            label: "Ticket Types",
            path: "/service-request/type/list",
          },
          {
            key: "sr-workflows",
            label: "Workflows",
            path: "/service-request/approvals/list",
          },
        ],
      },
      {
        key: "timesheet-management",
        label: "Timesheet",
        icon: Clock,
        children: [
          {
            key: "employee-timesheet",
            label: "My Timesheet",
            path: "/timesheet/my-timesheet",
          },
          {
            key: "employee-timesheets",
            label: "Team Timesheets",
            path: "/timesheet/employee-timesheets",
          },
          {
            key: "client-review",
            label: "Timesheet Review",
            path: "/timesheet/client-review",
          },
          {
            key: "timesheet-admin",
            label: "Timesheet Admin",
            children: [
              {
                key: "ts-clients",
                label: "Clients",
                path: "/timesheet/clients",
              },
              // {
              //   key: "ts-project-heads",
              //   label: "Project Heads",
              //   path: "/timesheet/project-heads",
              // },
              {
                key: "ts-projects",
                label: "Projects",
                path: "/timesheet/projects",
              },
              // { key: "ts-tasks", label: "Tasks", path: "/timesheet/tasks" },
              // { key: "ts-reports", label: "Reports", path: "/timesheet/reports" },
              {
                key: "ts-settings",
                label: "Settings",
                path: "/timesheet/settings",
              },
            ],
          },
        ],
      },
      {
        // Expense scopes are separate, permission-gated nav entries rather than
        // a toggle inside one screen — their row sets genuinely differ, and
        // collapsing them would silently widen a manager's scope (HLD §12.6).
        key: "expenses",
        label: "Expenses",
        icon: Receipt,
        moduleKey: "expense_management",
        children: [
          // Grouped by subject — the claim, the trip it may hang off, the
          // advance drawn against it — with the same scope ladder inside each:
          // mine, my reporting line, the org. Nine flat entries made the eye
          // sort by suffix to find the pair it wanted, and the sub-group nodes
          // carry no gate of their own: `filterNestedChildren` drops a group
          // whose leaves all filter out, so an employee sees one entry under
          // each heading and no empty headings.
          {
            key: "expense-claims",
            label: "Expense",
            children: [
              {
                key: "expense-my",
                label: "My Expense",
                path: "/expenses/my",
                permission: "submit_expense",
              },
              {
                // The caller's reporting line, and nothing else. It used to be
                // that line unioned with the caller's open rungs, which made
                // the entry mean "my people" or "my queue" depending on which
                // grant you held. The queue now lives on `expense-employees`,
                // which serves it to approvers who lack the org-wide read
                // (§5.2a).
                key: "expense-team",
                label: "Team Expense",
                path: "/expenses/team",
                anyPermission: [
                  "expense_manager_approval",
                  "expense_finance_approval",
                  "expense_l2_approval",
                ],
              },
              {
                // Finance and Leadership, not managers: the page serves the org
                // pipeline to whoever holds the org-wide read, and the caller's
                // own approval queue to whoever does not. A manager holds
                // neither the read nor a rung Team Expense does not already
                // show them.
                key: "expense-employees",
                label: "Employee Expense",
                path: "/expenses/employees",
                anyPermission: [
                  "view_expense_claims",
                  "expense_finance_approval",
                  "expense_l2_approval",
                ],
              },
            ],
          },
          {
            key: "expense-trips-group",
            label: "Trips",
            children: [
              {
                key: "expense-trips",
                label: "My Trips",
                path: "/expenses/trips",
                permission: "manage_own_trips",
              },
              {
                key: "expense-team-trips",
                label: "Team Trips",
                path: "/expenses/team-trips",
                anyPermission: [
                  "expense_manager_approval",
                  "expense_finance_approval",
                  "expense_l2_approval",
                ],
              },
              {
                key: "expense-employee-trips",
                label: "Employee Trips",
                path: "/expenses/trips/employees",
                anyPermission: [
                  "view_expense_claims",
                  "expense_finance_approval",
                  "expense_l2_approval",
                ],
              },
            ],
          },
          {
            key: "expense-advances",
            label: "Advance",
            children: [
              {
                key: "expense-advances-my",
                label: "My Advance",
                path: "/expenses/advances/my",
                permission: "request_expense_advance",
              },
              {
                // Deliberately not the approval codes its Expense and Trips
                // siblings use. This is the allotment desk, not a queue: the
                // page hands out money, and `allot_expense_advance` is the
                // grant that says you may. A manager who only approves sees it
                // when the org gives them that grant, and not before.
                key: "expense-advances-team",
                label: "Team Advance",
                path: "/expenses/advances/team",
                permission: "allot_expense_advance",
              },
              {
                key: "expense-employee-advances",
                label: "Employee Advance",
                path: "/expenses/advances/employees",
                anyPermission: [
                  "view_expense_claims",
                  "expense_finance_approval",
                  "expense_l2_approval",
                ],
              },
            ],
          },
          {
            // Left flat, below the three groups: it configures all of them, so
            // nesting it under any one would misfile it.
            //
            // The org's approval chains — expenses, trips and advances, each
            // configured on its own tab. Nav visibility is a convenience; both
            // config routes enforce the permission themselves
            // (approval-chain-hld.md §8).
            key: "expense-settings",
            label: "Settings",
            path: "/expenses/settings",
            permission: "manage_expense_config",
          },
        ],
      },
      {
        key: "exit",
        label: "Exit",
        icon: LogOut,
        moduleKey: "core_hr",
        hideForAdmin: true,
        children: [
          {
            key: "exit-employee",
            label: "My Exit",
            path: "/exit/employee",
            permission: "apply_exit_request",
          },
          {
            key: "exit-manager",
            label: "Exit Requests",
            path: "/exit/manager",
            permission: "approve_exit_request",
          },
          {
            key: "exit-hr",
            label: "Exit Monitor",
            path: "/exit/hr",
            permission: "monitor_exit_request",
          },
          {
            key: "exit-configuration",
            label: "Exit Configuration",
            path: "/exit/configuration",
            permission: "monitor_exit_request",
          },
          {
            key: "exit-it",
            label: "IT Clearances",
            path: "/exit/it",
            permission: "it_clearances",
          },
          {
            key: "exit-admin",
            label: "Admin Clearances",
            path: "/exit/admin",
            permission: "admin_clearances",
          },
          {
            key: "exit-finance",
            label: "Fin Clearances",
            path: "/exit/finance",
            permission: "final_settlement",
          },
        ],
      },
      {
        key: "analytics",
        label: "Analytics",
        icon: BarChart3,
        hideForAdmin: true,
        children: [
          { key: "an-workforce", label: "Workforce Overview", path: "/analytics/workforce", moduleKey: "reports_and_analytics", permission: "workforce_analytics" },
          {
            key: "an-leave",
            label: "Leave",
            children: [
              { key: "an-leave-my", label: "My", path: "/analytics/leave", moduleKey: "reports_and_analytics", permission: "employee_leave_analytics" },
              { key: "an-leave-mgr", label: "Manager", path: "/analytics/manager/leave", moduleKey: "reports_and_analytics", permission: "manager_leave_analytics" },
              { key: "an-leave-hr", label: "HR", path: "/analytics/hr/leave", moduleKey: "reports_and_analytics", permission: "hr_leave_analytics" },
              { key: "an-leave-md", label: "MD", path: "/analytics/md/leave", moduleKey: "reports_and_analytics", permission: "md_leave_analytics" },
              { key: "an-leave-cfo", label: "CFO", path: "/analytics/cfo/leave", moduleKey: "reports_and_analytics", permission: "cfo_leave_analytics" },
            ],
          },
          {
            key: "an-sr",
            label: "Service Ticket",
            children: [
              { key: "an-sr-my", label: "My", path: "/service-request/analytics", moduleKey: "reports_and_analytics", permission: "view_my_analytics" },
              { key: "an-sr-exec", label: "Executor", path: "/service-request/analytics/executor", moduleKey: "reports_and_analytics", permission: "view_executor_analytics" },
              { key: "an-sr-appr", label: "Approver", path: "/service-request/analytics/approver", moduleKey: "reports_and_analytics", permission: "view_approver_analytics" },
              { key: "an-sr-team", label: "Manager", path: "/service-request/analytics/team", moduleKey: "reports_and_analytics", permission: "view_team_analytics" },
              { key: "an-sr-org", label: "CFO", path: "/service-request/analytics/org", moduleKey: "reports_and_analytics", permission: "view_org_analytics" },
            ],
          },
          {
            key: "an-time",
            label: "Time",  
            children: [
              { key: "an-time-my", label: "My", path: "/analytics/time", moduleKey: "reports_and_analytics", permission: "employee_timesheet_analytics" },
              { key: "an-time-mgr", label: "Manager", path: "/analytics/manager/time", moduleKey: "reports_and_analytics", permission: "manager_timesheet_analytics" },
              { key: "an-time-hr", label: "HR", path: "/analytics/hr/time", moduleKey: "reports_and_analytics", permission: "hr_timesheet_analytics" },
              { key: "an-time-md", label: "MD", path: "/analytics/md/time", moduleKey: "reports_and_analytics", permission: "md_timesheet_analytics" },
              { key: "an-time-cfo", label: "CFO", path: "/analytics/cfo/time", moduleKey: "reports_and_analytics", permission: "cfo_timesheet_analytics" },
            ],
          },
          {
            key: "an-exit",
            label: "Exit",
            children: [
              { key: "an-exit-my", label: "My", path: "/analytics/exit", moduleKey: "reports_and_analytics", permission: "employee_exit_analytics" },
              { key: "an-exit-mgr", label: "Manager", path: "/analytics/manager/exit", moduleKey: "reports_and_analytics", permission: "manager_exit_analytics" },
              { key: "an-exit-hr", label: "HR", path: "/analytics/hr/exit", moduleKey: "reports_and_analytics", permission: "hr_exit_analytics" },
              { key: "an-exit-md", label: "MD", path: "/analytics/md/exit", moduleKey: "reports_and_analytics", permission: "md_exit_analytics" },
              { key: "an-exit-cfo", label: "CFO", path: "/analytics/cfo/exit", moduleKey: "reports_and_analytics", permission: "cfo_exit_analytics" },
            ],
          },
        ],
      },
      {
        key: "payroll",
        label: "Payslip",
        icon: Wallet,
        moduleKey: "core_hr",
        children: [
          {
            key: "payroll-new",
            label: "New Payslip",
            path: "/payroll/new",
            requiresPayslipAdmin: true,
          },
          {
            key: "payroll-bulk",
            label: "New Payslip (Bulk Upload)",
            path: "/payroll/bulk",
            requiresPayslipAdmin: true,
          },
          {
            key: "payroll-employee",
            label: "Employee Payslip",
            path: "/payroll/employee",
            requiresPayslipAdmin: true,
          },
          {
            key: "payroll-my",
            label: "My Payslip",
            path: "/payroll/my",
            permission: "my_payroll",
          },
        ],
      },
      // {
      //   key: "exit",
      //   label: "Exit Management",
      //   icon: LogOut,
      //   moduleKey: "core_hr",
      //   children: [
      //     { key: "exit-employee", label: "Apply Exit Request", path: "/exit/employee", permission: "apply_exit_request" },
      //     { key: "exit-manager", label: "Approve Exit Request", path: "/exit/manager", permission: "approve_exit_request" },
      //     { key: "exit-hr", label: "Monitor Exit Request", path: "/exit/hr", permission: "monitor_exit_request" },
      //     { key: "exit-it", label: "IT Clearances", path: "/exit/it", permission: "it_clearances" },
      //     { key: "exit-admin", label: "Admin Clearances", path: "/exit/admin", permission: "admin_clearances" },
      //     { key: "exit-finance", label: "Final Settlement", path: "/exit/finance", permission: "final_settlement" },
      //   ],
      // },
    ],
  },
];
