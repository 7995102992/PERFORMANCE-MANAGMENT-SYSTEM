import * as React from "react";
import {
  Download,
  Upload,
  Check,
  AlertTriangle,
  X,
  ChevronDown,
  ChevronRight,
  Loader2,
  FileSpreadsheet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FileUploader } from "@/components/shared/FileUploader";
import { cn } from "@/lib/utils";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { useAppSelector } from "@/store";
import {
  useDownloadTemplate,
  useBulkValidate,
  useBulkUpload,
} from "@/hooks/queries/use-employees";
import type {
  BulkValidateResult,
  BulkUploadResult,
  BulkRowResult,
} from "@/api/org-setup/employees";

type Step = "select" | "preview" | "uploading" | "done";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ACCEPT_TYPES = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export function BulkUploadDialog({ open, onOpenChange }: Props) {
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const orgId = savedOrg?.id ?? "";

  const downloadTemplate = useDownloadTemplate();
  const validate = useBulkValidate();
  const upload = useBulkUpload();

  const [step, setStep] = React.useState<Step>("select");
  const [file, setFile] = React.useState<File | null>(null);
  const [validation, setValidation] = React.useState<BulkValidateResult | null>(
    null,
  );
  const [selectedRowNums, setSelectedRowNums] = React.useState<Set<number>>(
    new Set(),
  );
  const [result, setResult] = React.useState<BulkUploadResult | null>(null);
  const [expandedRows, setExpandedRows] = React.useState<Set<number>>(
    new Set(),
  );

  // Reset on open
  React.useEffect(() => {
    if (open) {
      setStep("select");
      setFile(null);
      setValidation(null);
      setSelectedRowNums(new Set());
      setResult(null);
      setExpandedRows(new Set());
    }
  }, [open]);

  async function handleValidate() {
    if (!file || !orgId) return;
    try {
      const res = await validate.mutateAsync({ file });
      setValidation(res);
      // Pre-select all valid rows
      const valid = new Set(
        res.rows.filter((r) => r.status === "valid").map((r) => r.row_num),
      );
      setSelectedRowNums(valid);
      setStep("preview");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error("Validation failed", err);
    }
  }

  async function handleUpload() {
    if (!file || !orgId) return;
    setStep("uploading");
    try {
      const res = await upload.mutateAsync({
        file,
        selectedRowNums: Array.from(selectedRowNums),
      });
      setResult(res);
      setStep("done");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error("Upload failed", err);
      setStep("preview");
    }
  }

  function toggleRow(rowNum: number) {
    setSelectedRowNums((prev) => {
      const next = new Set(prev);
      if (next.has(rowNum)) next.delete(rowNum);
      else next.add(rowNum);
      return next;
    });
  }

  function toggleExpanded(rowNum: number) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNum)) next.delete(rowNum);
      else next.add(rowNum);
      return next;
    });
  }

  function toggleSelectAll(selectable: BulkRowResult[]) {
    if (selectable.every((r) => selectedRowNums.has(r.row_num))) {
      // Deselect all
      const next = new Set(selectedRowNums);
      selectable.forEach((r) => next.delete(r.row_num));
      setSelectedRowNums(next);
    } else {
      // Select all selectable
      const next = new Set(selectedRowNums);
      selectable.forEach((r) => next.add(r.row_num));
      setSelectedRowNums(next);
    }
  }

  // ── Step: SELECT ─────────────────────────────────────────────────────────

  if (step === "select") {
    return (
      <>
        {downloadTemplate.isPending && (
          <FullScreenLoader message="Generating template..." />
        )}
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
                    Includes dropdowns for BU, Department, Designation, and more
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => downloadTemplate.mutate()}
                  disabled={downloadTemplate.isPending}
                >
                  {downloadTemplate.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  {downloadTemplate.isPending
                    ? "Generating template..."
                    : "Download"}
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
                disabled={!file || validate.isPending}
              >
                {validate.isPending ? (
                  <>
                    <Loader2 className="animate-spin" /> Validating...
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

  // ── Step: PREVIEW ────────────────────────────────────────────────────────

  if (step === "preview" && validation) {
    const { valid_count, error_count, duplicate_count, file_errors, rows } =
      validation;
    const nonEmptyRows = rows.filter((r) => r.status !== "empty");
    const selectableRows = nonEmptyRows.filter(
      (r) => r.status === "valid" || r.status === "duplicate",
    );
    const allSelected =
      selectableRows.length > 0 &&
      selectableRows.every((r) => selectedRowNums.has(r.row_num));

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Review & Upload</DialogTitle>
            <DialogDescription>
              {validation.total_rows} rows detected — review per-row validation
              before uploading
            </DialogDescription>
          </DialogHeader>

          {/* Summary */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check className="h-3 w-3" /> {valid_count} valid
            </Badge>
            {error_count > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X className="h-3 w-3" /> {error_count} errors
              </Badge>
            )}
            {duplicate_count > 0 && (
              <Badge
                variant="secondary"
                className="text-warning border-warning/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {duplicate_count}{" "}
                duplicates
              </Badge>
            )}
            <span className="text-sm text-muted-foreground ml-2">
              {selectedRowNums.size} selected for upload
            </span>
          </div>

          {/* File-level errors */}
          {file_errors.length > 0 && (
            <div className="rounded-lg border border-destructive bg-destructive/5 p-3 shrink-0">
              <p className="text-sm font-medium text-destructive">
                File errors:
              </p>
              <ul className="mt-1 list-disc pl-5 text-sm text-destructive">
                {file_errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Row table */}
          {file_errors.length === 0 && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden border rounded-lg">
              {/* Header */}
              <div className="grid grid-cols-[40px_60px_110px_1fr_1fr_1fr_120px] gap-2 px-3 py-2 bg-muted/40 text-[11px] font-semibold text-label uppercase border-b shrink-0">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => toggleSelectAll(selectableRows)}
                  className="h-3.5 w-3.5"
                />
                <span>Row</span>
                <span>Status</span>
                <span>Name</span>
                <span>Email</span>
                <span>Business Unit</span>
                <span>Designation</span>
              </div>

              <ScrollArea className="flex-1 min-h-0 overflow-hidden">
                {nonEmptyRows.map((row) => {
                  const isSelectable =
                    row.status === "valid" || row.status === "duplicate";
                  const isSelected = selectedRowNums.has(row.row_num);
                  const isExpanded = expandedRows.has(row.row_num);
                  const parsed = row.parsed as Record<
                    string,
                    string | null | undefined
                  > | null;

                  return (
                    <div
                      key={row.row_num}
                      className={cn(
                        "border-b last:border-b-0",
                        row.status === "error" &&
                          "bg-red-50/40 dark:bg-red-950/10",
                        row.status === "duplicate" &&
                          "bg-amber-50/40 dark:bg-amber-950/10",
                      )}
                    >
                      <div className="grid grid-cols-[40px_60px_110px_1fr_1fr_1fr_120px] gap-2 items-center px-3 py-1.5 text-xs">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(row.row_num)}
                          disabled={!isSelectable}
                          className="h-3.5 w-3.5"
                        />
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.row_num)}
                          className="flex items-center gap-0.5 text-left hover:text-foreground"
                        >
                          {row.errors.length > 0 &&
                            (isExpanded ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            ))}
                          {row.row_num}
                        </button>
                        <span>
                          {row.status === "valid" && (
                            <Badge
                              variant="secondary"
                              className="text-success border-success/30 gap-1 h-5 px-1.5 text-[10px]"
                            >
                              <Check className="h-2.5 w-2.5" /> Valid
                            </Badge>
                          )}
                          {row.status === "error" && (
                            <Badge
                              variant="secondary"
                              className="text-destructive border-destructive/30 gap-1 h-5 px-1.5 text-[10px]"
                            >
                              <X className="h-2.5 w-2.5" /> Error
                            </Badge>
                          )}
                          {row.status === "duplicate" && (
                            <Badge
                              variant="secondary"
                              className="text-warning border-warning/30 gap-1 h-5 px-1.5 text-[10px]"
                            >
                              <AlertTriangle className="h-2.5 w-2.5" /> Dup
                            </Badge>
                          )}
                        </span>
                        <span className="truncate">
                          {[parsed?.first_name, parsed?.last_name]
                            .filter(Boolean)
                            .join(" ") || "—"}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {parsed?.work_email ?? "—"}
                        </span>
                        <span className="truncate">
                          {parsed?.business_unit ?? "—"}
                        </span>
                        <span className="truncate">
                          {parsed?.designation ?? "—"}
                        </span>
                      </div>

                      {isExpanded && row.errors.length > 0 && (
                        <div className="px-3 py-2 pl-[52px] space-y-0.5 bg-muted/30 border-t">
                          {row.errors.map((err, i) => (
                            <p key={i} className="text-[11px] text-destructive">
                              <span className="font-mono font-medium">
                                {err.field}:
                              </span>{" "}
                              {err.message}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {nonEmptyRows.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No data rows in the file.
                  </div>
                )}
              </ScrollArea>
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
              onClick={handleUpload}
              disabled={selectedRowNums.size === 0}
            >
              <Upload />
              Upload {selectedRowNums.size}{" "}
              {selectedRowNums.size === 1 ? "Row" : "Rows"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: UPLOADING ──────────────────────────────────────────────────────

  if (step === "uploading") {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-sm">
          <div className="flex flex-col items-center justify-center gap-4 py-8">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">Uploading...</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Please wait while we create the employees.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: DONE ───────────────────────────────────────────────────────────

  if (step === "done" && result) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {result.failed === 0 ? (
                <Check className="h-5 w-5 text-success" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-warning" />
              )}
              Upload Complete
            </DialogTitle>
            <DialogDescription>
              {result.successful} of {result.total} rows uploaded successfully.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check className="h-3 w-3" /> {result.successful} succeeded
            </Badge>
            {result.failed > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X className="h-3 w-3" /> {result.failed} failed
              </Badge>
            )}
          </div>

          {result.errors.length > 0 && (
            <ScrollArea className="flex-1 min-h-0 border rounded-lg">
              <div className="p-3 space-y-3">
                <p className="text-xs font-semibold text-label uppercase mb-1">
                  Errors
                </p>
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs">
                    <span className="font-mono text-muted-foreground">
                      Row {e.row_num}:
                    </span>{" "}
                    <span className="text-destructive">{e.message}</span>
                  </p>
                ))}
              </div>
            </ScrollArea>
          )}

          <DialogFooter className="shrink-0">
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
