import type { PmsHodRequestType } from "@/types/pms-goals";

/** The pill that says what kind of request a row is. */
export function RequestBadge({ type }: { type: PmsHodRequestType }) {
  const revision = type === "target_revision";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
        revision ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-700"
      }`}
    >
      {revision ? "Target revision" : "Goal sheet"}
    </span>
  );
}

/** Role label in the colour the design uses (manager blue, employee green, HOD purple). */
export function RoleLabel({ role }: { role: "manager" | "employee" | "hod" }) {
  const style =
    role === "manager" ? "text-blue-600" : role === "employee" ? "text-emerald-600" : "text-violet-600";
  return <span className={`text-xs font-semibold capitalize ${style}`}>{role === "hod" ? "HOD" : role}</span>;
}
