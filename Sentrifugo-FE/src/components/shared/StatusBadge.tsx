import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import {
  CircleCheck,
  CircleX,
  Clock,
  History,
  Check,
  FilePen,
} from "lucide-react";

type StatusVariant =
  | "active"
  | "inactive"
  | "pending"
  | "draft"
  | "reject"
  | "inprogress"
  | "open"
  | "submitted"
  | "l1_approved"
  | "l1_rejected"
  | "client_approved"
  | "client_rejected"
  | "resubmitted"
  | "not_submitted"
  | "pending_approval";

const STATUS_CONFIG: Record<
  StatusVariant,
  { icon: ComponentType<{ className?: string }>; label: string }
> = {
  active: { icon: CircleCheck, label: "Active" },
  inactive: { icon: CircleX, label: "Inactive" },
  pending: { icon: Clock, label: "Pending" },
  draft: { icon: FilePen, label: "Draft" },
  reject: { icon: CircleX, label: "Reject" },
  inprogress: { icon: History, label: "In Progress" },
  open: { icon: Check, label: "Open" },
  submitted: { icon: Clock, label: "Submitted" },
  l1_approved: { icon: CircleCheck, label: "L1 Approved" },
  l1_rejected: { icon: CircleX, label: "L1 Rejected" },
  client_approved: { icon: CircleCheck, label: "Client Approved" },
  client_rejected: { icon: CircleX, label: "Client Rejected" },
  resubmitted: { icon: History, label: "Resubmitted" },
  not_submitted: { icon: FilePen, label: "Not Submitted" },
  pending_approval: { icon: Clock, label: "Pending Approval" },
};

interface StatusBadgeProps {
  status: StatusVariant | boolean;
  activeLabel?: string;
  inactiveLabel?: string;
}

export function StatusBadge({
  status,
  activeLabel,
  inactiveLabel,
}: StatusBadgeProps) {
  const variant: StatusVariant =
    typeof status === "boolean" ? (status ? "active" : "inactive") : status;
  const config = STATUS_CONFIG[variant];
  const Icon = config.icon;
  const label =
    variant === "active" && activeLabel
      ? activeLabel
      : variant === "inactive" && inactiveLabel
        ? inactiveLabel
        : config.label;

  return (
    <Badge variant={variant}>
      <Icon />
      {label}
    </Badge>
  );
}
