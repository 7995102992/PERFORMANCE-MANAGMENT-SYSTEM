import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { parseISO } from "date-fns";
import {
  Award,
  CalendarDays,
  Clock,
  ClipboardList,
  Cake,
  Megaphone,
  Paperclip,
} from "lucide-react";

import { useAppSelector } from "@/store";
import { useAuth } from "@/hooks/use-auth";
import {
  useGetLeaveBalancesQuery,
  useGetMyLeaveRequestsQuery,
  useGetLeaveTypesQuery,
} from "@/store/api/lmsApi";
import type { LeaveBalanceItem } from "@/types/leave";
import { useGetMyTimesheetsQuery } from "@/store/api/timesheetApi";
import { useGetRequestsQuery } from "@/store/api/srmApi";
import {
  useGetOrgBirthdaysQuery,
  type BirthdayItem,
} from "@/store/api/iamApi";
import { useGetMyAnnouncementsQuery } from "@/store/api/announcementsApi";
import {
  DashCard,
  DashEmpty,
  DashList,
  DashSpinner,
  DashStatus,
  DashTabList,
  DashTab,
  SectionLabel,
  TimeAgo,
  fmtDate,
  dateRange,
  type DashTone,
} from "./dashboardUi";
import {
  EmployeeRequestCard,
  EmployeeTimesheetCard,
  canApproveLeave,
  canApproveSR,
  canManageTimesheet,
} from "./teamCards";
import { HolidayCalendarCard } from "./HolidayCalendarCard";

// ─── helpers ────────────────────────────────────────────────────

const CARD_H = "h-[340px]";

const LEAVE_BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--info)",
];

type Status = { label: string; tone: DashTone };

function leaveStatus(s: string): Status {
  switch (s) {
    case "APPROVED":
      return { label: "Approved", tone: "success" };
    case "REJECTED":
      return { label: "Rejected", tone: "destructive" };
    case "CANCELLED":
      return { label: "Cancelled", tone: "muted" };
    default:
      return { label: "Pending", tone: "pending" };
  }
}

function srStatus(s: string): Status {
  if (["resolved", "closed"].includes(s))
    return { label: "Resolved", tone: "success" };
  if (["rejected", "withdrawn"].includes(s))
    return { label: "Rejected", tone: "destructive" };
  return {
    label:
      s === "pending_approval" || s === "submitted"
        ? "Pending"
        : s
            .split("_")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" "),
    tone: "pending",
  };
}

function tsStatus(s: string): Status {
  if (["l1_approved", "client_approved"].includes(s))
    return { label: "Approved", tone: "success" };
  if (["l1_rejected", "client_rejected"].includes(s))
    return { label: "Rejected", tone: "destructive" };
  if (s === "draft") return { label: "Draft", tone: "muted" };
  return { label: "Pending", tone: "pending" };
}

// ─── component ──────────────────────────────────────────────────

export function MyView() {
  const user = useAppSelector((s) => s.auth.user);
  // Team cards are manager-only: the role gate (same signal as the sidebar's
  // minRole="manager" items) hides them for plain employees even when their
  // policy carries approval actions.
  const { role, hasNoPermissions } = useAuth();
  const isManager = role !== "employee";
  const showRequests =
    !hasNoPermissions && isManager && (canApproveLeave(user) || canApproveSR(user));
  const showTimesheets =
    !hasNoPermissions && isManager && canManageTimesheet(user);

  return (
    <div className="space-y-5">
      {!hasNoPermissions && (
        <section>
          <SectionLabel>My Overview</SectionLabel>
          <div className="grid gap-3.5 lg:grid-cols-3">
            <MyTimesheetCard />
            <MyLeavesCard />
            <MyRequestsCard />
          </div>
        </section>
      )}

      {(showRequests || showTimesheets) && (
        <section>
          <SectionLabel>Team Overview</SectionLabel>
          <div
            className={`grid gap-3.5 ${showRequests && showTimesheets ? "lg:grid-cols-2" : ""}`}
          >
            {showRequests ? <EmployeeRequestCard /> : null}
            {showTimesheets ? <EmployeeTimesheetCard /> : null}
          </div>
        </section>
      )}

      <section>
        <SectionLabel>Calendar & Events</SectionLabel>
        <div className="grid gap-3.5 lg:grid-cols-3">
          {!hasNoPermissions && <HolidayCalendarCard />}
          <BirthdaysCard />
          {/* Announcements are baseline employee content — an employee holding
              only core_hr.view_announcements still reports hasNoPermissions
              (no module *actions*), so this card is never permission-gated on
              the client. The feed itself is authorised server-side. */}
          <AnnouncementsCard />
        </div>
      </section>
    </div>
  );
}

// ─── My Requests ────────────────────────────────────────────────

type RequestRow = {
  key: string;
  kind: "leave" | "sr";
  title: string;
  sub: string;
  status: Status;
  createdOn?: string | null;
};

function MyRequestsCard() {
  const [tab, setTab] = useState<"all" | "leave" | "sr">("all");
  const user = useAppSelector((s) => s.auth.user);
  const orgId = user?.organisation_id ?? "";

  const { data: leaveData, isLoading: leaveLoading } =
    useGetMyLeaveRequestsQuery({
      page_size: 20,
      sort: "-created_on",
    });
  const { data: srData, isLoading: srLoading } = useGetRequestsQuery({
    my_requests: true,
    page_size: 20,
  });
  const { data: leaveTypes = [] } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId,
  });

  const leaveTypeName = useMemo(() => {
    const map = new Map(leaveTypes.map((t) => [t._id, t.name]));
    return (id: string) => map.get(id) ?? "Leave";
  }, [leaveTypes]);

  const rows: RequestRow[] = useMemo(() => {
    const items: RequestRow[] = [];
    for (const lr of leaveData?.items ?? []) {
      const days = lr.duration_days
        ? ` (${lr.duration_days} Day${lr.duration_days === 1 ? "" : "s"})`
        : "";
      items.push({
        key: `lv-${lr._id}`,
        kind: "leave",
        title: leaveTypeName(lr.leave_type_id),
        sub: `${dateRange(lr.start_date, lr.end_date, "dd-MMM-yyyy")}${days}`,
        status: leaveStatus(lr.status),
        createdOn: lr.created_on,
      });
    }
    for (const r of srData?.items ?? []) {
      items.push({
        key: `sr-${r.id}`,
        kind: "sr",
        title: r.title || r.request_type_name || "Service Ticket",
        sub: `${fmtDate(r.created_on, "dd-MMM-yyyy")} · ${r.ticket_no}`,
        status: srStatus(r.status),
        createdOn: r.created_on,
      });
    }
    return items.sort(
      (a, b) =>
        (b.createdOn ? parseISO(b.createdOn).getTime() : 0) -
        (a.createdOn ? parseISO(a.createdOn).getTime() : 0),
    );
  }, [leaveData, srData, leaveTypeName]);

  const filtered = rows.filter((r) => tab === "all" || r.kind === tab);
  const loading = leaveLoading || srLoading;

  return (
    <DashCard className={CARD_H}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">
          My Requests
        </h3>
        <DashTabList>
          <DashTab active={tab === "all"} onClick={() => setTab("all")}>
            All
          </DashTab>
          <DashTab active={tab === "leave"} onClick={() => setTab("leave")}>
            Leave
          </DashTab>
          <DashTab active={tab === "sr"} onClick={() => setTab("sr")}>
            Service Ticket
          </DashTab>
        </DashTabList>
      </div>
      {loading ? (
        <DashSpinner />
      ) : filtered.length > 0 ? (
        <DashList>
          {filtered.map((r) => (
            <div
              key={r.key}
              className="flex items-start justify-between gap-3 py-3 first:pt-0"
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">
                  {r.title}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {r.sub}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <TimeAgo iso={r.createdOn} />
                <DashStatus label={r.status.label} tone={r.status.tone} />
              </div>
            </div>
          ))}
        </DashList>
      ) : (
        <DashEmpty icon={ClipboardList} label="No requests yet." />
      )}
    </DashCard>
  );
}

// ─── My Timesheet ───────────────────────────────────────────────

function MyTimesheetCard() {
  const { data, isLoading } = useGetMyTimesheetsQuery({ page_size: 12 });
  const weeks = data?.items ?? [];

  const avg = useMemo(() => {
    if (weeks.length === 0) return null;
    const total = weeks.reduce((s, w) => s + (w.total_hours || 0), 0);
    return Math.round((total / weeks.length) * 10) / 10;
  }, [weeks]);

  return (
    <DashCard className={CARD_H}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">
          My Timesheet
        </h3>
        <div className="flex items-baseline gap-2 text-xs">
          <span className="text-muted-foreground">Average Weekly Hours</span>
          <span className="text-lg font-bold leading-none text-info">
            {avg ?? "—"}
          </span>
        </div>
      </div>
      {isLoading ? (
        <DashSpinner />
      ) : weeks.length > 0 ? (
        <DashList>
          {weeks.map((w) => {
            const st = tsStatus(w.timesheet_status);
            const weekNo = Math.ceil(parseISO(w.week_start_date).getDate() / 7);
            return (
              <div
                key={w.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">Week {weekNo}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {dateRange(w.week_start_date, w.week_end_date, "dd-MMM-yyyy")}
                  </div>
                </div>
                <DashStatus label={st.label} tone={st.tone} />
              </div>
            );
          })}
        </DashList>
      ) : (
        <DashEmpty icon={Clock} label="No timesheets yet." />
      )}
    </DashCard>
  );
}

// ─── My Leave Balance ───────────────────────────────────────────

function MyLeavesCard() {
  // Sourced from GET /leave-requests/balances — the same endpoint the Leave
  // Management balance panel uses, so the two screens can't disagree. NB: this
  // is gated by the leave type's `show_in_leave_balance` flag, whereas the old
  // analytics feed was gated by `show_in_analytics`.
  const { data, isLoading } = useGetLeaveBalancesQuery();
  // Memoised so the `?? []` fallback doesn't mint a new array each render and
  // invalidate the two useMemos below.
  const balances = useMemo(() => data?.balances ?? [], [data]);
  // This endpoint carries no entitlement, so the bars are scaled against the
  // largest available balance (matching the Leave Management panel) rather than
  // against an allocation.
  const maxAvailable = useMemo(
    () => Math.max(...balances.map((b) => availableFor(b)), 1),
    [balances],
  );
  // Hour-based types are excluded from the total rather than summed into a
  // day figure — mixing the two units would produce a meaningless number.
  const totalAvailable = useMemo(() => {
    const sum = balances
      .filter((b) => b.unit !== "HOURS")
      .reduce((s, b) => s + (b.available_days ?? 0), 0);
    return Math.round(sum * 10) / 10;
  }, [balances]);

  return (
    <DashCard className={CARD_H}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">
          My Leave Balance
        </h3>
        {totalAvailable > 0 ? (
          <div className="flex items-baseline gap-2 text-xs">
            <span className="text-muted-foreground">Total Available</span>
            <span className="text-lg font-bold leading-none text-info">
              {totalAvailable}
            </span>
          </div>
        ) : null}
      </div>
      {isLoading ? (
        <DashSpinner />
      ) : balances.length > 0 ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-x-5 gap-y-4 overflow-y-auto thin-scrollbar">
          {balances.map((b, i) => (
            <LeaveBar
              key={b.leave_type_id}
              balance={b}
              max={maxAvailable}
              color={LEAVE_BAR_COLORS[i % LEAVE_BAR_COLORS.length]}
            />
          ))}
        </div>
      ) : (
        <DashEmpty icon={CalendarDays} label="No leave balances." />
      )}
    </DashCard>
  );
}

/** Spendable balance in the type's own unit (hours for HOURS types). */
function availableFor(balance: LeaveBalanceItem): number {
  return balance.unit === "HOURS"
    ? (balance.available_hours ?? 0)
    : (balance.available_days ?? 0);
}

function LeaveBar({
  balance,
  max,
  color,
}: {
  balance: LeaveBalanceItem;
  /** Largest available balance on the card — the bar's 100% reference. */
  max: number;
  color: string;
}) {
  const available = availableFor(balance);
  const pct = Math.min(100, Math.max(0, (available / max) * 100));
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="truncate">{balance.leave_type_name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {/* Display-only rounding. The API returns the exact stored balance
              because entitlement.fractional_balance.mode owns real rounding —
              an "exact" plan legitimately holds 1.6666666666666667 days, which
              must not be printed raw. Matches the card's Total Available. */}
          {Math.round(available * 10) / 10}
          {balance.unit === "HOURS" ? "h" : "d"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

// ─── Birthdays & Anniversaries ──────────────────────────────────

function CelebrationRow({
  item,
  highlight,
}: {
  item: BirthdayItem;
  highlight?: boolean;
}) {
  const anniversary = item.type === "anniversary";
  const Icon = anniversary ? Award : Cake;
  return (
    <div
      className={`flex items-center gap-2.5 text-[13px] ${
        highlight
          ? "mb-2 rounded-xl bg-primary/5 px-3 py-2.5"
          : "py-2.5"
      }`}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className={`truncate ${highlight ? "font-medium" : ""}`}>
          {item.name}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {anniversary
            ? `Work Anniversary${item.years ? ` · ${item.years} yr${item.years > 1 ? "s" : ""}` : ""}`
            : "Birthday"}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {highlight ? "Today" : fmtDate(item.date, "dd-MMM-yyyy")}
      </span>
    </div>
  );
}

function BirthdaysCard() {
  const { data, isLoading } = useGetOrgBirthdaysQuery();
  const today = data?.today ?? [];
  const upcoming = (data?.upcoming ?? []).slice(
    0,
    Math.max(0, 7 - today.length),
  );

  return (
    <DashCard className={CARD_H}>
      <h3 className="mb-3 text-sm font-semibold text-foreground tracking-tight">
        Birthdays & Anniversaries
      </h3>
      {isLoading ? (
        <DashSpinner />
      ) : today.length === 0 && upcoming.length === 0 ? (
        <DashEmpty icon={Cake} label="No birthdays or anniversaries coming up." />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
          {today.map((b) => (
            <CelebrationRow key={`${b.type}-${b.user_id}`} item={b} highlight />
          ))}
          {upcoming.length > 0 ? (
            <div className="divide-y divide-dashed">
              {upcoming.map((b) => (
                <CelebrationRow key={`${b.type}-${b.user_id}`} item={b} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </DashCard>
  );
}

// ─── Company Announcements ──────────────────────────────────────

function AnnouncementsCard() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useGetMyAnnouncementsQuery({ limit: 5 });

  // Fail quiet: a 403 (no view_announcements) or a transient failure falls back
  // to the empty state rather than surfacing a raw error on the dashboard.
  const items = isError ? [] : (data ?? []);

  return (
    <DashCard className={CARD_H}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">
          Company Announcements
        </h3>
        {/* Only offered once there is more than this card can hold — with 5 or
            fewer the card already IS the full list. */}
        {items.length >= 5 && (
          <button
            type="button"
            onClick={() => navigate({ to: "/my-announcements" })}
            className="shrink-0 text-xs text-primary hover:underline"
          >
            View all
          </button>
        )}
      </div>
      {isLoading ? (
        <DashSpinner />
      ) : items.length > 0 ? (
        <DashList>
          {items.map((a) => {
            // Same paperclip + count treatment as the admin list's Attachments
            // column, so an employee can tell a post carries files before
            // opening it. Nothing is rendered when there are none.
            const attachmentCount = a.attachments?.length ?? 0;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() =>
                  navigate({
                    to: "/my-announcements/$announcementId",
                    params: { announcementId: a.id },
                  })
                }
                className="flex w-full items-center justify-between gap-3 py-3 text-left first:pt-0"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {a.title}
                </span>
                <span className="flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground">
                  {attachmentCount > 0 && (
                    <span
                      className="flex items-center gap-1"
                      aria-label={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
                    >
                      <Paperclip className="size-3 shrink-0" />
                      <span className="tabular-nums">{attachmentCount}</span>
                    </span>
                  )}
                  <span>{fmtDate(a.posted_date, "d MMM yyyy")}</span>
                </span>
              </button>
            );
          })}
        </DashList>
      ) : (
        <DashEmpty icon={Megaphone} label="No announcements yet." />
      )}
    </DashCard>
  );
}
