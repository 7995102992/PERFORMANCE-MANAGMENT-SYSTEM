import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Clock, FilePen, Info, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsAppraisalHodQueueQuery } from "@/store/api/pmsApi";
import type { PmsHodAppraisalStatus } from "@/types/pms-appraisal-hod";
import { formatDisplayDate } from "../shared/pms.utils";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StatusLabel } from "../shared/StatusLabel";

/** Value of the "All" status filter option. */
const ALL = "all";

/** Label, icon and colour for each L2 appraisal rating status (pending, draft, rated). */
const STATUS_META: Record<PmsHodAppraisalStatus, { label: string; icon: LucideIcon; className: string }> = {
  pending: { label: "Pending", icon: Clock, className: "text-amber-500" },
  draft: { label: "Draft", icon: FilePen, className: "text-amber-500" },
  rated: { label: "Rated", icon: CheckCircle2, className: "text-emerald-600" },
};

/** Formats a score to two decimals, or an em dash when there is none yet. */
const score = (v: number | null) => (v == null ? "—" : v.toFixed(2));

/** Screen 5.7 "Approve Appraisal - L2 List": employees sent by their Section Head for the Functional
 * Head's review. */
const ApproveAppraisalPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));

  const { data: rows = [], isLoading, isError } = useGetPmsAppraisalHodQueueQuery(financialYear);

  const [status, setStatus] = useState(ALL);
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (status === ALL || r.status === status) &&
        (q === "" || r.employee_name.toLowerCase().includes(q) || r.emp_code.toLowerCase().includes(q)),
    );
  }, [rows, status, search]);

  const pending = rows.filter((r) => r.status !== "rated").length;

  /** Opens the L2 rating form (5.6) for one employee. */
  const openEmployee = (employeeUserId: string) =>
    navigate({
      to: "/pms/approve-appraisal/$fy/employee/$employeeUserId",
      params: { fy, employeeUserId },
    });

  if (isLoading) return <PageLoader message="Loading the approval queue…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`Approve Appraisal – FY ${financialYear}`}
        subtitle="Employees sent by your Section Heads for your review"
        action={
          <div className="flex items-center gap-2">
            <FinancialYearTag
              fy={fy}
              onChange={(next) => navigate({ to: "/pms/approve-appraisal/$fy", params: { fy: next } })}
            />
            <span className="inline-flex items-center gap-1.5 text-sm text-amber-600">
              <Clock className="h-4 w-4" /> Pending: {pending}
            </span>
          </div>
        }
      />

      <PmsTableCard>
        <div className="mb-4 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Employees appear here when their Section Head (L1) submits the rating. You are their reviewer (L2).</p>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="rated">Rated</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="approve-appraisal-search">Search</Label>
            <Input
              id="approve-appraisal-search"
              placeholder="Search by employee name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the approval queue.</p>}
        {!isError && visible.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {rows.length === 0
              ? "No employees have been sent to you for review yet."
              : "No employees match these filters."}
          </p>
        )}
        {visible.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh>Employee</PmsTh>
                <PmsTh>Section Head</PmsTh>
                <PmsTh>Self</PmsTh>
                <PmsTh>L1</PmsTh>
                <PmsTh>Submitted On</PmsTh>
                <PmsTh>Status</PmsTh>
                <PmsTh>Actions</PmsTh>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const meta = STATUS_META[r.status];
                return (
                  <tr key={r.employee_user_id} className="border-t">
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{r.employee_name}</p>
                      <p className="text-xs text-muted-foreground">{r.emp_code}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.section_head ?? "—"}</td>
                    <td className="px-4 py-3 text-foreground">{score(r.self_score)}</td>
                    <td className="px-4 py-3 text-foreground">{score(r.l1_score)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.submitted_on ? formatDisplayDate(r.submitted_on) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant={r.status === "rated" ? "outline" : "default"}
                        onClick={() => openEmployee(r.employee_user_id)}
                      >
                        {r.status === "rated" ? "View" : "Review & Rate"}
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

export default ApproveAppraisalPage;
