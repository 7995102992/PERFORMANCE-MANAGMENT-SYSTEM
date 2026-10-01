import { useState, useRef } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { SectionCustomFields } from "@/components/shared/SectionCustomFields";
import { useNavigate } from "@tanstack/react-router";
import {
  Search,
  ArrowLeft,
  Clock,
  CheckCircle2,
  ClipboardList,
  ChevronDown,
  Calendar,
  Plus,
  FileText,
  Check,
  AlertCircle,
  Send,
  Monitor,
  Mail,
  Wifi,
  Lock,
  MessageSquare,
  AlertTriangle,
  Settings,
  UploadCloud,
  X,
  AlertOctagon,
  Star,
  Shield,
  Info,
  CircleCheck,
  CircleX,
  History,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { DatePicker } from "@/components/ui/date-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/lib/toast";
import {
  useGetEmployeesQuery,
  useCreateExitRequestMutation,
  useDeactivateEmployeeMutation,
  useSendClearanceReminderMutation,
  useGetHRExitRequestsQuery,
  useGetHRExitSummaryQuery,
  useInitiateClearancesMutation,
  useGetITAssetsQuery,
  useGetAdminTasksQuery,
  useGetFinanceClearanceRequestsQuery,
  useGetExitInterviewQuery,
  useRevokeExitRequestMutation,
  useGetChecklistsQuery,
} from "@/store/api/exitManagementApi";
import {
  useGetDepartmentsQuery,
  useGetBusinessUnitsQuery,
} from "@/store/api/iamApi";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { TablePagination } from "@/components/shared/TablePagination";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  return formatDateIST(dateStr);
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  return formatDateTimeIST(dateStr);
}

const STATUS_LABELS: Record<string, string> = {
  pending_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  awaiting_clearances: "Awaiting Clearances",
  under_review: "Under Review",
  completed: "Completed",
  deactivated: "Deactivated",
  notice_period: "Serving Notice",
  exit: "Exited",
  awaiting_exit_interview: "Awaiting Exit Interview",
};

const STATUS_BADGE_STYLES: Record<string, string> = {
  pending_approval:
    "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
  hr_initiated:
    "bg-badge-inprogress-text/10 text-badge-inprogress-text border-badge-inprogress-text/20",
  approved:
    "bg-badge-active-bg text-badge-active-text border-badge-active-text/20",
  rejected:
    "bg-badge-inactive-bg text-badge-inactive-text border-badge-inactive-text/20",
  withdrawn:
    "bg-badge-pending-bg text-badge-pending-text border-badge-pending-bg",
  awaiting_clearances:
    "bg-badge-inprogress-text/10 text-badge-inprogress-text border-badge-inprogress-text/20",
  under_review: "bg-primary/10 text-primary border-primary/20",
  completed:
    "bg-badge-active-bg text-badge-active-text border-badge-active-text/20",
  deactivated: "bg-muted text-muted-foreground border-border",
  awaiting_exit_interview:
    "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
};

function ExitStatusBadge({
  status,
  requestId,
  employeeStatus,
}: {
  status: string;
  requestId: string;
  employeeStatus?: string | null;
}) {
  const { data: interview } = useGetExitInterviewQuery(requestId, {
    skip: status !== "completed" && status !== "awaiting_clearances",
  });
  // Fold the employee account lifecycle (UserDocument.status) into the single
  // request badge: `exit` is terminal and always wins; `notice_period` replaces
  // only the generic "Approved" state (which otherwise hides that the employee
  // is now serving notice) so the clearance states stay visible.
  const effectiveStatus =
    employeeStatus === "exit"
      ? "exit"
      : employeeStatus === "notice_period" && status === "approved"
        ? "notice_period"
        : status === "completed" && !interview
          ? "awaiting_exit_interview"
          : status;
  const label = STATUS_LABELS[effectiveStatus] || status;
  const s = effectiveStatus.toLowerCase();

  if (s === "approved" || s === "completed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleCheck className="size-3.5 shrink-0 text-success" />
        {label}
      </span>
    );
  }
  if (s === "rejected") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleX className="size-3.5 shrink-0 text-destructive" />
        {label}
      </span>
    );
  }
  if (s === "withdrawn" || s === "deactivated" || s === "exit") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleX className="size-3.5 shrink-0 text-muted-foreground" />
        {label}
      </span>
    );
  }
  if (s === "notice_period") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Clock className="size-3.5 shrink-0 text-badge-pending-text" />
        {label}
      </span>
    );
  }
  if (
    s === "hr_initiated" ||
    s === "awaiting_clearances" ||
    s === "under_review"
  ) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <History className="size-3.5 shrink-0 text-badge-inprogress-text" />
        {label}
      </span>
    );
  }
  if (s.includes("pending") || s.includes("awaiting")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Clock className="size-3.5 shrink-0 text-badge-pending-text" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
      {label}
    </span>
  );
}

function HRRequestDetail({
  selectedRequest,
  onBack,
  onRemind,
  onDeactivate,
  onRevoke,
  initiateClearances,
  setSelectedRequest,
  hrChecklistItems,
  hrCheckedItems,
  setHrCheckedItems,
  hasCustomFields,
  setHasCustomFields,
}: {
  selectedRequest: any;
  onBack: () => void;
  onRemind: () => void;
  onDeactivate: () => void;
  onRevoke: () => void;
  initiateClearances: any;
  setSelectedRequest: any;
  hrChecklistItems: string[];
  hrCheckedItems: Record<number, boolean>;
  setHrCheckedItems: React.Dispatch<
    React.SetStateAction<Record<number, boolean>>
  >;
  hasCustomFields: boolean;
  setHasCustomFields: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const navigate = useNavigate();
  const { data: itAssets = [] } = useGetITAssetsQuery({});
  const { data: adminTasks = [] } = useGetAdminTasksQuery({});
  const { data: financeRequests = [] } = useGetFinanceClearanceRequestsQuery(
    {},
  );
  const { data: exitInterview } = useGetExitInterviewQuery(selectedRequest.id, {
    skip: !selectedRequest.id,
  });

  const requestITAssets = itAssets.filter(
    (a: any) => a.exitRequestId === selectedRequest.id,
  );
  const requestAdminTasks = adminTasks.filter(
    (a: any) => a.exitRequestId === selectedRequest.id,
  );
  const requestFinance = financeRequests.filter(
    (f: any) => f.exitRequestId === selectedRequest.id,
  );

  const clearances = [
    ...requestITAssets.map((a: any) => ({
      name: `IT - ${a.assetType}`,
      assignedTo: "IT Admin",
      status:
        a.status === "verified"
          ? "Completed"
          : a.status === "returned"
            ? "Returned"
            : "Pending",
      completedOn: a.verifiedOn ? formatDateTime(a.verifiedOn) : "-",
    })),
    ...requestAdminTasks.map((t: any) => ({
      name: `Admin - ${t.taskType.replace(/_/g, " ")}`,
      assignedTo: "Admin Team",
      status: t.status === "completed" ? "Completed" : "Pending",
      completedOn: t.completedOn ? formatDateTime(t.completedOn) : "-",
    })),
    ...requestFinance.map((f: any) => ({
      name: "Finance Clearance",
      assignedTo: "Finance Team",
      status:
        f.status === "paid" || f.status === "approved"
          ? "Completed"
          : f.status === "not_cleared"
            ? "Not Cleared"
            : "Pending",
      completedOn: f.clearedOn ? formatDateTime(f.clearedOn) : "-",
    })),
  ];

  const allClearancesDone =
    clearances.length > 0 &&
    clearances.every((c: any) => c.status === "Completed");

  const latestTimestamp = (items: any[], dateField: string) => {
    const dates = items
      .map((i) => i[dateField])
      .filter(Boolean)
      .map((d: string) => new Date(d.endsWith("Z") ? d : d + "Z").getTime());
    if (dates.length === 0) return null;
    return formatDateTime(new Date(Math.max(...dates)).toISOString());
  };

  const itCompletedOn = latestTimestamp(
    requestITAssets.filter((a: any) => a.status === "verified"),
    "verifiedOn",
  );
  const adminCompletedOn = latestTimestamp(
    requestAdminTasks.filter((t: any) => t.status === "completed"),
    "completedOn",
  );
  const financeCompletedOn = latestTimestamp(
    requestFinance.filter(
      (f: any) => f.status === "paid" || f.status === "approved",
    ),
    "clearedOn",
  );
  const interviewCompletedOn = exitInterview?.submittedOn
    ? formatDateTime(exitInterview.submittedOn)
    : exitInterview?.createdOn
      ? formatDateTime(exitInterview.createdOn)
      : null;

  const timeline: {
    label: string;
    date: string;
    by: string;
    status: string;
  }[] = [];
  timeline.push({
    label: "Exit request submitted",
    date: formatDateTime(selectedRequest.createdOn),
    by: selectedRequest.name || selectedRequest.employeeName || "",
    status: "completed",
  });
  if (selectedRequest.approvedOn) {
    timeline.push({
      label: "Manager approved the request",
      date: formatDateTime(selectedRequest.approvedOn),
      by: selectedRequest.manager || "",
      status: "completed",
    });
  }
  if (
    selectedRequest.status === "awaiting_clearances" ||
    selectedRequest.status === "completed" ||
    selectedRequest.status === "deactivated"
  ) {
    timeline.push({
      label: "Clearances initiated",
      date: "-",
      by: "HR",
      status: "completed",
    });
  }
  if (
    selectedRequest.status === "completed" ||
    selectedRequest.status === "deactivated"
  ) {
    timeline.push({
      label: "All clearances completed",
      date: "-",
      by: "",
      status: "completed",
    });
  }
  if (selectedRequest.status === "deactivated") {
    timeline.push({
      label: "Employee deactivated",
      date: selectedRequest.deactivatedOn
        ? formatDateTime(selectedRequest.deactivatedOn)
        : "-",
      by: "",
      status: "completed",
    });
  }
  if (!["completed", "deactivated"].includes(selectedRequest.status)) {
    const nextStep =
      selectedRequest.status === "approved"
        ? "Pending clearance initiation"
        : selectedRequest.status === "awaiting_clearances"
          ? "Awaiting clearances completion"
          : selectedRequest.status === "pending_approval"
            ? "Pending manager approval"
            : "Pending review";
    timeline.push({ label: nextStep, date: "-", by: "", status: "pending" });
  }

  const timelineMarkup = (() => {
    const status = selectedRequest.status;
    const effectiveStatus =
      status === "completed" && !exitInterview
        ? "awaiting_exit_interview"
        : status;
    const isRejected = status === "rejected";
    const isManagerDone = [
      "approved",
      "awaiting_clearances",
      "awaiting_exit_interview",
      "completed",
      "deactivated",
    ].includes(status);
    const isClearancesStarted = [
      "awaiting_clearances",
      "awaiting_exit_interview",
      "completed",
      "deactivated",
    ].includes(status);
    const isAllDone = ["completed", "deactivated"].includes(status);
    const isInterviewDone = !!exitInterview;

    const steps = [
      {
        label: "Request Submitted",
        done: true,
        date: formatDateTime(selectedRequest.createdOn),
        sub:
          selectedRequest.name ||
          `${selectedRequest.employeeName || "-"}${selectedRequest.empCode ? ` (${selectedRequest.empCode})` : ""}`,
      },
      {
        label: "Manager Approval",
        done: isManagerDone,
        rejected: isRejected,
        date: selectedRequest.approvedOn
          ? formatDateTime(selectedRequest.approvedOn)
          : isRejected
            ? "Rejected"
            : "Pending",
      },
      {
        label: "HR Review & Clearance",
        done: isClearancesStarted,
        date: isClearancesStarted ? "Initiated" : isRejected ? "-" : "Pending",
      },
      {
        label: "IT Clearance",
        done:
          isAllDone ||
          ["verified"].includes(selectedRequest.itClearanceStatus || ""),
        date:
          isAllDone ||
          ["verified"].includes(selectedRequest.itClearanceStatus || "")
            ? itCompletedOn || "Completed"
            : isRejected
              ? "-"
              : selectedRequest.itClearanceStatus === "not_cleared"
                ? "Not Cleared"
                : isClearancesStarted
                  ? "In Progress"
                  : "Pending",
      },
      {
        label: "Admin Clearance",
        done:
          isAllDone ||
          ["completed"].includes(selectedRequest.adminClearanceStatus || ""),
        date:
          isAllDone ||
          ["completed"].includes(selectedRequest.adminClearanceStatus || "")
            ? adminCompletedOn || "Completed"
            : isRejected
              ? "-"
              : isClearancesStarted
                ? "In Progress"
                : "Pending",
      },
      {
        label: "Finance Clearance",
        done:
          isAllDone ||
          ["approved", "paid", "sent_to_payroll"].includes(
            selectedRequest.financeClearanceStatus || "",
          ),
        date:
          isAllDone ||
          ["approved", "paid", "sent_to_payroll"].includes(
            selectedRequest.financeClearanceStatus || "",
          )
            ? financeCompletedOn || "Completed"
            : isRejected
              ? "-"
              : selectedRequest.financeClearanceStatus === "not_cleared"
                ? "Not Cleared"
                : isClearancesStarted
                  ? "In Progress"
                  : "Pending",
      },
      {
        label: "Finance Clearance",
        done:
          isAllDone ||
          ["approved", "paid", "sent_to_payroll"].includes(
            selectedRequest.financeClearanceStatus || "",
          ),
        date:
          isAllDone ||
          ["approved", "paid", "sent_to_payroll"].includes(
            selectedRequest.financeClearanceStatus || "",
          )
            ? "Completed"
            : isRejected
              ? "-"
              : selectedRequest.financeClearanceStatus === "not_cleared"
                ? "Not Cleared"
                : isClearancesStarted
                  ? "In Progress"
                  : "Pending",
      },
      {
        label: "Exit Interview",
        done: isInterviewDone,
        date: isInterviewDone
          ? interviewCompletedOn || "Completed"
          : isRejected
            ? "-"
            : effectiveStatus === "awaiting_exit_interview" ||
                (allClearancesDone && !isInterviewDone)
              ? "Awaiting Submission"
              : "Pending",
      },
      {
        label: "Exit Complete",
        done: isAllDone && isInterviewDone,
        date:
          isAllDone && isInterviewDone
            ? "Completed"
            : isRejected
              ? "-"
              : "Pending",
      },
    ];

    return (
      <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
        <h3 className="font-bold text-foreground mb-5 text-base">
          Request Timeline
        </h3>
        <div className="flex flex-col ml-2">
          {steps.map((step, i) => (
            <div
              key={step.label}
              className={`flex gap-4 relative ${i < steps.length - 1 ? "pb-8" : ""}`}
            >
              {i < steps.length - 1 && (
                <div className="absolute left-[9px] top-6 bottom-0 w-[2px] bg-muted"></div>
              )}
              <div
                className={`relative z-10 w-5 h-5 rounded-full bg-card border-2 flex items-center justify-center mt-0.5 flex-shrink-0 ${
                  step.done
                    ? "border-success"
                    : step.rejected
                      ? "border-destructive"
                      : "border-border"
                }`}
              >
                {step.done ? (
                  <Check className="w-3 h-3 text-success" strokeWidth={3} />
                ) : step.rejected ? (
                  <X className="w-3 h-3 text-destructive" strokeWidth={3} />
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-muted-foreground/30" />
                )}
              </div>
              <div className="flex flex-col mt-[-2px]">
                <span className="text-sm font-semibold text-foreground">
                  {step.label}
                </span>
                <span
                  className={`text-xs mt-1 ${step.done ? "text-muted-foreground" : step.rejected ? "text-destructive font-semibold" : "text-muted-foreground"}`}
                >
                  {step.date}
                </span>
                {step.sub && (
                  <span className="text-xs text-muted-foreground mt-1">
                    {step.sub}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  })();

  return (
    <div className="flex flex-col w-full h-full bg-muted overflow-auto px-6 py-6">
      <div className="flex flex-col gap-6 w-full mx-auto">
        {/* Section 1: Header */}
        <div className="flex flex-col gap-4">
          <button
            className="text-muted-foreground hover:text-foreground cursor-pointer w-fit"
            onClick={onBack}
          >
            <ArrowLeft />
          </button>
          <div className="flex justify-between items-start">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold text-foreground">
                  Exit Request Details
                </h1>
                <ExitStatusBadge
                  status={selectedRequest.status}
                  requestId={selectedRequest.id}
                  employeeStatus={selectedRequest.employeeStatus}
                />
              </div>
              <span className="text-sm text-muted-foreground font-medium">
                Request ID: {selectedRequest.requestCode || selectedRequest.id}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {[
                "approved",
                "awaiting_clearances",
                "awaiting_exit_interview",
              ].includes(selectedRequest.status) && (
                <Button
                  variant="destructive"
                  className="font-semibold h-9 px-4 text-sm"
                  onClick={onRevoke}
                >
                  Revoke
                </Button>
              )}
              {selectedRequest.status === "awaiting_clearances" && (
                <Button
                  variant="soft"
                  className="font-semibold flex items-center gap-2"
                  onClick={onRemind}
                >
                  <Send /> Send Reminder (All Pending)
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Section 2: Initiate Clearances banner */}
        {selectedRequest.status === "approved" && (
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <h3 className="font-bold text-primary">
                This request has been approved by the manager.
              </h3>
              <p className="text-sm text-primary">
                Initiate clearances to create IT, Admin, and Finance tasks for
                the offboarding process.
              </p>
            </div>
            <Button
              variant="soft"
              className="font-bold px-6 h-10 flex-shrink-0"
              onClick={async () => {
                try {
                  const completedHrChecklist = hrChecklistItems.filter(
                    (_, idx) => hrCheckedItems[idx],
                  );
                  const clearanceArg =
                    completedHrChecklist.length > 0
                      ? {
                          id: selectedRequest.id,
                          body: { completedChecklist: completedHrChecklist },
                        }
                      : selectedRequest.id;
                  await initiateClearances(clearanceArg).unwrap();
                  setSelectedRequest((prev: any) => ({
                    ...prev,
                    status: "awaiting_clearances",
                  }));
                  toast.success(
                    "Clearances initiated successfully. IT, Admin, and Finance tasks have been created.",
                  );
                } catch (err: any) {
                  toast.error(
                    err?.data?.detail || "Failed to initiate clearances.",
                  );
                }
              }}
            >
              Initiate Clearances
            </Button>
          </div>
        )}

        {selectedRequest.status === "awaiting_clearances" && (
          <div className="bg-success/10 border border-success/20 rounded-xl p-5 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
            <span className="text-sm text-success font-medium">
              Clearances have been initiated. IT, Admin, and Finance teams can
              now process their tasks.
            </span>
          </div>
        )}

        {selectedRequest.status === "completed" && (
          <div className="bg-success/10 border border-success/20 rounded-xl p-5 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
            <span className="text-sm text-success font-medium">
              All clearances have been completed successfully. The exit process
              is now complete.
            </span>
          </div>
        )}

        {/* Section 3: Top row — Employee Information | Exit Details | Request Timeline */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Employee Information */}
          <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex flex-col">
            <h3 className="font-bold text-foreground mb-6 text-base">
              Employee Information
            </h3>
            <div className="flex items-center gap-3 mb-5">
              <Avatar className="h-10 w-10 border-2 border-card shadow-md flex-shrink-0">
                <AvatarFallback className="bg-primary/10 text-primary font-bold text-base">
                  {(selectedRequest.name || "?").charAt(0)}
                </AvatarFallback>
              </Avatar>
              <span className="font-bold text-foreground text-sm">
                {selectedRequest.name ||
                  `${selectedRequest.employeeName || "-"}${selectedRequest.empCode ? ` (${selectedRequest.empCode})` : ""}`}
              </span>
            </div>
            <div className="flex flex-col justify-between flex-1 text-sm">
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Date of Joining
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.dateOfJoining || "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Manager
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.manager ||
                    selectedRequest.reportingManagerName ||
                    "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Department
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.department || "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Email
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-primary break-all">
                  {selectedRequest.email ||
                    selectedRequest.employeeEmail ||
                    "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Phone
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.phone || "-"}
                </span>
              </div>
            </div>
          </div>

          {/* Exit Details */}
          <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex flex-col">
            <h3 className="font-bold text-foreground mb-5 text-base">
              Exit Details
            </h3>
            <div className="flex flex-col justify-between flex-1 text-sm">
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Reason for Exit
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.reason
                    ? selectedRequest.reason.charAt(0).toUpperCase() +
                      selectedRequest.reason.slice(1)
                    : "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Exit Type
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.exitType
                    ? selectedRequest.exitType.charAt(0).toUpperCase() +
                      selectedRequest.exitType.slice(1)
                    : "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Last Working Day
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {formatDate(selectedRequest.lastWorkingDay)}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Notice Period
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.noticePeriod ||
                    (selectedRequest.noticePeriodDays
                      ? `${selectedRequest.noticePeriodDays} Days`
                      : "-")}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="font-semibold text-foreground min-w-[120px]">
                  Initiated By
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground">
                  {selectedRequest.initiatedBy ||
                    (selectedRequest.hrInitiated ? "HR" : "Employee")}
                </span>
              </div>
              {selectedRequest.additionalDetails && (
                <div className="flex gap-3">
                  <span className="font-semibold text-foreground min-w-[120px]">
                    Additional Details
                  </span>
                  <span className="text-muted-foreground">:</span>
                  <span className="text-muted-foreground">
                    {selectedRequest.additionalDetails}
                  </span>
                </div>
              )}
              {selectedRequest.otherReason && (
                <div className="flex gap-3">
                  <span className="font-semibold text-foreground min-w-[120px]">
                    Other Reason
                  </span>
                  <span className="text-muted-foreground">:</span>
                  <span className="text-muted-foreground">
                    {selectedRequest.otherReason}
                  </span>
                </div>
              )}
              {selectedRequest.rejectionReason && (
                <div className="flex gap-3">
                  <span className="font-semibold text-foreground min-w-[120px]">
                    Rejection Reason
                  </span>
                  <span className="text-muted-foreground">:</span>
                  <span className="text-destructive font-medium">
                    {selectedRequest.rejectionReason}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Request Timeline (inline from timelineMarkup) */}
          {timelineMarkup}
        </div>

        {/* Section 4: Clearance Status (full width) */}
        <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-foreground text-base">
                Clearance Status
              </h3>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-success"></div>{" "}
                Completed
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-badge-pending-bg"></div>{" "}
                Pending
              </div>
            </div>
          </div>
          {clearances.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No clearance tasks created yet.
              {selectedRequest.status === "approved" &&
                ' Click "Initiate Clearances" above to start the offboarding process.'}
            </p>
          ) : (
            <div className="rounded-xl border border-border overflow-x-auto bg-card">
              <Table>
                <TableHeader className="bg-table-header">
                  <TableRow>
                    <TableHead className="font-medium text-foreground uppercase tracking-wide h-10 text-xs">
                      Clearance
                    </TableHead>
                    <TableHead className="font-medium text-foreground uppercase tracking-wide h-10 text-xs">
                      Assigned To
                    </TableHead>
                    <TableHead className="font-medium text-foreground uppercase tracking-wide h-10 text-xs">
                      Status
                    </TableHead>
                    <TableHead className="font-medium text-foreground uppercase tracking-wide h-10 text-xs">
                      Completed On
                    </TableHead>
                    <TableHead className="font-bold text-foreground h-10 text-xs uppercase text-center">
                      Action
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clearances.map((c, i) => (
                    <TableRow
                      key={i}
                      className="border-b border-border last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => {
                        let route = "";
                        if (c.assignedTo === "IT Admin") route = "/exit/it";
                        else if (c.assignedTo === "Admin Team")
                          route = "/exit/admin";
                        else if (c.assignedTo === "Finance Team")
                          route = "/exit/finance";

                        if (route) {
                          navigate({
                            to: route,
                            search: { requestId: selectedRequest.id },
                          });
                        }
                      }}
                    >
                      <TableCell className="text-sm font-medium text-muted-foreground py-3">
                        {c.name}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground py-3">
                        {c.assignedTo}
                      </TableCell>
                      <TableCell className="py-3">
                        <span
                          className={`text-xs font-bold ${c.status === "Completed" ? "text-success" : c.status === "Not Cleared" ? "text-destructive" : "text-badge-pending-text"}`}
                        >
                          {c.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground py-3">
                        {c.completedOn}
                      </TableCell>
                      <TableCell className="text-center py-3">
                        {c.status !== "Completed" && (
                          <span
                            className="text-primary font-bold text-xs cursor-pointer hover:underline flex items-center justify-center gap-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemind();
                            }}
                          >
                            <Send />
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* HR Verification Checklist — only shown if configured */}
        {hrChecklistItems.length > 0 && (
          <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
            <h3 className="font-bold text-foreground mb-4 text-base">
              Verification Checklist
            </h3>
            <div className="flex flex-col gap-3">
              {hrChecklistItems.map((label, index) => {
                const isCompleted = selectedRequest.status === "deactivated";
                const savedChecklist =
                  selectedRequest.hrCompletedChecklist || [];
                const isChecked = isCompleted
                  ? savedChecklist.includes(label)
                  : !!hrCheckedItems[index];
                return (
                  <label
                    key={index}
                    className="flex items-center gap-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        if (!isCompleted) {
                          setHrCheckedItems((prev) => ({
                            ...prev,
                            [index]: !prev[index],
                          }));
                        }
                      }}
                      disabled={isCompleted}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-ring"
                    />
                    <span className="text-sm text-foreground">{label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Custom Fields */}
        <div
          className={
            hasCustomFields
              ? "bg-card rounded-xl border border-border p-6 shadow-sm"
              : "hidden"
          }
        >
          <h3 className="font-bold text-foreground mb-4 text-base">
            Custom Fields
          </h3>
          <SectionCustomFields
            entityType="exit_request"
            section="hr_clearance"
            entityId={selectedRequest.id}
            readOnly
            onHasDefinitionsChange={setHasCustomFields}
          />
        </div>

        {/* Section 5: Exit Interview (full width read-only form) */}
        <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-5">
            <h3 className="font-bold text-foreground text-base">
              Exit Interview
            </h3>
            <Badge
              className={`${exitInterview ? "bg-badge-active-bg text-badge-active-text border-badge-active-text/20" : "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20"} hover:bg-transparent px-2 h-5 text-[10px] font-bold ml-auto`}
            >
              {exitInterview ? "Completed" : "Pending"}
            </Badge>
          </div>
          {exitInterview ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground font-medium">1. Reason for Leaving</span>
                <p className="text-sm text-foreground">
                  {exitInterview.reasonForLeaving || "-"}
                </p>
                {exitInterview.otherReason && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {exitInterview.otherReason}
                  </p>
                )}
              </div>
              <Separator />
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground font-medium">2. Overall Experience</span>
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4, 5].map((star) => {
                    const rating = exitInterview.overallRating || 0;
                    const isFull = rating >= star;
                    const isHalf = !isFull && rating >= star - 0.5;
                    return (
                      <div key={star} className="relative w-6 h-6">
                        <Star
                          className={`w-6 h-6 ${isFull ? "text-warning fill-warning" : "text-muted-foreground/30"}`}
                          strokeWidth={1}
                        />
                        {isHalf && (
                          <div className="absolute inset-0 overflow-hidden w-[50%]">
                            <Star className="w-6 h-6 text-warning fill-warning" strokeWidth={1} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <span className="text-sm text-muted-foreground ml-1">
                    {exitInterview.overallRating ? `${exitInterview.overallRating} / 5` : "-"}
                  </span>
                </div>
              </div>
              <Separator />
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground font-medium">3. What did you like most about working here?</span>
                <p className="text-sm text-foreground">
                  {exitInterview.likedMost || "-"}
                </p>
              </div>
              <Separator />
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground font-medium">4. What can we improve?</span>
                <p className="text-sm text-foreground">
                  {exitInterview.improvements || "-"}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The employee has not submitted their exit interview yet.
            </p>
          )}
        </div>

        {/* Section 6: Deactivate Employee */}
        <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex flex-col">
          <h3 className="font-bold text-foreground mb-4 text-base">
            Deactivate Employee
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed flex-1">
            Once all tasks and clearances are completed, you can deactivate
            the employee record.
          </p>
          <Button
            variant="outline"
            className="mt-5 text-destructive border-destructive hover:bg-destructive/10 w-fit"
            disabled={
              (selectedRequest.status !== "awaiting_clearances" &&
                selectedRequest.status !== "awaiting_exit_interview" &&
                selectedRequest.status !== "completed") ||
              !allClearancesDone ||
              !exitInterview
            }
            onClick={onDeactivate}
          >
            Deactivate Employee
          </Button>
        </div>
      </div>
    </div>
  );
}

export const HRFlow = () => {
  const today = new Date().toISOString().split("T")[0];
  const maxLastWorkingDay = (() => {
    const fourMonths = new Date();
    fourMonths.setMonth(fourMonths.getMonth() + 4);
    const yearEnd = new Date(new Date().getFullYear(), 11, 31);
    const cap = fourMonths < yearEnd ? fourMonths : yearEnd;
    return cap.toISOString().split("T")[0];
  })();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [buFilter, setBuFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const { data: departmentsData } = useGetDepartmentsQuery({ limit: 100 });
  const { data: businessUnitsData } = useGetBusinessUnitsQuery({ limit: 100 });
  const [toDate, setToDate] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedRequest, setSelectedRequest] = useState<any>(null);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [archiveToggle, setArchiveToggle] = useState(false);
  const [isDeactivated, setIsDeactivated] = useState(false);

  // Initiate Exit state
  const [isInitiating, setIsInitiating] = useState(false);
  const [initiateEmployeeId, setInitiateEmployeeId] = useState("");
  const [initiateEmployeeSearch, setInitiateEmployeeSearch] = useState("");
  const [initiateExitType, setInitiateExitType] = useState("");
  const [initiateLastWorkingDay, setInitiateLastWorkingDay] = useState("");
  const [initiateImmediateExit, setInitiateImmediateExit] = useState(false);
  const [initiateOverrideNotice, setInitiateOverrideNotice] = useState(false);
  const [initiateReason, setInitiateReason] = useState("");
  const [initiateOtherReason, setInitiateOtherReason] = useState("");
  const [initiateDetailedReason, setInitiateDetailedReason] = useState("");
  const [initiateFiles, setInitiateFiles] = useState<File[]>([]);
  const [initiateLoading, setInitiateLoading] = useState(false);
  const [showImmediateExitConfirm, setShowImmediateExitConfirm] =
    useState(false);
  const [initiateSuccess, setInitiateSuccess] = useState(false);
  const [initiateSuccessData, setInitiateSuccessData] = useState<{
    employeeName: string;
    lastWorkingDay: string;
  } | null>(null);
  const initiateFileRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);
  const [showSettlement, setShowSettlement] = useState(false);
  const [showInterview, setShowInterview] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const { data: employees = [] } = useGetEmployeesQuery({
    search: initiateEmployeeSearch || undefined,
    limit: 100,
  });
  const [createExitRequest] = useCreateExitRequestMutation();
  const [deactivateEmployee] = useDeactivateEmployeeMutation();
  const [sendClearanceReminder] = useSendClearanceReminderMutation();
  const [initiateClearances] = useInitiateClearancesMutation();
  const [revokeExitRequest] = useRevokeExitRequestMutation();

  const { data: hrChecklists } = useGetChecklistsQuery({ deptId: "HR" });
  const hrChecklist = hrChecklists?.[0];
  const hrChecklistItems = hrChecklist?.items || [];
  const [hrCheckedItems, setHrCheckedItems] = useState<Record<number, boolean>>(
    {},
  );
  const [hasCustomFields, setHasCustomFields] = useState(false);

  const handleRevoke = async () => {
    if (!selectedRequest) return;
    try {
      await revokeExitRequest(selectedRequest.id).unwrap();
      setSelectedRequest(null);
      toast.success("Exit request has been revoked successfully.");
    } catch (err: any) {
      toast.error(err?.data?.detail || "Failed to revoke request.");
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      "In Progress":
        "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
      "Pending Tasks":
        "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
      Pending:
        "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
      "Awaiting Clearances": "bg-primary/10 text-primary border-primary/20",
      Completed: "bg-success/15 text-success border-success/30",
      Overdue: "bg-destructive/10 text-destructive border-destructive/20",
    };

    return (
      <span
        className={`inline-flex items-center px-3 py-1 rounded-md text-[10px] font-bold border ${styles[status] || "bg-muted text-muted-foreground border-border"}`}
      >
        {status}
      </span>
    );
  };

  const { data: hrRequests = [] } = useGetHRExitRequestsQuery({
    skip: (currentPage - 1) * pageSize,
    limit: pageSize,
    search: searchTerm || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    department: deptFilter === "all" ? undefined : deptFilter,
    businessUnit: buFilter === "all" ? undefined : buFilter,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  });

  const { data: summary } = useGetHRExitSummaryQuery();

  const selectedEmployee = employees.find((e) => e.id === initiateEmployeeId);

  const resetInitiateForm = () => {
    setInitiateEmployeeId("");
    setInitiateEmployeeSearch("");
    setInitiateExitType("");
    setInitiateLastWorkingDay("");
    setInitiateImmediateExit(false);
    setInitiateOverrideNotice(false);
    setInitiateReason("");
    setInitiateOtherReason("");
    setInitiateDetailedReason("");
    setInitiateFiles([]);
    setShowErrors(false);
  };

  const handleInitiateSubmit = async () => {
    if (
      !initiateEmployeeId ||
      !initiateExitType ||
      !initiateLastWorkingDay ||
      !initiateReason ||
      !initiateDetailedReason
    )
      return;
    if (initiateReason === "others" && !initiateOtherReason) return;
    setInitiateLoading(true);
    try {
      const created = await createExitRequest({
        employeeId: initiateEmployeeId,
        lastWorkingDay: initiateLastWorkingDay,
        reason: initiateReason,
        otherReason:
          initiateReason === "others" ? initiateOtherReason : undefined,
        additionalDetails: initiateDetailedReason,
        exitType: initiateExitType,
        hrInitiated: true,
        immediateExit: initiateImmediateExit,
      }).unwrap();

      // Immediate exit must actually revoke access now. Creating the request only
      // stores the flag (status stays pending_approval); deactivateEmployee is the
      // single point that flips the account to EXIT and emits employee.deleted, and
      // it has no status guard — so call it right after creation to honour the
      // "Deactivate Access" confirmation the HR user just accepted.
      if (initiateImmediateExit) {
        await deactivateEmployee(created.id).unwrap();
      }

      const emp = employees.find((e) => e.id === initiateEmployeeId);
      const empName =
        [emp?.firstName, emp?.lastName].filter(Boolean).join(" ") || "Employee";
      const lwd = new Date(initiateLastWorkingDay)
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        })
        .replace(/ /g, "-");
      setInitiateSuccessData({ employeeName: empName, lastWorkingDay: lwd });
      setInitiateSuccess(true);
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to initiate exit.");
    } finally {
      setInitiateLoading(false);
    }
  };

  const handlePageDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDraggingOver(true);
  };
  const handlePageDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDraggingOver(false);
  };
  const handlePageDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const handlePageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDraggingOver(false);
    const dt = new DataTransfer();
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      dt.items.add(e.dataTransfer.files[i]);
    }
    if (initiateFileRef.current) {
      initiateFileRef.current.files = dt.files;
      initiateFileRef.current.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
    }
  };

  const handleInitiateFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
    ];
    const maxSize = 10 * 1024 * 1024;
    const validFiles: File[] = [];
    for (let i = 0; i < files.length; i++) {
      if (allowedTypes.includes(files[i].type) && files[i].size <= maxSize)
        validFiles.push(files[i]);
    }
    setInitiateFiles((prev) => [...prev, ...validFiles]);
    if (initiateFileRef.current) initiateFileRef.current.value = "";
  };

  const handleRemind = async () => {
    if (!selectedRequest) return;
    try {
      await sendClearanceReminder(selectedRequest.id).unwrap();
      toast.success("Reminder sent successfully");
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to send reminder");
    }
  };

  const handleDeactivate = async () => {
    if (!selectedRequest) return;
    try {
      const completedHrChecklist = hrChecklistItems.filter(
        (_, idx) => hrCheckedItems[idx],
      );
      const deactivateArg =
        completedHrChecklist.length > 0
          ? {
              id: selectedRequest.id,
              body: { completedChecklist: completedHrChecklist },
            }
          : selectedRequest.id;
      await deactivateEmployee(deactivateArg).unwrap();
      toast.success("Employee deactivated successfully");
      setIsDeactivated(true);
      setShowDeactivate(false);
      setSelectedRequest((prev: any) => ({
        ...prev,
        status: "deactivated",
        employeeStatus: "exit",
      }));
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to deactivate employee");
    }
  };

  const renderInitiateExit = () => {
    return (
      <Sheet
        open={isInitiating}
        onOpenChange={(v) => {
          if (!v) {
            setIsInitiating(false);
            resetInitiateForm();
          }
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Initiate Exit</SheetTitle>
            <SheetDescription>
              Enter exit details to initiate the employee exit process.
            </SheetDescription>
          </SheetHeader>

          <div
            className={`flex-1 overflow-y-auto px-6 py-5 space-y-6 relative ${isDraggingOver ? "ring-2 ring-primary ring-inset bg-primary/5" : ""}`}
            onDragEnter={handlePageDragEnter}
            onDragLeave={handlePageDragLeave}
            onDragOver={handlePageDragOver}
            onDrop={handlePageDrop}
          >
            {isDraggingOver && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 pointer-events-none">
                <div className="flex flex-col items-center gap-2 text-primary">
                  <UploadCloud className="size-12" />
                  <p className="text-sm font-semibold">
                    Drop files anywhere to upload
                  </p>
                </div>
              </div>
            )}
            {/* Employee Information */}
            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <h3 className="font-bold text-foreground mb-6 text-base">
                Employee Information
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Employee <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={initiateEmployeeId}
                    onValueChange={setInitiateEmployeeId}
                  >
                    <SelectTrigger className="border-border">
                      <div className="flex items-center gap-2">
                        <SelectValue placeholder="Search employee by name or ID" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {employees.map((emp) => (
                        <SelectItem key={emp.id} value={emp.id}>
                          {[emp.firstName, emp.lastName]
                            .filter(Boolean)
                            .join(" ")}{" "}
                          {emp.empCode ? `(${emp.empCode})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showErrors && !initiateEmployeeId && (
                    <p className="text-xs text-destructive">
                      Employee is required
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Manager <span className="text-destructive">*</span>
                  </Label>
                  <div className="flex items-center gap-2 h-10 px-3 border border-border rounded-md bg-muted text-sm text-muted-foreground">
                    <span>
                      {selectedEmployee ? "Manager" : "Select employee first"}
                    </span>
                  </div>
                </div>
              </div>

              {selectedEmployee && (
                <div className="flex items-center gap-4 mt-6 p-4 bg-muted rounded-xl border border-border/50">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback className="bg-primary/10 text-primary font-bold text-sm">
                      {(selectedEmployee.firstName || "?").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid grid-cols-3 gap-8 text-sm flex-1">
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground font-medium">
                        Department
                      </span>
                      <span className="text-foreground font-semibold">—</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground font-medium">
                        Employee Type
                      </span>
                      <span className="text-foreground font-semibold">
                        Full Time
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground font-medium">
                        Date of Joining
                      </span>
                      <span className="text-foreground font-semibold">—</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Exit Details */}
            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <h3 className="font-bold text-foreground mb-6 text-base">
                Exit Details
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Exit Type <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={initiateExitType}
                    onValueChange={setInitiateExitType}
                  >
                    <SelectTrigger className="border-border">
                      <SelectValue placeholder="Select Exit Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="termination">Termination</SelectItem>
                      <SelectItem value="absconding">Absconding</SelectItem>
                      <SelectItem value="retirement">Retirement</SelectItem>
                      <SelectItem value="contract_end">Contract End</SelectItem>
                    </SelectContent>
                  </Select>
                  {showErrors && !initiateExitType && (
                    <p className="text-xs text-destructive">
                      Exit type is required
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Last Working Day <span className="text-destructive">*</span>
                  </Label>
                  <DatePicker
                    value={initiateLastWorkingDay}
                    onChange={(v) => setInitiateLastWorkingDay(v)}
                    min={today}
                    max={maxLastWorkingDay}
                    className="border-border h-10 w-full"
                  />
                  {showErrors && !initiateLastWorkingDay && (
                    <p className="text-xs text-destructive">
                      Last working day is required
                    </p>
                  )}
                  <span className="text-xs text-muted-foreground">
                    This will be the employee's last working day with the
                    organization.
                  </span>
                </div>
              </div>

              <Separator className="my-6" />

              {/* Immediate Exit Toggle */}
              <div className="flex items-center justify-between p-4 border border-border rounded-xl bg-muted/50 mb-6">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-foreground">
                    Immediate Exit
                  </span>
                  <AlertOctagon className="w-4 h-4 text-badge-pending-text" />
                </div>
                <button
                  className={`relative w-12 h-6 rounded-full transition-colors ${initiateImmediateExit ? "bg-primary" : "bg-muted-foreground/30"}`}
                  onClick={() =>
                    setInitiateImmediateExit(!initiateImmediateExit)
                  }
                >
                  <div
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow-sm transition-transform ${initiateImmediateExit ? "translate-x-6" : "translate-x-0.5"}`}
                  />
                </button>
              </div>
              {initiateImmediateExit && (
                <div className="bg-badge-pending-bg border border-badge-pending-text/20 rounded-xl p-3 flex items-start gap-2 mb-6">
                  <AlertTriangle className="w-4 h-4 text-badge-pending-text flex-shrink-0 mt-0.5" />
                  <span className="text-xs text-badge-pending-text">
                    This will skip notice period and revoke all system access
                    immediately.
                  </span>
                </div>
              )}

              {/* Notice Period */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Notice Period (auto)
                  </Label>
                  <div className="h-10 px-3 border border-border rounded-md bg-muted flex items-center text-sm text-muted-foreground">
                    30 Days
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Auto calculated based on company policy and employee's
                    notice period.
                  </span>
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <Checkbox
                    id="override-notice"
                    checked={initiateOverrideNotice}
                    onCheckedChange={(checked) =>
                      setInitiateOverrideNotice(checked === true)
                    }
                  />
                  <Label
                    htmlFor="override-notice"
                    className="text-sm text-foreground cursor-pointer"
                  >
                    Override Notice Period
                  </Label>
                </div>
              </div>

              {/* Reason for Exit */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Reason for Exit <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={initiateReason}
                    onValueChange={setInitiateReason}
                  >
                    <SelectTrigger className="border-border">
                      <SelectValue placeholder="Select Reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="misconduct">Misconduct</SelectItem>
                      <SelectItem value="performance">
                        Poor Performance
                      </SelectItem>
                      <SelectItem value="redundancy">Redundancy</SelectItem>
                      <SelectItem value="absconding">Absconding</SelectItem>
                      <SelectItem value="contract_expiry">
                        Contract Expiry
                      </SelectItem>
                      <SelectItem value="retirement">Retirement</SelectItem>
                      <SelectItem value="others">Others</SelectItem>
                    </SelectContent>
                  </Select>
                  {showErrors && !initiateReason && (
                    <p className="text-xs text-destructive">
                      Reason for exit is required
                    </p>
                  )}
                </div>
                {initiateReason === "others" && (
                  <div className="flex flex-col gap-2">
                    <Label className="text-sm font-semibold text-foreground">
                      Specify Other Reason{" "}
                      <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      placeholder="Enter other reason"
                      value={initiateOtherReason}
                      onChange={(e) => setInitiateOtherReason(e.target.value)}
                      className="border-border h-10"
                    />
                    {showErrors && !initiateOtherReason && (
                      <p className="text-xs text-destructive">
                        Other reason is required
                      </p>
                    )}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Detailed Reason for Exit{" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Textarea
                      placeholder="Enter detailed reason for exit..."
                      value={initiateDetailedReason}
                      onChange={(e) =>
                        setInitiateDetailedReason(e.target.value)
                      }
                      maxLength={1000}
                      className="border-border resize-none min-h-[100px] pb-6"
                    />
                    <span className="absolute bottom-8 right-3 text-xs text-muted-foreground">
                      {initiateDetailedReason.length} / 1000
                    </span>
                  </div>
                  {showErrors && !initiateDetailedReason && (
                    <p className="text-xs text-destructive mt-1">
                      Detailed reason is required
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Documents */}
            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <h3 className="font-bold text-foreground mb-1 text-base">
                Documents
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                Upload Supporting Documents
              </p>

              <input
                ref={initiateFileRef}
                type="file"
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                multiple
                className="hidden"
                onChange={handleInitiateFileSelect}
              />
              <div
                className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center gap-2 bg-card hover:bg-muted/50 transition-colors cursor-pointer"
                onClick={() => initiateFileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const dt = new DataTransfer();
                  for (let i = 0; i < e.dataTransfer.files.length; i++)
                    dt.items.add(e.dataTransfer.files[i]);
                  if (initiateFileRef.current) {
                    initiateFileRef.current.files = dt.files;
                    initiateFileRef.current.dispatchEvent(
                      new Event("change", { bubbles: true }),
                    );
                  }
                }}
              >
                <UploadCloud className="w-8 h-8 text-primary" />
                <span className="text-sm font-semibold text-primary">
                  Upload Files
                </span>
                <span className="text-xs text-muted-foreground">
                  Drag and drop files here or click to browse
                </span>
                <span className="text-xs text-muted-foreground">
                  Supported formats: PDF, DOC, DOCX, JPG, PNG (Max 10MB each)
                </span>
              </div>

              {initiateFiles.length > 0 && (
                <div className="flex flex-col gap-2 mt-4">
                  {initiateFiles.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 border border-border rounded-xl bg-card"
                    >
                      <div className="flex items-center gap-3">
                        <FileText className="w-5 h-5 text-primary" />
                        <span
                          className="text-sm font-medium text-primary hover:underline cursor-pointer"
                          onClick={() => {
                            const url = URL.createObjectURL(file);
                            window.open(url, "_blank");
                          }}
                        >
                          {file.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {(file.size / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <button
                        onClick={() =>
                          setInitiateFiles((prev) =>
                            prev.filter((_, i) => i !== index),
                          )
                        }
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted-foreground mt-3 italic">
                Examples: Termination Letter, Warning Letter, Resignation Email,
                etc.
              </p>
            </div>
          </div>

          {/* Fixed Footer */}
          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => {
                setIsInitiating(false);
                resetInitiateForm();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              disabled={initiateLoading}
              onClick={() => {
                if (
                  !initiateEmployeeId ||
                  !initiateExitType ||
                  !initiateLastWorkingDay ||
                  !initiateReason ||
                  !initiateDetailedReason ||
                  (initiateReason === "others" && !initiateOtherReason)
                ) {
                  setShowErrors(true);
                  return;
                }
                if (initiateImmediateExit) {
                  setShowImmediateExitConfirm(true);
                } else {
                  handleInitiateSubmit();
                }
              }}
            >
              {initiateLoading ? "Submitting..." : "Submit"}
            </Button>
          </div>

          <Dialog open={initiateSuccess} onOpenChange={setInitiateSuccess}>
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <DialogTitle>Exit initiated</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-success" />
                  <span>Exit has been initiated successfully.</span>
                </div>
                {initiateSuccessData && (
                  <div className="text-sm space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Employee</span>
                      <span className="text-foreground font-medium">
                        {initiateSuccessData.employeeName}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        Last Working Day
                      </span>
                      <span className="text-foreground font-medium">
                        {initiateSuccessData.lastWorkingDay}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  autoFocus
                  onClick={() => {
                    setInitiateSuccess(false);
                    setInitiateSuccessData(null);
                    setIsInitiating(false);
                    resetInitiateForm();
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={showImmediateExitConfirm}
            onOpenChange={setShowImmediateExitConfirm}
          >
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <AlertTriangle className="size-5 text-warning" />
                  <DialogTitle>Immediate exit?</DialogTitle>
                </div>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                All system access will be revoked instantly. Are you sure?
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => setShowImmediateExitConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setShowImmediateExitConfirm(false);
                    handleInitiateSubmit();
                  }}
                >
                  Deactivate Access
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );
  };

  const StarRating = ({
    count,
    total = 5,
  }: {
    count: number;
    total?: number;
  }) => (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: total }).map((_, i) => (
        <Star
          key={i}
          className={`w-4 h-4 ${i < count ? "fill-primary text-primary" : "fill-muted text-muted"}`}
        />
      ))}
    </div>
  );

  const renderSettlement = () => {
    if (!selectedRequest) return null;
    return (
      <Sheet
        open={showSettlement}
        onOpenChange={(v) => {
          if (!v) setShowSettlement(false);
        }}
      >
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Final Settlement & Documents</SheetTitle>
            <SheetDescription>
              Review and manage final settlement status and related documents.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            <div className="flex justify-between items-start">
              <div className="flex flex-col items-end gap-1 ml-auto">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Request ID
                </span>
                <span className="text-sm font-bold text-foreground">
                  {selectedRequest.id}
                </span>
                <Badge className="bg-badge-pending-bg text-badge-pending-text hover:bg-badge-pending-bg border-badge-pending-text/20 px-3 py-1 text-xs font-bold mt-1">
                  In Progress
                </Badge>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex items-center gap-8">
              <div className="flex items-center gap-4">
                <Avatar className="h-14 w-14 border-2 border-primary/20 shadow-md">
                  <AvatarFallback className="bg-primary text-white font-bold text-xl">
                    {selectedRequest.name
                      .split(" ")
                      .map((n: string) => n[0])
                      .join("")}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="font-bold text-foreground text-lg">
                    {selectedRequest.name} ({selectedRequest.empId})
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {selectedRequest.role}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {selectedRequest.department}
                  </span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    Email: {selectedRequest.email}
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="flex flex-col border-l border-border pl-4">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Last Working Day (LWD)
                </span>
                <span className="font-bold text-foreground mt-1">
                  {selectedRequest.lastWorkingDay}
                </span>
              </div>
              <div className="flex flex-col border-l border-border pl-4">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Exit Reason
                </span>
                <span className="font-bold text-foreground mt-1">
                  Career growth and relocation
                </span>
              </div>
              <div className="flex flex-col border-l border-border pl-4">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Exit Date
                </span>
                <div className="flex items-center gap-1.5 mt-1">
                  <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="font-bold text-foreground">
                    {selectedRequest.relievingDate}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <h3 className="font-bold text-foreground mb-6 text-base">
                Final Settlement{" "}
                <span className="text-muted-foreground font-normal text-sm">
                  (View Only)
                </span>
              </h3>
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
                    <FileText />
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-sm font-semibold text-foreground min-w-[140px]">
                      Status
                    </span>
                    <span className="text-muted-foreground/60">:</span>
                    <Badge className="bg-badge-pending-bg text-badge-pending-text hover:bg-badge-pending-bg border-badge-pending-text/20 px-2.5 py-0.5 text-xs font-bold">
                      In Progress
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
                    <ClipboardList className="w-4.5 h-4.5" />
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-sm font-semibold text-foreground min-w-[140px]">
                      Processed By
                    </span>
                    <span className="text-muted-foreground">:</span>
                    <span className="text-sm text-muted-foreground">
                      Finance Team
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
                    <Calendar className="w-4.5 h-4.5" />
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-sm font-semibold text-foreground min-w-[140px]">
                      Expected Completion
                    </span>
                    <span className="text-muted-foreground">:</span>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">
                        30-Jun-2025
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
                    <FileText />
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-sm font-semibold text-foreground min-w-[140px]">
                      Remarks
                    </span>
                    <span className="text-muted-foreground">:</span>
                    <span className="text-sm text-muted-foreground">
                      Awaiting final approvals
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <h3 className="font-bold text-foreground mb-6 text-base">
                Documents
              </h3>
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between p-4 border border-border rounded-xl hover:bg-muted transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <FileText />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-foreground">
                        Experience Letter.pdf
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Uploaded on 24-Jun-2025
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-4 text-xs font-bold border-primary/20 text-primary hover:bg-primary/10"
                  >
                    View
                  </Button>
                </div>
                <div className="flex items-center justify-between p-4 border border-border rounded-xl hover:bg-muted transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <FileText />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-foreground">
                        Relieving Letter.pdf
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Uploaded on 24-Jun-2025
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-4 text-xs font-bold border-primary/20 text-primary hover:bg-primary/10"
                  >
                    View
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-success/10 rounded-xl border border-success/20 p-5 flex items-start gap-4">
                <CheckCircle2 className="w-8 h-8 text-success flex-shrink-0 mt-0.5" />
                <div className="flex flex-col">
                  <span className="text-base font-bold text-success">
                    Settlement Completed
                  </span>
                  <span className="text-sm text-success mt-0.5">
                    Approved by Finance Team
                  </span>
                  <span className="text-sm text-success">
                    Date: 30-Jun-2025
                  </span>
                </div>
              </div>

              <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                <h3 className="font-bold text-foreground mb-3 text-base">
                  Actions
                </h3>
                <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
                  Once all settlement activities are completed, you can proceed
                  to deactivate and archive the employee record.
                </p>
                <Button
                  variant="soft"
                  className="font-bold px-6"
                  onClick={() => setShowDeactivate(true)}
                >
                  Proceed to Deactivate & Archive
                </Button>
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 flex items-start gap-3">
              <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <p className="text-sm text-primary font-medium">
                  All settlement related activities are being managed by the
                  Finance Team.
                </p>
                <p className="text-sm text-primary">
                  You will be notified once the settlement is completed.
                </p>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  };

  const renderInterview = () => {
    if (!selectedRequest) return null;
    const interviewQuestions = [
      {
        q: "How would you rate your overall experience working with the company?",
        rating: 4,
        label: "Good",
        comment:
          "Overall a good experience. Learned a lot and enjoyed working with the team.",
        charCount: 73,
      },
      {
        q: "What did you like most about working here?",
        rating: 4,
        label: "Good",
        comment: "Great work culture, supportive team and flexibility.",
        charCount: 49,
      },
      {
        q: "What could we have done better?",
        rating: 3,
        label: "Average",
        comment:
          "More opportunities for career growth and clearer communication on expectations.",
        charCount: 77,
      },
    ];

    return (
      <Sheet
        open={showInterview}
        onOpenChange={(v) => {
          if (!v) setShowInterview(false);
        }}
      >
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Exit Interview</SheetTitle>
            <SheetDescription>
              View the exit interview submitted by the employee.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            <div className="flex justify-between items-start">
              <div className="flex flex-col items-end gap-1 ml-auto">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Request ID
                </span>
                <span className="text-sm font-bold text-foreground">
                  {selectedRequest.id}
                </span>
                <Badge className="bg-badge-pending-bg text-badge-pending-text hover:bg-badge-pending-bg border-badge-pending-text/20 px-3 py-1 text-xs font-bold mt-1">
                  In Progress
                </Badge>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex items-center gap-8">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16 border-2 border-primary/20 shadow-md">
                  <AvatarFallback className="bg-primary text-white font-bold text-xl">
                    {selectedRequest.name
                      .split(" ")
                      .map((n: string) => n[0])
                      .join("")}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="font-bold text-foreground text-lg">
                    {selectedRequest.name} ({selectedRequest.empId})
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {selectedRequest.role}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {selectedRequest.department}
                  </span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    Email: {selectedRequest.email}
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="flex flex-col border-l border-border pl-4">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Last Working Day
                </span>
                <span className="font-bold text-foreground mt-1">
                  {selectedRequest.lastWorkingDay}
                </span>
              </div>
              <div className="flex flex-col border-l border-border pl-4">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Exit Reason
                </span>
                <span className="font-bold text-foreground mt-1">
                  Career growth and relocation
                </span>
              </div>
              <div className="flex flex-col border-l border-border pl-4">
                <span className="text-xs font-bold text-muted-foreground uppercase">
                  Interview Date
                </span>
                <div className="flex items-center gap-1.5 mt-1">
                  <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="font-bold text-foreground">24-Jun-2025</span>
                </div>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-bold text-foreground text-base">
                  Interview Responses
                </h3>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground font-medium">
                    Overall Rating
                  </span>
                  {/* eslint-disable-next-line react-hooks/static-components */}
                  <StarRating count={4} />
                  <span className="text-muted-foreground font-medium">
                    (4/5)
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-6">
                {interviewQuestions.map((item, i) => (
                  <div key={i} className="border border-border rounded-xl p-5">
                    <p className="text-sm font-bold text-foreground mb-3">
                      {i + 1}. {item.q}
                    </p>
                    <div className="flex items-center gap-2 mb-3">
                      <StarRating count={item.rating} />
                      <span className="text-sm text-muted-foreground font-medium">
                        {item.label}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-bold text-muted-foreground uppercase">
                        Comments
                      </span>
                      <div className="relative">
                        <div className="bg-muted rounded-xl border border-border p-3 text-sm text-muted-foreground min-h-[60px]">
                          {item.comment}
                        </div>
                        <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground font-medium">
                          {item.charCount}/500
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 bg-primary/5 border border-primary/10 rounded-xl p-3 flex items-center gap-2">
                <Info className="w-4 h-4 text-primary flex-shrink-0" />
                <p className="text-xs text-primary font-medium">
                  This is the employee's feedback submitted on 24-Jun-2025.
                </p>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-5">
                <Shield className="w-5 h-5 text-primary" />
                <h3 className="font-bold text-foreground text-base">
                  Interview Details
                </h3>
              </div>
              <div className="grid grid-cols-[120px_auto_1fr] gap-y-4 gap-x-2 text-sm">
                <span className="font-semibold text-foreground">
                  Interview Type
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground font-medium">
                  Exit Interview
                </span>
                <span className="font-semibold text-foreground">
                  Conducted By
                </span>
                <span className="text-muted-foreground">:</span>
                <div className="flex items-center gap-2">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-muted text-muted-foreground text-[10px] font-bold">
                      SK
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">
                      Sneha Kapoor
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      HR Executive
                    </span>
                  </div>
                </div>
                <span className="font-semibold text-foreground">
                  Department
                </span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground font-bold">HR</span>
                <span className="font-semibold text-foreground">Location</span>
                <span className="text-muted-foreground">:</span>
                <span className="text-muted-foreground font-bold">
                  Bangalore, India
                </span>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
              <h3 className="font-bold text-foreground mb-5 text-base">
                Evaluation Summary
              </h3>
              <div className="flex flex-col gap-3">
                {[
                  { label: "Overall Experience", rating: 4 },
                  { label: "Job Role", rating: 4 },
                  { label: "Team", rating: 5 },
                  { label: "Management", rating: 4 },
                ].map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground font-medium">
                      {item.label}
                    </span>
                    <StarRating count={item.rating} />
                  </div>
                ))}
                <div className="flex items-center justify-between pt-3 border-t border-border mt-1">
                  <span className="text-sm text-muted-foreground font-medium">
                    Would you recommend us?
                  </span>
                  <span className="text-sm font-bold text-success">Yes</span>
                </div>
              </div>
            </div>

            <div className="bg-primary/10 rounded-xl border border-primary/20 p-5">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-foreground text-sm mb-1">
                    Note
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    Thank the employee for their time and honest feedback.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  };

  const renderHRDetail = () => {
    if (!selectedRequest) return null;
    return (
      <Sheet
        open={!!selectedRequest}
        onOpenChange={(v) => {
          if (!v) setSelectedRequest(null);
        }}
      >
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <div className="flex-1 overflow-y-auto">
            <HRRequestDetail
              selectedRequest={selectedRequest}
              onBack={() => setSelectedRequest(null)}
              onRemind={handleRemind}
              onDeactivate={() => setShowDeactivate(true)}
              onRevoke={handleRevoke}
              initiateClearances={initiateClearances}
              setSelectedRequest={setSelectedRequest}
              hrChecklistItems={hrChecklistItems}
              hrCheckedItems={hrCheckedItems}
              setHrCheckedItems={setHrCheckedItems}
              hasCustomFields={hasCustomFields}
              setHasCustomFields={setHasCustomFields}
            />
          </div>
        </SheetContent>
      </Sheet>
    );
  };

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Exit Requests Dashboard"
          subtitle="Overview of all exit requests and their current status"
          action={
            <Button onClick={() => setIsInitiating(true)}>
              <Plus /> Initiate Exit
            </Button>
          }
        />

        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              key: "all",
              label: "Total Requests",
              value: summary?.total || 0,
              icon: ClipboardList,
              action: () => setStatusFilter("all"),
            },
            {
              key: "pending_approval",
              label: "In Progress",
              value: summary?.inProgress || 0,
              icon: Clock,
              action: () => setStatusFilter("pending_approval"),
            },

            {
              key: "awaiting_clearances",
              label: "Awaiting Clearances",
              value: summary?.awaitingClearances || 0,
              icon: FileText,
              action: () => setStatusFilter("awaiting_clearances"),
            },
            {
              key: "completed",
              label: "Completed",
              value: summary?.completed || 0,
              icon: CheckCircle2,
              action: () => setStatusFilter("completed"),
            },
          ].map((card) => (
            <div
              key={card.key}
              className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${statusFilter === card.key ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/50"}`}
              onClick={card.action}
            >
              <div>
                <p className="text-xs text-muted-foreground font-medium">
                  {card.label}
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {card.value}
                </p>
              </div>
              <card.icon className="size-8 shrink-0 text-muted-foreground" />
            </div>
          ))}
        </div>

        {/* Table with integrated toolbar */}
        <div className="rounded-xl border overflow-x-auto bg-card">
          {/* Toolbar */}
          <div className="flex items-center gap-3 border-b px-4 py-3 flex-wrap">
            <div className="relative flex-1 min-w-0 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search by employee name or request ID"
                className="pl-9"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <Select
              value={buFilter}
              onValueChange={(v) => {
                setBuFilter(v);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="All Business Units" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Business Units</SelectItem>
                {(businessUnitsData ?? []).map((bu) => (
                  <SelectItem key={bu.id} value={bu.business_unit_name}>
                    {bu.business_unit_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={deptFilter} onValueChange={setDeptFilter}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="All Depts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Departments</SelectItem>
                {(departmentsData ?? []).map((dept) => (
                  <SelectItem key={dept.id} value={dept.departmentName}>
                    {dept.departmentName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="pending_approval">
                  Pending Approval
                </SelectItem>
                <SelectItem value="under_review">Under Review</SelectItem>
                <SelectItem value="awaiting_clearances">
                  Awaiting Clearances
                </SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
            <DatePicker
              value={fromDate}
              onChange={(v) => {
                setFromDate(v);
                if (toDate && v > toDate) setToDate("");
              }}
              max={toDate || undefined}
              placeholder="From date"
              className="w-[160px]"
            />
            <DatePicker
              value={toDate}
              onChange={(v) => setToDate(v)}
              min={fromDate || undefined}
              placeholder="To date"
              className="w-[160px]"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearchTerm("");
                setStatusFilter("all");
                setDeptFilter("all");
                setBuFilter("all");
                setFromDate("");
                setToDate("");
              }}
            >
              Reset
            </Button>
          </div>

          {/* Table Content */}
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 w-[12%]">
                  Request ID
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[16%]">
                  Employee Name
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[12%]">
                  Employee Code
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                  Department
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                  Last Working Day
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                  Status
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[12%]">
                  Initiated By
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hrRequests.length > 0 ? (
                hrRequests.map((request) => {
                  const empName = `${request.employeeName || "Employee"}${request.empCode ? ` (${request.empCode})` : ""}`;
                  const lwd = new Date(request.lastWorkingDay)
                    .toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                      timeZone: "Asia/Kolkata",
                    })
                    .replace(/ /g, "-");
                  return (
                    <TableRow
                      key={request.id}
                      className="cursor-pointer"
                      onClick={() =>
                        setSelectedRequest({
                          ...request,
                          name: empName,
                          empId: request.empCode,
                          role: request.employeeRole,
                          subDept: request.subDept,
                          location: request.currentLocation,
                          dateOfJoining: request.dateOfJoining
                            ? new Date(request.dateOfJoining)
                                .toLocaleDateString("en-GB", {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                  timeZone: "Asia/Kolkata",
                                })
                                .replace(/ /g, "-")
                            : "N/A",
                          manager: request.reportingManagerName,
                          email: request.employeeEmail,
                          phone: request.phone,
                          requestedOn: request.createdOn
                            ? new Date(request.createdOn)
                                .toLocaleDateString("en-GB", {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                  timeZone: "Asia/Kolkata",
                                })
                                .replace(/ /g, "-")
                            : "N/A",
                          noticePeriod: `${request.noticePeriodDays} Days`,
                          initiatedBy: request.hrInitiated ? "HR" : "Employee",
                        })
                      }
                    >
                      <TableCell className="text-sm text-muted-foreground font-medium">
                        {request.requestCode}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground font-medium text-center">
                        {request.employeeName || "Employee"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {request.empCode || "-"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {request.department || "N/A"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {lwd}
                      </TableCell>
                      <TableCell className="text-center">
                        <ExitStatusBadge
                          status={request.status}
                          requestId={request.id}
                          employeeStatus={request.employeeStatus}
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {request.hrInitiated ? "HR" : "Employee"}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      title="No exit requests found"
                      description="No requests match your current filters."
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <TablePagination
            currentPage={currentPage}
            totalPages={Math.max(
              1,
              currentPage + (hrRequests.length >= pageSize ? 1 : 0),
            )}
            startIndex={
              hrRequests.length > 0 ? (currentPage - 1) * pageSize + 1 : 0
            }
            endIndex={(currentPage - 1) * pageSize + hrRequests.length}
            total={hrRequests.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setCurrentPage(1);
            }}
          />
        </div>
      </div>

      <Dialog open={showDeactivate} onOpenChange={setShowDeactivate}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-5 text-warning" />
              <DialogTitle>Deactivate employee?</DialogTitle>
            </div>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to deactivate the employee's record? This
            action cannot be undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() => setShowDeactivate(false)}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleDeactivate}
            >
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {renderInitiateExit()}
      {renderHRDetail()}
      {renderSettlement()}
      {renderInterview()}
    </>
  );
};

export default HRFlow;
