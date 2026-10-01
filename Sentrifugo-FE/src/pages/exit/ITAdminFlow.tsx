import { useState, useEffect, useRef } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { SectionCustomFields } from "@/components/shared/SectionCustomFields";
import { useSearch } from "@tanstack/react-router";
import {
  Search,
  Clock,
  CheckCircle2,
  Check,
  Loader2,
  ClipboardList,
  AlertCircle,
  XCircle,
  X,
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
import { Textarea } from "@/components/ui/textarea";
import {
  useGetITAssetsQuery,
  useGetITAssetsSummaryQuery,
  useVerifyITAssetMutation,
  useGetChecklistsQuery,
  useUpdateChecklistMutation,
  type ITAssetReturnResponse,
  type DepartmentChecklist,
} from "@/store/api/exitManagementApi";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { add } from "date-fns";
import {
  useGetDepartmentsQuery,
  useGetBusinessUnitsQuery,
} from "@/store/api/iamApi";

const IT_STATUS_ORDER: Record<string, number> = {
  pending: 0,
  returned: 1,
  not_cleared: 2,
  verified: 3,
};

const IT_STATUS_STYLES: Record<string, string> = {
  pending:
    "bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20",
  returned: "bg-primary/10 text-primary border-primary/20",
  verified:
    "bg-badge-active-bg text-badge-active-text border-badge-active-text/20",
  not_cleared: "bg-destructive/10 text-destructive border-destructive/20",
};

const IT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  returned: "Returned",
  verified: "Verified",
  not_cleared: "Not Cleared",
};

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  return formatDateIST(dateStr);
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  return formatDateTimeIST(dateStr);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SimpleDialog = ({
  title,
  message,
  onClose,
}: {
  title: string;
  message: string;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="bg-popover border border-border rounded shadow-lg w-[360px]">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg font-bold leading-none"
        >
          X
        </button>
      </div>
      <div className="px-4 py-5">
        <p className="text-sm text-foreground">{message}</p>
      </div>
      <div className="flex justify-end px-4 py-3 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          className="px-6 text-sm"
          onClick={onClose}
        >
          Ok
        </Button>
      </div>
    </div>
  </div>
);

const AssetDetailView = ({
  item,
  open,
  onOpenChange,
  checklistData,
}: {
  item: ITAssetReturnResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checklistData?: DepartmentChecklist;
}) => {
  const onBack = () => onOpenChange(false);
  const checklistItems = checklistData?.items || [];
  const [updateChecklist, { isLoading: isUpdatingChecklist }] =
    useUpdateChecklistMutation();
  const [newItem, setNewItem] = useState("");
  const [checkedItems, setCheckedItems] = useState<Record<number, boolean>>({});
  const [hasCustomFields, setHasCustomFields] = useState(false);

  useEffect(() => {
    if (item && checklistItems.length > 0) {
      const initial: Record<number, boolean> = {};
      item.completedChecklist?.forEach((label) => {
        const index = checklistItems.indexOf(label);
        if (index !== -1) initial[index] = true;
      });
      setCheckedItems(initial);
    }
  }, [item, checklistData]);

  const [assetCondition] = useState("good");
  const [verificationNotes, setVerificationNotes] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  const [verifyAsset, { isLoading: isVerifying }] = useVerifyITAssetMutation();

  const toggleCheck = (index: number) => {
    setCheckedItems((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleAddItem = async () => {
    if (!newItem.trim() || !checklistData) return;
    try {
      await updateChecklist({
        deptId: checklistData.deptId,
        deptName: checklistData.deptName,
        items: [...checklistItems, newItem.trim()],
      }).unwrap();
      setNewItem("");
    } catch {
      toast.error("Failed to add checklist item");
    }
  };

  const handleDeleteItem = async (index: number) => {
    if (!checklistData) return;
    try {
      const newItems = [...checklistItems];
      newItems.splice(index, 1);
      await updateChecklist({
        deptId: checklistData.deptId,
        deptName: checklistData.deptName,
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

  const handleVerifyAndComplete = async () => {
    const isChecklistValid =
      checklistItems.length === 0 ||
      checklistItems.some((_, i) => checkedItems[i]);
    if (!verificationNotes.trim() || !isChecklistValid) {
      setShowErrors(true);
      return;
    }

    try {
      const completedChecklist = checklistItems.filter(
        (_, idx) => checkedItems[idx],
      );
      await verifyAsset({
        id: item!.id,
        body: {
          condition: assetCondition,
          verificationNotes: verificationNotes,
          completedChecklist,
        },
      }).unwrap();
      toast.success("Asset verified successfully");
      onBack();
    } catch {
      toast.error("Failed to verify asset");
    }
  };

  const [isNotClearedModalOpen, setIsNotClearedModalOpen] = useState(false);

  const handleNotCleared = async () => {
    try {
      const completedChecklist = checklistItems.filter(
        (_, idx) => checkedItems[idx],
      );
      await verifyAsset({
        id: item!.id,
        body: {
          condition: assetCondition,
          verificationNotes: verificationNotes || "Not Cleared",
          status: "not_cleared",
          completedChecklist,
        },
      }).unwrap();
      toast.success("Asset marked as not cleared");
      setIsNotClearedModalOpen(false);
      onBack();
    } catch {
      toast.error("Failed to update status");
    }
  };

  if (!item) return null;
  const itStatus = item.status.toLowerCase();
  const isVerified = itStatus === "verified";
  const isNotCleared = itStatus === "not_cleared" || itStatus === "not cleared";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
        <SheetHeader className="px-6 py-5 border-b">
          <SheetTitle>Exit Requests Details</SheetTitle>
          <SheetDescription>
            Review and returning from departing employee
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="border border-border rounded-xl p-6">
                <h2 className="text-base font-bold text-foreground mb-4">
                  Employee Information
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <span className="text-xs text-muted-foreground font-medium">
                      Employee ID
                    </span>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      {item.empCode}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground font-medium">
                      Employee Name
                    </span>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      {item.employeeName}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground font-medium">
                      Department
                    </span>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      {item.department}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground font-medium">
                      Last Working Day
                    </span>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      {formatDate(item.lastWorkingDay)}
                    </p>
                  </div>
                </div>
              </div>

              {isVerified && (
                <div className="inline-flex items-center gap-2 bg-success/10 border border-success/20 text-success rounded-full px-4 py-2 text-sm font-medium w-fit">
                  <CheckCircle2 /> Verification Completed on{" "}
                  {item.verifiedOn
                    ? new Date(item.verifiedOn)
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
              <div className="border border-border rounded-xl p-6">
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
                          disabled={isVerified || isNotCleared}
                          className="w-4 h-4 rounded border-border text-primary focus:ring-ring"
                        />
                        <span className="text-sm text-foreground">{label}</span>
                      </label>
                      {!isVerified && !isNotCleared && (
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

                  {!isVerified && !isNotCleared && (
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

              <div className="border border-border rounded-xl p-6">
                <h2 className="text-base font-bold text-foreground mb-4">
                  Verification Notes <span className="text-destructive">*</span>
                </h2>
                <div className="flex flex-col gap-4">
                  <div>
                    <Textarea
                      className="mt-1.5 border-border min-h-[80px]"
                      placeholder="Enter verification notes, any damages, missing accessories etc..."
                      value={
                        isVerified || isNotCleared
                          ? item.verificationNotes || ""
                          : verificationNotes
                      }
                      onChange={(e) => setVerificationNotes(e.target.value)}
                      disabled={isVerified || isNotCleared}
                    />
                    {showErrors && !verificationNotes.trim() && (
                      <p className="text-xs text-destructive mt-1">
                        Verification notes are required.
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
                  section="it_clearance"
                  entityId={item.exitRequestId}
                  readOnly
                  onHasDefinitionsChange={setHasCustomFields}
                />
              </div>
            </div>

            {/* Right sidebar */}
            <div className="flex flex-col gap-6">
              <div className="w-full lg:w-[400px] flex flex-col flex-shrink-0">
                <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
                  <h3 className="font-bold text-foreground mb-6 text-base">
                    Request Timeline
                  </h3>
                  {(() => {
                    const adminDone = item.adminClearanceStatus === "completed";
                    const adminRejected =
                      item.adminClearanceStatus === "not_cleared";
                    const adminDate = adminDone
                      ? "Completed"
                      : adminRejected
                        ? "Not Cleared"
                        : item.adminClearanceStatus
                          ? "In Progress"
                          : "Pending";

                    const financeDone =
                      item.financeClearanceStatus === "approved" ||
                      item.financeClearanceStatus === "paid" ||
                      item.financeClearanceStatus === "sent_to_payroll";
                    const financeRejected =
                      item.financeClearanceStatus === "not_cleared";
                    const financeDate = financeDone
                      ? "Completed"
                      : financeRejected
                        ? "Not Cleared"
                        : item.financeClearanceStatus
                          ? "In Progress"
                          : "Pending";

                    const exitComplete = isVerified && adminDone && financeDone;

                    const steps = [
                      {
                        label: "Request Submitted",
                        done: true,
                        rejected: false,
                        date: formatDateTime(item.createdOn),
                        sub: `${item.employeeName || "-"}${item.empCode ? ` (${item.empCode})` : ""}`,
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
                        done: isVerified,
                        rejected: isNotCleared,
                        date: isVerified
                          ? item.verifiedOn
                            ? formatDateTime(item.verifiedOn)
                            : "Completed"
                          : isNotCleared
                            ? "Not Cleared"
                            : "In Progress",
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
                        rejected: financeRejected,
                        date: financeDate,
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
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-4 flex items-center justify-between">
          <Button variant="outline" onClick={onBack}>
            {isVerified || isNotCleared ? "Close" : "Cancel"}
          </Button>
          {!isVerified && !isNotCleared && (
            <div className="flex gap-4">
              <Button
                variant="outline"
                onClick={() => setIsNotClearedModalOpen(true)}
                className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive px-6 font-semibold"
                disabled={isVerifying}
              >
                Not Cleared
              </Button>
              <Button
                variant="soft"
                onClick={handleVerifyAndComplete}
                disabled={isVerifying}
              >
                {isVerifying ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <CheckCircle2 />
                )}
                Verify & Complete
              </Button>
            </div>
          )}
        </div>
      </SheetContent>

      <Dialog
        open={isNotClearedModalOpen}
        onOpenChange={setIsNotClearedModalOpen}
      >
        <DialogContent className="sm:max-w-[400px] p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-foreground">
              Mark as Not Cleared
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Are you sure you want to mark this asset as not cleared?
            </p>
          </DialogHeader>
          <div className="flex justify-center gap-4 mt-6">
            <Button
              variant="outline"
              onClick={() => setIsNotClearedModalOpen(false)}
              className="px-8 font-semibold h-11"
              disabled={isVerifying}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={handleNotCleared}
              className="px-8 font-semibold h-11"
              disabled={isVerifying}
            >
              {isVerifying ? <Loader2 className="animate-spin" /> : null}
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
};

export const ITAdminFlow = () => {
  const searchParams = useSearch({ strict: false });
  const autoOpenedRef = useRef(false);
  const [searchTerm, setSearchTerm] = useState(
    (searchParams as any).requestId || "",
  );
  const [statusFilter, setStatusFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [buFilter, setBuFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedItem, setSelectedItem] =
    useState<ITAssetReturnResponse | null>(null);

  const { data: departmentsData } = useGetDepartmentsQuery({ limit: 100 });
  const { data: businessUnitsData } = useGetBusinessUnitsQuery({ limit: 100 });

  const { data: checklists } = useGetChecklistsQuery({ deptId: "IT" });
  const itChecklist = checklists?.[0];

  const { data: summary, isLoading: isSummaryLoading } =
    useGetITAssetsSummaryQuery();
  const { data: assets, isLoading: isAssetsLoading } = useGetITAssetsQuery({
    skip: (currentPage - 1) * pageSize,
    limit: pageSize,
    search: searchTerm,
    status: statusFilter === "all" ? undefined : statusFilter,
    department: deptFilter === "all" ? undefined : deptFilter,
    businessUnit: buFilter === "all" ? undefined : buFilter,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  });

  useEffect(() => {
    const reqId = (searchParams as any).requestId;
    if (reqId && assets && assets.length > 0 && !autoOpenedRef.current) {
      const match = assets.find((a: any) => a.exitRequestId === reqId);
      if (match) {
        setSelectedItem(match);
        autoOpenedRef.current = true;
      }
    }
  }, [assets, searchParams]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getStatusBadge = (status: string) => {
    const s = status.toLowerCase();
    const label = IT_STATUS_LABELS[s] || status;
    if (s === "verified") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <CircleCheck className="size-3.5 shrink-0 text-success" />
          {label}
        </span>
      );
    }
    if (s === "not_cleared") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <CircleX className="size-3.5 shrink-0 text-destructive" />
          {label}
        </span>
      );
    }
    if (s === "pending") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <Clock className="size-3.5 shrink-0 text-badge-pending-text" />
          {label}
        </span>
      );
    }
    if (s === "returned") {
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="IT Clearance Requests"
        subtitle="Overview of all exit requests and their current status"
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
            label: "Pending Returns",
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
            key: "verified",
            label: "Verified",
            value: summary?.verified || 0,
            icon: CheckCircle2,
          },
        ].map((card) => (
          <div
            key={card.key}
            onClick={() => {
              setStatusFilter(card.key);
              setCurrentPage(1);
            }}
            className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${statusFilter === card.key ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/50"}`}
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
          <Select
            value={deptFilter}
            onValueChange={(v) => {
              setDeptFilter(v);
              setCurrentPage(1);
            }}
          >
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
              <SelectItem value="returned">Returned</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
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

        {isAssetsLoading ? (
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
              {!assets || assets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      title="No asset returns found"
                      description="No returns match your current filters."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                [...assets].sort((a, b) => (IT_STATUS_ORDER[a.status.toLowerCase()] ?? 99) - (IT_STATUS_ORDER[b.status.toLowerCase()] ?? 99)).map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedItem(item)}
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
            currentPage + (assets && assets.length >= pageSize ? 1 : 0),
          )}
          startIndex={
            assets && assets.length > 0 ? (currentPage - 1) * pageSize + 1 : 0
          }
          endIndex={assets ? (currentPage - 1) * pageSize + assets.length : 0}
          total={assets?.length ?? 0}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setCurrentPage(1);
          }}
        />
      </div>

      <AssetDetailView
        item={selectedItem}
        open={!!selectedItem}
        onOpenChange={(v) => {
          if (!v) setSelectedItem(null);
        }}
        checklistData={itChecklist}
      />
    </div>
  );
};

export default ITAdminFlow;
