import { useState, useRef, useEffect } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import {
  Search,
  Edit,
  UploadCloud,
  Check,
  FileText,
  Download,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Info,
  Plus,
  MessageSquare,
  Star,
  XCircle,
  X,
  ChevronRight,
  FilePlus,
  CircleCheck,
  CircleX,
  Clock,
  History,
  MoreHorizontal,
  Pencil,
  CircleMinus,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAppSelector } from "@/store";

import {
  useGetEmployeesQuery,
  useGetExitRequestsQuery,
  useCreateExitRequestMutation,
  useUpdateExitRequestMutation,
  useWithdrawExitRequestMutation,
  useReapplyExitRequestMutation,
  useSubmitExitInterviewMutation,
  useGetExitInterviewQuery,
  useUploadAssetMutation,
  useGetAssetQuery,
} from "@/store/api/exitManagementApi";
import type { ExitRequestResponse } from "@/store/api/exitManagementApi";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

const STATUS_LABELS: Record<string, string> = {
  pending_approval: "Pending Approval",
  hr_initiated: "HR Initiated - Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  awaiting_clearances: "Awaiting Clearances",
  under_review: "Under Review",
  completed: "Completed",
  awaiting_exit_interview: "Awaiting Exit Interview",
  deactivated: "Deactivated",
  notice_period: "Serving Notice",
  exit: "Exited",
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

export const EmployeeFlow = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [exitReason, setExitReason] = useState("");
  const [additionalDetails, setAdditionalDetails] = useState("");
  const [otherReason, setOtherReason] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [selectedRequest, setSelectedRequest] =
    useState<ExitRequestResponse | null>(null);
  const [isSubmitDialogOpen, setIsSubmitDialogOpen] = useState(false);
  const [isConfirmSubmitOpen, setIsConfirmSubmitOpen] = useState(false);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [isReapplying, setIsReapplying] = useState(false);
  const [reapplyFromId, setReapplyFromId] = useState<string | null>(null);
  const [isProvidingFeedback, setIsProvidingFeedback] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingRequest, setEditingRequest] =
    useState<ExitRequestResponse | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [isWithdrawDialogOpen, setIsWithdrawDialogOpen] = useState(false);
  const [withdrawRequestId, setWithdrawRequestId] = useState<string | null>(
    null,
  );
  const [submittedRequest, setSubmittedRequest] =
    useState<ExitRequestResponse | null>(null);

  // Interview form state
  const [interviewReason, setInterviewReason] = useState("");
  const [interviewOtherReason, setInterviewOtherReason] = useState("");
  const [interviewRating, setInterviewRating] = useState(0);
  const [interviewLikedMost, setInterviewLikedMost] = useState("");
  const [interviewImprovements, setInterviewImprovements] = useState("");
  const [interviewManagerFeedback, setInterviewManagerFeedback] = useState("");

  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Logged-in user
  const loggedInUser = useAppSelector((s) => s.auth.user);

  // API hooks
  const { data: employees = [] } = useGetEmployeesQuery({ limit: 100 });
  useEffect(() => {
    if (loggedInUser?.id && !selectedEmployeeId) {
      if (employees.length > 0) {
        const match = employees.find((e) => e.userId === loggedInUser.id);
        setSelectedEmployeeId(match ? match.id : loggedInUser.id);
      } else {
        setSelectedEmployeeId(loggedInUser.id);
      }
    }
  }, [loggedInUser, selectedEmployeeId, employees]);
  const { data: exitRequests = [], isLoading: isLoadingRequests } =
    useGetExitRequestsQuery({
      search: searchTerm,
      status: statusFilter || undefined,
    });
  const [createExitRequest] = useCreateExitRequestMutation();
  const [updateExitRequest] = useUpdateExitRequestMutation();
  const [withdrawExitRequest] = useWithdrawExitRequestMutation();
  const [reapplyExitRequest] = useReapplyExitRequestMutation();
  const [submitExitInterview] = useSubmitExitInterviewMutation();
  const [uploadAsset] = useUploadAssetMutation();
  const { data: exitInterview } = useGetExitInterviewQuery(
    selectedRequest?.id ?? "",
    { skip: !selectedRequest },
  );

  const uploadFiles = async (files: File[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const file of files) {
      const result = await uploadAsset({
        file,
        folder: "exit-documents",
      }).unwrap();
      ids.push(result.id);
    }
    return ids;
  };

  const resetForm = () => {
    setExitReason("");
    setAdditionalDetails("");
    setOtherReason("");
    setSelectedFiles([]);
    setShowErrors(false);
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
    if (fileInputRef.current) {
      fileInputRef.current.files = dt.files;
      fileInputRef.current.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const validFiles: File[] = [];
    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
    ];
    const maxSize = 2 * 1024 * 1024;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!allowedTypes.includes(file.type)) continue;
      if (file.size > maxSize) continue;
      validFiles.push(file);
    }
    setSelectedFiles((prev) => [...prev, ...validFiles]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreateRequest = async () => {
    if (!exitReason || !selectedEmployeeId) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const documentIds =
        selectedFiles.length > 0 ? await uploadFiles(selectedFiles) : undefined;
      const result = await createExitRequest({
        employeeId: selectedEmployeeId,
        reason: exitReason,
        otherReason: exitReason === "others" ? otherReason : undefined,
        additionalDetails: additionalDetails || undefined,
        documentIds,
      }).unwrap();
      setSubmittedRequest(result);
      setIsSubmitDialogOpen(true);
    } catch (err: any) {
      const detail = err?.data?.detail;
      const message = Array.isArray(detail)
        ? detail.map((d: any) => d.msg).join(", ")
        : typeof detail === "string"
          ? detail
          : err?.data?.message ||
            err?.message ||
            "Failed to submit exit request. Please try again.";
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateRequest = async () => {
    if (!editingRequest) return;
    setLoading(true);
    try {
      const documentIds =
        selectedFiles.length > 0 ? await uploadFiles(selectedFiles) : undefined;
      await updateExitRequest({
        id: editingRequest.id,
        body: {
          reason: exitReason || undefined,
          otherReason: exitReason === "others" ? otherReason : undefined,
          additionalDetails: additionalDetails || undefined,
          documentIds,
        },
      }).unwrap();
      setIsUpdateDialogOpen(true);
    } catch {
      // error handled by RTK Query
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawRequestId) return;
    setLoading(true);
    try {
      await withdrawExitRequest(withdrawRequestId).unwrap();
      setIsWithdrawDialogOpen(false);
      setWithdrawRequestId(null);
      setSelectedRequest(null);
    } catch {
      // error handled by RTK Query
    } finally {
      setLoading(false);
    }
  };

  const handleReapply = async () => {
    if (!reapplyFromId || !exitReason) return;
    setLoading(true);
    try {
      const documentIds =
        selectedFiles.length > 0 ? await uploadFiles(selectedFiles) : undefined;
      const result = await reapplyExitRequest({
        id: reapplyFromId,
        body: {
          employeeId: selectedEmployeeId,
          reason: exitReason,
          otherReason: exitReason === "others" ? otherReason : undefined,
          additionalDetails: additionalDetails || undefined,
          documentIds,
        },
      }).unwrap();
      setSubmittedRequest(result);
      setIsSubmitDialogOpen(true);
    } catch {
      // error handled by RTK Query
    } finally {
      setLoading(false);
    }
  };

  const isInterviewFormValid =
    interviewReason &&
    interviewRating > 0 &&
    interviewLikedMost.trim() &&
    interviewImprovements.trim() &&
    interviewManagerFeedback.trim() &&
    (interviewReason !== "other" || interviewOtherReason.trim());

  const handleSubmitInterview = async () => {
    if (!selectedRequest || !isInterviewFormValid) return;
    setLoading(true);
    try {
      const body: Record<string, any> = {};
      if (interviewReason) body.reasonForLeaving = interviewReason;
      if (interviewOtherReason) body.otherReason = interviewOtherReason;
      if (interviewRating > 0) body.overallRating = interviewRating;
      if (interviewLikedMost.trim()) body.likedMost = interviewLikedMost.trim();
      if (interviewImprovements.trim())
        body.improvements = interviewImprovements.trim();
      if (interviewManagerFeedback.trim())
        body.managerFeedback = interviewManagerFeedback.trim();
      await submitExitInterview({
        requestId: selectedRequest.id,
        body: body as any,
      }).unwrap();
      setIsProvidingFeedback(false);
      setInterviewReason("");
      setInterviewOtherReason("");
      setInterviewRating(0);
      setInterviewLikedMost("");
      setInterviewImprovements("");
      setInterviewManagerFeedback("");
    } catch (err: any) {
      console.error("Exit interview submit error:", err);
      setErrorMessage(
        err?.data?.message || err?.message || "Failed to submit exit interview",
      );
    } finally {
      setLoading(false);
    }
  };

  const startEditing = (req: ExitRequestResponse) => {
    setEditingRequest(req);
    setExitReason(req.reason);
    setOtherReason(req.otherReason || "");
    setAdditionalDetails(req.additionalDetails || "");
    setIsEditing(true);
  };

  const startReapply = (req: ExitRequestResponse) => {
    setReapplyFromId(req.id);
    setSelectedEmployeeId(req.employeeId);
    setExitReason(req.reason);
    setOtherReason(req.otherReason || "");
    setAdditionalDetails(req.additionalDetails || "");
    setIsReapplying(true);
    setSelectedRequest(null);
  };

  const withdrawDialog = (
    <Dialog open={isWithdrawDialogOpen} onOpenChange={setIsWithdrawDialogOpen}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-warning" />
            <DialogTitle>Withdraw exit request?</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Are you sure you want to withdraw this exit request? This action
          cannot be undone.
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            autoFocus
            onClick={() => {
              setIsWithdrawDialogOpen(false);
              setWithdrawRequestId(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-destructive border-destructive hover:bg-destructive/10"
            onClick={handleWithdraw}
            disabled={loading}
          >
            {loading ? "Withdrawing..." : "Withdraw"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const renderEditRequest = () => {
    return (
      <Sheet
        open={isEditing}
        onOpenChange={(v) => {
          if (!v) setIsCancelDialogOpen(true);
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Edit Exit Request</SheetTitle>
            <SheetDescription>
              Update the details of your exit request.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                Exit Details
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm text-muted-foreground font-medium">
                    Reason for Exit <span className="text-destructive">*</span>
                  </Label>
                  <Select value={exitReason} onValueChange={setExitReason}>
                    <SelectTrigger className="border-border">
                      <SelectValue placeholder="Select Reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="career">Career Growth</SelectItem>
                      <SelectItem value="education">
                        Higher Education
                      </SelectItem>
                      <SelectItem value="relocation">Relocation</SelectItem>
                      <SelectItem value="health">Health Reasons</SelectItem>
                      <SelectItem value="others">Others</SelectItem>
                    </SelectContent>
                  </Select>
                  {showErrors && !exitReason && (
                    <p className="text-xs text-destructive">
                      Reason for exit is required
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm text-muted-foreground font-medium">
                    Additional Details (Optional)
                  </Label>
                  <Textarea
                    value={additionalDetails}
                    onChange={(e) => setAdditionalDetails(e.target.value)}
                    className="resize-none min-h-[100px] border-border focus-visible:ring-primary"
                  />
                </div>

                {exitReason === "others" && (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col">
                      <Label className="text-sm text-muted-foreground font-medium">
                        Specify other reason{" "}
                        <span className="text-destructive">*</span>
                      </Label>
                      <span className="text-xs text-muted-foreground">
                        Required when "Others" is selected
                      </span>
                    </div>
                    <Input
                      value={otherReason}
                      onChange={(e) => setOtherReason(e.target.value)}
                      className="border-border focus-visible:ring-primary"
                    />
                  </div>
                )}
              </div>
            </div>

            <Separator className="bg-muted" />

            <div>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                Supporting Documents{" "}
                <span className="text-muted-foreground font-normal">
                  (Optional)
                </span>
              </h3>
              <div className="flex flex-col gap-4">
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                  multiple
                  className="hidden"
                  id="edit-file-input"
                  onChange={handleFileSelect}
                />
                {editingRequest && editingRequest.documentIds.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      Existing Documents
                    </span>
                    {editingRequest.documentIds.map((docId) => (
                      <DocumentItem key={docId} docId={docId} />
                    ))}
                  </div>
                )}
                <Button
                  variant="outline"
                  className="w-fit h-9 bg-card border-border text-foreground hover:bg-muted mt-1 gap-2"
                  onClick={() =>
                    document.getElementById("edit-file-input")?.click()
                  }
                >
                  <Plus className="text-primary" /> Add / Replace Document
                </Button>
                {selectedFiles.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {selectedFiles.map((file, index) => (
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
                          onClick={() => removeFile(index)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <X />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setIsCancelDialogOpen(true)}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={() => {
                if (!exitReason) {
                  setShowErrors(true);
                  return;
                }
                handleUpdateRequest();
              }}
              disabled={loading}
            >
              {loading ? "Updating..." : "Update Request"}
            </Button>
          </div>

          <Dialog
            open={isUpdateDialogOpen}
            onOpenChange={setIsUpdateDialogOpen}
          >
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <DialogTitle>Request updated</DialogTitle>
              </DialogHeader>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-success" />
                <span>
                  Your exit request has been updated and sent for approval.
                </span>
              </div>
              <DialogFooter>
                <Button
                  autoFocus
                  onClick={() => {
                    setIsUpdateDialogOpen(false);
                    setIsEditing(false);
                    resetForm();
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={isCancelDialogOpen}
            onOpenChange={setIsCancelDialogOpen}
          >
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <AlertTriangle className="size-5 text-warning" />
                  <DialogTitle>Discard changes?</DialogTitle>
                </div>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                You have unsaved changes. Are you sure you want to leave? Your
                changes will be lost.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => setIsCancelDialogOpen(false)}
                >
                  Stay
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setIsCancelDialogOpen(false);
                    setIsEditing(false);
                    setEditingRequest(null);
                    setSelectedRequest(null);
                    resetForm();
                  }}
                >
                  Discard
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );
  };

  const renderExitInterview = () => {
    return (
      <Sheet
        open={isProvidingFeedback}
        onOpenChange={(v) => {
          if (!v) setIsProvidingFeedback(false);
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Exit Interview Form</SheetTitle>
            <SheetDescription>
              Please provide your valuable feedback.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            {errorMessage && (
              <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-xl p-3 text-sm">
                {errorMessage}
              </div>
            )}

            {exitInterview && (
              <div className="bg-success/10 border border-success/20 rounded-xl p-4 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-success" />
                <span className="text-sm text-success font-medium">
                  You have already submitted your exit interview.
                </span>
              </div>
            )}

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col gap-4">
              <h3 className="font-bold text-foreground">
                1. Reason for Leaving{" "}
              </h3>
              <div className="flex flex-col gap-1.5">
                <Label className="text-sm text-muted-foreground">
                  What is the main reason for leaving the company?{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={interviewReason}
                  onValueChange={setInterviewReason}
                  disabled={!!exitInterview}
                >
                  <SelectTrigger className="border-border">
                    <SelectValue placeholder="Select Reason" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="career">
                      Better Career Opportunity
                    </SelectItem>
                    <SelectItem value="salary">
                      Compensation / Salary
                    </SelectItem>
                    <SelectItem value="personal">Personal Reasons</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {interviewReason === "other" && (
                <div className="flex flex-col gap-1.5 mt-2">
                  <Label className="text-sm text-muted-foreground">
                    Other reason (please specify){" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    placeholder="Enter your reason"
                    value={interviewOtherReason}
                    onChange={(e) => setInterviewOtherReason(e.target.value)}
                    className="border-border resize-none min-h-[80px]"
                    disabled={!!exitInterview}
                  />
                </div>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h3 className="font-bold text-foreground">
                  2. Overall Experience{" "}
                </h3>
                <Label className="text-sm text-muted-foreground">
                  How would you rate your overall experience at the company?{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <div className="flex items-center gap-1 mt-1">
                  {[1, 2, 3, 4, 5].map((star) => {
                    const fullValue = star;
                    const halfValue = star - 0.5;
                    const isFull = interviewRating >= fullValue;
                    const isHalf = !isFull && interviewRating >= halfValue;
                    return (
                      <div
                        key={star}
                        className="relative w-8 h-8 cursor-pointer"
                        style={{ isolation: "isolate" }}
                      >
                        <Star
                          className={`w-8 h-8 transition-colors pointer-events-none ${isFull ? "text-warning fill-warning" : "text-muted-foreground/50"}`}
                          strokeWidth={1}
                        />
                        {isHalf && (
                          <div className="absolute inset-0 overflow-hidden w-[50%] pointer-events-none">
                            <Star
                              className="w-8 h-8 text-warning fill-warning"
                              strokeWidth={1}
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          className="absolute inset-y-0 left-0 w-[50%] bg-transparent border-0 p-0 cursor-pointer"
                          style={{ zIndex: 1 }}
                          onClick={() =>
                            !exitInterview && setInterviewRating(halfValue)
                          }
                        />
                        <button
                          type="button"
                          className="absolute inset-y-0 right-0 w-[50%] bg-transparent border-0 p-0 cursor-pointer"
                          style={{ zIndex: 1 }}
                          onClick={() =>
                            !exitInterview && setInterviewRating(fullValue)
                          }
                        />
                      </div>
                    );
                  })}
                  {interviewRating > 0 && (
                    <span className="ml-2 text-sm text-muted-foreground font-medium">
                      {interviewRating} / 5
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <h3 className="font-bold text-foreground">
                  3. What did you like most about working here?{" "}
                  <span className="text-destructive">*</span>
                </h3>
                <Textarea
                  placeholder="Enter your feedback"
                  value={interviewLikedMost}
                  onChange={(e) => setInterviewLikedMost(e.target.value)}
                  className="border-border resize-none min-h-[100px]"
                  disabled={!!exitInterview}
                />
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col gap-4">
              <h3 className="font-bold text-foreground">
                4. What can we improve?{" "}
                <span className="text-destructive">*</span>
              </h3>
              <Textarea
                placeholder="Enter your suggestions"
                value={interviewImprovements}
                onChange={(e) => setInterviewImprovements(e.target.value)}
                className="border-border resize-none min-h-[100px]"
                disabled={!!exitInterview}
              />
            </div>

            <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col gap-4">
              <h3 className="font-bold text-foreground">
                5. Feedback on Manager{" "}
                <span className="text-destructive">*</span>
              </h3>
              <Textarea
                placeholder="Enter your feedback"
                value={interviewManagerFeedback}
                onChange={(e) => setInterviewManagerFeedback(e.target.value)}
                className="border-border resize-none min-h-[100px]"
                disabled={!!exitInterview}
              />
            </div>
          </div>

          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setIsProvidingFeedback(false)}
            >
              Cancel
            </Button>
            {!exitInterview && (
              <Button
                variant="soft"
                onClick={handleSubmitInterview}
                disabled={loading || !isInterviewFormValid}
              >
                {loading ? "Submitting..." : "Submit"}
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    );
  };

  const renderReapplyRequest = () => {
    return (
      <Sheet
        open={isReapplying}
        onOpenChange={(v) => {
          if (!v) setIsCancelDialogOpen(true);
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Reapply Exit Request</SheetTitle>
            <SheetDescription>
              Some details from your previous request have been prefilled.
              Please review and submit.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 flex items-center gap-3">
              <Info className="w-5 h-5 text-primary flex-shrink-0" />
              <span className="text-sm text-foreground">
                You are reapplying because your previous request was rejected.
              </span>
            </div>

            <div className="flex flex-col gap-6">
              <h3 className="text-sm font-semibold text-foreground">
                Exit Details
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Reason for Exit <span className="text-destructive">*</span>
                  </Label>
                  <Select value={exitReason} onValueChange={setExitReason}>
                    <SelectTrigger className="w-full border-border bg-card">
                      <SelectValue placeholder="Select Reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal Reasons</SelectItem>
                      <SelectItem value="career">Career Growth</SelectItem>
                      <SelectItem value="education">
                        Higher Education
                      </SelectItem>
                      <SelectItem value="relocation">Relocation</SelectItem>
                      <SelectItem value="compensation">Compensation</SelectItem>
                      <SelectItem value="environment">
                        Work Environment
                      </SelectItem>
                      <SelectItem value="others">Others</SelectItem>
                    </SelectContent>
                  </Select>
                  {showErrors && !exitReason && (
                    <p className="text-xs text-destructive">
                      Reason for exit is required
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Additional Details (Optional)
                  </Label>
                  <Textarea
                    value={additionalDetails}
                    onChange={(e) => setAdditionalDetails(e.target.value)}
                    className="min-h-[100px] border-border bg-card resize-none"
                  />
                </div>

                {exitReason === "others" && (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col">
                      <Label className="text-sm font-semibold text-foreground">
                        Specify other reason{" "}
                        <span className="text-destructive">*</span>
                      </Label>
                      <span className="text-xs text-muted-foreground mt-0.5">
                        Required when "Others" is selected
                      </span>
                    </div>
                    <Input
                      value={otherReason}
                      onChange={(e) => setOtherReason(e.target.value)}
                      className="h-10 border-border bg-card mt-1"
                    />
                  </div>
                )}
              </div>
            </div>

            <Separator className="bg-muted" />

            <div className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold text-foreground">
                Supporting Documents{" "}
                <span className="text-muted-foreground font-normal text-sm">
                  (Optional)
                </span>
              </h3>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                multiple
                className="hidden"
                id="reapply-file-input"
                onChange={handleFileSelect}
              />
              <Button
                variant="outline"
                className="w-fit h-10 px-4 border-border text-foreground font-medium"
                onClick={() =>
                  document.getElementById("reapply-file-input")?.click()
                }
              >
                <Plus /> Add / Replace Document
              </Button>
              <p className="text-xs text-muted-foreground mt-1">
                Maximum File Size: 2MB.{" "}
                <span className="ml-2">
                  Supported Formats: PDF, DOCX, DOC, PNG, JPG
                </span>
              </p>
              {selectedFiles.length > 0 && (
                <div className="flex flex-col gap-2 mt-2">
                  {selectedFiles.map((file, index) => (
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
                        onClick={() => removeFile(index)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setIsCancelDialogOpen(true)}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={() => {
                if (!exitReason) {
                  setShowErrors(true);
                  return;
                }
                handleReapply();
              }}
              disabled={loading}
            >
              {loading ? "Submitting..." : "Submit Request"}
            </Button>
          </div>

          <Dialog
            open={isSubmitDialogOpen}
            onOpenChange={setIsSubmitDialogOpen}
          >
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle>Request submitted</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-success" />
                  <span>
                    Your request has been moved to "Under Review" for manager/HR
                    approval.
                  </span>
                </div>

                {submittedRequest && (
                  <div className="bg-muted rounded-xl p-5 border text-left">
                    <h4 className="font-semibold text-sm text-foreground mb-4">
                      Request Summary
                    </h4>
                    <div className="grid grid-cols-[1fr_1fr] gap-y-3 text-sm">
                      <span className="text-muted-foreground">
                        Request Code
                      </span>
                      <span className="text-foreground font-medium">
                        {submittedRequest.requestCode}
                      </span>

                      <span className="text-muted-foreground">
                        Reason for Exit
                      </span>
                      <span className="text-foreground font-medium">
                        {submittedRequest.reason.charAt(0).toUpperCase() +
                          submittedRequest.reason.slice(1)}
                      </span>

                      {submittedRequest.otherReason && (
                        <>
                          <span className="text-muted-foreground">
                            Other Reason
                          </span>
                          <span className="text-foreground font-medium">
                            {submittedRequest.otherReason}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  autoFocus
                  onClick={() => {
                    setIsSubmitDialogOpen(false);
                    setIsReapplying(false);
                    resetForm();
                    setSubmittedRequest(null);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={isCancelDialogOpen}
            onOpenChange={setIsCancelDialogOpen}
          >
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <AlertTriangle className="size-5 text-warning" />
                  <DialogTitle>Discard changes?</DialogTitle>
                </div>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                You have unsaved changes. Are you sure you want to leave? Your
                changes will be lost.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => setIsCancelDialogOpen(false)}
                >
                  Stay
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setIsCancelDialogOpen(false);
                    setIsReapplying(false);
                    setReapplyFromId(null);
                    setSelectedRequest(null);
                    resetForm();
                  }}
                >
                  Discard
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );
  };

  const renderAddNewRequest = () => {
    return (
      <Sheet
        open={isAddingNew}
        onOpenChange={(v) => {
          if (!v) {
            setIsCancelDialogOpen(true);
          }
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Add New Exit Request</SheetTitle>
            <SheetDescription>
              Please provide the details below to initiate your exit request.
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
            <div className="flex flex-col gap-6">
              <h3 className="text-lg font-bold text-foreground">
                Exit Details
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground">
                    Employee
                  </Label>
                  <Input
                    className="h-10 border-border bg-card"
                    value={
                      loggedInUser
                        ? [loggedInUser.first_name, loggedInUser.last_name]
                            .filter(Boolean)
                            .join(" ")
                        : ""
                    }
                    readOnly
                    disabled
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground/80">
                    Reason for Exit <span className="text-destructive">*</span>
                  </Label>
                  <Select value={exitReason} onValueChange={setExitReason}>
                    <SelectTrigger className="w-full border-border bg-card">
                      <SelectValue placeholder="Select Reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal Reasons</SelectItem>
                      <SelectItem value="career">Career Growth</SelectItem>
                      <SelectItem value="education">
                        Higher Education
                      </SelectItem>
                      <SelectItem value="relocation">Relocation</SelectItem>
                      <SelectItem value="compensation">Compensation</SelectItem>
                      <SelectItem value="environment">
                        Work Environment
                      </SelectItem>
                      <SelectItem value="others">Others</SelectItem>
                    </SelectContent>
                  </Select>
                  {showErrors && !exitReason && (
                    <p className="text-xs text-destructive">
                      Reason for exit is required
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold text-foreground/80">
                    Additional Details (Optional)
                  </Label>
                  <Textarea
                    placeholder="Enter additional details"
                    value={additionalDetails}
                    onChange={(e) => setAdditionalDetails(e.target.value)}
                    className="min-h-[100px] border-border bg-card resize-none"
                  />
                </div>

                {exitReason === "others" && (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col">
                      <Label className="text-sm font-semibold text-foreground/80">
                        Specify other reason{" "}
                        <span className="text-destructive">*</span>
                      </Label>
                      <span className="text-xs text-muted-foreground mt-0.5">
                        Required when "Others" is selected
                      </span>
                    </div>
                    <Input
                      placeholder="Enter reason"
                      value={otherReason}
                      onChange={(e) => setOtherReason(e.target.value)}
                      className="h-10 border-border bg-card mt-1"
                    />
                    {showErrors && !otherReason && (
                      <p className="text-xs text-destructive">
                        Other reason is required
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <Separator className="bg-muted my-2" />

            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-bold text-foreground">
                Supporting Documents{" "}
                <span className="text-muted-foreground font-normal text-sm">
                  (Optional)
                </span>
              </h3>

              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <div
                className="border-2 border-dashed border-border rounded-xl p-12 flex flex-col items-center justify-center gap-3 bg-card hover:bg-muted/50 transition-colors cursor-pointer w-full"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const dt = new DataTransfer();
                  for (let i = 0; i < e.dataTransfer.files.length; i++) {
                    dt.items.add(e.dataTransfer.files[i]);
                  }
                  if (fileInputRef.current) {
                    fileInputRef.current.files = dt.files;
                    fileInputRef.current.dispatchEvent(
                      new Event("change", { bubbles: true }),
                    );
                  }
                }}
              >
                <div className="w-12 h-12 flex items-center justify-center mb-2">
                  <UploadCloud className="w-8 h-8 text-muted-foreground/60" />
                </div>
                <p className="text-sm font-medium text-foreground/80">
                  Drag & Drop your supporting documents
                </p>
                <Button
                  variant="soft"
                  className="h-9 px-6 font-medium mt-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  Browse Files
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  Maximum File Size: 2MB.{" "}
                  <span className="ml-2">
                    Supported Formats: PDF, DOCX, DOC, PNG, JPG
                  </span>
                </p>
              </div>

              {selectedFiles.length > 0 && (
                <div className="flex flex-col gap-2 mt-2">
                  {selectedFiles.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 border border-border rounded-xl bg-card"
                    >
                      <div className="flex items-center gap-3">
                        <FileText className="w-5 h-5 text-primary" />
                        <span className="text-sm font-medium text-foreground">
                          {file.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {(file.size / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <button
                        onClick={() => removeFile(index)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {errorMessage && (
              <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-4 flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{errorMessage}</span>
              </div>
            )}
          </div>

          {/* Fixed Footer */}
          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setIsCancelDialogOpen(true)}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={() => {
                if (
                  !selectedEmployeeId ||
                  !exitReason ||
                  (exitReason === "others" && !otherReason)
                ) {
                  setShowErrors(true);
                  return;
                }
                setIsConfirmSubmitOpen(true);
              }}
              disabled={loading}
            >
              Submit Request
            </Button>
          </div>

          <Dialog
            open={isConfirmSubmitOpen}
            onOpenChange={setIsConfirmSubmitOpen}
          >
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <DialogTitle>Submit exit request?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Are you sure you want to submit this exit request? This action
                will send it for approval.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setIsConfirmSubmitOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  autoFocus
                  onClick={() => {
                    setIsConfirmSubmitOpen(false);
                    handleCreateRequest();
                  }}
                  disabled={loading}
                >
                  {loading ? "Submitting..." : "Submit"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={isSubmitDialogOpen}
            onOpenChange={setIsSubmitDialogOpen}
          >
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle>Request submitted</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-success" />
                  <span>
                    Your request has been moved to "Under Review" for manager/HR
                    approval.
                  </span>
                </div>

                {submittedRequest && (
                  <div className="bg-muted rounded-xl p-5 border text-left">
                    <h4 className="font-semibold text-sm text-foreground mb-4">
                      Request Summary
                    </h4>
                    <div className="grid grid-cols-[1fr_1fr] gap-y-3 text-sm">
                      <span className="text-muted-foreground">
                        Request Code
                      </span>
                      <span className="text-foreground font-medium">
                        {submittedRequest.requestCode}
                      </span>

                      <span className="text-muted-foreground">
                        Reason for Exit
                      </span>
                      <span className="text-foreground font-medium">
                        {submittedRequest.reason.charAt(0).toUpperCase() +
                          submittedRequest.reason.slice(1)}
                      </span>

                      {submittedRequest.otherReason && (
                        <>
                          <span className="text-muted-foreground">
                            Other Reason
                          </span>
                          <span className="text-foreground font-medium">
                            {submittedRequest.otherReason}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  autoFocus
                  onClick={() => {
                    setIsSubmitDialogOpen(false);
                    setIsAddingNew(false);
                    resetForm();
                    setSubmittedRequest(null);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={isCancelDialogOpen}
            onOpenChange={setIsCancelDialogOpen}
          >
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <AlertTriangle className="size-5 text-warning" />
                  <DialogTitle>Discard changes?</DialogTitle>
                </div>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                You have unsaved changes. Are you sure you want to leave? Your
                changes will be lost.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  autoFocus
                  onClick={() => setIsCancelDialogOpen(false)}
                >
                  Stay
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setIsCancelDialogOpen(false);
                    setIsAddingNew(false);
                    setSelectedRequest(null);
                    resetForm();
                  }}
                >
                  Discard
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );
  };

  const renderSelectedRequest = () => {
    if (!selectedRequest) return null;
    return (
      <Sheet
        open={!!selectedRequest}
        onOpenChange={(v) => {
          if (!v) setSelectedRequest(null);
        }}
      >
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Exit Request Details</SheetTitle>
            <SheetDescription>
              Request ID: {selectedRequest.requestCode}
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
            {selectedRequest.status === "approved" && (
              <div className="bg-success/10 border border-success/20 rounded-xl p-5 flex items-start gap-4 w-full">
                <CheckCircle2 className="w-8 h-8 text-success flex-shrink-0" />
                <div className="flex flex-col gap-1">
                  <h3 className="font-bold text-success">
                    Your exit has been approved.
                  </h3>
                  <p className="text-sm text-success">
                    Please complete all remaining tasks before your exit date.
                  </p>
                </div>
              </div>
            )}

            {selectedRequest.status === "rejected" && (
              <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-5 flex items-start gap-4 w-full">
                <XCircle
                  className="w-8 h-8 text-destructive flex-shrink-0 mt-0.5"
                  strokeWidth={1.5}
                />
                <div className="flex flex-col gap-1">
                  <h3 className="font-bold text-foreground">
                    Your exit request has been rejected.
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    You can re-apply for exit after addressing the rejection
                    reason.
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-col lg:flex-row gap-6 w-full">
              <div className="flex flex-col flex-1 min-w-0 gap-6">
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                  <h3 className="text-sm font-semibold text-foreground mb-4">
                    Request Information
                  </h3>
                  <div className="grid grid-cols-[1fr_2fr] gap-y-5 text-sm">
                    <span className="text-muted-foreground font-medium">
                      Request ID
                    </span>
                    <span className="text-foreground">
                      {selectedRequest.requestCode}
                    </span>

                    <span className="text-muted-foreground font-medium">
                      Reason for Exit
                    </span>
                    <span className="text-foreground">
                      {selectedRequest.reason.charAt(0).toUpperCase() +
                        selectedRequest.reason.slice(1)}
                    </span>

                    {selectedRequest.otherReason && (
                      <>
                        <span className="text-muted-foreground font-medium">
                          Other Reason
                        </span>
                        <span className="text-foreground">
                          {selectedRequest.otherReason}
                        </span>
                      </>
                    )}

                    {selectedRequest.additionalDetails && (
                      <>
                        <span className="text-muted-foreground font-medium">
                          Additional Details
                        </span>
                        <span className="text-foreground">
                          {selectedRequest.additionalDetails}
                        </span>
                      </>
                    )}

                    <span className="text-muted-foreground font-medium">
                      Submitted On
                    </span>
                    <span className="text-foreground">
                      {formatDateTime(selectedRequest.createdOn)}
                    </span>
                  </div>

                  {selectedRequest.status === "rejected" &&
                    selectedRequest.rejectionReason && (
                      <>
                        <Separator className="bg-muted my-6" />
                        <div className="flex flex-col gap-2">
                          <h3 className="font-bold text-foreground text-sm">
                            Rejection Reason
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {selectedRequest.rejectionReason}
                          </p>
                        </div>
                      </>
                    )}
                </div>

                {selectedRequest.documentIds.length > 0 && (
                  <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                    <h3 className="text-sm font-semibold text-foreground mb-4">
                      Supporting Documents ({selectedRequest.documentIds.length}
                      )
                    </h3>
                    {selectedRequest.documentIds.map((docId) => (
                      <DocumentItem key={docId} docId={docId} />
                    ))}
                  </div>
                )}

                {[
                  "approved",
                  "pending_approval",
                  "hr_initiated",
                  "completed",
                  "awaiting_clearances",
                  "deactivated",
                  "awaiting_exit_interview",
                ].includes(selectedRequest.status) && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-foreground text-base">
                      Actions
                    </h3>
                    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
                      <div className="flex items-start justify-between gap-6">
                        <div className="flex items-start gap-4">
                          <div className="p-3 bg-badge-pending-bg text-badge-pending-text rounded-xl flex-shrink-0">
                            <MessageSquare className="w-7 h-7" />
                          </div>
                          <div className="flex flex-col">
                            <span className="font-bold text-foreground text-base">
                              Complete Your Exit Interview
                            </span>
                            <div className="flex items-center gap-4 mt-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`w-2.5 h-2.5 rounded-full ${exitInterview ? "bg-success" : "bg-badge-pending-bg"}`}
                                ></span>
                                <span className="text-xs font-semibold text-foreground">
                                  {exitInterview ? "Submitted" : "Pending"}
                                </span>
                              </div>
                              {exitInterview && (
                                <span className="text-xs text-muted-foreground">
                                  Submitted on{" "}
                                  {formatDate(
                                    exitInterview.createdOn ||
                                      exitInterview.submittedOn,
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          className="border-border text-primary hover:bg-primary/5 font-semibold h-10 px-6 flex-shrink-0"
                          onClick={() => setIsProvidingFeedback(true)}
                        >
                          {exitInterview
                            ? "View Exit Interview"
                            : "Complete Your Exit Interview"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="w-full lg:w-[400px] flex flex-col flex-shrink-0">
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                  <h3 className="text-sm font-semibold text-foreground mb-4">
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
                                <Circle className="w-4 h-4 text-muted-foreground fill-muted-foreground" />
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
            </div>

            <div className="flex justify-end w-full gap-3">
              {(selectedRequest.status === "pending_approval" ||
                selectedRequest.status === "hr_initiated") && (
                <Button
                  variant="soft"
                  className="px-8 h-10"
                  onClick={() => startEditing(selectedRequest)}
                >
                  <Edit /> Edit
                </Button>
              )}
              {(selectedRequest.status === "pending_approval" ||
                selectedRequest.status === "hr_initiated") && (
                <Button
                  variant="destructive"
                  className="px-8 h-10"
                  onClick={() => {
                    setWithdrawRequestId(selectedRequest.id);
                    setIsWithdrawDialogOpen(true);
                  }}
                >
                  <XCircle /> Withdraw
                </Button>
              )}
              <Button
                variant="outline"
                className="px-8 border-border text-foreground font-medium h-10 hover:bg-muted"
                onClick={() => setSelectedRequest(null)}
              >
                Close
              </Button>
            </div>

            {selectedRequest.status === "rejected" && (
              <div className="flex flex-col gap-4 w-full mt-2">
                <h3 className="font-bold text-foreground text-base">Actions</h3>

                <div
                  className="bg-card border border-border rounded-xl p-5 shadow-sm flex items-center justify-between cursor-pointer hover:bg-muted transition-colors max-w-2xl"
                  onClick={() => startReapply(selectedRequest)}
                >
                  <div className="flex items-start gap-4">
                    <div className="p-2 bg-destructive/10 text-destructive rounded-xl flex-shrink-0">
                      <FilePlus className="w-6 h-6" />
                    </div>
                    <div className="flex flex-col">
                      <span className="font-bold text-foreground">
                        Re-Apply Exit Request
                      </span>
                      <span className="text-sm text-muted-foreground mt-1">
                        You can submit a new exit request.
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground" />
                </div>

                <div className="flex justify-end mt-4">
                  <Button
                    variant="outline"
                    className="px-8 border-border text-foreground font-medium h-10 hover:bg-muted"
                    onClick={() => setSelectedRequest(null)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            )}

            {withdrawDialog}
          </div>
        </SheetContent>
      </Sheet>
    );
  };

  // VIEW: Main List Dashboard
  return (
    <div className="space-y-6">
      <PageHeader
        title="My Exit Requests"
        subtitle="View and track all your exit / resignation requests."
        action={
          <Button
            onClick={() => {
              setIsAddingNew(true);
              resetForm();
            }}
          >
            <Plus /> Add New Exit Request
          </Button>
        }
      />

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by reason or request code..."
              className="pl-9"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending_approval">Pending Approval</SelectItem>
              <SelectItem value="hr_initiated">
                HR Initiated - Pending Approval
              </SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="under_review">Under Review</SelectItem>
              <SelectItem value="awaiting_clearances">
                Awaiting Clearances
              </SelectItem>
              <SelectItem value="awaiting_exit_interview">
                Awaiting Exit Interview
              </SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="withdrawn">Withdrawn</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 w-[15%]">
                Request Code
              </TableHead>
              <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[25%]">
                Reason for Exit
              </TableHead>
              <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[20%]">
                Submitted On
              </TableHead>
              <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[15%]">
                Status
              </TableHead>
              <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[7%]">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoadingRequests ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-muted-foreground"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : exitRequests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    title="No exit requests found"
                    description="Submit a new exit request to get started."
                  />
                </TableCell>
              </TableRow>
            ) : (
              exitRequests.map((request) => {
                const canEdit = request.status === "pending_approval";
                const canWithdraw = [
                  "pending_approval",
                  "approved",
                  "awaiting_clearances",
                ].includes(request.status);
                const showActions = canEdit || canWithdraw;
                return (
                  <TableRow
                    key={request.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedRequest(request)}
                  >
                    <TableCell className="text-sm text-muted-foreground font-medium">
                      {request.requestCode}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground text-center">
                      {request.reason.charAt(0).toUpperCase() +
                        request.reason.slice(1)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground text-center">
                      {formatDateTime(request.createdOn)}
                    </TableCell>
                    <TableCell className="text-center">
                      <ExitStatusBadge
                        status={request.status}
                        requestId={request.id}
                        employeeStatus={request.employeeStatus}
                      />
                    </TableCell>
                    <TableCell
                      className="text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {showActions ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canEdit && (
                              <DropdownMenuItem
                                onClick={() => startEditing(request)}
                              >
                                <Pencil className="size-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                            )}
                            {canWithdraw && (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => {
                                  setWithdrawRequestId(request.id);
                                  setIsWithdrawDialogOpen(true);
                                }}
                              >
                                <CircleMinus className="size-4 mr-2" />
                                Withdraw
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {renderAddNewRequest()}
      {renderSelectedRequest()}
      {renderEditRequest()}
      {renderExitInterview()}
      {renderReapplyRequest()}
      {withdrawDialog}
    </div>
  );
};

export default EmployeeFlow;
