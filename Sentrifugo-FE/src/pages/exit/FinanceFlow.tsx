import { useState, useEffect, useRef } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { SectionCustomFields } from "@/components/shared/SectionCustomFields";
import { useSearch } from "@tanstack/react-router";
import {
  Search,
  Clock,
  CheckCircle2,
  ClipboardList,
  Calendar,
  Loader2,
  Check,
  X,
  XCircle,
  CircleCheck,
  CircleX,
  History,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  useGetFinanceClearanceRequestsQuery,
  useGetFinanceSummaryQuery,
  useUpdateFinanceStatusMutation,
  useGetChecklistsQuery,
  useUpdateChecklistMutation,
  type FinanceClearanceResponse,
  type DepartmentChecklist,
} from "@/store/api/exitManagementApi";
import {
  useGetDepartmentsQuery,
  useGetBusinessUnitsQuery,
} from "@/store/api/iamApi";
import { toast } from "sonner";
import { DatePicker } from "@/components/ui/date-picker";
import { PageHeader } from "@/components/shared/PageHeader";

import { TablePagination } from "@/components/shared/TablePagination";
import { EmptyState } from "@/components/shared/EmptyState";
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

const STATUS_ORDER: Record<string, number> = {
  pending: 0,
  under_review: 1,
  not_cleared: 2,
  approved: 3,
  sent_to_payroll: 4,
  paid: 5,
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  under_review: "Under Review",
  approved: "Verified",
  sent_to_payroll: "Sent to Payroll",
  paid: "Paid",
  not_cleared: "Not Cleared",
};

const STATUS_STYLES: Record<string, string> = {
  pending:
    "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
  under_review: "bg-primary/5 text-primary border-primary/20",
  approved: "bg-success/10 text-success border-success/20",
  sent_to_payroll:
    "bg-badge-inprogress-text/10 text-badge-inprogress-text border-badge-inprogress-text/20",
  paid: "bg-muted text-muted-foreground border-border/50",
  not_cleared: "bg-destructive/10 text-destructive border-destructive/20",
};

const getStatusBadge = (status: string) => {
  const label = STATUS_LABELS[status] || status;
  const s = status.toLowerCase();
  if (s === "approved" || s === "completed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleCheck className="size-3.5 shrink-0 text-success" />
        {label}
      </span>
    );
  }
  if (s === "not_cleared" || s === "rejected") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleX className="size-3.5 shrink-0 text-destructive" />
        {label}
      </span>
    );
  }
  if (s.includes("pending")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Clock className="size-3.5 shrink-0 text-badge-pending-text" />
        {label}
      </span>
    );
  }
  if (s === "in_progress" || s === "awaiting_clearances") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <History className="size-3.5 shrink-0 text-badge-inprogress-text" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
      {label}
    </span>
  );
};

export const FinanceFlow = () => {
  const searchParams = useSearch({ strict: false });
  const autoOpenedRef = useRef(false);
  const [searchTerm, setSearchTerm] = useState(
    (searchParams as any).requestId || "",
  );
  const [statusFilter, setStatusFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [buFilter, setBuFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { data: departmentsData } = useGetDepartmentsQuery({ limit: 100 });
  const { data: businessUnitsData } = useGetBusinessUnitsQuery({ limit: 100 });
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedRequest, setSelectedRequest] =
    useState<FinanceClearanceResponse | null>(null);

  const [remarks, setRemarks] = useState("");
  const [isNotClearedModalOpen, setIsNotClearedModalOpen] = useState(false);
  const [notClearedReason, setNotClearedReason] = useState("");
  const [notClearedRemarks, setNotClearedRemarks] = useState("");

  const { data: summary, isLoading: isSummaryLoading } =
    useGetFinanceSummaryQuery();
  const { data: requests, isLoading: isRequestsLoading } =
    useGetFinanceClearanceRequestsQuery({
      skip: (currentPage - 1) * pageSize,
      limit: pageSize,
      search: searchTerm,
      status: statusFilter === "all" ? undefined : statusFilter,
      department: deptFilter === "all" ? undefined : deptFilter,
      businessUnit: buFilter === "all" ? undefined : buFilter,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });

  const [updateStatus, { isLoading: isUpdating }] =
    useUpdateFinanceStatusMutation();
  const [showErrors, setShowErrors] = useState(false);
  const [showNotClearedErrors, setShowNotClearedErrors] = useState(false);
  const [hasCustomFields, setHasCustomFields] = useState(false);

  const { data: checklists } = useGetChecklistsQuery({ deptId: "FINANCE" });
  const financeChecklist = checklists?.[0];
  const checklistItems = financeChecklist?.items || [];
  const [updateChecklist, { isLoading: isUpdatingChecklist }] =
    useUpdateChecklistMutation();
  const [newItem, setNewItem] = useState("");
  const [checkedItems, setCheckedItems] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (selectedRequest && checklistItems.length > 0) {
      const initial: Record<number, boolean> = {};
      selectedRequest.completedChecklist?.forEach((label) => {
        const index = checklistItems.indexOf(label);
        if (index !== -1) initial[index] = true;
      });
      setCheckedItems(initial);
    }
  }, [selectedRequest, financeChecklist]);

  const toggleCheck = (index: number) => {
    setCheckedItems((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleAddItem = async () => {
    if (!newItem.trim() || !financeChecklist) return;
    try {
      await updateChecklist({
        deptId: financeChecklist.deptId,
        deptName: financeChecklist.deptName,
        items: [...checklistItems, newItem.trim()],
      }).unwrap();
      setNewItem("");
    } catch {
      toast.error("Failed to add checklist item");
    }
  };

  const handleDeleteItem = async (index: number) => {
    if (!financeChecklist) return;
    try {
      const newItems = [...checklistItems];
      newItems.splice(index, 1);
      await updateChecklist({
        deptId: financeChecklist.deptId,
        deptName: financeChecklist.deptName,
        items: newItems,
      }).unwrap();
      setCheckedItems((prev) => {
        const next = { ...prev };
        delete next[index];
        const shifted: Record<number, boolean> = {};
        Object.keys(next).forEach((k) => {
          const kNum = Number(k);
          if (kNum > index) shifted[kNum - 1] = next[kNum];
          else shifted[kNum] = next[kNum];
        });
        return shifted;
      });
    } catch {
      toast.error("Failed to delete checklist item");
    }
  };

  useEffect(() => {
    const reqId = (searchParams as any).requestId;
    if (reqId && requests && requests.length > 0 && !autoOpenedRef.current) {
      const match = requests.find((a: any) => a.exitRequestId === reqId);
      if (match) {
        setSelectedRequest(match);
        autoOpenedRef.current = true;
      }
    }
  }, [requests, searchParams]);

  const handleUpdateStatus = async (
    newStatus: string,
    reason?: string,
    customRemarks?: string,
  ) => {
    if (!selectedRequest) return;

    try {
      const completedChecklist = checklistItems.filter(
        (_, idx) => checkedItems[idx],
      );
      await updateStatus({
        id: selectedRequest.id,
        body: {
          status: newStatus,
          remarks: customRemarks || remarks,
          clearanceReason: reason,
          completedChecklist,
        },
      }).unwrap();
      toast.success(`Clearance status updated to ${newStatus}`);
      setSelectedRequest(null);
      setRemarks("");
      setIsNotClearedModalOpen(false);
      setNotClearedReason("");
      setNotClearedRemarks("");
      setShowNotClearedErrors(false);
    } catch {
      toast.error("Failed to update status");
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleCardClick = (filter: string) => {
    setStatusFilter(statusFilter === filter ? "all" : filter);
    setCurrentPage(1);
  };

  const renderFinanceDetail = () => {
    if (!selectedRequest) return null;
    const isCompleted = ["approved", "paid", "completed"].includes(
      selectedRequest.status.toLowerCase(),
    );

    const financeStatus = selectedRequest.status.toLowerCase();
    const isCleared = ["approved", "completed", "cleared"].includes(
      financeStatus,
    );
    const isPaid = financeStatus === "paid";
    const isSentToPayroll =
      financeStatus === "sent_to_payroll" ||
      financeStatus === "sent to payroll";
    const isNotCleared =
      financeStatus === "not_cleared" || financeStatus === "not cleared";

    return (
      <Sheet
        open={!!selectedRequest}
        onOpenChange={(v) => {
          if (!v) setSelectedRequest(null);
        }}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Finance Clearance Details</SheetTitle>
            <SheetDescription>
              Review and process finance clearance for departing employee
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 flex flex-col gap-6">
                <div className="grid grid-cols-1 gap-6">
                  <div className="border border-border rounded-xl p-6 bg-card">
                    <h2 className="text-base font-bold text-foreground mb-4">
                      Employee Information
                    </h2>
                    <div className="flex flex-col gap-4">
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">
                          Employee ID
                        </span>
                        <p className="text-sm font-medium text-foreground mt-0.5">
                          {selectedRequest.empCode}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">
                          Employee Name
                        </span>
                        <p className="text-sm font-medium text-foreground mt-0.5">
                          {selectedRequest.employeeName}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">
                          Department
                        </span>
                        <p className="text-sm font-medium text-foreground mt-0.5">
                          {selectedRequest.department}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">
                          Last Working Day
                        </span>
                        <p className="text-sm font-medium text-foreground mt-0.5">
                          {formatDate(selectedRequest.lastWorkingDay)}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {isCompleted && (
                  <div className="inline-flex items-center gap-2 bg-success/10 border border-success/20 text-success rounded-full px-4 py-2 text-sm font-medium w-fit">
                    <CheckCircle2 /> Verification Completed on{" "}
                    {selectedRequest.clearedOn
                      ? new Date(selectedRequest.clearedOn)
                          .toLocaleDateString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            timeZone: "Asia/Kolkata",
                          })
                          .replace(/ /g, "-")
                      : "N/A"}
                  </div>
                )}

                {/* Verification Checklist */}
                <div className="border border-border rounded-xl p-6 bg-card">
                  <h2 className="text-base font-bold text-foreground mb-4">
                    Verification Checklist{" "}
                    <span className="text-destructive">*</span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {checklistItems.map((label, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between group"
                      >
                        <label className="flex items-center gap-3 cursor-pointer flex-1">
                          <input
                            type="checkbox"
                            checked={!!checkedItems[index]}
                            onChange={() => toggleCheck(index)}
                            disabled={isCompleted || isNotCleared}
                            className="w-4 h-4 rounded border-border text-primary focus:ring-ring"
                          />
                          <span className="text-sm text-foreground">
                            {label}
                          </span>
                        </label>
                        {!isCompleted && !isNotCleared && (
                          <button
                            onClick={() => handleDeleteItem(index)}
                            disabled={isUpdatingChecklist}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive p-1 rounded transition-opacity"
                          >
                            <X />
                          </button>
                        )}
                      </div>
                    ))}

                    {!isCompleted && !isNotCleared && (
                      <div className="flex items-center gap-2 mt-2 pt-3 border-t border-border">
                        <Input
                          placeholder="Add new checklist item..."
                          value={newItem}
                          onChange={(e) => setNewItem(e.target.value)}
                          className="text-sm"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddItem();
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={handleAddItem}
                          disabled={!newItem.trim() || isUpdatingChecklist}
                        >
                          Add
                        </Button>
                      </div>
                    )}
                    {showErrors &&
                      checklistItems.length > 0 &&
                      !checklistItems.some((_, i) => checkedItems[i]) && (
                        <p className="text-xs text-destructive mt-1">
                          Please complete at least one item before verifying.
                        </p>
                      )}
                  </div>
                </div>

                <div className="border border-border rounded-xl bg-card overflow-x-auto flex flex-col">
                  <div className="p-6">
                    <h3 className="text-lg font-bold text-foreground mb-4">
                      Finance Clearance Details
                    </h3>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        Remarks / Notes{" "}
                        <span className="text-destructive">*</span>
                      </label>
                      <Textarea
                        className="min-h-[120px] resize-y"
                        placeholder="Add any notes or comments..."
                        value={
                          isCompleted ? selectedRequest.remarks || "" : remarks
                        }
                        onChange={(e) => setRemarks(e.target.value)}
                        disabled={isCompleted}
                      />
                      {showErrors && !remarks.trim() && (
                        <p className="text-xs text-destructive mt-1">
                          Remarks / Notes are required.
                        </p>
                      )}
                      {!isCompleted && (
                        <p className="text-xs text-muted-foreground text-right">
                          {remarks.length} / 500
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Custom Fields */}
                <div
                  className={
                    hasCustomFields
                      ? "border border-border rounded-xl p-6"
                      : "hidden"
                  }
                >
                  <h2 className="text-base font-bold text-foreground mb-4">
                    Custom Fields
                  </h2>
                  <SectionCustomFields
                    entityType="exit_request"
                    section="finance_clearance"
                    entityId={selectedRequest.exitRequestId}
                    readOnly
                    onHasDefinitionsChange={setHasCustomFields}
                  />
                </div>
              </div>

              <div className="w-full flex flex-col flex-shrink-0">
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                  <h3 className="font-bold text-foreground mb-6 text-base">
                    Request Timeline
                  </h3>
                  {(() => {
                    const itDone =
                      selectedRequest.itClearanceStatus === "verified";
                    const itRejected =
                      selectedRequest.itClearanceStatus === "not_cleared";
                    const itDate = itDone
                      ? "Completed"
                      : itRejected
                        ? "Not Cleared"
                        : selectedRequest.itClearanceStatus
                          ? "In Progress"
                          : "Pending";

                    const adminDone =
                      selectedRequest.adminClearanceStatus === "completed";
                    const adminRejected =
                      selectedRequest.adminClearanceStatus === "not_cleared";
                    const adminDate = adminDone
                      ? "Completed"
                      : adminRejected
                        ? "Not Cleared"
                        : selectedRequest.adminClearanceStatus
                          ? "In Progress"
                          : "Pending";

                    const financeDone = isCleared || isPaid || isSentToPayroll;

                    const exitComplete = itDone && adminDone && financeDone;

                    const steps = [
                      {
                        label: "Request Submitted",
                        done: true,
                        rejected: false,
                        date: formatDateTime(selectedRequest.createdOn),
                        sub: `${selectedRequest.employeeName || "-"}${selectedRequest.empCode ? ` (${selectedRequest.empCode})` : ""}`,
                      },
                      {
                        label: "Manager Approval",
                        done: true,
                        rejected: false,
                        date: "Approved",
                        sub: "",
                      },
                      {
                        label: "HR Review & Clearance",
                        done: true,
                        rejected: false,
                        date: "Initiated",
                        sub: "",
                      },
                      {
                        label: "IT Clearance",
                        done: itDone,
                        rejected: itRejected,
                        date: itDate,
                        sub: "",
                      },
                      {
                        label: "Admin Clearance",
                        done: adminDone,
                        rejected: adminRejected,
                        date: adminDate,
                        sub: "",
                      },
                      {
                        label: "Finance Clearance",
                        done: financeDone,
                        rejected: isNotCleared,
                        date: financeDone
                          ? selectedRequest.clearedOn
                            ? formatDateTime(selectedRequest.clearedOn)
                            : "Cleared"
                          : isNotCleared
                            ? "Not Cleared"
                            : "In Progress",
                        sub: "",
                      },
                      {
                        label: "Exit Interview",
                        done: false,
                        rejected: false,
                        date: exitComplete ? "Awaiting Submission" : "Pending",
                        sub: "",
                      },
                      {
                        label: "Exit Complete",
                        done: exitComplete,
                        rejected: false,
                        date: exitComplete ? "Completed" : "Pending",
                        sub: "",
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
            </div>
          </div>

          {/* Footer */}
          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button variant="outline" onClick={() => setSelectedRequest(null)}>
              {isCompleted ? "Close" : "Cancel"}
            </Button>
            {!isCompleted && (
              <div className="flex gap-4">
                <Button
                  variant="outline"
                  onClick={() => setIsNotClearedModalOpen(true)}
                  className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive px-6 font-semibold"
                  disabled={isUpdating}
                >
                  Not Cleared
                </Button>
                <Button
                  variant="soft"
                  onClick={() => {
                    const isChecklistValid =
                      checklistItems.length === 0 ||
                      checklistItems.some((_, i) => checkedItems[i]);
                    if (!remarks.trim() || !isChecklistValid) {
                      setShowErrors(true);
                      return;
                    }
                    handleUpdateStatus("approved");
                  }}
                  className="px-6 font-semibold gap-2"
                  disabled={isUpdating}
                >
                  {isUpdating ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <CheckCircle2 />
                  )}
                  Mark as Cleared
                </Button>
              </div>
            )}
          </div>

          <Dialog
            open={isNotClearedModalOpen}
            onOpenChange={setIsNotClearedModalOpen}
          >
            <DialogContent className="sm:max-w-[500px] p-6">
              <DialogHeader>
                <DialogTitle className="text-xl font-bold text-foreground">
                  Mark as Not Cleared
                </DialogTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Please provide the reason for not clearing the finance.
                </p>
              </DialogHeader>
              <div className="flex flex-col gap-5 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Remarks / Comments{" "}
                    <span className="text-destructive">*</span>
                  </label>
                  <Textarea
                    className="min-h-[120px] resize-y"
                    placeholder="Enter remarks or comments..."
                    value={notClearedRemarks}
                    onChange={(e) => setNotClearedRemarks(e.target.value)}
                  />
                  {showNotClearedErrors && !notClearedRemarks.trim() && (
                    <p className="text-xs text-destructive mt-1">
                      Remarks / Comments are required.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground text-right">
                    {notClearedRemarks.length} / 500
                  </p>
                </div>
              </div>
              <div className="flex justify-center gap-4 mt-2">
                <Button
                  variant="outline"
                  onClick={() => setIsNotClearedModalOpen(false)}
                  className="px-8 font-semibold h-11"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (!notClearedReason || !notClearedRemarks.trim()) {
                      setShowNotClearedErrors(true);
                      return;
                    }
                    handleUpdateStatus(
                      "not_cleared",
                      notClearedReason,
                      notClearedRemarks,
                    );
                  }}
                  variant="soft"
                  className="px-8 font-semibold h-11"
                  disabled={isUpdating}
                >
                  {isUpdating ? <Loader2 className="animate-spin" /> : null}
                  Confirm
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance Clearance Requests"
        subtitle="Manage offboarding workflows, final settlements, and clearance statuses."
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            key: "all",
            label: "Total Requests",
            value: summary?.total || 0,
            icon: ClipboardList,
          },
          {
            key: "pending",
            label: "Pending Review",
            value: summary?.pending || 0,
            icon: Clock,
          },
          {
            key: "not_cleared",
            label: "Not Cleared",
            value: summary?.notCleared || 0,
            icon: XCircle,
          },
          {
            key: "approved",
            label: "Verified",
            value: summary?.approved || 0,
            icon: CheckCircle2,
          },
        ].map((card) => (
          <div
            key={card.key}
            onClick={() => handleCardClick(card.key)}
            className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${
              statusFilter === card.key
                ? "bg-primary/5 border-primary/20"
                : statusFilter === "all" && card.key === "all"
                  ? "bg-primary/5 border-primary/20"
                  : "bg-card hover:bg-muted/50"
            }`}
          >
            <div>
              <p className="text-xs text-muted-foreground font-medium">
                {card.label}
              </p>
              <p className="text-2xl font-bold text-foreground">
                {isSummaryLoading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  card.value
                )}
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
              placeholder="Search by Name, Code..."
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
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Departments" />
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
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setCurrentPage(1);
            }}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="under_review">Under Review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="sent_to_payroll">Sent to Payroll</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="not_cleared">Not Cleared</SelectItem>
            </SelectContent>
          </Select>
          <DatePicker
            value={fromDate}
            onChange={(v) => {
              setFromDate(v);
              if (toDate && v && toDate < v) setToDate("");
            }}
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
              setCurrentPage(1);
            }}
          >
            Reset
          </Button>
        </div>

        {isRequestsLoading ? (
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
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                  Department
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10 text-center w-[14%]">
                  Last Working Day
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
              {!requests || requests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      title="No finance clearance requests found"
                      description="No requests match your current filters."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                [...requests].sort((a, b) => (STATUS_ORDER[a.status.toLowerCase()] ?? 99) - (STATUS_ORDER[b.status.toLowerCase()] ?? 99)).map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedRequest(item)}
                  >
                    <TableCell className="text-sm text-muted-foreground font-medium">
                      {item.requestCode ||
                        item.exitRequestId.substring(
                          item.exitRequestId.length - 8,
                        )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground font-medium text-center">
                      {item.employeeName}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground text-center">
                      {item.empCode || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground text-center">
                      {item.department || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground text-center">
                      {formatDate(item.lastWorkingDay)}
                    </TableCell>
                    <TableCell className="text-center">
                      {getStatusBadge(item.status)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground text-center">
                      {formatDate(item.createdOn)}
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
            currentPage + (requests && requests.length >= pageSize ? 1 : 0),
          )}
          startIndex={
            requests && requests.length > 0
              ? (currentPage - 1) * pageSize + 1
              : 0
          }
          endIndex={
            requests ? (currentPage - 1) * pageSize + requests.length : 0
          }
          total={requests?.length ?? 0}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setCurrentPage(1);
          }}
        />
      </div>

      {renderFinanceDetail()}
    </div>
  );
};

export default FinanceFlow;
