import { useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { Bell, CheckCircle2, Circle, Clock, RefreshCw, Shuffle, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsTeamStatusQuery,
  useGetPmsTransferNoticesQuery,
  useSendGoalsToHodMutation,
} from "@/store/api/pmsApi";
import type { PmsTeamMember } from "@/types/pms-goals";
import { formatDisplayDate } from "../shared/pms.utils";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StatusLabel } from "../shared/StatusLabel";

/** What the row button does (adds "send" for acknowledged sheets). */
type RowAction = "set" | "continue" | "revise" | "send" | "view" | "kras";

/** Label, icon, colour and button action for each goal status. */
const STATUS_META: Record<string, { label: string; icon: LucideIcon; className: string; action: RowAction; actionLabel?: string }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground", action: "set" },
  draft: { label: "Draft", icon: Clock, className: "text-amber-500", action: "continue" },
  sent_to_employee: { label: "Sent to Employee", icon: RefreshCw, className: "text-blue-500", action: "view" },
  acknowledged: { label: "Acknowledged", icon: CheckCircle2, className: "text-emerald-600", action: "send" },
  change_requested: { label: "Returned – change requested", icon: XCircle, className: "text-destructive", action: "revise", actionLabel: "Review & Revise" },
  returned_by_hod: { label: "Returned by HOD for target revision", icon: XCircle, className: "text-destructive", action: "revise" },
  transferred_in: { label: "Transferred in · period 2 KRAs needed", icon: Clock, className: "text-amber-500", action: "kras" },
  with_hod: { label: "With HOD", icon: RefreshCw, className: "text-blue-500", action: "view" },
  approved: { label: "Approved by HOD", icon: CheckCircle2, className: "text-emerald-600", action: "view" },
};

/** Meta for a status; unknown statuses get a neutral label. */
const statusMeta = (status: string) =>
  STATUS_META[status] ?? { label: status.replace(/_/g, " "), icon: Circle, className: "text-muted-foreground", action: "view" as RowAction };

/** Button text per row action. */
const ACTION_LABEL: Record<RowAction, string> = {
  set: "Set Goals",
  continue: "Continue",
  kras: "Set KRAs",
  revise: "Revise",
  send: "Send to HOD",
  view: "View",
};

/** Screen 3.6 - My Team, Goal Status: where each report's goals stand, and sending acknowledged sheets to the HOD. */
const TeamGoalStatusPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  // Team with goal status (3.6) and the transfer notices shown in the banner.
  const { data: team = [], isLoading, isError } = useGetPmsTeamStatusQuery(financialYear);
  const { data: transfers = [] } = useGetPmsTransferNoticesQuery(financialYear);
  // Send-to-HOD mutation and the set of ticked rows.
  const [sendToHod, { isLoading: sending }] = useSendGoalsToHodMutation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // `returned`: employees who asked for a change; `selectable`: acknowledged sheets that can go to the HOD.
  const rows = team;
  const returned = rows.filter((m) => m.goal_status === "change_requested");
  const selectable = rows.filter((m) => m.goal_status === "acknowledged");
  const allSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.user_id));

  /** Ticks or unticks one row. */
  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  /** Ticks every selectable row, or clears the selection when all are ticked. */
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((m) => m.user_id)));

  /** Sends the given acknowledged sheets to the HOD and clears the selection. */
  const send = async (ids: string[]) => {
    try {
      await sendToHod({ financial_year: financialYear, employee_user_ids: ids }).unwrap();
      toast.success(ids.length === 1 ? "Goal sheet sent to the HOD" : `${ids.length} goal sheets sent to the HOD`);
      setSelected(new Set());
    } catch (e) {
      toast.error(e, "Could not send the goal sheets to the HOD");
    }
  };

  /** Row button: "send" sends that one sheet; the others open the matching form. */
  const open = (m: PmsTeamMember, action: RowAction) => {
    if (action === "send") return send([m.user_id]);
    // Targets need the role template first: send the manager to "Create & assign template".
    if (action === "set" && !m.template_assigned) {
      return navigate({ to: "/pms/team-goal-setting/$fy/role", params: { fy } });
    }
    if (action === "kras") {
      return navigate({
        to: "/pms/team-goal-setting/$fy/employee/$employeeUserId/transfer",
        params: { fy, employeeUserId: m.user_id },
      });
    }
    if (action === "revise") {
      return navigate({
        to: "/pms/team-goal-setting/$fy/employee/$employeeUserId/revise",
        params: { fy, employeeUserId: m.user_id },
      });
    }
    return navigate({
      to: "/pms/team-goal-setting/$fy/employee/$employeeUserId",
      params: { fy, employeeUserId: m.user_id },
    });
  };

  if (isLoading) return <PageLoader message="Loading your team…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="My Team – Goal Status"
        subtitle="Your team's goal status — open an employee to review their request"
        action={
          <div className="flex items-center gap-3">
            <FinancialYearTag fy={fy} />
            <Button disabled={selected.size === 0 || sending} onClick={() => send([...selected])}>
              {sending ? "Sending…" : selected.size > 0 ? `Send Selected to HOD (${selected.size})` : "Send Selected to HOD"}
            </Button>
          </div>
        }
      />

      <PmsTableCard>
        {returned.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
            <Bell className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>New:</strong> {returned.map((m) => m.name).join(", ")} returned their goal sheet with a change
              request. Open the employee to review and revise.
            </p>
          </div>
        )}
        {transfers.map((t) => (
          <div
            key={t.employee_user_id}
            className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
          >
            <Shuffle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="flex-1">
              <strong>Transfer:</strong> {t.employee_name} joined your team on {formatDisplayDate(t.joined_on)} from{" "}
              {t.from_department} (previous manager {t.previous_manager}). The transfer was recorded by {t.recorded_by}.
              Their {t.from_department} goals are frozen as period 1 — set their KRAs for period 2.
            </p>
          </div>
        ))}

        {isError && (
          <p className="px-4 py-6 text-sm text-destructive">
            Could not load your team. Check that you are signed in as a reporting manager.
          </p>
        )}
        {!isError && rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">No team members report to you.</p>
        )}
        {rows.length > 0 && (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className={PMS_HEADER_ROW}>
                  <PmsTh className="w-10">
                    <Checkbox
                      aria-label="Select all acknowledged goal sheets"
                      checked={allSelected}
                      disabled={selectable.length === 0}
                      onCheckedChange={toggleAll}
                    />
                  </PmsTh>
                  <PmsTh>Employee</PmsTh>
                  <PmsTh>Role</PmsTh>
                  <PmsTh>Goal status</PmsTh>
                  <PmsTh>Action</PmsTh>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const meta = statusMeta(m.goal_status);
                  const canSelect = m.goal_status === "acknowledged";
                  const primary = meta.action === "revise" || meta.action === "send" || meta.action === "kras";
                  return (
                    <tr key={m.user_id} className="border-t">
                      <td className="px-4 py-3">
                        <Checkbox
                          aria-label={`Select ${m.name}`}
                          checked={selected.has(m.user_id)}
                          disabled={!canSelect}
                          onCheckedChange={() => toggle(m.user_id)}
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">{m.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{m.designation_name || "—"}</td>
                      <td className="px-4 py-3">
                        <StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />
                      </td>
                      <td className="px-4 py-3">
                        {primary ? (
                          <Button size="sm" disabled={sending} onClick={() => open(m, meta.action)}>
                            {meta.actionLabel ?? ACTION_LABEL[meta.action]}
                          </Button>
                        ) : (
                          <Button variant="link" className="h-auto p-0" onClick={() => open(m, meta.action)}>
                            {meta.actionLabel ?? ACTION_LABEL[meta.action]}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-1 pt-4 text-sm text-muted-foreground">
              {selected.size} selected · Only acknowledged goal sheets can be selected and sent to the HOD. Returned
              sheets need your revision first.
            </p>
          </>
        )}
      </PmsTableCard>
    </div>
  );
};

export default TeamGoalStatusPage;
