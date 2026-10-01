import { useState } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  FileSpreadsheet,
  FileText,
  Briefcase,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import {
  useGetClientTimesheetQuery,
  useClientApproveTimesheetMutation,
  useClientRejectTimesheetMutation,
  useClientBulkApproveMutation,
  useClientBulkRejectMutation,
} from "@/store/api/timesheetApi";
import type { ClientWeekSummaryItem } from "@/store/api/timesheetApi";
import { ProjectApprovalBadge } from "@/components/shared/ProjectApprovalBadge";
import { downloadAuthed } from "@/lib/download";
import { getWeekNumberInMonth } from "@/lib/week";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;



const formatDate = (d: string) => formatDateIST(d);

const formatDateTime = (d: string | null) => (d ? formatDateTimeIST(d) : "—");

interface Props {
  timesheetId: string | null;
  weeks?: ClientWeekSummaryItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ClientTimesheetDetail = ({
  timesheetId,
  weeks,
  open,
  onOpenChange,
}: Props) => {
  const [rejectDialog, setRejectDialog] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [rejectAllDialog, setRejectAllDialog] = useState(false);
  const [rejectAllComment, setRejectAllComment] = useState("");
  const [hoursChecked, setHoursChecked] = useState(false);
  const [activeTimesheetId, setActiveTimesheetId] = useState<string | null>(
    null,
  );

  const currentId = activeTimesheetId ?? timesheetId;

  const { data: detail, isLoading } = useGetClientTimesheetQuery(currentId!, {
    skip: !currentId,
  });
  const [approveTs, { isLoading: isApproving }] =
    useClientApproveTimesheetMutation();
  const [rejectTs, { isLoading: isRejecting }] =
    useClientRejectTimesheetMutation();
  const [bulkApprove, { isLoading: isBulkApproving }] =
    useClientBulkApproveMutation();
  const [bulkReject, { isLoading: isBulkRejecting }] =
    useClientBulkRejectMutation();

  const canApprove =
    detail &&
    detail.timesheet_status === "l1_approved" &&
    detail.client_approval_required !== false;

  const extractErrorMsg = (err: unknown, fallback: string) => {
    const e = err as { data?: { detail?: string }; status?: number };
    return e?.data?.detail ?? fallback;
  };

  // All weeks in this month awaiting client approval
  const pendingWeekIds = (weeks ?? [])
    .filter(
      (w) => w.timesheet_status === "l1_approved" && w.client_approval_required,
    )
    .map((w) => w.id);

  const handleApproveAll = async () => {
    if (pendingWeekIds.length === 0) return;
    try {
      await bulkApprove({ timesheet_ids: pendingWeekIds }).unwrap();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(extractErrorMsg(err, "Failed to approve timesheets"));
    }
  };

  const handleRejectAll = async () => {
    if (pendingWeekIds.length === 0 || !rejectAllComment) return;
    try {
      await bulkReject({
        timesheet_ids: pendingWeekIds,
        comments: rejectAllComment,
      }).unwrap();
      setRejectAllDialog(false);
      setRejectAllComment("");
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(extractErrorMsg(err, "Failed to reject timesheets"));
    }
  };

  const handleApprove = async () => {
    if (!detail) return;
    try {
      await approveTs({ id: detail.id, body: {} }).unwrap();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(extractErrorMsg(err, "Failed to approve timesheet"));
    }
  };

  const handleReject = async () => {
    if (!detail || !rejectComment) return;
    try {
      await rejectTs({
        id: detail.id,
        body: { comments: rejectComment },
      }).unwrap();
      setRejectDialog(false);
      setRejectComment("");
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(extractErrorMsg(err, "Failed to reject timesheet"));
      setRejectDialog(false);
      setRejectComment("");
    }
  };

  // Export the whole month for this employee (viewed week's month/year)
  const handleMonthlyExport = async (format: "excel" | "pdf") => {
    if (!detail) return;
    const start = new Date(detail.week_start_date);
    const params = new URLSearchParams({
      user_id: detail.user_id,
      month: String(start.getMonth() + 1),
      year: String(start.getFullYear()),
    });
    const ext = format === "excel" ? "xlsx" : "pdf";
    const code = detail.emp_code ?? detail.user_id ?? "timesheet";
    const fallback =
      `${code}_${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}.${ext}`.replace(
        /\s+/g,
        "_",
      );
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}client-portal/timesheets/monthly/export/${format}?${params.toString()}`,
        fallback,
      );
    } catch {
      toast.error("Export failed. Please try again.");
    }
  };

  const handleExcelDownload = () => handleMonthlyExport("excel");
  const handlePdfDownload = () => handleMonthlyExport("pdf");

  const handleSheetChange = (v: boolean) => {
    if (!v) {
      setRejectDialog(false);
      setRejectComment("");
      setRejectAllDialog(false);
      setRejectAllComment("");
      setHoursChecked(false);
      setActiveTimesheetId(null);
    }
    onOpenChange(v);
  };

  const dailyBreakdown = detail?.daily_breakdown ?? [];
  const projectContext = detail?.project_context;
  const projectApprovals = detail?.project_approvals ?? [];

  return (
    <>
      <Sheet open={open} onOpenChange={handleSheetChange}>
        <SheetContent
          className="w-[80vw] max-w-[80vw] flex flex-col p-0"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <SheetHeader className="px-6 py-5 border-b">
            <div>
              <SheetTitle>Client Timesheet Review</SheetTitle>
              <SheetDescription>
                Review and approve/reject client timesheet
              </SheetDescription>
            </div>
          </SheetHeader>

          {isLoading || !detail ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                {/* Employee Info */}
                <div className="flex items-center gap-3">
                  <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-primary">
                      {(detail.user_name ?? detail.user_id ?? "")
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((w: string) => w[0].toUpperCase())
                        .join("")}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold text-foreground truncate">
                      {detail.user_name ?? detail.user_id}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {detail.emp_code ?? detail.user_id}
                    </p>
                  </div>
                  {pendingWeekIds.length > 0 && (
                    <div className="flex items-center gap-2 self-center">
                      <Button
                        size="sm"
                        onClick={handleApproveAll}
                        disabled={isBulkApproving}
                        title="Approve all pending weeks this month"
                      >
                        {isBulkApproving && (
                          <Loader2 className="animate-spin" />
                        )}
                        Approve All ({pendingWeekIds.length})
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive hover:bg-destructive/10"
                        onClick={() => setRejectAllDialog(true)}
                        title="Reject all pending weeks this month"
                      >
                        Reject All
                      </Button>
                    </div>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 self-center"
                      >
                        <Download /> Export
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={handleExcelDownload}>
                        <FileSpreadsheet className="size-4 mr-2" /> Excel
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handlePdfDownload}>
                        <FileText /> PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Week selector tabs */}
                {weeks && weeks.length > 1 && (
                  <div className="flex items-center gap-2 overflow-x-auto border-b pb-3">
                    {[...weeks]
                      .sort((a, b) =>
                        a.week_start_date.localeCompare(b.week_start_date),
                      )
                      .map((wk) => {
                        const active = wk.id === currentId;
                        return (
                          <button
                            key={wk.id}
                            type="button"
                            onClick={() => setActiveTimesheetId(wk.id)}
                            title={`${formatDate(wk.week_start_date)} – ${formatDate(wk.week_end_date)} · ${wk.total_hours}h`}
                            className={`shrink-0 rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                              active
                                ? "border-primary bg-primary/5 text-primary"
                                : "border-border text-foreground hover:bg-muted/50"
                            }`}
                          >
                            Week {getWeekNumberInMonth(wk.week_start_date)}
                          </button>
                        );
                      })}
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  {/* Left: Daily Breakdown */}
                  <div className="lg:col-span-2 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          Daily Hour Breakdown
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Week: {formatDate(detail.week_start_date)} –{" "}
                          {formatDate(detail.week_end_date)}
                        </p>
                      </div>
                      {canApprove && (
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive border-destructive hover:bg-destructive/10"
                            onClick={() => setRejectDialog(true)}
                          >
                            <XCircle /> Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleApprove}
                            disabled={isApproving}
                          >
                            {isApproving && (
                              <Loader2 className="animate-spin" />
                            )}
                            <CheckCircle2 /> Approve
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border overflow-x-auto bg-card">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-table-header hover:bg-table-header border-b border-table-border">
                            <th className="text-left p-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              Date & Day
                            </th>
                            <th className="text-center p-3 text-xs font-medium text-muted-foreground uppercase tracking-wide w-20">
                              Hours
                            </th>
                            <th className="text-left p-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              Work Comments & Tasks
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {dailyBreakdown.map((day, i) => (
                            <tr key={i} className="border-b last:border-b-0">
                              <td className="p-3">
                                <div className="font-medium text-sm">
                                  {day.day}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {formatDate(day.date)}
                                </div>
                              </td>
                              <td className="p-3 text-center">
                                <span
                                  className={`text-sm font-bold text-muted-foreground`}
                                >
                                  {day.hours}
                                </span>
                              </td>
                              <td className="p-3">
                                {day.tasks.map((t, j) => (
                                  <div
                                    key={j}
                                    className="text-sm text-foreground"
                                  >
                                    <span className="font-medium">
                                      {t.project_name}
                                    </span>
                                    {t.task_name && (
                                      <span className="text-muted-foreground">
                                        {" "}
                                        / {t.task_name}
                                      </span>
                                    )}
                                    {t.notes && (
                                      <span className="text-muted-foreground">
                                        {" "}
                                        - {t.notes}
                                      </span>
                                    )}
                                  </div>
                                ))}
                                {day.tasks.length === 0 && day.hours === 0 && (
                                  <span className="text-sm text-muted-foreground">
                                    Not entered.
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-table-header border-t-2 border-table-border">
                            <td className="p-3 font-bold text-sm text-foreground">
                              TOTAL WEEKLY HOURS
                            </td>
                            <td className="p-3 text-center">
                              <span className="text-lg font-bold text-foreground">
                                {detail.total_weekly_hours ??
                                  detail.total_hours}
                                h
                              </span>
                            </td>
                            <td className="p-3 text-xs text-muted-foreground">
                              Calculated from{" "}
                              {formatDate(detail.week_start_date)} to{" "}
                              {formatDate(detail.week_end_date)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>

                  {/* Right: Project Context + History */}
                  <div className="space-y-4">
                    {projectContext && (
                      <div className="rounded-xl border bg-card p-4 space-y-2 text-sm">
                        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                          <Briefcase className="size-4" /> Project Context
                        </h3>
                        <div>
                          <span className="text-muted-foreground">
                            Project:
                          </span>
                          <span className="ml-2 font-medium">
                            {projectContext.project_name}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Client:</span>
                          <span className="ml-2 font-medium">
                            {projectContext.client_name}
                          </span>
                        </div>
                        {projectContext.project_code && (
                          <div>
                            <span className="text-muted-foreground">Code:</span>
                            <span className="ml-2 font-medium">
                              {projectContext.project_code}
                            </span>
                          </div>
                        )}
                        <div>
                          <span className="text-muted-foreground">
                            Billing Status:
                          </span>
                          <span
                            className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${projectContext.billing_status === "BILLABLE" ? "bg-badge-active-bg text-badge-active-text" : "bg-muted text-muted-foreground"}`}
                          >
                            {projectContext.billing_status}
                          </span>
                        </div>
                      </div>
                    )}

                    {detail.approval_history &&
                      detail.approval_history.length > 0 && (
                        <div className="rounded-xl border bg-card p-4 space-y-2">
                          <h3 className="text-sm font-semibold text-foreground">
                            Approval History
                          </h3>
                          {detail.approval_history.map((ar) => (
                            <div
                              key={ar.id}
                              className="text-xs border-l-2 pl-3 py-1 border-border"
                            >
                              <div className="flex items-center gap-1">
                                {ar.action === "approved" ||
                                ar.action === "submitted" ? (
                                  <CheckCircle2 className="size-3 text-success" />
                                ) : (
                                  <XCircle className="size-3 text-destructive" />
                                )}
                                <span className="font-medium capitalize">
                                  {ar.action}
                                </span>
                                <span className="text-muted-foreground">
                                  by {ar.approver_name ?? ar.approver_id}
                                </span>
                              </div>
                              <div className="text-muted-foreground">
                                {ar.approver_role} –{" "}
                                {ar.acted_at ? formatDate(ar.acted_at) : ""}
                              </div>
                              {ar.comments && (
                                <div className="text-muted-foreground mt-0.5">
                                  "{ar.comments}"
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                </div>

                {/* Project Approvals */}
                {false && projectApprovals.length > 0 && (
                  <div className="rounded-xl border overflow-x-auto bg-card">
                    <div className="px-4 py-3 border-b">
                      <h3 className="text-sm font-semibold text-foreground">
                        Project Approvals
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Per-project approval status for this timesheet
                      </p>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Project
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Status
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Employee
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Manager
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Manager action at
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Your decision
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Your action at
                          </TableHead>
                          <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                            Comments
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {projectApprovals.map((pa) => {
                          const awaitingReview = pa.status === "l1_approved";
                          const clientApproved =
                            pa.status === "client_approved";
                          const clientRejected =
                            pa.status === "client_rejected";
                          return (
                            <TableRow
                              key={pa.project_id}
                              className={
                                awaitingReview
                                  ? "bg-info/5"
                                  : clientApproved
                                    ? "bg-success/5"
                                    : clientRejected
                                      ? "bg-destructive/5"
                                      : ""
                              }
                            >
                              <TableCell className="font-medium text-sm">
                                {pa.project_name}
                              </TableCell>
                              <TableCell>
                                <ProjectApprovalBadge status={pa.status} />
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {pa.submitted_by_name ?? pa.submitted_by_id}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {pa.l1_approver_name ?? "—"}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                {formatDateTime(pa.l1_acted_at)}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {clientApproved ? (
                                  "You approved"
                                ) : clientRejected ? (
                                  "You rejected"
                                ) : awaitingReview ? (
                                  <span className="text-info font-medium">
                                    Awaiting your review
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                {formatDateTime(pa.client_acted_at)}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground max-w-[160px]">
                                {pa.client_comments ?? "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Reject Dialog */}
      <Dialog
        open={rejectDialog}
        onOpenChange={(v) => {
          if (!v) {
            setRejectDialog(false);
            setRejectComment("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Timesheet</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Label>
              Reason for rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
              placeholder="Provide reason for rejection..."
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleReject}
              disabled={!rejectComment || isRejecting}
            >
              {isRejecting && <Loader2 className="animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject All Dialog */}
      <Dialog
        open={rejectAllDialog}
        onOpenChange={(v) => {
          if (!v) {
            setRejectAllDialog(false);
            setRejectAllComment("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject {pendingWeekIds.length} Timesheets</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Label>
              Reason for rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={rejectAllComment}
              onChange={(e) => setRejectAllComment(e.target.value)}
              placeholder="Provide reason for rejecting all pending weeks..."
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleRejectAll}
              disabled={!rejectAllComment || isBulkRejecting}
            >
              {isBulkRejecting && <Loader2 className="animate-spin" />}
              Reject All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ClientTimesheetDetail;
