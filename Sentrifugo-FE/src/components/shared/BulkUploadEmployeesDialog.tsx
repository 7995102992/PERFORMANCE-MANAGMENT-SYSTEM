import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Download,
  Upload,
  Check,
  AlertTriangle,
  X,
  FileSpreadsheet,
  Loader2,
} from "lucide-react";
import { FileUploader } from "@/components/shared/FileUploader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import type { BulkValidateResult } from "@/store/api/lmsApi";

type Step = "select" | "preview" | "uploading" | "done";

const ACCEPT_TYPES = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

interface BulkUploadEmployeesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownloadTemplate: () => Promise<void>;
  onValidate: (file: File) => Promise<BulkValidateResult>;
  onAssign: (
    userIds: string[],
  ) => Promise<{ added: number; skipped?: number; total: number }>;
  entityName: string;
}

export function BulkUploadEmployeesDialog({
  open,
  onOpenChange,
  onDownloadTemplate,
  onValidate,
  onAssign,
  entityName,
}: BulkUploadEmployeesDialogProps) {
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [result, setResult] = useState<BulkValidateResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignResult, setAssignResult] = useState<{
    added: number;
    skipped?: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setStep("select");
      setFile(null);
      setResult(null);
      setSelectedIds(new Set());
      setAssignResult(null);
    }
  }, [open]);

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      await onDownloadTemplate();
    } finally {
      setIsDownloading(false);
    }
  };

  const handleValidate = async () => {
    if (!file) return;
    setIsValidating(true);
    try {
      const res = await onValidate(file);
      setResult(res);
      const validIds = new Set(
        res.rows
          .filter((r) => r.status === "valid" && r.user_id)
          .map((r) => r.user_id!),
      );
      setSelectedIds(validIds);
      setStep("preview");
    } catch (err) {
      toast.error(err, "Validation failed");
    } finally {
      setIsValidating(false);
    }
  };

  const handleAssign = async () => {
    if (selectedIds.size === 0) return;
    setStep("uploading");
    try {
      const res = await onAssign(Array.from(selectedIds));
      setAssignResult(res);
      setStep("done");
      const parts = [`${res.added} assigned`];
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      toast.success(parts.join(", "));
    } catch (err) {
      toast.error(err, "Assignment failed");
      setStep("preview");
    }
  };

  const validRows = useMemo(
    () => result?.rows.filter((r) => r.status === "valid" && r.user_id) ?? [],
    [result],
  );
  const allSelected =
    validRows.length > 0 && validRows.every((r) => selectedIds.has(r.user_id!));

  const toggleAll = () => {
    if (allSelected) {
      const next = new Set(selectedIds);
      validRows.forEach((r) => next.delete(r.user_id!));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      validRows.forEach((r) => next.add(r.user_id!));
      setSelectedIds(next);
    }
  };

  const toggleRow = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // ── Step: SELECT ──────────────────────────────────────────────────────────
  if (step === "select") {
    return (
      <>
        {isDownloading && <FullScreenLoader message="Generating template…" />}
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Import Employees</DialogTitle>
              <DialogDescription>
                Download the template, fill it in, and upload. Column order
                doesn't matter — headers are matched by name.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 py-2">
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-icon-bg shrink-0">
                  <FileSpreadsheet className="h-5 w-5 text-icon" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Employee Template</p>
                  <p className="text-xs text-muted-foreground">
                    Match employees by email address or employee code
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  disabled={isDownloading}
                >
                  {isDownloading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  {isDownloading ? "Generating…" : "Download"}
                </Button>
              </div>

              <FileUploader
                value={file}
                onChange={setFile}
                accept={ACCEPT_TYPES}
                maxSizeMB={10}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="soft"
                onClick={handleValidate}
                disabled={!file || isValidating}
              >
                {isValidating ? (
                  <>
                    <Loader2 className="animate-spin" /> Validating…
                  </>
                ) : (
                  "Next: Review"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ── Step: PREVIEW ─────────────────────────────────────────────────────────
  if (step === "preview" && result) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Review & Assign</DialogTitle>
            <DialogDescription>
              {result.total_rows} row{result.total_rows === 1 ? "" : "s"}{" "}
              detected — review per-row validation before assigning to this{" "}
              {entityName}.
            </DialogDescription>
          </DialogHeader>

          {/* Summary chips */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {result.valid_count > 0 && (
              <Badge
                variant="secondary"
                className="text-success border-success/30 gap-1"
              >
                <Check  /> {result.valid_count} valid
              </Badge>
            )}
            {result.error_count > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X  /> {result.error_count} error
                {result.error_count === 1 ? "" : "s"}
              </Badge>
            )}
            {result.duplicate_count > 0 && (
              <Badge
                variant="secondary"
                className="text-warning border-warning/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {result.duplicate_count}{" "}
                already assigned
              </Badge>
            )}
            <span className="text-sm text-muted-foreground ml-2">
              {selectedIds.size} selected for assignment
            </span>
          </div>

          {/* File-level errors */}
          {result.file_errors?.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive shrink-0">
              <p className="font-medium">File errors:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.file_errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Row table */}
          <div className="flex-1 min-h-0 overflow-hidden rounded-lg border">
            <div className="h-full overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-table-header">
                  <TableRow className="border-b border-table-border">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                        disabled={validRows.length === 0}
                      />
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      #
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Email
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Emp Code
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Name
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Department
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow
                      key={row.row_num}
                      className={cn(
                        row.status === "error" && "bg-destructive/5",
                        row.status === "duplicate" && "bg-warning/5",
                      )}
                    >
                      <TableCell>
                        <Checkbox
                          checked={
                            !!row.user_id && selectedIds.has(row.user_id)
                          }
                          onCheckedChange={() =>
                            row.user_id && toggleRow(row.user_id)
                          }
                          disabled={row.status !== "valid"}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.row_num}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {row.email || "—"}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {row.emp_code || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.name || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.department || "—"}
                      </TableCell>
                      <TableCell>
                        {row.status === "valid" && (
                          <Badge
                            variant="secondary"
                            className="text-success border-success/30 gap-1 h-5 px-1.5 text-[10px]"
                          >
                            <Check  /> Valid
                          </Badge>
                        )}
                        {row.status === "error" && (
                          <span className="flex items-center gap-1">
                            <Badge
                              variant="secondary"
                              className="text-destructive border-destructive/30 gap-1 h-5 px-1.5 text-[10px]"
                            >
                              <X  /> Error
                            </Badge>
                            <span className="text-[10px] text-destructive truncate">
                              {row.errors[0]}
                            </span>
                          </span>
                        )}
                        {row.status === "duplicate" && (
                          <Badge
                            variant="secondary"
                            className="text-warning border-warning/30 gap-1 h-5 px-1.5 text-[10px]"
                          >
                            Already assigned
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {result.rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        No data rows in the file.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {validRows.length === 0 && result.rows.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning shrink-0">
              <AlertTriangle className="size-4 shrink-0" />
              No valid employees to assign. Fix the errors in your file and try
              again.
            </div>
          )}

          <DialogFooter className="shrink-0 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep("select")}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="soft"
              onClick={handleAssign}
              disabled={selectedIds.size === 0}
            >
              <Upload />
              Assign {selectedIds.size}{" "}
              {selectedIds.size === 1 ? "Employee" : "Employees"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: UPLOADING ───────────────────────────────────────────────────────
  if (step === "uploading") {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-sm">
          <div className="flex flex-col items-center justify-center gap-4 py-8">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">Assigning…</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Please wait while we assign the employees.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: DONE ────────────────────────────────────────────────────────────
  if (step === "done" && assignResult) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {!assignResult.skipped || assignResult.skipped === 0 ? (
                <Check className="h-5 w-5 text-success" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-warning" />
              )}
              Import Complete
            </DialogTitle>
            <DialogDescription>
              {assignResult.added} employee{assignResult.added === 1 ? "" : "s"}{" "}
              assigned to this {entityName}. Total now: {assignResult.total}.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check  /> {assignResult.added} assigned
            </Badge>
            {!!assignResult.skipped && (
              <Badge
                variant="secondary"
                className="text-warning border-warning/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {assignResult.skipped}{" "}
                skipped
              </Badge>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              onClick={() => onOpenChange(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return null;
}
