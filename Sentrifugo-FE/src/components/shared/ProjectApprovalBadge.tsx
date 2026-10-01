import type { ProjectApprovalStatus } from "@/types/timesheet";

const PA_CONFIG: Record<
  ProjectApprovalStatus,
  { label: string; className: string }
> = {
  submitted: {
    label: "Pending Review",
    className: "bg-warning/10 text-warning border border-warning/20",
  },
  resubmitted: {
    label: "Resubmitted",
    className: "bg-warning/10 text-warning border border-warning/20",
  },
  l1_approved: {
    label: "Manager Approved",
    className: "bg-primary/10 text-primary border border-primary/20",
  },
  l1_rejected: {
    label: "Manager Rejected",
    className:
      "bg-destructive/10 text-destructive border border-destructive/20",
  },
  client_approved: {
    label: "Client Approved",
    className: "bg-success/10 text-success border border-success/20",
  },
  client_rejected: {
    label: "Client Rejected",
    className:
      "bg-destructive/10 text-destructive border border-destructive/20",
  },
};

export function ProjectApprovalBadge({
  status,
}: {
  status: ProjectApprovalStatus;
}) {
  const cfg = PA_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}
