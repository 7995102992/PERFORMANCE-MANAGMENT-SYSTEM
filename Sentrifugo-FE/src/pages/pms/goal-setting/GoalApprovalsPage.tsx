import { useParams, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsApprovalsQuery } from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";

/** Screen 5.1 "Team Goals Settings" (HOD): goal sheets waiting for approval. */
const GoalApprovalsPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const { data: items = [], isLoading, isError } = useGetPmsApprovalsQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading approvals…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Team Goals Settings"
        subtitle="All employees' goal sheets waiting for your approval"
        action={<span className="text-sm text-muted-foreground">FY {financialYear}</span>}
      />

      <PmsTableCard>
        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the approval queue.</p>}
        {!isError && items.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">No goal sheets are waiting for approval.</p>
        )}
        {items.length > 0 && (
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
              {items.map((i) => (
                <tr key={i.employee_user_id} className="border-t">
                  <td className="px-4 py-3 font-medium text-foreground">{i.employee_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{i.designation_name || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{i.emp_code}</td>
                  <td className="px-4 py-3">{i.goal_status.replace(/_/g, " ")}</td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      onClick={() =>
                        navigate({
                          to: "/pms/goal-approvals/$fy/employee/$employeeUserId",
                          params: { fy, employeeUserId: i.employee_user_id },
                        })
                      }
                    >
                      Review
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

export default GoalApprovalsPage;
