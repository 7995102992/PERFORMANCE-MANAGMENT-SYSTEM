import { useParams, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Circle, Clock, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsTeamQuery } from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";

const STATUS_META: Record<string, { label: string; icon: LucideIcon; className: string; action: string }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground", action: "Set Goals" },
  draft: { label: "Draft", icon: Clock, className: "text-amber-500", action: "Continue" },
  sent_to_employee: { label: "Sent to Employee", icon: RefreshCw, className: "text-blue-500", action: "View" },
  acknowledged: { label: "Acknowledged", icon: CheckCircle2, className: "text-emerald-600", action: "View" },
  change_requested: { label: "Change Requested", icon: XCircle, className: "text-destructive", action: "Revise" },
  with_hod: { label: "With HOD", icon: RefreshCw, className: "text-blue-500", action: "View" },
  approved: { label: "Approved", icon: CheckCircle2, className: "text-emerald-600", action: "View" },
};

const statusMeta = (status: string) =>
  STATUS_META[status] ?? { label: status.replace(/_/g, " "), icon: Circle, className: "text-muted-foreground", action: "View" };

/** Screen 3.1 - My Team: the manager's direct reports and where each one's goals stand. */
const TeamGoalSettingPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const { data: team = [], isLoading, isError } = useGetPmsTeamQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading your team…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="My Team"
        subtitle="Eligible team members and their goal status"
        action={
          <div className="flex items-center gap-3">
            <span className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground">
              FY {financialYear}
            </span>
            <Button onClick={() => navigate({ to: "/pms/team-goal-setting/$fy/role", params: { fy } })}>
              Set Goals
            </Button>
          </div>
        }
      />

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
          <table className="w-full text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh>Employee</PmsTh>
                <PmsTh>Role</PmsTh>
                <PmsTh>Goal status</PmsTh>
                <PmsTh>Action</PmsTh>
              </tr>
            </thead>
            <tbody>
              {team.map((m) => {
                const meta = statusMeta(m.goal_status);
                const Icon = meta.icon;
                return (
                  <tr key={m.user_id} className="border-t">
                    <td className="px-4 py-3 font-medium text-foreground">{m.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{m.designation_name || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 ${meta.className}`}>
                        <Icon className="h-4 w-4" />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="link"
                        className="h-auto p-0"
                        onClick={() =>
                          navigate({
                            to: "/pms/team-goal-setting/$fy/employee/$employeeUserId",
                            params: { fy, employeeUserId: m.user_id },
                          })
                        }
                      >
                        {meta.action}
                      </Button>
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

export default TeamGoalSettingPage;
