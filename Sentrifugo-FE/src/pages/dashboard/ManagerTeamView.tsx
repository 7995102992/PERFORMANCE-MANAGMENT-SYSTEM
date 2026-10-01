import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { CalendarDays, ClipboardList, Clock, Users } from "lucide-react";

import { useAppSelector } from "@/store";
import {
  useGetManagerPendingApprovalsQuery,
  useGetTeamAvailabilityQuery,
  useGetTeamLeaveSummaryQuery,
  useGetLeaveTypesQuery,
} from "@/store/api/lmsApi";
import { useGetApprovalDashboardQuery } from "@/store/api/timesheetApi";
import { useGetPendingApprovalsQuery } from "@/store/api/srmApi";
import {
  DashCard,
  DashHeader,
  DashSpinner,
  DashEmpty,
  StatRow,
  initials,
  dateRange,
  ago,
} from "./dashboardUi";

// ─── manager detection ──────────────────────────────────────────

type PermUser =
  | {
      permissions?: Record<string, unknown>;
      organisation_id?: string | null;
    }
  | null
  | undefined;

function actionOn(user: PermUser, moduleKey: string, action: string): boolean {
  const perm = user?.permissions?.[moduleKey] as
    | { actions?: Record<string, boolean> }
    | undefined;
  return !!perm?.actions?.[action];
}

export function isManager(user: PermUser): boolean {
  if (!user) return false;
  return (
    actionOn(user, "leave_management", "manage_leave_request") ||
    actionOn(user, "service_request", "manage_request") ||
    actionOn(user, "service_request", "approve_request") ||
    actionOn(user, "timesheet_management", "manage_timesheet")
  );
}

// ─── types ─────────────────────────────────────────────────────

type ApprovalItem = {
  key: string;
  kind: "leave" | "sr";
  name: string;
  detail: string;
  createdOn?: string | null;
  onClick: () => void;
};

// ─── component ──────────────────────────────────────────────────

export function ManagerTeamView() {
  const navigate = useNavigate();
  const user = useAppSelector((s) => s.auth.user);
  const orgId = user?.organisation_id ?? "";

  const now = new Date();
  const today = format(now, "yyyy-MM-dd");
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  const { data: leavePending = [], isLoading: leaveLoading } =
    useGetManagerPendingApprovalsQuery();
  // scope=awaiting_me: only rows this manager can actually act on. Without it
  // the widened endpoint also returns their whole reporting tree's ticket
  // history, which would list here as "pending approval" work.
  const { data: srPending, isLoading: srLoading } = useGetPendingApprovalsQuery({
    scope: "awaiting_me",
    page_size: 50,
  });
  const { data: leaveTypes = [] } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId,
  });
  const { data: availability, isLoading: availLoading } =
    useGetTeamAvailabilityQuery({
      start_date: today,
      end_date: today,
    });
  const { data: tsDash, isLoading: tsLoading } = useGetApprovalDashboardQuery({
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  });
  const { data: teamLeave, isLoading: summaryLoading } =
    useGetTeamLeaveSummaryQuery({
      from_date: monthStart,
      to_date: monthEnd,
    });

  const leaveTypeName = useMemo(() => {
    const map = new Map(leaveTypes.map((t) => [t._id, t.name]));
    return (id: string) => map.get(id) ?? "Leave";
  }, [leaveTypes]);

  const approvals: ApprovalItem[] = useMemo(() => {
    const items: ApprovalItem[] = [];
    for (const lr of leavePending) {
      const days = lr.duration_days
        ? ` (${lr.duration_days} day${lr.duration_days === 1 ? "" : "s"})`
        : "";
      items.push({
        key: `lv-${lr._id}`,
        kind: "leave",
        name: lr.employee_name || "Employee",
        detail: `${leaveTypeName(lr.leave_type_id)} · ${dateRange(lr.start_date, lr.end_date)}${days}`,
        createdOn: lr.created_on,
        onClick: () =>
          navigate({ to: "/leave-management/manager-leave-management" }),
      });
    }
    for (const r of srPending?.items ?? []) {
      items.push({
        key: `sr-${r.id}`,
        kind: "sr",
        name: r.requester_name || "Employee",
        detail: `${r.ticket_no} · ${r.title}`,
        createdOn: r.created_on,
        onClick: () => navigate({ to: "/service-request/approval-queue/list" }),
      });
    }
    return items.sort(
      (a, b) =>
        (b.createdOn ? new Date(b.createdOn).getTime() : 0) -
        (a.createdOn ? new Date(a.createdOn).getTime() : 0),
    );
  }, [leavePending, srPending, leaveTypeName, navigate]);

  const today0 = availability?.daily_availability?.[0];
  const onLeaveToday = today0?.on_leave ?? [];

  const pendingTs = (tsDash?.submitted ?? 0) + (tsDash?.resubmitted ?? 0);

  const summaryTypes = teamLeave?.summary_by_type ?? [];
  const maxTypeDays = Math.max(1, ...summaryTypes.map((t) => t.total_days));

  return (
    <div className="space-y-3.5">
      {/* ── Approvals queue ─────────────────────────────────── */}
      <ApprovalsQueue items={approvals} loading={leaveLoading || srLoading} />

      {/* ── Team cards ──────────────────────────────────────── */}
      <div className="grid gap-3.5 md:grid-cols-3">
        {/* Who's out today */}
        <DashCard>
          <DashHeader
            icon={<Users className="h-3.5 w-3.5" />}
            accent="violet"
            title="Who's out today"
            action={{
              label: "Team calendar →",
              onClick: () =>
                navigate({ to: "/leave-management/manager-leave-management" }),
            }}
          />
          {availLoading ? (
            <DashSpinner />
          ) : (
            <>
              <div className="text-2xl font-bold leading-none text-foreground">
                {today0?.on_leave_count ?? onLeaveToday.length}
                <span className="ml-1 text-sm font-medium text-muted-foreground">
                  of {availability?.total_team_size ?? 0} out
                </span>
              </div>
              {onLeaveToday.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  {onLeaveToday.slice(0, 5).map((p) => (
                    <div
                      key={p.request_id}
                      className="flex items-center gap-2 text-[13px]"
                    >
                      <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                        {initials(p.employee_name)}
                      </div>
                      <span className="flex-1 truncate">{p.employee_name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {p.leave_type_name}
                        {p.duration_mode === "HALF_DAY" ? " · half" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-muted-foreground">
                  Everyone on your team is in today.
                </p>
              )}
            </>
          )}
        </DashCard>

        {/* Team timesheet compliance */}
        <DashCard>
          <DashHeader
            icon={<Clock className="h-3.5 w-3.5" />}
            accent="emerald"
            title="Team timesheets"
            action={{
              label: "Review →",
              onClick: () => navigate({ to: "/timesheet/manager-approval" }),
            }}
          />
          {tsLoading ? (
            <DashSpinner />
          ) : (
            <>
              <div className="text-2xl font-bold leading-none text-foreground">
                {pendingTs}
                <span className="ml-1 text-sm font-medium text-muted-foreground">
                  awaiting approval
                </span>
              </div>
              <div className="mt-3 space-y-1.5 text-[13px]">
                <StatRow label="Submitted" value={tsDash?.submitted ?? 0} />
                <StatRow label="Resubmitted" value={tsDash?.resubmitted ?? 0} />
                <StatRow label="Approved" value={tsDash?.l1_approved ?? 0} />
                <StatRow
                  label="Total this period"
                  value={tsDash?.total ?? 0}
                  muted
                />
              </div>
            </>
          )}
        </DashCard>

        {/* Team leave summary (this month) */}
        <DashCard>
          <DashHeader
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            accent="amber"
            title="Team leave · this month"
            action={{
              label: "Details →",
              onClick: () =>
                navigate({ to: "/leave-management/manager-leave-management" }),
            }}
          />
          {summaryLoading ? (
            <DashSpinner />
          ) : summaryTypes.length > 0 ? (
            <>
              <div className="mb-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {teamLeave?.employees_with_leaves ?? 0}
                </span>{" "}
                of {teamLeave?.total_employees ?? 0} took leave
              </div>
              <div className="space-y-2">
                {summaryTypes.slice(0, 5).map((t) => (
                  <div
                    key={t.leave_type_id}
                    className="grid grid-cols-[1fr_auto] items-center gap-2 text-[13px]"
                  >
                    <div className="min-w-0">
                      <div className="mb-1 flex justify-between gap-2">
                        <span className="truncate">{t.leave_type_name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {t.total_days}d · {t.total_requests} req
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded bg-muted">
                        <div
                          className="h-full rounded bg-primary"
                          style={{
                            width: `${(t.total_days / maxTypeDays) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <DashEmpty icon={CalendarDays} label="No team leave this month." />
          )}
        </DashCard>
      </div>
    </div>
  );
}

// ─── approvals queue card ───────────────────────────────────────

function ApprovalsQueue({
  items,
  loading,
}: {
  items: ApprovalItem[];
  loading: boolean;
}) {
  const [tab, setTab] = useState<"all" | "leave" | "sr">("all");
  const counts = {
    all: items.length,
    leave: items.filter((i) => i.kind === "leave").length,
    sr: items.filter((i) => i.kind === "sr").length,
  };
  const filtered = items.filter((i) => tab === "all" || i.kind === tab);

  return (
    <div className="rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2.5 text-sm font-semibold text-foreground tracking-tight">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <ClipboardList className="h-3.5 w-3.5" />
          </span>
          Pending approvals
          {counts.all > 0 ? (
            <span className="rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-white">
              {counts.all}
            </span>
          ) : null}
        </h3>
        <div
          role="tablist"
          className="flex items-center gap-1 rounded-xl bg-muted p-0.5 text-xs"
        >
          <PillTab active={tab === "all"} onClick={() => setTab("all")}>
            All ({counts.all})
          </PillTab>
          <PillTab active={tab === "leave"} onClick={() => setTab("leave")}>
            Leave ({counts.leave})
          </PillTab>
          <PillTab active={tab === "sr"} onClick={() => setTab("sr")}>
            SR ({counts.sr})
          </PillTab>
        </div>
      </div>

      {loading ? (
        <DashSpinner />
      ) : filtered.length > 0 ? (
        <div className="divide-y">
          {filtered.slice(0, 8).map((item) => (
            <button
              key={item.key}
              onClick={item.onClick}
              className="flex w-full items-center gap-3 py-3 text-left transition hover:bg-muted/40"
            >
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-info/10 text-[11px] font-semibold text-info">
                {initials(item.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.name}</div>
                <div className="truncate text-[13px] text-muted-foreground">
                  {item.detail}
                </div>
              </div>
              <div className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                {ago(item.createdOn)}
              </div>
              <span
                className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold ${
                  item.kind === "leave"
                    ? "bg-warning/10 text-warning"
                    : "bg-info/10 text-info"
                }`}
              >
                {item.kind === "leave" ? "Leave" : "Service Ticket"}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <DashEmpty
          icon={ClipboardList}
          label="Nothing awaiting your approval."
        />
      )}
    </div>
  );
}

// ─── small presentational pieces ────────────────────────────────

function PillTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 font-medium transition ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
