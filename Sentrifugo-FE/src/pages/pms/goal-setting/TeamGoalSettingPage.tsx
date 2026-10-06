import { useParams, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsTeamQuery } from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not Started",
  draft: "Draft",
  sent_to_employee: "Sent to Employee",
  acknowledged: "Acknowledged",
  change_requested: "Change Requested",
  with_hod: "With HOD",
};

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
          <span className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground">
            FY {financialYear}
          </span>
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
                <PmsTh>Emp ID</PmsTh>
                <PmsTh>Goal status</PmsTh>
                <PmsTh>Action</PmsTh>
              </tr>
            </thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.user_id} className="border-t">
                  <td className="px-4 py-3 font-medium text-foreground">{m.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.designation_name || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.emp_code}</td>
                  <td className="px-4 py-3">{STATUS_LABEL[m.goal_status] ?? m.goal_status}</td>
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
                      {m.goal_status === "not_started" ? "Set Goals" : "Open"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PmsTableCard>
    </div>
  );
};

export default TeamGoalSettingPage;
