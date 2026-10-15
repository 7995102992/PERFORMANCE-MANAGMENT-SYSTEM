import { useParams } from "@tanstack/react-router";
import { CheckCircle2, Lock } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsTeamProgressQuery } from "@/store/api/pmsApi";
import type { PmsRag, PmsTeamProgressRow } from "@/types/pms-manager";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RagDot } from "../shared/RagDot";

/** RAG states from worst to best, used to pick the worst one among a row KRAs. */
const WORST: PmsRag[] = ["off_track", "at_risk", "on_track"];

/** Dot beside "KRAs on track": the worst status among the KRAs that need attention. */
const rowRag = (row: PmsTeamProgressRow): PmsRag =>
  WORST.find((r) => row.attention.some((a) => a.rag === r)) ?? "on_track";

/** Text colour for each RAG state in the summary tiles. */
const STAT_TONE: Record<PmsRag, string> = {
  on_track: "text-emerald-600",
  at_risk: "text-amber-600",
  off_track: "text-red-600",
};

/** Screen 3.9 - Team Progress Dashboard: the team's KRA progress, per employee. */
const TeamProgressPage = () => {
  // Route param `fy` is the financial-year start (2026); the API wants "2026-27".
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const financialYear = fyToApi(Number(fy));
  // One row per team member: KRAs on track, attention list, achievement and overall RAG.
  const { data: rows = [], isLoading, isError } = useGetPmsTeamProgressQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading team progress…" />;

  /** Number of employees whose overall status is `rag`. */
  const count = (rag: PmsRag) => rows.filter((r) => r.overall_rag === rag).length;
  // The three summary tiles above the table.
  const stats: Array<{ rag: PmsRag; label: string }> = [
    { rag: "on_track", label: "Employees on track" },
    { rag: "at_risk", label: "Employees at risk" },
    { rag: "off_track", label: "Employees off track" },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Team Progress Dashboard"
        subtitle="Progress of your team's goals by KRA"
        action={<FinancialYearTag fy={fy} />}
      />

      <PmsTableCard>
        <div className="mb-3 flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Progress tracking opens for an employee as soon as their goals are approved by HOD. Employees still awaiting
            approval are shown as <strong>Locked</strong>.
          </p>
        </div>

        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the team progress.</p>}

        {!isError && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {stats.map((s) => (
                <div key={s.rag} className="rounded-lg border p-3">
                  <p className={`text-2xl font-semibold ${STAT_TONE[s.rag]}`}>{count(s.rag)}</p>
                  <p className="text-sm text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>

            {rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No team members to track yet.</p>
            ) : (
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className={PMS_HEADER_ROW}>
                    <PmsTh>Employee</PmsTh>
                    <PmsTh>KRAs on track (of 6)</PmsTh>
                    <PmsTh>KRAs needing attention</PmsTh>
                    <PmsTh>Achievement</PmsTh>
                    <PmsTh>Employee comments</PmsTh>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.employee_user_id} className="border-t align-top">
                      <td className="px-4 py-3 font-medium text-foreground">{r.employee_name}</td>
                      {r.locked ? (
                        <>
                          <td className="px-4 py-3 text-muted-foreground">—</td>
                          <td className="px-4 py-3 text-muted-foreground">—</td>
                          <td className="px-4 py-3 text-muted-foreground">—</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              <Lock className="h-4 w-4" /> Locked – awaiting approval
                            </span>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-2 font-semibold text-foreground">
                              <RagDot rag={rowRag(r)} />
                              {r.kras_on_track}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {r.attention.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <ul className="space-y-1">
                                {r.attention.map((a) => (
                                  <li key={a.kra_name} className="flex items-center gap-2 text-foreground">
                                    <RagDot rag={a.rag} />
                                    {a.kra_name}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className="px-4 py-3 text-foreground">{r.achievement?.toFixed(1)}%</td>
                          <td className="px-4 py-3 text-muted-foreground">{r.comment ?? "—"}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="mt-4 flex gap-4 text-xs text-muted-foreground">
              {(["on_track", "at_risk", "off_track"] as PmsRag[]).map((rag) => (
                <RagDot key={rag} rag={rag} showLabel className="text-muted-foreground" />
              ))}
            </div>
          </>
        )}
      </PmsTableCard>
    </div>
  );
};

export default TeamProgressPage;
