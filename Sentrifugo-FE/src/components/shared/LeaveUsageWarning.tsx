import { Info } from "lucide-react";
import { useGetLeaveTypeUsageQuery } from "@/store/api/lmsApi";
import type { LeaveTypeResponse } from "@/types/leave";

interface Props {
  /** The type being applied for / approved. Nothing renders unless it is an
   *  unrestricted type with the warning switched on. */
  leaveType?: Pick<
    LeaveTypeResponse,
    "is_unrestricted" | "show_usage_warning"
  > | null;
  leaveTypeId?: string;
  /** Whose usage to show. Omit on the employee's own apply form; pass the
   *  requester's id on an approver surface. */
  userId?: string;
  /** Approver copy ("This employee has used…") vs the employee's own
   *  ("You have used…"). */
  audience?: "employee" | "approver";
}

const dayLabel = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * Usage warning for unrestricted leave.
 *
 * Such a type has no balance, so neither the employee nor the approver has a
 * number to judge a request against — this supplies one. Renders nothing unless
 * the type is configured for it, so it is safe to drop in unconditionally.
 */
export function LeaveUsageWarning({
  leaveType,
  leaveTypeId,
  userId,
  audience = "employee",
}: Props) {
  const enabled =
    !!leaveTypeId &&
    !!leaveType?.is_unrestricted &&
    !!leaveType?.show_usage_warning;

  const { data } = useGetLeaveTypeUsageQuery(
    { leave_type_id: leaveTypeId ?? "", ...(userId ? { user_id: userId } : {}) },
    { skip: !enabled },
  );

  if (!enabled || !data) return null;
  // Nothing used yet is not a warning — say nothing rather than "used 0 days".
  if (!data.days_used) return null;

  const who = audience === "approver" ? "This employee has" : "You have";
  const period = data.period_label ? ` in ${data.period_label}` : " this year";

  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
      <Info className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="text-sm text-foreground">
        {who} used {dayLabel(data.days_used)} of this leave{period}.
        {data.pending_days > 0 && (
          <span className="text-muted-foreground">
            {" "}
            ({dayLabel(data.pending_days)} awaiting approval.)
          </span>
        )}
      </p>
    </div>
  );
}
