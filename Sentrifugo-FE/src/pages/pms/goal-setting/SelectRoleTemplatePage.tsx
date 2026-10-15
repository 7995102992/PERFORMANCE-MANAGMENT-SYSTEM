import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Circle, Clock, Info, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useAssignRoleTemplateMutation, useGetPmsRoleEmployeesQuery } from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StatusLabel } from "../shared/StatusLabel";
import { FinancialYearTag } from "../shared/FinancialYearTag";

/** What the row button does: open the form, continue a draft, revise, view, or set period 2 KRAs. */
type RowAction = "set" | "continue" | "revise" | "view" | "kras";

/** Label, icon, colour and button action for each goal status. */
const STATUS_META: Record<string, { label: string; icon: LucideIcon; className: string; action: RowAction }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground", action: "set" },
  draft: { label: "Draft", icon: Clock, className: "text-amber-500", action: "continue" },
  sent_to_employee: { label: "Sent to Employee", icon: RefreshCw, className: "text-blue-500", action: "view" },
  acknowledged: { label: "Acknowledged", icon: CheckCircle2, className: "text-emerald-600", action: "view" },
  change_requested: { label: "Change Requested", icon: XCircle, className: "text-destructive", action: "revise" },
  returned_by_hod: { label: "Returned by HOD", icon: XCircle, className: "text-destructive", action: "revise" },
  transferred_in: { label: "Transferred in", icon: Clock, className: "text-amber-500", action: "kras" },
  with_hod: { label: "With HOD", icon: RefreshCw, className: "text-blue-500", action: "view" },
  approved: { label: "Approved by HOD", icon: CheckCircle2, className: "text-emerald-600", action: "view" },
};

/** Meta for a status; unknown statuses get a neutral label built from the status text. */
const statusMeta = (status: string) =>
  STATUS_META[status] ?? { label: status.replace(/_/g, " "), icon: Circle, className: "text-muted-foreground", action: "view" as RowAction };

/** Button text per row action. */
const ACTION_LABEL: Record<RowAction, string> = {
  set: "Set Targets",
  continue: "Continue",
  revise: "Revise",
  kras: "Set KRAs",
  view: "View",
};

/**
 * Screen 4.2 - Goal Setting, Select Employee. Pick a role (its template loads automatically), press
 * "Assign Template" to give it to every report in the role who has none, then open one employee at a time to
 * set targets. "Set Targets" stays disabled until the employee has a template.
 */
const SelectRoleTemplatePage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  // Every employee under the manager roles (the `scope` parameter is ignored by the real API).
  const { data: employees = [], isLoading, isError } = useGetPmsRoleEmployeesQuery(financialYear);
  const [assign, { isLoading: assigning }] = useAssignRoleTemplateMutation();

  // Distinct roles (designations) found among the employees, each with its template name.
  const roles = useMemo(() => {
    const seen = new Map<string, { name: string; template: string; templateId: string }>();
    for (const e of employees) {
      if (!seen.has(e.designation_id)) {
        seen.set(e.designation_id, { name: e.designation_name || "—", template: "", templateId: "" });
      }
      // The auto-loaded template (name and id): what applies to the role's employees.
      const role = seen.get(e.designation_id)!;
      if (e.template_id && !role.templateId) {
        role.templateId = e.template_id;
        role.template = e.template_name ?? "";
      }
    }
    return [...seen.entries()].map(([id, r]) => ({ id, ...r }));
  }, [employees]);

  // Selected role; falls back to the first role. `inRole` are the employees of that role.
  const [roleId, setRoleId] = useState("");
  const activeRole = roles.find((r) => r.id === roleId) ?? roles[0];
  const inRole = employees.filter((e) => e.designation_id === activeRole?.id);
  // Employees who still need the template.
  const unassigned = inRole.filter((e) => !e.template_assigned);
  // "1 sent, 1 in draft, 5 not started": how the role's goal sheets stand.
  const sentStatuses = ["sent_to_employee", "acknowledged", "with_hod", "approved"];
  const sent = inRole.filter((e) => sentStatuses.includes(e.goal_status)).length;
  const drafts = inRole.filter((e) => e.goal_status === "draft").length;
  const notStarted = inRole.filter((e) => e.goal_status === "not_started").length;
  const returned = inRole.length - sent - drafts - notStarted;
  const summary =
    `${sent} sent, ${drafts} in draft, ${notStarted} not started` +
    (returned > 0 ? `, ${returned} need${returned === 1 ? "s" : ""} revision` : "");

  /** Back to My Team. */
  const back = () => navigate({ to: "/pms/team-goal-setting/$fy", params: { fy } });

  /** Opens the right form for the row action: revise, transfer KRAs, or the target assignment form. */
  const open = (userId: string, action: RowAction) =>
    navigate({
      to:
        action === "revise"
          ? "/pms/team-goal-setting/$fy/employee/$employeeUserId/revise"
          : action === "kras"
            ? "/pms/team-goal-setting/$fy/employee/$employeeUserId/transfer"
            : "/pms/team-goal-setting/$fy/employee/$employeeUserId",
      params: { fy, employeeUserId: userId },
    });

  /** "Create & assign template": sends the role and its template id; everyone in the role who has none gets it. */
  const onAssign = async () => {
    if (!activeRole?.templateId) return;
    try {
      const res = await assign({
        financial_year: financialYear,
        designation_id: activeRole.id,
        template_id: activeRole.templateId,
      }).unwrap();
      toast.success(
        res.assigned === 0
          ? "Everyone in this role already has the template"
          : `${res.template_name} assigned to ${res.assigned} employee${res.assigned === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(e, "Could not assign the template");
    }
  };

  if (isLoading) return <PageLoader message="Loading your team…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Goal Setting – Select Employee"
        subtitle="The template is auto-loaded based on role — assign it, then pick one employee"
        action={<FinancialYearTag fy={fy} />}
      />

      {isError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          Could not load your team. Check that you are signed in as a reporting manager.
        </p>
      )}

      {!isError && (
        <PmsTableCard className="space-y-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-72 space-y-1.5">
              <Label>Role</Label>
              <Select value={activeRole?.id ?? ""} onValueChange={setRoleId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-72 space-y-1.5">
              <Label htmlFor="auto-template">Template (auto-loaded)</Label>
              <Input id="auto-template" readOnly value={activeRole?.template || "No active template for this role"} />
            </div>
            <Button onClick={onAssign} disabled={assigning || !activeRole?.templateId || unassigned.length === 0}>
              <CheckCircle2 /> {assigning ? "Assigning…" : "Assign Template"}
            </Button>
          </div>

          <p className="flex items-start gap-2 rounded-lg bg-primary/10 px-4 py-3 text-sm text-primary">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              Targets are set for <strong>one employee at a time</strong>. Open an employee to enter the targets.
            </span>
          </p>

          <div>
            <p className="mb-3 text-base font-semibold text-foreground">Employees in this Role</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className={PMS_HEADER_ROW}>
                    <PmsTh>Employee</PmsTh>
                    <PmsTh>Emp ID</PmsTh>
                    <PmsTh>Employment Type</PmsTh>
                    <PmsTh>Goal Status</PmsTh>
                    <PmsTh>Action</PmsTh>
                  </tr>
                </thead>
                <tbody>
                  {inRole.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No employees under this role.
                      </td>
                    </tr>
                  )}
                  {inRole.map((e) => {
                    const meta = statusMeta(e.goal_status);
                    const hasTemplate = !!e.template_assigned;
                    // Setting targets needs the template first; continuing, viewing and revising do not.
                    const blocked = meta.action === "set" && !hasTemplate;
                    return (
                      <tr key={e.user_id} className="border-t">
                        <td className="px-4 py-3.5 text-foreground">{e.name}</td>
                        <td className="px-4 py-3.5 text-foreground">{e.emp_code}</td>
                        <td className="px-4 py-3.5 text-foreground">{e.employment_type ?? "—"}</td>
                        <td className="px-4 py-3.5">
                          <StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />
                        </td>
                        <td className="px-4 py-3.5">
                          <Button
                            size="sm"
                            variant={meta.action === "set" || meta.action === "revise" ? "default" : "outline"}
                            disabled={blocked}
                            title={blocked ? "Assign the template first" : undefined}
                            onClick={() => open(e.user_id, meta.action)}
                          >
                            {ACTION_LABEL[meta.action]}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {inRole.length > 0 && (
              <p className="px-1 pt-4 text-sm text-muted-foreground">
                {inRole.length} employee{inRole.length === 1 ? "" : "s"} · {summary} · Goals are set for all
                employees, including Trainee and Probationary.
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <Button variant="outline" onClick={back}>
              Back
            </Button>
          </div>
        </PmsTableCard>
      )}
    </div>
  );
};

export default SelectRoleTemplatePage;
