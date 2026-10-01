import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { CalendarDays, Clock, Mail, Plus } from "lucide-react";

import { useAppSelector } from "@/store";
import { useAuth } from "@/hooks/use-auth";
import { useSidebar } from "@/components/ui/sidebar";
import { MyView } from "./MyView";
import { OrganisationView, isOrgAdmin } from "./OrganisationView";

export const EmployeeDashboard = () => {
  const navigate = useNavigate();
  const user = useAppSelector((s) => s.auth.user);
  const firstName = user?.first_name?.trim() || "there";
  const admin = isOrgAdmin(user);
  const { hasNoPermissions } = useAuth();
  // Width the sidebar currently occupies — the floating quick-actions bar is
  // centered on the content area (viewport minus sidebar), not the viewport.
  const { state: sidebarState, isMobile } = useSidebar();
  const sidebarWidth = isMobile
    ? "0rem"
    : sidebarState === "collapsed"
      ? "var(--sidebar-width-icon)"
      : "var(--sidebar-width)";

  const goApplyLeave = () =>
    navigate({
      to: "/leave-management/employee-leave-management",
      search: { view: undefined, leaveId: undefined, from: undefined },
    });
  const goTimesheet = () => navigate({ to: "/timesheet/my-timesheet" });
  const goRequests = () =>
    navigate({ to: "/service-request/my-requests/list" });

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }, []);

  return (
    <div className="mx-auto max-w-[1280px] space-y-5 pb-28">
      {/* ── Greeting ─────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            {greeting}, {firstName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {admin
              ? "Here's how your organisation is doing today."
              : "Here's your day at a glance."}
          </p>
        </div>
        <div className="hidden items-center gap-2 rounded-full border bg-card px-4 py-2 text-xs text-muted-foreground sm:flex">
          <CalendarDays className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">
            {format(new Date(), "EEE, dd-MMM-yyyy")}
          </span>
        </div>
      </div>

      {admin ? <OrganisationView /> : <MyView />}

      {/* ── Quick actions — hidden for now; uncomment to re-enable ──
      {admin || hasNoPermissions ? null : (
        <div
          className="fixed bottom-6 z-40 flex -translate-x-1/2 gap-1 rounded-full bg-foreground p-2 shadow-2xl backdrop-blur-sm transition-[left] duration-200 ease-linear"
          style={{ left: `calc(50% + ${sidebarWidth} / 2)` }}
        >
          <QuickAction
            primary
            icon={Plus}
            label="Apply leave"
            onClick={goApplyLeave}
          />
          <QuickAction icon={Clock} label="Log time" onClick={goTimesheet} />
          <QuickAction icon={Mail} label="Raise ticket" onClick={goRequests} />
        </div>
      )}
      */}
    </div>
  );
};

export default EmployeeDashboard;

function QuickAction({
  icon: Icon,
  label,
  onClick,
  primary,
}: {
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-4 py-2.5 text-[13px] font-medium text-background transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
        primary ? "bg-primary hover:opacity-90" : "hover:bg-background/10"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
