import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  ClipboardList,
  Clock,
  UserMinus,
  Users,
} from "lucide-react";

import { useGetOrgOnLeaveTodayQuery } from "@/store/api/lmsApi";
import { useGetOrgTimesheetComplianceQuery } from "@/store/api/timesheetApi";
import { useGetHeadcountSnapshotQuery } from "@/store/api/iamApi";
import { useGetDashboardSummaryQuery } from "@/store/api/srmApi";
import {
  DashCard,
  DashHeader,
  DashSpinner,
  DashEmpty,
  SectionLabel,
  StatRow,
  initials,
} from "./dashboardUi";

// ─── admin detection ────────────────────────────────────────────

export function isOrgAdmin(
  user:
    | { is_org_admin?: boolean | null; is_super_admin?: boolean | null }
    | null
    | undefined,
): boolean {
  return !!(user?.is_org_admin || user?.is_super_admin);
}

// ─── helpers ────────────────────────────────────────────────────

const SR_CARD_COLORS: Record<string, string> = {
  total: "bg-muted text-muted-foreground",
  open: "bg-info/10 text-info",
  approved: "bg-success/10 text-success",
  resolved_today: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
  escalated: "bg-warning/10 text-warning",
  role_card: "bg-warning/10 text-warning",
};

// ─── component ──────────────────────────────────────────────────

export function OrganisationView() {
  const navigate = useNavigate();

  const { data: srSummary, isLoading: srLoading } =
    useGetDashboardSummaryQuery();
  const { data: onLeave, isLoading: leaveLoading } =
    useGetOrgOnLeaveTodayQuery();
  const { data: ts, isLoading: tsLoading } =
    useGetOrgTimesheetComplianceQuery();
  const { data: headcount, isLoading: hcLoading } =
    useGetHeadcountSnapshotQuery();

  const srCards = srSummary?.cards ?? [];
  const srOpen = srCards.find((c) => c.id === "open")?.value ?? 0;
  const activeEmployees =
    headcount?.active_employees || onLeave?.total_employees || 0;
  const compliancePct =
    activeEmployees > 0 && ts
      ? Math.min(100, Math.round((ts.submitted_users / activeEmployees) * 100))
      : null;

  return (
    <div className="space-y-4">
      <SectionLabel>Organisation</SectionLabel>

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          icon={<Users className="h-3.5 w-3.5" />}
          accent="primary"
          label="Employees"
          value={hcLoading && leaveLoading ? "—" : activeEmployees}
        />
        <KpiTile
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          accent="violet"
          label="On leave today"
          value={leaveLoading ? "—" : (onLeave?.total_out ?? 0)}
        />
        <KpiTile
          icon={<ClipboardList className="h-3.5 w-3.5" />}
          accent="blue"
          label="Open tickets"
          value={srLoading ? "—" : srOpen}
        />
        <KpiTile
          icon={<Clock className="h-3.5 w-3.5" />}
          accent="emerald"
          label="Timesheet filed"
          value={
            tsLoading || hcLoading
              ? "—"
              : compliancePct != null
                ? `${compliancePct}%`
                : (ts?.submitted_users ?? 0)
          }
        />
        <KpiTile
          icon={<UserMinus className="h-3.5 w-3.5" />}
          accent="amber"
          label="Exits in progress"
          value={hcLoading ? "—" : (headcount?.in_progress_exits ?? 0)}
        />
      </div>

      <div className="grid gap-3.5 md:grid-cols-2">
        {/* Service requests overview */}
        <DashCard>
          <DashHeader
            title="Service requests"
            icon={<ClipboardList className="h-3.5 w-3.5" />}
            accent="blue"
            action={{
              label: "Open queue →",
              onClick: () => navigate({ to: "/service-request/queue/list" }),
            }}
          />
          {srLoading ? (
            <DashSpinner />
          ) : srCards.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {srCards.map((c) => (
                <div
                  key={c.id}
                  className={`rounded-xl px-3 py-2.5 ${SR_CARD_COLORS[c.id] ?? "bg-muted text-foreground"}`}
                >
                  <div className="text-xl font-bold leading-none">
                    {c.value}
                  </div>
                  <div className="mt-1 text-[11px] font-medium">{c.label}</div>
                </div>
              ))}
            </div>
          ) : (
            <DashEmpty icon={ClipboardList} label="No service-request data." />
          )}
        </DashCard>

        {/* Org on leave today */}
        <DashCard>
          <DashHeader
            title="On leave today"
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            accent="violet"
            action={{
              label: "Leave →",
              onClick: () =>
                navigate({ to: "/leave-management/manager-leave-management" }),
            }}
          />
          {leaveLoading ? (
            <DashSpinner />
          ) : (
            <>
              <div className="text-2xl font-bold leading-none text-foreground">
                {onLeave?.total_out ?? 0}
                <span className="ml-1 text-sm font-medium text-muted-foreground">
                  of {onLeave?.total_employees ?? 0} out
                </span>
              </div>
              {onLeave && onLeave.items.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  {onLeave.items.slice(0, 5).map((p) => (
                    <div
                      key={p.user_id}
                      className="flex items-center gap-2 text-[13px]"
                    >
                      <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                        {initials(p.name)}
                      </div>
                      <span className="flex-1 truncate">
                        {p.name ?? "Employee"}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {p.department_name ?? p.leave_type_name ?? "Leave"}
                      </span>
                    </div>
                  ))}
                  {onLeave.items.length > 5 ? (
                    <div className="text-[11px] text-muted-foreground">
                      +{onLeave.items.length - 5} more
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-muted-foreground">
                  Everyone is in today.
                </p>
              )}
            </>
          )}
        </DashCard>

        {/* Timesheet compliance */}
        <DashCard>
          <DashHeader
            title="Timesheet compliance · this week"
            icon={<Clock className="h-3.5 w-3.5" />}
            accent="emerald"
            action={{
              label: "Review →",
              onClick: () => navigate({ to: "/timesheet/employee-timesheets" }),
            }}
          />
          {tsLoading || hcLoading ? (
            <DashSpinner />
          ) : (
            <>
              <div className="text-2xl font-bold leading-none text-foreground">
                {compliancePct != null
                  ? `${compliancePct}%`
                  : (ts?.submitted_users ?? 0)}
                <span className="ml-1 text-sm font-medium text-muted-foreground">
                  {compliancePct != null ? "submitted" : "submitted users"}
                </span>
              </div>
              <div className="mt-3 space-y-1.5 text-[13px]">
                <StatRow
                  label="Submitted users"
                  value={ts?.submitted_users ?? 0}
                />
                <StatRow
                  label="Active employees"
                  value={activeEmployees}
                  muted
                />
                <StatRow
                  label="Timesheets this week"
                  value={ts?.total_timesheets ?? 0}
                  muted
                />
              </div>
            </>
          )}
        </DashCard>

        {/* Headcount snapshot */}
        <DashCard>
          <DashHeader
            title="Headcount"
            icon={<Users className="h-3.5 w-3.5" />}
            accent="primary"
          />
          {hcLoading ? (
            <DashSpinner />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Metric
                icon={<Users className="h-4 w-4" />}
                value={headcount?.active_employees ?? 0}
                label="Active"
                tone="bg-success/10 text-success"
              />
              <Metric
                icon={<CalendarDays className="h-4 w-4" />}
                value={headcount?.new_joiners_this_month ?? 0}
                label="New this month"
                tone="bg-info/10 text-info"
              />
              <Metric
                icon={<UserMinus className="h-4 w-4" />}
                value={headcount?.in_progress_exits ?? 0}
                label="Exits in progress"
                tone="bg-warning/10 text-warning"
              />
            </div>
          )}
        </DashCard>
      </div>
    </div>
  );
}

// ─── small presentational pieces ────────────────────────────────

const KPI_TONES: Record<string, string> = {
  primary: "bg-primary/10 text-primary",
  violet: "bg-primary/10 text-primary",
  blue: "bg-info/10 text-info",
  emerald: "bg-success/10 text-success",
  amber: "bg-warning/10 text-warning",
};

function KpiTile({
  icon,
  accent,
  label,
  value,
}: {
  icon: React.ReactNode;
  accent: string;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <span
          className={`grid h-7 w-7 place-items-center rounded-xl ${KPI_TONES[accent] ?? KPI_TONES.primary}`}
        >
          {icon}
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold leading-none tracking-tight text-foreground">
        {value}
      </div>
    </div>
  );
}

function Metric({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone: string;
}) {
  return (
    <div className={`rounded-xl px-2.5 py-3 text-center ${tone}`}>
      <div className="mx-auto mb-1 w-fit">{icon}</div>
      <div className="text-xl font-bold leading-none">{value}</div>
      <div className="mt-1 text-[10px] font-medium leading-tight">{label}</div>
    </div>
  );
}
