import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsHodHistoryQuery } from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatDisplayDate } from "../shared/pms.utils";
import { RequestBadge } from "./hod/hod.components";
import { HOD_LIST_PATH, HOD_SELECT_CLASS, HOD_TRAIL_PATH, hodNumber } from "./hod/hod.utils";

/** Approval History: every decision the HOD already made. Open a row to see the full trail of that employee. */
const ApprovalHistoryPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));

  const [search, setSearch] = useState("");
  const [requestType, setRequestType] = useState("");
  const [decision, setDecision] = useState("");

  const { data: rows = [], isLoading, isError } = useGetPmsHodHistoryQuery({
    financialYear,
    requestType: requestType || undefined,
    decision: decision || undefined,
    search: search.trim() || undefined,
  });

  const approved = rows.filter((r) => r.decision === "approved").length;
  const returned = rows.length - approved;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Approval History"
        subtitle="Everything you have already approved or returned. Open a row to see the full trail for that employee."
        action={
          <Button variant="outline" onClick={() => navigate({ to: HOD_LIST_PATH, params: { fy } })}>
            ← Goal Approvals
          </Button>
        }
      />

      <PmsTableCard>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="w-64"
            placeholder="Search employee"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className={HOD_SELECT_CLASS} value={requestType} onChange={(e) => setRequestType(e.target.value)}>
            <option value="">All requests</option>
            <option value="goal_sheet">Goal sheet</option>
            <option value="target_revision">Target revision</option>
          </select>
          <select className={HOD_SELECT_CLASS} value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">All decisions</option>
            <option value="approved">Approved</option>
            <option value="returned">Returned</option>
          </select>
          <span className="rounded-md border bg-card px-3 py-2 text-sm font-medium">FY {financialYear}</span>
        </div>

        {isLoading && <PageLoader message="Loading history…" />}
        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the approval history.</p>}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No decisions found.</p>
        )}
        {rows.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className={PMS_HEADER_ROW}>
                  <PmsTh>Date</PmsTh>
                  <PmsTh>Employee</PmsTh>
                  <PmsTh>Request</PmsTh>
                  <PmsTh>What changed</PmsTh>
                  <PmsTh>Your decision</PmsTh>
                  <PmsTh>Your remarks</PmsTh>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={`${r.employee_user_id}-${r.request_type}-${r.decided_on}-${i}`}
                    className="cursor-pointer border-t hover:bg-muted/40"
                    onClick={() =>
                      navigate({ to: HOD_TRAIL_PATH, params: { fy, employeeUserId: r.employee_user_id } })
                    }
                  >
                    <td className="px-4 py-3 text-muted-foreground">{formatDisplayDate(r.decided_on)}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{r.employee_name}</p>
                      <p className="text-xs text-muted-foreground">{r.manager_name || "—"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <RequestBadge type={r.request_type} />
                    </td>
                    <td className="px-4 py-3">
                      {r.kpi_name ? (
                        <>
                          <p className="text-xs text-muted-foreground">{r.kpi_name}</p>
                          <p className="font-medium text-foreground">
                            {hodNumber(r.from)} → {hodNumber(r.to)} {r.unit ?? ""}
                          </p>
                          {r.more_changes > 0 && (
                            <p className="text-xs text-primary">+ {r.more_changes} more</p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="text-xs text-muted-foreground">All KRAs</p>
                          <p className="font-medium text-foreground">No change</p>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          r.decision === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                        }`}
                      >
                        {r.decision === "approved" ? "Approved" : "Returned"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.remarks || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {rows.length} decision{rows.length === 1 ? "" : "s"} in FY {financialYear} · {approved} approved,{" "}
          {returned} returned
        </p>
      </PmsTableCard>
    </div>
  );
};

export default ApprovalHistoryPage;
