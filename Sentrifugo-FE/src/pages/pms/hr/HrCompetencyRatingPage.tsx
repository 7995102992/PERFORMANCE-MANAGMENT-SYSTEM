import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Clock, FilePen, Info, Send, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsHrQueueQuery, useSendPmsToCalibrationMutation } from "@/store/api/pmsApi";
import type { PmsHrRatingStatus } from "@/types/pms-hr";
import { formatDisplayDate } from "../shared/pms.utils";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StatusLabel } from "../shared/StatusLabel";
import { usePmsDepartments } from "../shared/usePmsLookups";

/** Value of every "All ..." filter option. */
const ALL = "all";

/** Label, icon and colour for each HR rating status (pending, draft, rated). */
const STATUS_META: Record<PmsHrRatingStatus, { label: string; icon: LucideIcon; className: string }> = {
  pending: { label: "Pending", icon: Clock, className: "text-amber-500" },
  draft: { label: "Draft", icon: FilePen, className: "text-amber-500" },
  rated: { label: "Rated", icon: CheckCircle2, className: "text-emerald-600" },
};

/** Screen 1.7 - HR Competency Rating: the employees who have come to Corporate HR to be rated. */
const HrCompetencyRatingPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));

  // Employees whose manager appraisal is in, and the mutation behind "Send Rated to Calibration".
  const { data: rows = [], isLoading, isError } = useGetPmsHrQueueQuery(financialYear);
  const [send, { isLoading: sending }] = useSendPmsToCalibrationMutation();
  const { data: departments } = usePmsDepartments();

  // Filters (department, status, search text) and the set of ticked employee ids.
  const [department, setDepartment] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Department id to name, for the Department column.
  const departmentName = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);

  // Rows after the department, status and search filters.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (department === ALL || r.department_id === department) &&
        (status === ALL || r.status === status) &&
        (q === "" || r.employee_name.toLowerCase().includes(q) || r.emp_code.toLowerCase().includes(q)),
    );
  }, [rows, department, status, search]);

  // Only rated employees that are not already with calibration can be sent on.
  const sendable = visible.filter((r) => r.status === "rated" && !r.sent_to_calibration);
  const allTicked = sendable.length > 0 && sendable.every((r) => selected.has(r.employee_user_id));

  /** Ticks or unticks one employee. */
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Ticks or unticks every sendable employee in the current view. */
  const toggleAll = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      sendable.forEach((r) => (on ? next.add(r.employee_user_id) : next.delete(r.employee_user_id)));
      return next;
    });

  /** Sends the ticked, rated employees to calibration and clears the selection. */
  const onSend = async () => {
    const ids = [...selected].filter((id) => rows.some((r) => r.employee_user_id === id && r.status === "rated"));
    if (ids.length === 0) {
      toast.error("Tick the rated employees to send to calibration");
      return;
    }
    try {
      const { sent } = await send({ financial_year: financialYear, employee_user_ids: ids }).unwrap();
      toast.success(`${sent} employee${sent === 1 ? "" : "s"} sent to calibration`);
      setSelected(new Set());
    } catch (e) {
      toast.error(e, "Could not send to calibration");
    }
  };

  /** Opens the HR competency rating form (1.8) for one employee. */
  const openEmployee = (employeeUserId: string) =>
    navigate({
      to: "/pms/hr-competency-rating/$fy/employee/$employeeUserId",
      params: { fy, employeeUserId },
    });

  if (isLoading) return <PageLoader message="Loading HR competency ratings…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`HR Competency Rating – FY ${financialYear}`}
        subtitle="Rate the HR competencies after the Functional Head rating"
        action={
          <div className="flex items-center gap-2">
            <FinancialYearTag
              fy={fy}
              onChange={(next) => navigate({ to: "/pms/hr-competency-rating/$fy", params: { fy: next } })}
            />
            <Button onClick={onSend} disabled={sending || selected.size === 0}>
              {sending ? "Sending…" : "Send Rated to Calibration"} <Send />
            </Button>
          </div>
        }
      />

      <PmsTableCard>
        <div className="mb-4 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Employees come to you after the Functional Head rating. Rate the HR competencies; once rated, tick them
            and send them to Calibration.
          </p>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-[14rem_10rem_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger aria-label="Department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
            <Label htmlFor="hr-search">Search</Label>
            <Input
              id="hr-search"
              placeholder="Search by employee name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the HR competency ratings.</p>}
        {!isError && visible.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {rows.length === 0
              ? "No employees have reached Corporate HR for this year yet."
              : "No employees match these filters."}
          </p>
        )}
        {visible.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh className="w-10">
                  <Checkbox
                    aria-label="Select all rated employees"
                    checked={allTicked}
                    disabled={sendable.length === 0}
                    onCheckedChange={(v) => toggleAll(v === true)}
                  />
                </PmsTh>
                <PmsTh>Employee</PmsTh>
                <PmsTh>Department</PmsTh>
                <PmsTh>Functional Head</PmsTh>
                <PmsTh>HOD Rated On</PmsTh>
                <PmsTh>HR Competency Rating</PmsTh>
                <PmsTh>Action</PmsTh>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const meta = STATUS_META[r.status];
                const canTick = r.status === "rated" && !r.sent_to_calibration;
                return (
                  <tr key={r.employee_user_id} className="border-t">
                    <td className="px-4 py-3">
                      <Checkbox
                        aria-label={`Select ${r.employee_name}`}
                        checked={selected.has(r.employee_user_id)}
                        disabled={!canTick}
                        onCheckedChange={(v) => toggle(r.employee_user_id, v === true)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{r.employee_name}</p>
                      <p className="text-xs text-muted-foreground">{r.emp_code}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {(r.department_id && departmentName.get(r.department_id)) || r.department_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.functional_head ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.hod_rated_on ? formatDisplayDate(r.hod_rated_on) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />
                      {r.sent_to_calibration && (
                        <span className="ml-2 text-xs text-muted-foreground">· In calibration</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant={r.status === "rated" || r.sent_to_calibration ? "outline" : "default"}
                        onClick={() => openEmployee(r.employee_user_id)}
                      >
                        {r.status === "rated" || r.sent_to_calibration
                          ? "View"
                          : r.status === "draft"
                            ? "Continue"
                            : "Rate"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {visible.length > 0 && (
          <p className="px-1 pt-4 text-sm text-muted-foreground">
            Showing 1 to {visible.length} of {rows.length} employees · {selected.size} selected
          </p>
        )}
      </PmsTableCard>
    </div>
  );
};

export default HrCompetencyRatingPage;
