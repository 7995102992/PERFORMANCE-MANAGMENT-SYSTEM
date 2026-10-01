import { useMemo, useState } from "react";
import { parseISO } from "date-fns";
import { ClipboardList } from "lucide-react";

import { useAppSelector } from "@/store";
import {
  useGetManagerPendingApprovalsQuery,
  useGetLeaveTypesQuery,
} from "@/store/api/lmsApi";
import { useGetPendingApprovalsQuery } from "@/store/api/srmApi";
import { useGetTeamTimesheetsQuery } from "@/store/api/timesheetApi";
import {
  DashCard,
  DashEmpty,
  DashList,
  DashSpinner,
  DashStatus,
  DashTabList,
  DashTab,
  TimeAgo,
  initials,
  dateRange,
} from "./dashboardUi";

const CARD_H = "h-[340px]";

// ─── permission helpers ─────────────────────────────────────────

type PermUser = { permissions?: Record<string, unknown> } | null | undefined;

function actionOn(user: PermUser, moduleKey: string, action: string): boolean {
  const perm = user?.permissions?.[moduleKey] as
    | { actions?: Record<string, boolean> }
    | undefined;
  return !!perm?.actions?.[action];
}

export const canApproveLeave = (u: PermUser) =>
  actionOn(u, "leave_management", "manage_leave_request");
export const canApproveSR = (u: PermUser) =>
  actionOn(u, "service_request", "manage_request") ||
  actionOn(u, "service_request", "approve_request");
export const canManageTimesheet = (u: PermUser) =>
  actionOn(u, "timesheet_management", "manage_timesheet");

// ─── Employee Request (team leave + SR pending approval) ─────────

type ReqRow = {
  key: string;
  kind: "leave" | "sr";
  name: string;
  detail: string;
  createdOn?: string | null;
};

export function EmployeeRequestCard() {
  const user = useAppSelector((s) => s.auth.user);
  const orgId = user?.organisation_id ?? "";
  const showLeave = canApproveLeave(user);
  const showSr = canApproveSR(user);

  const { data: leavePending = [], isLoading: leaveLoading } =
    useGetManagerPendingApprovalsQuery(undefined, { skip: !showLeave });
  const { data: srPending, isLoading: srLoading } = useGetPendingApprovalsQuery(
    // scope=awaiting_me: only rows this manager can actually act on. Without it
    // the widened endpoint also returns their whole reporting tree's ticket
    // history, which would list here as "pending approval" work.
    { scope: "awaiting_me", page_size: 20 },
    { skip: !showSr },
  );
  const { data: leaveTypes = [] } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId || !showLeave,
  });

  const leaveTypeName = useMemo(() => {
    const map = new Map(leaveTypes.map((t) => [t._id, t.name]));
    return (id: string) => map.get(id) ?? "Leave";
  }, [leaveTypes]);

  const rows: ReqRow[] = useMemo(() => {
    const items: ReqRow[] = [];
    for (const lr of leavePending) {
      const days = lr.duration_days
        ? ` (${lr.duration_days} Day${lr.duration_days === 1 ? "" : "s"})`
        : "";
      items.push({
        key: `lv-${lr._id}`,
        kind: "leave",
        name: lr.employee_name || lr.employee_email || "Employee",
        detail: `${leaveTypeName(lr.leave_type_id)} · ${dateRange(lr.start_date, lr.end_date)}${days}`,
        createdOn: lr.created_on,
      });
    }
    for (const r of srPending?.items ?? []) {
      items.push({
        key: `sr-${r.id}`,
        kind: "sr",
        name: r.requester_name || "Employee",
        detail: `${r.ticket_no} · ${r.title}`,
        createdOn: r.created_on,
      });
    }
    return items.sort(
      (a, b) =>
        (b.createdOn ? parseISO(b.createdOn).getTime() : 0) -
        (a.createdOn ? parseISO(a.createdOn).getTime() : 0),
    );
  }, [leavePending, srPending, leaveTypeName]);

  const tabs: Array<{ key: "all" | "leave" | "sr"; label: string }> = [
    { key: "all", label: "All" },
    ...(showLeave ? ([{ key: "leave", label: "Leave" }] as const) : []),
    ...(showSr ? ([{ key: "sr", label: "Service Ticket" }] as const) : []),
  ];
  const [tab, setTab] = useState<"all" | "leave" | "sr">("all");
  const filtered = rows.filter((r) => tab === "all" || r.kind === tab);
  const loading = (showLeave && leaveLoading) || (showSr && srLoading);

  return (
    <DashCard className={CARD_H}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">
          Employee Requests
        </h3>
        <DashTabList>
          {tabs.map((t) => (
            <DashTab
              key={t.key}
              active={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </DashTab>
          ))}
        </DashTabList>
      </div>
      {loading ? (
        <DashSpinner />
      ) : filtered.length > 0 ? (
        <DashList>
          {filtered.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-3 py-3 first:pt-0"
            >
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-info/10 text-[10px] font-semibold text-info">
                {initials(r.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{r.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.detail}
                </div>
              </div>
              <TimeAgo iso={r.createdOn} />
              <DashStatus label="Pending" tone="pending" />
            </div>
          ))}
        </DashList>
      ) : (
        <DashEmpty
          icon={ClipboardList}
          label="Nothing pending your approval."
        />
      )}
    </DashCard>
  );
}

// ─── Employee Timesheet (team timesheets pending review) ─────────

export function EmployeeTimesheetCard() {
  const { data, isLoading } = useGetTeamTimesheetsQuery({
    timesheet_status: "submitted",
    page_size: 10,
  });

  const rows = useMemo(() => {
    const out: {
      key: string;
      name: string;
      range: string;
      submittedAt?: string | null;
    }[] = [];
    for (const bucket of data?.items ?? []) {
      for (const w of bucket.weeks ?? []) {
        out.push({
          key: `${bucket.user_id}-${w.id}`,
          name: bucket.user_name || "Employee",
          range: dateRange(w.week_start_date, w.week_end_date, "dd-MMM-yyyy"),
          submittedAt: w.submitted_at,
        });
      }
    }
    return out
      .sort(
        (a, b) =>
          (b.submittedAt ? parseISO(b.submittedAt).getTime() : 0) -
          (a.submittedAt ? parseISO(a.submittedAt).getTime() : 0),
      )
      .slice(0, 40);
  }, [data]);

  return (
    <DashCard className={CARD_H}>
      <h3 className="mb-3 text-sm font-semibold text-foreground tracking-tight">
        Employee Timesheets
      </h3>
      {isLoading ? (
        <DashSpinner />
      ) : rows.length > 0 ? (
        <DashList>
          {rows.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-3 py-3 first:pt-0"
            >
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-info/10 text-[10px] font-semibold text-info">
                {initials(r.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{r.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.range}
                </div>
              </div>
              <TimeAgo iso={r.submittedAt} />
              <DashStatus label="Pending" tone="pending" />
            </div>
          ))}
        </DashList>
      ) : (
        <DashEmpty icon={ClipboardList} label="No timesheets pending review." />
      )}
    </DashCard>
  );
}
