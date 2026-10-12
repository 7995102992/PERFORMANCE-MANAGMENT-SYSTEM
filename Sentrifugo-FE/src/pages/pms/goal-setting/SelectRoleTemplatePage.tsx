import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  approved: "Approved",
};

/**
 * Screen 3.2 - Select Role Template: the manager picks a role and sees everyone
 * under it. Grouping step between "My Team" (3.1) and "Employee Target
 * Assignment" (3.3) — there's no dedicated bulk-assign API yet, so "Assign &
 * Enter Targets" opens the first selected employee's target form, the same
 * single-employee flow 3.3 already supports; multiple employees in one role
 * still means multiple passes through it.
 */
const SelectRoleTemplatePage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const { data: team = [], isLoading, isError } = useGetPmsTeamQuery(financialYear);

  const roles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of team) {
      if (!seen.has(m.designation_id)) seen.set(m.designation_id, m.designation_name || "—");
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [team]);

  const [roleId, setRoleId] = useState<string>("");
  const activeRoleId = roleId || roles[0]?.id || "";
  const employeesInRole = team.filter((m) => m.designation_id === activeRoleId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const back = () => navigate({ to: "/pms/team-goal-setting/$fy", params: { fy } });

  const onAssign = () => {
    const firstSelected = employeesInRole.find((m) => selected.has(m.user_id));
    if (!firstSelected) return;
    navigate({
      to: "/pms/team-goal-setting/$fy/employee/$employeeUserId",
      params: { fy, employeeUserId: firstSelected.user_id },
    });
  };

  if (isLoading) return <PageLoader message="Loading your team…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Goal Setting – Select Role Template" subtitle="Choose a role to see everyone under it" />

      {isError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          Could not load your team. Check that you are signed in as a reporting manager.
        </p>
      )}

      {!isError && (
        <PmsTableCard className="space-y-5">
          <div className="max-w-xs space-y-1.5">
            <label className="text-sm font-medium text-foreground">Role</label>
            <Select value={activeRoleId} onValueChange={(v) => { setRoleId(v); setSelected(new Set()); }}>
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

          <div>
            <p className="mb-2 text-sm font-semibold text-foreground">Employees in this Role</p>
            <table className="w-full text-sm">
              <thead>
                <tr className={PMS_HEADER_ROW}>
                  <PmsTh className="w-10" />
                  <PmsTh>Employee</PmsTh>
                  <PmsTh>Emp ID</PmsTh>
                  <PmsTh>Goal status</PmsTh>
                </tr>
              </thead>
              <tbody>
                {employeesInRole.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No employees under this role.
                    </td>
                  </tr>
                )}
                {employeesInRole.map((m) => (
                  <tr key={m.user_id} className="border-t">
                    <td className="px-4 py-3">
                      <Checkbox checked={selected.has(m.user_id)} onCheckedChange={() => toggle(m.user_id)} />
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">{m.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{m.emp_code}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {STATUS_LABEL[m.goal_status] ?? m.goal_status.replace(/_/g, " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PmsTableCard>
      )}

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={back}>
          Back
        </Button>
        <Button onClick={onAssign} disabled={selected.size === 0}>
          Assign &amp; Enter Targets →
        </Button>
      </div>
    </div>
  );
};

export default SelectRoleTemplatePage;
