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
import { useConfirm } from "@/providers/confirm-dialog-provider";
import type {
  HolidayBulkValidateResult,
  HolidayBulkValidateRow,
} from "@/types/leave";

type Step = "select" | "preview" | "uploading" | "done";

const ACCEPT_TYPES = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

interface BulkUploadHolidaysDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Plan year — used to phrase the year-mismatch confirm prompt. */
  planYear?: number;
  onDownloadTemplate: () => Promise<void>;
  onValidate: (file: File) => Promise<HolidayBulkValidateResult>;
  onImport: (
    holidays: {
      name: string;
      date: string;
      classification_id: string;
      description: string;
    }[],
  ) => Promise<{ imported: number; skipped: number }>;
  entityName?: string;
}

export function BulkUploadHolidaysDialog({
  open,
  onOpenChange,
  planYear,
  onDownloadTemplate,
  onValidate,
  onImport,
  entityName = "holiday plan",
}: BulkUploadHolidaysDialogProps) {
  const confirm = useConfirm();
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [result, setResult] = useState<HolidayBulkValidateResult | null>(null);
  const [selectedRowNums, setSelectedRowNums] = useState<Set<number>>(
    new Set(),
  );
  const [acceptedYearFixes, setAcceptedYearFixes] = useState<
    Map<number, string>
  >(new Map());
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setStep("select");
      setFile(null);
      setResult(null);
      setSelectedRowNums(new Set());
      setAcceptedYearFixes(new Map());
      setImportResult(null);
    }
  }, [open]);

  const isImportable = (r: HolidayBulkValidateRow) =>
    r.status === "valid" ||
    (r.status === "year_mismatch" && acceptedYearFixes.has(r.row_num));

  const importableRows = useMemo(
    () => result?.rows.filter(isImportable) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, acceptedYearFixes],
  );

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
      const validIdxs = new Set(
        res.rows.filter((r) => r.status === "valid").map((r) => r.row_num),
      );
      setSelectedRowNums(validIdxs);
      setAcceptedYearFixes(new Map());
      setStep("preview");

      const mismatches = res.rows.filter(
        (r) => r.status === "year_mismatch" && r.suggested_date,
      );
      if (mismatches.length > 0 && planYear) {
        confirm({
          title: `Update ${mismatches.length} date${mismatches.length === 1 ? "" : "s"} to ${planYear}?`,
          description:
            `${mismatches.length} holiday date${mismatches.length === 1 ? " is" : "s are"} outside the plan year (${planYear}). ` +
            `Click "Update & Include" to shift the year to ${planYear} and include them. ` +
            `Click "Skip" to leave them out.`,
          confirmText: "Update & Include",
          cancelText: "Skip",
          onConfirm: () => {
            const fixes = new Map<number, string>();
            for (const r of mismatches) {
              if (r.suggested_date) fixes.set(r.row_num, r.suggested_date);
            }
            setAcceptedYearFixes(fixes);
            setSelectedRowNums((prev) => {
              const next = new Set(prev);
              for (const r of mismatches) next.add(r.row_num);
              return next;
            });
          },
        });
      }
    } catch (err) {
      toast.error(err, "Validation failed");
    } finally {
      setIsValidating(false);
    }
  };

  const handleImport = async () => {
    if (!result || selectedRowNums.size === 0) return;
    setStep("uploading");
    try {
      const holidays = result.rows
        .filter((r) => isImportable(r) && selectedRowNums.has(r.row_num))
        .map((r) => ({
          name: r.name,
          date: acceptedYearFixes.get(r.row_num) ?? r.date,
          classification_id: r.classification_id,
          description: r.description,
        }));
      const res = await onImport(holidays);
      setImportResult(res);
      setStep("done");
      const parts = [`${res.imported} imported`];
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      toast.success(parts.join(", "));
    } catch (err) {
      toast.error(err, "Import failed");
      setStep("preview");
    }
  };

  const toggleRow = (rowNum: number) => {
    setSelectedRowNums((prev) => {
      const next = new Set(prev);
      if (next.has(rowNum)) next.delete(rowNum);
      else next.add(rowNum);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allSelected =
      importableRows.length > 0 &&
      importableRows.every((r) => selectedRowNums.has(r.row_num));
    if (allSelected) {
      const next = new Set(selectedRowNums);
      importableRows.forEach((r) => next.delete(r.row_num));
      setSelectedRowNums(next);
    } else {
      const next = new Set(selectedRowNums);
      importableRows.forEach((r) => next.add(r.row_num));
      setSelectedRowNums(next);
    }
  };

  // ── Step: SELECT ──────────────────────────────────────────────────────────
  if (step === "select") {
    return (
      <>
        {isDownloading && <FullScreenLoader message="Generating template…" />}
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Import Holidays</DialogTitle>
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
                  <p className="text-sm font-medium">Holiday Template</p>
                  <p className="text-xs text-muted-foreground">
                    Includes a Classification dropdown
                    {planYear ? ` — pre-configured for ${planYear}` : ""}
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
    const { rows, summary } = result;
    const allSelected =
      importableRows.length > 0 &&
      importableRows.every((r) => selectedRowNums.has(r.row_num));

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Review & Import</DialogTitle>
            <DialogDescription>
              {summary.total} row{summary.total === 1 ? "" : "s"} detected —
              review per-row validation before importing into this {entityName}.
            </DialogDescription>
          </DialogHeader>

          {/* Summary chips */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {summary.valid > 0 && (
              <Badge
                variant="secondary"
                className="text-success border-success/30 gap-1"
              >
                <Check  /> {summary.valid} valid
              </Badge>
            )}
            {!!summary.year_mismatches && summary.year_mismatches > 0 && (
              <Badge
                variant="secondary"
                className="text-info border-info/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {summary.year_mismatches}{" "}
                year mismatch
              </Badge>
            )}
            {summary.errors > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X  /> {summary.errors} error
                {summary.errors === 1 ? "" : "s"}
              </Badge>
            )}
            {summary.duplicates > 0 && (
              <Badge
                variant="secondary"
                className="text-warning border-warning/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {summary.duplicates}{" "}
                duplicate{summary.duplicates === 1 ? "" : "s"}
              </Badge>
            )}
            <span className="text-sm text-muted-foreground ml-2">
              {selectedRowNums.size} selected for import
            </span>
          </div>

          {/* Row table */}
          <div className="flex-1 min-h-0 overflow-hidden rounded-lg border">
            <div className="h-full overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-table-header">
                  <TableRow className="border-b border-table-border">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                        disabled={importableRows.length === 0}
                      />
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      #
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Holiday Name
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Date
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Classification
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Description
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const fixedDate = acceptedYearFixes.get(row.row_num);
                    return (
                      <TableRow
                        key={row.row_num}
                        className={cn(
                          row.status === "error" && "bg-destructive/5",
                          row.status === "duplicate" && "bg-warning/5",
                          row.status === "year_mismatch" && "bg-info/5",
                        )}
                      >
                        <TableCell>
                          <Checkbox
                            checked={selectedRowNums.has(row.row_num)}
                            onCheckedChange={() => toggleRow(row.row_num)}
                            disabled={!isImportable(row)}
                          />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.row_num}
                        </TableCell>
                        <TableCell className="text-xs font-medium">
                          {row.name || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fixedDate ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="line-through opacity-60">
                                {row.date || "—"}
                              </span>
                              <span className="font-medium text-foreground">
                                → {fixedDate}
                              </span>
                            </span>
                          ) : (
                            row.date || "—"
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.classification || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[140px] truncate">
                          {row.description || "—"}
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
                          {row.status === "year_mismatch" && (
                            <Badge
                              variant="secondary"
                              className="text-info border-info/30 gap-1 h-5 px-1.5 text-[10px]"
                            >
                              {fixedDate ? "Auto-fixed" : "Year mismatch"}
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
                              <AlertTriangle className="h-2.5 w-2.5" /> Dup
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {rows.length === 0 && (
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

          {importableRows.length === 0 && rows.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning shrink-0">
              <AlertTriangle className="size-4 shrink-0" />
              No valid holidays to import. Fix the errors in your file and try
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
              onClick={handleImport}
              disabled={selectedRowNums.size === 0}
            >
              <Upload />
              Import {selectedRowNums.size}{" "}
              {selectedRowNums.size === 1 ? "Holiday" : "Holidays"}
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
              <p className="text-lg font-semibold">Importing…</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Please wait while we add the holidays.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: DONE ────────────────────────────────────────────────────────────
  if (step === "done" && importResult) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {importResult.skipped === 0 ? (
                <Check className="h-5 w-5 text-success" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-warning" />
              )}
              Import Complete
            </DialogTitle>
            <DialogDescription>
              {importResult.imported} of{" "}
              {importResult.imported + importResult.skipped} holiday
              {importResult.imported + importResult.skipped === 1
                ? ""
                : "s"}{" "}
              imported successfully.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check  /> {importResult.imported} imported
            </Badge>
            {importResult.skipped > 0 && (
              <Badge
                variant="secondary"
                className="text-warning border-warning/30 gap-1"
              >
                <AlertTriangle className="h-3 w-3" /> {importResult.skipped}{" "}
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
