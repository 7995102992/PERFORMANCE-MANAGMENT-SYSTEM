import { useNavigate, useParams } from "@tanstack/react-router";
import { Bell, CheckCircle2, Circle, Clock, RefreshCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsTeamAppraisalQuery } from "@/store/api/pmsApi";
import type { PmsManagerRatingStatus, PmsSelfAppraisalStatus } from "@/types/pms-manager";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StatusLabel } from "../shared/StatusLabel";

/** Label, icon and colour for the employee self-appraisal status. */
const SELF_META: Record<PmsSelfAppraisalStatus, { label: string; icon: LucideIcon; className: string }> = {
  submitted: { label: "Submitted", icon: CheckCircle2, className: "text-emerald-600" },
  not_submitted: { label: "Not Submitted", icon: Circle, className: "text-muted-foreground" },
  not_applicable: { label: "Not applicable – Trainee", icon: Circle, className: "text-muted-foreground" },
};

/** What the manager button does for a row (null = nothing to do yet). */
type ManagerAction = "rate" | "continue" | "view" | "rate_p2" | null;

/** Label, icon, colour and button action for the manager rating status. */
const MANAGER_META: Record<
  PmsManagerRatingStatus,
  { label: string; icon: LucideIcon; className: string; action: ManagerAction }
> = {
  pending: { label: "Pending", icon: Clock, className: "text-amber-500", action: "rate" },
  draft: { label: "Draft", icon: Clock, className: "text-amber-500", action: "continue" },
  submitted_to_hod: { label: "Submitted to HOD", icon: RefreshCw, className: "text-blue-500", action: "view" },
  period_1_rated: { label: "Period 1 rated", icon: RefreshCw, className: "text-blue-500", action: "rate_p2" },
  waiting: { label: "Waiting for Self Appraisal", icon: Circle, className: "text-muted-foreground", action: null },
  not_applicable: { label: "Not applicable", icon: Circle, className: "text-muted-foreground", action: null },
};

/** Button text per manager action. */
const ACTION_LABEL: Record<Exclude<ManagerAction, null>, string> = {
  rate: "Rate",
  continue: "Continue",
  view: "View",
  rate_p2: "Rate Period 2",
};

/** Screen 3.13 - Team Appraisal: every team member's self appraisal and your rating status. */
const TeamAppraisalPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  // One row per team member: self appraisal status and score, and the manager rating status.
  const { data: rows = [], isLoading, isError } = useGetPmsTeamAppraisalQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading the team appraisal…" />;

  // Employees who submitted a self appraisal and are waiting for the manager rating (shown in the banner).
  const awaiting = rows.filter((r) => r.manager_status === "pending" && r.self_status === "submitted");

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`Team Appraisal – FY ${financialYear}`}
        subtitle="Your team's appraisal status — open an employee to appraise"
        action={<FinancialYearTag fy={fy} />}
      />

      <PmsTableCard>
        {awaiting.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
            <Bell className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>New:</strong> {awaiting.map((r) => r.employee_name).join(", ")} submitted self appraisal. Open
              the employee to give your rating.
            </p>
          </div>
        )}

        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the team appraisal.</p>}
        {!isError && rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">No team members are in this appraisal cycle.</p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh>Employee</PmsTh>
                <PmsTh>Role</PmsTh>
                <PmsTh>Self appraisal</PmsTh>
                <PmsTh>Self score</PmsTh>
                <PmsTh>Manager rating</PmsTh>
                <PmsTh>Action</PmsTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const self = SELF_META[r.self_status];
                const mgr = MANAGER_META[r.manager_status];
                const primary = mgr.action === "rate" || mgr.action === "rate_p2";
                return (
                  <tr key={r.employee_user_id} className="border-t">
                    <td className="px-4 py-3 font-medium text-foreground">{r.employee_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.role}</td>
                    <td className="px-4 py-3">
                      <StatusLabel icon={self.icon} label={self.label} className={self.className} />
                    </td>
                    <td className="px-4 py-3 text-foreground">{r.self_score === null ? "—" : r.self_score.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <StatusLabel
                        icon={mgr.icon}
                        label={r.manager_note ?? mgr.label}
                        className={mgr.className}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {mgr.action === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Button
                          size="sm"
                          variant={primary ? "default" : "outline"}
                          onClick={() =>
                            navigate({
                              to: "/pms/team-appraisal/$fy/employee/$employeeUserId",
                              params: { fy, employeeUserId: r.employee_user_id },
                            })
                          }
                        >
                          {ACTION_LABEL[mgr.action]}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </PmsTableCard>
    </div>
  );
};

export default TeamAppraisalPage;
