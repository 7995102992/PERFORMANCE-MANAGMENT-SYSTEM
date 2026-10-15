import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Circle, Clock, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsTeamQuery } from "@/store/api/pmsApi";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StageWindowBanner } from "../shared/StageWindowBanner";
import { StatusLabel } from "../shared/StatusLabel";
import { SendToHodDialog } from "./SendToHodDialog";

/** What the row button does. */
type RowAction = "set" | "continue" | "revise" | "view" | "kras";

/** Label, icon, colour and button action for each goal status. */
const STATUS_META: Record<string, { label: string; icon: LucideIcon; className: string; action: RowAction }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground", action: "set" },
  draft: { label: "Draft", icon: Clock, className: "text-amber-500", action: "continue" },
  sent_to_employee: { label: "Sent to Employee", icon: RefreshCw, className: "text-blue-500", action: "view" },
  acknowledged: { label: "Acknowledged", icon: CheckCircle2, className: "text-emerald-600", action: "view" },
  change_requested: { label: "Change Requested", icon: XCircle, className: "text-destructive", action: "revise" },
  returned_by_hod: { label: "Returned by HOD", icon: XCircle, className: "text-destructive", action: "revise" },
  transferred_in: { label: "Transferred in", icon: Clock, className: "text-amber-500", action: "kras" },
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
  revise: "Revise",
  kras: "Set KRAs",
  view: "View",
};

/** Screen 3.1 - My Team: the manager's eligible team members and where each one's goals stand. */
const TeamGoalSettingPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  // The manager direct reports and their goal status.
  const { data: team = [], isLoading, isError } = useGetPmsTeamQuery(financialYear);
  // The acknowledged employee whose "Send to HOD" dialog is open.
  const [sendFor, setSendFor] = useState<(typeof team)[number] | null>(null);

  /** Opens the form that matches the action: transfer KRAs, revise, or the target assignment form. */
  const open = (userId: string, action: RowAction) => {
    // Targets need the role template first: send the manager to "Create & assign template".
    if (action === "set" && !team.find((m) => m.user_id === userId)?.template_assigned) {
      return navigate({ to: "/pms/team-goal-setting/$fy/role", params: { fy } });
    }
    if (action === "kras") {
      return navigate({
        to: "/pms/team-goal-setting/$fy/employee/$employeeUserId/transfer",
        params: { fy, employeeUserId: userId },
      });
    }
    if (action === "revise") {
      return navigate({
        to: "/pms/team-goal-setting/$fy/employee/$employeeUserId/revise",
        params: { fy, employeeUserId: userId },
      });
    }
    return navigate({
      to: "/pms/team-goal-setting/$fy/employee/$employeeUserId",
      params: { fy, employeeUserId: userId },
    });
  };

  if (isLoading) return <PageLoader message="Loading your team…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="My Team"
        subtitle="Eligible team members and their goal status"
        action={
          <div className="flex items-center gap-3">
            <FinancialYearTag
              fy={fy}
              onChange={(next) => navigate({ to: "/pms/team-goal-setting/$fy", params: { fy: next } })}
            />
            <Button onClick={() => navigate({ to: "/pms/team-goal-setting/$fy/role", params: { fy } })}>
              Set Goals
            </Button>
          </div>
        }
      />

      <StageWindowBanner stage="goal_setting" financialYear={fyToApi(Number(fy))} />

      <PmsTableCard>
        {isError && (
          <p className="px-4 py-6 text-sm text-destructive">
            Could not load your team. Check that you are signed in as a reporting manager.
          </p>
        )}
        {!isError && team.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">No team members report to you.</p>
        )}
        {team.length > 0 && (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className={PMS_HEADER_ROW}>
                  <PmsTh>Employee</PmsTh>
                  <PmsTh>Role</PmsTh>
                  <PmsTh>Template</PmsTh>
                  <PmsTh>Goal status</PmsTh>
                  <PmsTh>Action</PmsTh>
                </tr>
              </thead>
              <tbody>
                {team.map((m) => {
                  const meta = statusMeta(m.goal_status);
                  const underlined = meta.action === "set" || meta.action === "revise";
                  return (
                    <tr key={m.user_id} className="border-t">
                      <td className="px-4 py-3 text-foreground">{m.name}</td>
                      <td className="px-4 py-3 text-foreground">{m.designation_name || "—"}</td>
                      <td className="px-4 py-3 text-foreground">{m.template_name || "—"}</td>
                      <td className="px-4 py-3">
                        <StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />
                      </td>
                      <td className="px-4 py-3">
                        {m.goal_status === "acknowledged" ? (
                          // The employee acknowledged: the manager sends the sheet (with any revised KRAs) to the HOD.
                          <Button size="sm" onClick={() => setSendFor(m)}>
                            Send to HOD
                          </Button>
                        ) : (
                          <Button
                            variant="link"
                            className={`h-auto p-0 ${underlined ? "" : "text-foreground no-underline hover:no-underline"}`}
                            onClick={() => open(m.user_id, meta.action)}
                          >
                            {ACTION_LABEL[meta.action]}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-1 pt-4 text-sm text-muted-foreground">
              Use <strong>Send to HOD</strong> once an employee has acknowledged. The HOD approves the sheet or returns
              it to you; you then revise it and send it to the employee again. See every sheet in{" "}
              <Button
                variant="link"
                className="h-auto p-0 text-sm"
                onClick={() => navigate({ to: "/pms/team-goal-setting/$fy/status", params: { fy } })}
              >
                Goal Status
              </Button>
              .
            </p>
          </>
        )}
      </PmsTableCard>

      <SendToHodDialog employee={sendFor} financialYear={financialYear} onClose={() => setSendFor(null)} />
    </div>
  );
};

export default TeamGoalSettingPage;
