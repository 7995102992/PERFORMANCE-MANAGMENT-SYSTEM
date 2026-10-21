import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Circle, RefreshCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsMidYearTeamQuery } from "@/store/api/pmsApi";
import type { PmsMidYearStatus } from "@/types/pms-manager";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RagDot } from "../shared/RagDot";
import { StatusLabel } from "../shared/StatusLabel";

/** Label, icon and colour for each mid-year review status. */
const STATUS_META: Record<PmsMidYearStatus, { label: string; icon: LucideIcon; className: string }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground" },
  completed_no_revision: { label: "Completed – No Revision", icon: CheckCircle2, className: "text-emerald-600" },
  revision_requested: { label: "Revision Requested", icon: RefreshCw, className: "text-blue-500" },
  completed_with_revision: { label: "Completed – Revision Applied", icon: CheckCircle2, className: "text-emerald-600" },
};

/** Screen 3.10 - Mid-Year Review, My Team: where each employee's mid-year review stands. */
const MidYearTeamPage = () => {
  // Route param `fy` is the financial-year start (2026); the API wants "2026-27".
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  // One row per team member from `useGetPmsMidYearTeamQuery`: H1 achievement, RAG and review status.
  const { data: rows = [], isLoading, isError } = useGetPmsMidYearTeamQuery(fyToApi(Number(fy)));

  if (isLoading) return <PageLoader message="Loading the mid-year review…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Mid-Year Review – My Team"
        subtitle="Your team's mid-year status — open an employee to start the review"
        action={<FinancialYearTag fy={fy} />}
      />

      <PmsTableCard>
        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the mid-year review.</p>}
        {!isError && rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">You have no direct reports.</p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh>Employee</PmsTh>
                <PmsTh>Role</PmsTh>
                <PmsTh>Latest achievement</PmsTh>
                <PmsTh>RAG</PmsTh>
                <PmsTh>Mid-year status</PmsTh>
                <PmsTh>Action</PmsTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = STATUS_META[r.status];
                const open = r.status === "not_started";
                // Goals the HOD has not approved cannot be reviewed yet.
                const reviewable = r.goals_approved !== false;
                return (
                  <tr key={r.employee_user_id} className="border-t">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {r.employee_name}
                      {r.emp_code && <span className="ml-2 text-xs font-normal text-muted-foreground">{r.emp_code}</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.role}</td>
                    <td className="px-4 py-3 text-foreground">
                      {r.h1_achievement === null ? "—" : `${r.h1_achievement.toFixed(1)}%`}
                    </td>
                    <td className="px-4 py-3">
                      {r.rag ? <RagDot rag={r.rag} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />
                    </td>
                    <td className="px-4 py-3">
                      {reviewable ? (
                        <Button
                          variant="link"
                          className="h-auto p-0"
                          onClick={() =>
                            navigate({
                              to: "/pms/mid-year-review/$fy/employee/$employeeUserId",
                              params: { fy, employeeUserId: r.employee_user_id },
                            })
                          }
                        >
                          {open ? "Open Review" : "View"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Goals not approved yet</span>
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

export default MidYearTeamPage;
