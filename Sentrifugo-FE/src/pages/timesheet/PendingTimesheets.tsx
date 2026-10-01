import { useState } from "react";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2, Clock, Eye, RefreshCcw } from "lucide-react";
import {
  useGetMyTimesheetsQuery,
  useResubmitTimesheetMutation,
  useGetProjectsQuery,
} from "@/store/api/timesheetApi";
import type { WeeklyTimesheetResponse } from "@/types/timesheet";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";

const formatDate = (d: string) => {
  const date = new Date(d);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
};

const tsStatusVariant = (status: string) => {
  const map: Record<
    string,
    "submitted" | "resubmitted" | "l1_rejected" | "client_rejected"
  > = {
    submitted: "submitted",
    resubmitted: "resubmitted",
    l1_rejected: "l1_rejected",
    client_rejected: "client_rejected",
  };
  return map[status] ?? "pending";
};

const PendingTimesheets = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [viewDetail, setViewDetail] = useState<WeeklyTimesheetResponse | null>(
    null,
  );
  const [resubmitConfirm, setResubmitConfirm] = useState<string | null>(null);

  const { data, isLoading } = useGetMyTimesheetsQuery({
    page,
    page_size: pageSize,
  });
  const { data: projects } = useGetProjectsQuery({
    page: 1,
    page_size: 100,
    status: "all",
  });
  const [resubmit, { isLoading: isResubmitting }] =
    useResubmitTimesheetMutation();

  const projectMap = new Map(
    (projects?.items ?? []).map((p) => [p.id, p.name]),
  );

  const pendingTimesheets = (data?.items ?? []).filter((ts) =>
    ["submitted", "resubmitted", "l1_rejected", "client_rejected"].includes(
      ts.timesheet_status,
    ),
  );
  const total = data?.total ?? 0;

  const handleResubmit = async (id: string) => {
    try {
      await resubmit(id).unwrap();
      toast.success("Timesheet resubmitted for approval");
      setResubmitConfirm(null);
    } catch (err) {
      toast.error(err, "Failed to resubmit timesheet");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pending Approval"
        subtitle="Track submitted timesheets awaiting manager approval"
      />

      {isLoading ? (
        <PageLoader message="Loading timesheets…" />
      ) : pendingTimesheets.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No pending timesheets"
          description="Timesheets awaiting approval will appear here."
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Week
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Total Hours
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Status
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Submitted On
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingTimesheets.map((ts) => (
                <TableRow key={ts.id}>
                  <TableCell className="font-medium">
                    {formatDate(ts.week_start_date)} -{" "}
                    {formatDate(ts.week_end_date)}
                  </TableCell>
                  <TableCell>{ts.total_hours} hrs</TableCell>
                  <TableCell>
                    <StatusBadge
                      status={
                        tsStatusVariant(ts.timesheet_status) as Parameters<
                          typeof StatusBadge
                        >[0]["status"]
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {formatDate(ts.updated_on ?? ts.created_on)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setViewDetail(ts)}
                      >
                        <Eye className="size-4" />
                      </Button>
                      {(ts.timesheet_status === "l1_rejected" ||
                        ts.timesheet_status === "client_rejected") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => setResubmitConfirm(ts.id)}
                        >
                          <RefreshCcw className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination
            currentPage={page}
            totalPages={Math.ceil(total / pageSize)}
            startIndex={Math.min((page - 1) * pageSize + 1, total)}
            endIndex={Math.min(page * pageSize, total)}
            total={total}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!viewDetail} onOpenChange={() => setViewDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Timesheet Detail</DialogTitle>
          </DialogHeader>
          {viewDetail && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Week</p>
                  <p className="text-sm font-medium">
                    {formatDate(viewDetail.week_start_date)} -{" "}
                    {formatDate(viewDetail.week_end_date)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total Hours</p>
                  <p className="text-sm font-medium">
                    {viewDetail.total_hours}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <p className="text-sm font-medium capitalize">
                    {viewDetail.timesheet_status.replace("_", " ")}
                  </p>
                </div>
              </div>
              {(viewDetail.entries?.length ?? 0) > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Project
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Task
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Date
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Hours
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {viewDetail.entries?.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          {projectMap.get(entry.project_id) ?? entry.project_id}
                        </TableCell>
                        <TableCell>{entry.task_id}</TableCell>
                        <TableCell>{formatDate(entry.entry_date)}</TableCell>
                        <TableCell>{entry.hours}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resubmit Confirmation */}
      <Dialog
        open={!!resubmitConfirm}
        onOpenChange={() => setResubmitConfirm(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Resubmit Timesheet</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to resubmit this timesheet for approval?
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => resubmitConfirm && handleResubmit(resubmitConfirm)}
              disabled={isResubmitting}
            >
              {isResubmitting && <Loader2 className="animate-spin" />}
              Resubmit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PendingTimesheets;
