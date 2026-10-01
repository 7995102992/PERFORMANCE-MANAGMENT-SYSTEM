import { useState } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { SectionCustomFields } from "@/components/shared/SectionCustomFields";
import {
  Search,
  Eye,
  Check,
  X,
  Download,
  TriangleAlert,
  Clock,
  CheckCircle2,
  XCircle,
  CircleCheck,
  CircleX,
  History,
  RotateCcw,
  LayoutTemplate,
  FileText,
  Info,
  Loader2,
  AlertTriangle,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

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
import { toast } from "@/lib/toast";
import { DatePicker } from "@/components/ui/date-picker";
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

import {
  useGetTeamExitRequestsQuery,
  useGetTeamExitSummaryQuery,
  useManagerApproveRequestMutation,
  useManagerRejectRequestMutation,
  useRevokeExitRequestMutation,
  useGetAssetQuery,
  useGetExitInterviewQuery,
  useGetChecklistsQuery,
} from "@/store/api/exitManagementApi";
import type { TeamExitRequestResponse } from "@/store/api/exitManagementApi";
import {
  useGetDepartmentsQuery,
  useGetBusinessUnitsQuery,
} from "@/store/api/iamApi";

function ExitStatusBadge({
  status,
  requestId,
  employeeStatus,
}: {
  status: string;
  requestId: string;
  employeeStatus?: string | null;
  className?: string;
}) {
  const { data: interview } = useGetExitInterviewQuery(requestId, {
    skip: status !== "completed",
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

function DocumentItem({ docId }: { docId: string }) {
  const { data: asset } = useGetAssetQuery(docId);
  const fileName = asset?.file_name ?? "Document";
  const fileUrl = asset?.file_url;

  const handleDownload = async () => {
    if (!fileUrl) return;
    try {
      const response = await fetch(fileUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      window.open(fileUrl, "_blank");
    }
  };

  return (
    <div className="flex items-center justify-between p-3 border border-border rounded-xl hover:bg-muted transition-colors">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-destructive/10 text-destructive rounded">
          <FileText />
        </div>
        {fileUrl ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-primary hover:underline cursor-pointer"
          >
            {fileName}
          </a>
        ) : (
          <span className="text-sm font-medium text-primary">{fileName}</span>
        )}
      </div>
      {fileUrl && (
        <button
          onClick={handleDownload}
          className="text-primary hover:text-primary"
        >
          <Download className="w-5 h-5 cursor-pointer" />
        </button>
      )}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending_approval: "Pending Approval",
  hr_initiated: "HR Initiated - Pending Approval",
  under_review: "Under Review",
  awaiting_clearances: "Awaiting Clearances",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  completed: "Completed",
  deactivated: "Deactivated",
  notice_period: "Serving Notice",
  exit: "Exited",
  awaiting_exit_interview: "Awaiting Exit Interview",
};

const STATUS_STYLES: Record<string, string> = {
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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return formatDateIST(dateStr);
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  return formatDateTimeIST(dateStr);
}

export const ManagerFlow = () => {
  const today = new Date().toISOString().split("T")[0];
  const maxLastWorkingDay = (() => {
    const fourMonths = new Date();
    fourMonths.setMonth(fourMonths.getMonth() + 4);
    const yearEnd = new Date(new Date().getFullYear(), 11, 31);
    const cap = fourMonths < yearEnd ? fourMonths : yearEnd;
    return cap.toISOString().split("T")[0];
  })();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [businessUnitFilter, setBusinessUnitFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { data: departmentsData } = useGetDepartmentsQuery({ limit: 100 });
  const { data: businessUnitsData } = useGetBusinessUnitsQuery({ limit: 100 });
  const [toDate, setToDate] = useState("");

  const [selectedRequest, setSelectedRequest] =
    useState<TeamExitRequestResponse | null>(null);
  const [isApproveDialogOpen, setIsApproveDialogOpen] = useState(false);
  const [approveComments, setApproveComments] = useState("");
  const [finalLastWorkingDay, setFinalLastWorkingDay] = useState("");
  const [isRejectDialogOpen, setIsRejectDialogOpen] = useState(false);
  const [rejectActionType, setRejectActionType] = useState("");
  const [rejectComments, setRejectComments] = useState("");
  const [loading, setLoading] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const { data: teamRequests = [], isLoading: isLoadingRequests } =
    useGetTeamExitRequestsQuery({
      skip: (currentPage - 1) * pageSize,
      limit: pageSize,
      search: searchTerm || undefined,
      status: statusFilter || undefined,
      department: departmentFilter || undefined,
      businessUnit: businessUnitFilter || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });

  const { data: summary } = useGetTeamExitSummaryQuery();
  const { data: exitInterview } = useGetExitInterviewQuery(
    selectedRequest?.id ?? "",
    { skip: !selectedRequest },
  );

  const [managerApproveRequest] = useManagerApproveRequestMutation();
  const [managerRejectRequest] = useManagerRejectRequestMutation();
  const [revokeExitRequest] = useRevokeExitRequestMutation();
  const [isRevokeDialogOpen, setIsRevokeDialogOpen] = useState(false);

  const { data: managerChecklists } = useGetChecklistsQuery({
    deptId: "MANAGER",
  });
  const managerChecklist = managerChecklists?.[0];
  const checklistItems = managerChecklist?.items || [];
  const [checkedItems, setCheckedItems] = useState<Record<number, boolean>>({});
  const [hasCustomFields, setHasCustomFields] = useState(false);

  const handleRevoke = async () => {
    if (!selectedRequest) return;
    setLoading(true);
    try {
      await revokeExitRequest(selectedRequest.id).unwrap();
      setIsRevokeDialogOpen(false);
      toast.success(
        `Exit request for ${selectedRequest.employeeName} has been revoked.`,
      );
      setSelectedRequest(null);
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to revoke request.");
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!selectedRequest || !finalLastWorkingDay) return;
    setLoading(true);
    try {
      const completedChecklist = checklistItems.filter(
        (_, idx) => checkedItems[idx],
      );
      const result = await managerApproveRequest({
        id: selectedRequest.id,
        body: {
          comments: approveComments || undefined,
          finalLastWorkingDay,
          completedChecklist:
            completedChecklist.length > 0 ? completedChecklist : undefined,
        },
      }).unwrap();
      setSelectedRequest(result);
      setIsApproveDialogOpen(false);
      setApproveComments("");
      setFinalLastWorkingDay("");
      toast.success(
        `Resignation Approved. An email has been sent to ${selectedRequest.employeeName} and the HR Department to initiate offboarding.`,
      );
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to approve request.");
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    if (!selectedRequest || !rejectActionType || !rejectComments) return;
    setLoading(true);
    try {
      const completedChecklist = checklistItems.filter(
        (_, idx) => checkedItems[idx],
      );
      const result = await managerRejectRequest({
        id: selectedRequest.id,
        body: {
          actionType: rejectActionType as "standard" | "retention",
          comments: rejectComments,
          completedChecklist:
            completedChecklist.length > 0 ? completedChecklist : undefined,
        },
      }).unwrap();
      setSelectedRequest(result);
      setIsRejectDialogOpen(false);
      if (rejectActionType === "retention") {
        toast.success(
          `Retention Confirmed. The exit process for ${selectedRequest.employeeName} has been cancelled. Their status remains Active.`,
        );
      } else {
        toast.error(
          "Request Rejected. The employee has been notified to correct and resubmit their request.",
        );
      }
      setRejectActionType("");
      setRejectComments("");
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to reject request.");
    } finally {
      setLoading(false);
    }
  };

  const approveDialogMarkup = (
    <Dialog open={isApproveDialogOpen} onOpenChange={setIsApproveDialogOpen}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b">
          <DialogTitle>Approve exit request</DialogTitle>
        </DialogHeader>

        <div className="p-6 flex flex-col gap-6 pt-2">
          <div className="bg-success/10 rounded-xl border border-success/20 p-4 flex gap-3">
            <TriangleAlert className="w-6 h-6 text-success flex-shrink-0" />
            <div className="flex flex-col text-sm text-success mt-0.5">
              <span className="font-semibold mb-1">
                You are about to approve this exit request.
              </span>
            </div>
          </div>

          {selectedRequest && (
            <div className="bg-muted rounded-xl p-5 border border-border">
              <h4 className="text-sm font-semibold text-foreground mb-4">
                Request Summary
              </h4>
              <div className="grid grid-cols-[1fr_1fr] gap-y-3 text-sm">
                <span className="text-muted-foreground">Employee Name</span>
                <span className="text-foreground font-medium">
                  {selectedRequest.employeeName}
                  {selectedRequest.empCode
                    ? ` (${selectedRequest.empCode})`
                    : ""}
                </span>

                <span className="text-muted-foreground">Request Code</span>
                <span className="text-foreground font-medium">
                  {selectedRequest.requestCode}
                </span>

                <span className="text-muted-foreground">
                  Reason for Leaving
                </span>
                <span className="text-foreground font-medium">
                  {selectedRequest.reason.charAt(0).toUpperCase() +
                    selectedRequest.reason.slice(1)}
                </span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 relative">
            <Label className="text-sm font-semibold text-foreground">
              Manager Comments <span className="text-destructive">*</span>
            </Label>
            <Textarea
              placeholder="Enter comments"
              className="h-24 resize-none border-border focus-visible:ring-0 focus-visible:border-muted-foreground/40 pb-6"
              maxLength={360}
              value={approveComments}
              onChange={(e) => setApproveComments(e.target.value)}
            />
            <span className="absolute bottom-8 right-3 text-xs text-muted-foreground font-medium">
              {approveComments.length}/360
            </span>
            {showErrors && !approveComments && (
              <p className="text-xs text-destructive mt-1">
                Manager comments are required
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-sm font-semibold text-foreground">
              Last Working Day<span className="text-destructive">*</span>
            </Label>
            <DatePicker
              value={finalLastWorkingDay}
              onChange={(v) => setFinalLastWorkingDay(v)}
              min={today}
              max={maxLastWorkingDay}
              className="border-border h-10 w-full"
            />
            {showErrors && !finalLastWorkingDay && (
              <p className="text-xs text-destructive">
                Last working day is required
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setIsApproveDialogOpen(false);
              setShowErrors(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={loading}
            onClick={() => {
              if (!finalLastWorkingDay || !approveComments) {
                setShowErrors(true);
                return;
              }
              handleApprove();
            }}
          >
            {loading ? "Approving..." : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const rejectDialogMarkup = (
    <Dialog
      open={isRejectDialogOpen}
      onOpenChange={(open) => {
        setIsRejectDialogOpen(open);
        if (!open) {
          setRejectActionType("");
          setRejectComments("");
        }
      }}
    >
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b">
          <DialogTitle>Reject resignation request</DialogTitle>
        </DialogHeader>

        <div className="p-6 flex flex-col gap-6 pt-2">
          <div className="bg-destructive/10 rounded-xl border border-destructive/20 p-4 flex gap-3">
            <XCircle className="w-6 h-6 text-destructive flex-shrink-0" />
            <div className="flex flex-col text-sm text-destructive mt-0.5">
              <span className="font-semibold mb-1">
                You are about to reject this resignation request.
              </span>
              <span>
                Please provide a reason for rejection or select retention if
                applicable.
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-sm font-semibold text-foreground">
              Select Action Type <span className="text-destructive">*</span>
            </Label>
            <Select
              value={rejectActionType}
              onValueChange={setRejectActionType}
            >
              <SelectTrigger className="border-border">
                <SelectValue placeholder="Select Action Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">
                  Standard Rejection (e.g., "Wrong date," "Missing info")
                </SelectItem>
                <SelectItem value="retention">
                  Successful Retention (The employee has agreed to stay)
                </SelectItem>
              </SelectContent>
            </Select>
            {showErrors && !rejectActionType && (
              <p className="text-xs text-destructive">
                Action type is required
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2 relative">
            <Label className="text-sm font-semibold text-foreground">
              Manager Comments / Retention Summary{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Textarea
              placeholder="Explain why this request is being rejected or what was promised to retain the employee (e.g., salary correction, role change)."
              className="h-28 resize-none border-border focus-visible:ring-ring pb-6"
              maxLength={500}
              value={rejectComments}
              onChange={(e) => setRejectComments(e.target.value)}
            />
            <span className="absolute bottom-8 right-3 text-xs text-muted-foreground font-medium">
              {rejectComments.length}/500
            </span>
            {showErrors && !rejectComments && (
              <p className="text-xs text-destructive mt-1">
                Comments are required
              </p>
            )}
          </div>

          <div className="bg-primary/5 rounded-xl p-3 flex gap-2">
            <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <span className="text-sm text-primary font-medium">
              The employee will be notified about the rejection / retention
              decision.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setIsRejectDialogOpen(false);
              setRejectActionType("");
              setRejectComments("");
              setShowErrors(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-destructive border-destructive hover:bg-destructive/10"
            disabled={loading}
            onClick={() => {
              if (!rejectActionType || !rejectComments) {
                setShowErrors(true);
                return;
              }
              handleReject();
            }}
          >
            {loading ? "Submitting..." : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const renderManagerDetail = () => {
    if (!selectedRequest) return null;
    return (
      <>
        <Sheet
          open={!!selectedRequest}
          onOpenChange={(v) => {
            if (!v) setSelectedRequest(null);
          }}
        >
          <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
            <SheetHeader className="px-6 py-5 border-b">
              <div className="flex items-center justify-between">
                <div>
                  <SheetTitle>Exit Request Details</SheetTitle>
                  <SheetDescription>
                    Request ID: {selectedRequest.requestCode}
                  </SheetDescription>
                </div>
                <ExitStatusBadge
                  status={selectedRequest.status}
                  requestId={selectedRequest.id}
                  employeeStatus={selectedRequest.employeeStatus}
                />
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex flex-col">
                  <h3 className="font-bold text-foreground mb-6 text-base">
                    Employee Information
                  </h3>

                  <div className="flex items-center gap-4 mb-8">
                    <div className="w-12 h-12 rounded-full bg-muted overflow-x-auto flex-shrink-0">
                      <div className="w-full h-full bg-primary/10 text-primary flex items-center justify-center font-bold text-lg">
                        {(selectedRequest.employeeName || "?").charAt(0)}
                      </div>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-bold text-foreground">
                        {selectedRequest.employeeName || "-"}
                        {selectedRequest.empCode
                          ? ` (${selectedRequest.empCode})`
                          : ""}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-y-6 text-sm gap-x-4 flex-1">
                    <span className="font-semibold text-foreground">
                      Employee ID
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.empCode || "-"}
                    </span>

                    <span className="font-semibold text-foreground">
                      Department
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.department || "-"}
                    </span>

                    <span className="font-semibold text-foreground">
                      Date of Joining
                    </span>
                    <span className="text-muted-foreground">
                      {formatDate(selectedRequest.dateOfJoining)}
                    </span>

                    <span className="font-semibold text-foreground">
                      Current Location
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.currentLocation || "-"}
                    </span>

                    <span className="font-semibold text-foreground">
                      Reporting Manager
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.reportingManagerName || "-"}
                    </span>
                  </div>
                </div>

                <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex flex-col">
                  <h3 className="font-bold text-foreground mb-6 text-base">
                    Exit Request Information
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] text-sm gap-x-4 flex-1 content-between">
                    <span className="font-semibold text-foreground">
                      Request ID
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.requestCode}
                    </span>

                    <span className="font-semibold text-foreground">
                      Exit Type
                    </span>
                    <span className="text-muted-foreground">Resignation</span>

                    <span className="font-semibold text-foreground">
                      Reason for Leaving
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.reason.charAt(0).toUpperCase() +
                        selectedRequest.reason.slice(1)}
                    </span>

                    {selectedRequest.otherReason && (
                      <>
                        <span className="font-semibold text-foreground">
                          Other Reason
                        </span>
                        <span className="text-muted-foreground">
                          {selectedRequest.otherReason}
                        </span>
                      </>
                    )}

                    <span className="font-semibold text-foreground">
                      Notice Period
                    </span>
                    <span className="text-muted-foreground">
                      {selectedRequest.noticePeriodDays
                        ? `${selectedRequest.noticePeriodDays} Days`
                        : "-"}
                    </span>

                    <span className="font-semibold text-foreground">
                      Created on
                    </span>
                    <span className="text-muted-foreground">
                      {formatDateTime(selectedRequest.createdOn)}
                    </span>
                  </div>
                </div>

                <div className="bg-card rounded-xl border border-border p-6 shadow-sm flex flex-col">
                  <h3 className="font-bold text-foreground mb-6 text-base">
                    Request Timeline
                  </h3>
                  {(() => {
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
                    const isAllDone = ["completed", "deactivated"].includes(
                      status,
                    );
                    const isInterviewDone = !!exitInterview;

                    const steps = [
                      {
                        label: "Request Submitted",
                        done: true,
                        date: formatDateTime(selectedRequest.createdOn),
                        sub: `${selectedRequest.employeeName || "-"}${selectedRequest.empCode ? ` (${selectedRequest.empCode})` : ""}`,
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
                        date: isClearancesStarted
                          ? "Initiated"
                          : isRejected
                            ? "-"
                            : "Pending",
                      },
                      {
                        label: "IT Clearance",
                        done:
                          isAllDone ||
                          ["verified"].includes(
                            selectedRequest.itClearanceStatus || "",
                          ),
                        date:
                          isAllDone ||
                          ["verified"].includes(
                            selectedRequest.itClearanceStatus || "",
                          )
                            ? "Completed"
                            : isRejected
                              ? "-"
                              : selectedRequest.itClearanceStatus ===
                                  "not_cleared"
                                ? "Not Cleared"
                                : isClearancesStarted
                                  ? "In Progress"
                                  : "Pending",
                      },
                      {
                        label: "Admin Clearance",
                        done:
                          isAllDone ||
                          ["completed"].includes(
                            selectedRequest.adminClearanceStatus || "",
                          ),
                        date:
                          isAllDone ||
                          ["completed"].includes(
                            selectedRequest.adminClearanceStatus || "",
                          )
                            ? "Completed"
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
                            ? "Completed"
                            : isRejected
                              ? "-"
                              : selectedRequest.financeClearanceStatus ===
                                  "not_cleared"
                                ? "Not Cleared"
                                : isClearancesStarted
                                  ? "In Progress"
                                  : "Pending",
                      },
                      {
                        label: "Exit Interview",
                        done: isInterviewDone,
                        date: isInterviewDone
                          ? "Completed"
                          : isRejected
                            ? "-"
                            : effectiveStatus === "awaiting_exit_interview" ||
                                (isClearancesStarted && !isInterviewDone)
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
                                <Check
                                  className="w-3 h-3 text-success"
                                  strokeWidth={3}
                                />
                              ) : step.rejected ? (
                                <X
                                  className="w-3 h-3 text-destructive"
                                  strokeWidth={3}
                                />
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
                    );
                  })()}
                </div>
              </div>

              <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                <h3 className="font-bold text-foreground mb-5 text-base">
                  Supporting Documents ({selectedRequest.documentIds.length})
                </h3>
                {selectedRequest.documentIds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No documents attached.
                  </p>
                ) : (
                  selectedRequest.documentIds.map((docId) => (
                    <DocumentItem key={docId} docId={docId} />
                  ))
                )}
              </div>

              {checklistItems.length > 0 && (
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                  <h3 className="font-bold text-foreground mb-4 text-base">
                    Verification Checklist
                  </h3>
                  <div className="flex flex-col gap-3">
                    {checklistItems.map((label, index) => {
                      const isCompleted =
                        selectedRequest.status !== "pending_approval" &&
                        selectedRequest.status !== "under_review";
                      const savedChecklist =
                        selectedRequest.managerCompletedChecklist || [];
                      const isChecked = isCompleted
                        ? savedChecklist.includes(label)
                        : !!checkedItems[index];
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
                                setCheckedItems((prev) => ({
                                  ...prev,
                                  [index]: !prev[index],
                                }));
                              }
                            }}
                            disabled={isCompleted}
                            className="w-4 h-4 rounded border-border text-primary focus:ring-ring"
                          />
                          <span className="text-sm text-foreground">
                            {label}
                          </span>
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
                  section="manager_clearance"
                  entityId={selectedRequest.id}
                  readOnly
                  onHasDefinitionsChange={setHasCustomFields}
                />
              </div>

              {selectedRequest.additionalDetails && (
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                  <h3 className="font-bold text-foreground mb-3 text-base">
                    Additional Details
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedRequest.additionalDetails}
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-4 mt-4">
                <Button
                  variant="outline"
                  className="px-8 border-border text-foreground font-semibold h-10 hover:bg-muted"
                  onClick={() => setSelectedRequest(null)}
                >
                  Cancel
                </Button>
                {(selectedRequest.status === "pending_approval" ||
                  selectedRequest.status === "under_review") && (
                  <>
                    <Button
                      variant="outline"
                      className="px-8 h-10 font-semibold text-destructive border-destructive hover:bg-destructive/10"
                      onClick={() => setIsRejectDialogOpen(true)}
                    >
                      Reject Request
                    </Button>
                    <Button
                      variant="soft"
                      className="px-8 h-10 font-semibold"
                      onClick={() => setIsApproveDialogOpen(true)}
                    >
                      Approve Request
                    </Button>
                  </>
                )}
                {["approved", "awaiting_clearances"].includes(
                  selectedRequest.status,
                ) && (
                  <Button
                    variant="destructive"
                    className="px-8 font-semibold h-10"
                    onClick={() => setIsRevokeDialogOpen(true)}
                  >
                    <XCircle /> Revoke
                  </Button>
                )}
              </div>
            </div>
          </SheetContent>
        </Sheet>

        {approveDialogMarkup}
        {rejectDialogMarkup}
        <Dialog open={isRevokeDialogOpen} onOpenChange={setIsRevokeDialogOpen}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <AlertTriangle className="size-5 text-warning" />
                <DialogTitle>Revoke exit request?</DialogTitle>
              </div>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to revoke the exit request for{" "}
              <span className="font-semibold text-foreground">
                {selectedRequest?.employeeName}
              </span>
              ? This will withdraw the approved request.
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                autoFocus
                onClick={() => setIsRevokeDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={handleRevoke}
                disabled={loading}
              >
                {loading ? "Revoking..." : "Revoke"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  };

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Team Exit Requests"
          subtitle="View and manage exit requests from your team members."
        />

        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {[
            {
              key: "",
              label: "Total Requests",
              value: summary?.total ?? 0,
              icon: LayoutTemplate,
            },
            {
              key: "pending_approval",
              label: "Pending Approval",
              value: summary?.pendingApproval ?? 0,
              icon: Clock,
            },
            {
              key: "approved",
              label: "Approved",
              value: summary?.approved ?? 0,
              icon: CheckCircle2,
            },
            {
              key: "rejected",
              label: "Rejected",
              value: summary?.rejected ?? 0,
              icon: XCircle,
            },
            {
              key: "withdrawn",
              label: "Withdrawn",
              value: summary?.withdrawn ?? 0,
              icon: RotateCcw,
            },
          ].map((card) => (
            <div
              key={card.key}
              className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${statusFilter === card.key ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/50"}`}
              onClick={() => {
                setStatusFilter(card.key);
                setCurrentPage(1);
              }}
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
          <div className="flex items-center gap-3 border-b px-4 py-3 flex-wrap">
            <div className="relative flex-1 min-w-0 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search by employee name, request ID or reason"
                className="pl-9"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <Select
              value={businessUnitFilter || "all"}
              onValueChange={(v) => setBusinessUnitFilter(v === "all" ? "" : v)}
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
            <Select
              value={departmentFilter || "all"}
              onValueChange={(v) => setDepartmentFilter(v === "all" ? "" : v)}
            >
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
            <Select
              value={statusFilter || "all"}
              onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending_approval">
                  Pending Approval
                </SelectItem>
                <SelectItem value="under_review">Under Review</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="awaiting_clearances">
                  Awaiting Clearances
                </SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="withdrawn">Withdrawn</SelectItem>
              </SelectContent>
            </Select>
            <DatePicker
              value={fromDate}
              onChange={(v) => setFromDate(v)}
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
                setStatusFilter("");
                setDepartmentFilter("");
                setBusinessUnitFilter("");
                setFromDate("");
                setToDate("");
              }}
            >
              Reset
            </Button>
          </div>

          {isLoadingRequests ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
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
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[16%]">
                    Reason
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                    Requested On
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teamRequests.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState
                        title="No exit requests found"
                        description="No requests match your current filters."
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  teamRequests.map((request) => (
                    <TableRow
                      key={request.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedRequest(request)}
                    >
                      <TableCell className="text-sm text-muted-foreground font-medium">
                        {request.requestCode}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground font-medium text-center">
                        {request.employeeName || "-"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {request.empCode || "-"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {request.reason.charAt(0).toUpperCase() +
                          request.reason.slice(1)}
                      </TableCell>
                      <TableCell className="text-center">
                        <ExitStatusBadge
                          status={request.status}
                          requestId={request.id}
                          employeeStatus={request.employeeStatus}
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground text-center">
                        {formatDateTime(request.createdOn)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
          <TablePagination
            currentPage={currentPage}
            totalPages={Math.max(
              1,
              currentPage + (teamRequests.length >= pageSize ? 1 : 0),
            )}
            startIndex={
              teamRequests.length > 0 ? (currentPage - 1) * pageSize + 1 : 0
            }
            endIndex={(currentPage - 1) * pageSize + teamRequests.length}
            total={teamRequests.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setCurrentPage(1);
            }}
          />
        </div>
      </div>
      {renderManagerDetail()}
      {approveDialogMarkup}
      {rejectDialogMarkup}
    </>
  );
};

export default ManagerFlow;
