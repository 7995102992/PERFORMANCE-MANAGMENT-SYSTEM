import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsHodTrailQuery } from "@/store/api/pmsApi";
import { PmsTableCard } from "../shared/PmsTableCard";
import { formatDisplayDate } from "../shared/pms.utils";
import { RoleLabel } from "./hod/hod.components";
import { HOD_HISTORY_PATH, hodNumber } from "./hod/hod.utils";

/** Box colour of one step in "how the target moved", by who made the change. */
const STEP_STYLE = {
  manager: "border-border bg-card",
  employee: "border-amber-300 bg-amber-50",
  hod: "border-emerald-300 bg-emerald-50",
} as const;

/** Trail: how every changed KPI moved, and each request of the employee with who did what and when. Read only. */
const ApprovalTrailPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const back = () => navigate({ to: HOD_HISTORY_PATH, params: { fy } });

  const { data, isLoading, isError } = useGetPmsHodTrailQuery({ employeeUserId, financialYear });

  if (isLoading) return <PageLoader message="Loading trail…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Trail" subtitle="Could not load the trail." />
        <Button variant="outline" onClick={back}>← Approval History</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`${data.employee_name} · Trail`}
        subtitle={`${data.emp_code} · ${data.designation_name || "—"} · Manager: ${data.manager_name || "—"} · FY ${data.financial_year} · Read only`}
        action={
          <Button variant="outline" onClick={back}>
            ← Approval History
          </Button>
        }
      />

      {data.moves.map((move) => (
        <PmsTableCard key={move.kpi_name}>
          <h2 className="text-base font-semibold text-foreground">{move.kpi_name} – how the target moved</h2>
          <p className="text-sm text-muted-foreground">Each box is one change, with who made it.</p>
          <div className="mt-4 flex flex-wrap items-stretch gap-2">
            {move.steps.map((step, i) => (
              <div key={`${step.date}-${i}`} className="flex items-center gap-2">
                <div className={`min-w-40 rounded-lg border p-3 ${STEP_STYLE[step.actor_role]}`}>
                  <p className="text-xs text-muted-foreground">{formatDisplayDate(step.date)}</p>
                  <p className="text-xl font-bold text-foreground">{hodNumber(step.value)}</p>
                  <RoleLabel role={step.actor_role} />
                  <p className="text-xs text-muted-foreground">{step.label}</p>
                </div>
                {i < move.steps.length - 1 && <span className="text-muted-foreground">→</span>}
              </div>
            ))}
          </div>
        </PmsTableCard>
      ))}

      {data.requests.length === 0 && (
        <PmsTableCard>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing has happened on these goals yet.</p>
        </PmsTableCard>
      )}

      {data.requests.map((req) => (
        <PmsTableCard key={req.request_no}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Request {req.request_no} · {req.title}
              </h2>
              <p className="text-sm text-muted-foreground">{req.subtitle}</p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                req.status === "approved"
                  ? "bg-emerald-100 text-emerald-700"
                  : req.status === "returned"
                    ? "bg-red-100 text-red-700"
                    : "bg-primary/10 text-primary"
              }`}
            >
              {req.status === "approved"
                ? `Approved ${formatDisplayDate(req.status_date)}`
                : req.status === "returned"
                  ? `Returned ${formatDisplayDate(req.status_date)}`
                  : "Waiting for you"}
            </span>
          </div>
          <div className="mt-4 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Who</th>
                  <th className="px-4 py-2.5">What happened</th>
                </tr>
              </thead>
              <tbody>
                {req.events.map((e, i) => (
                  <tr
                    key={`${e.date}-${i}`}
                    className={`border-t ${e.actor_role === "employee" ? "bg-amber-50" : ""}`}
                  >
                    <td className="px-4 py-3 text-muted-foreground">{formatDisplayDate(e.date)}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{e.actor_name || "—"}</p>
                      <RoleLabel role={e.actor_role} />
                    </td>
                    <td className="px-4 py-3 text-foreground">{e.summary || e.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PmsTableCard>
      ))}
    </div>
  );
};

export default ApprovalTrailPage;
