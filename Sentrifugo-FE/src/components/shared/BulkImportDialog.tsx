import { useEffect, useState } from "react";
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
import type { ValidateResponse, ValidateRow } from "@/store/api/timesheetApi";

type Step = "select" | "preview" | "importing" | "done";

export interface BulkImportResult {
  total: number;
  created: number;
  errors: { row: number; error: string }[];
}

// A section describes one validate table (projects may have two: projects + tasks)
export interface PreviewSection {
  label: string;
  rows: ValidateRow[];
  total: number;
  columns: { key: string; label: string }[];
}

interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityName: string;
  templateLabel: string;
  templateDescription: string;
  /** Build preview sections from the validate result */
  buildSections: (result: ValidateResponse) => PreviewSection[];
  onDownloadTemplate: () => Promise<void>;
  onValidate: (file: File) => Promise<ValidateResponse>;
  onImport: (file: File) => Promise<BulkImportResult>;
}

const ACCEPT_TYPES = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

function StatusBadge({ status }: { status: ValidateRow["status"] }) {
  if (status === "new")
    return (
      <Badge
        variant="secondary"
        className="text-success border-success/30 gap-1 h-5 px-1.5 text-[10px]"
      >
        <Check  /> New
      </Badge>
    );
  if (status === "existing")
    return (
      <Badge
        variant="secondary"
        className="text-warning border-warning/30 gap-1 h-5 px-1.5 text-[10px]"
      >
        <AlertTriangle className="h-2.5 w-2.5" /> Existing
      </Badge>
    );
  return (
    <Badge
      variant="secondary"
      className="text-destructive border-destructive/30 gap-1 h-5 px-1.5 text-[10px]"
    >
      <X  /> Error
    </Badge>
  );
}

function SectionTable({ section }: { section: PreviewSection }) {
  const newCount = section.rows.filter((r) => r.status === "new").length;
  const existingCount = section.rows.filter(
    (r) => r.status === "existing",
  ).length;
  const errorCount = section.rows.filter((r) => r.status === "error").length;

  return (
    <div className="space-y-2">
      {/* Section header with summary chips */}
      <div className="flex flex-wrap items-center gap-2">
        {section.label && (
          <span className="text-sm font-medium text-foreground">
            {section.label}
          </span>
        )}
        {newCount > 0 && (
          <Badge
            variant="secondary"
            className="text-success border-success/30 gap-1"
          >
            <Check  /> {newCount} new
          </Badge>
        )}
        {existingCount > 0 && (
          <Badge
            variant="secondary"
            className="text-warning border-warning/30 gap-1"
          >
            <AlertTriangle className="h-3 w-3" /> {existingCount} existing
          </Badge>
        )}
        {errorCount > 0 && (
          <Badge
            variant="secondary"
            className="text-destructive border-destructive/30 gap-1"
          >
            <X  /> {errorCount} error
            {errorCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <div className="max-h-[300px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-table-header">
              <TableRow className="border-b border-table-border">
                <TableHead className="text-xs font-medium text-foreground w-12">
                  #
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground">
                  Status
                </TableHead>
                {section.columns.map((col) => (
                  <TableHead key={col.key} className="text-xs">
                    {col.label}
                  </TableHead>
                ))}
                <TableHead className="text-xs font-medium text-foreground">
                  Reason
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.rows.map((row) => (
                <TableRow
                  key={row.row}
                  className={cn(
                    row.status === "error" && "bg-destructive/5",
                    row.status === "existing" && "bg-warning/5",
                  )}
                >
                  <TableCell className="text-xs text-muted-foreground">
                    {row.row}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  {section.columns.map((col) => (
                    <TableCell key={col.key} className="text-xs">
                      {row.data[col.key] || "—"}
                    </TableCell>
                  ))}
                  <TableCell className="text-xs text-muted-foreground italic">
                    {row.reason || "—"}
                  </TableCell>
                </TableRow>
              ))}
              {section.rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={section.columns.length + 3}
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
    </div>
  );
}

export function BulkImportDialog({
  open,
  onOpenChange,
  entityName,
  templateLabel,
  templateDescription,
  buildSections,
  onDownloadTemplate,
  onValidate,
  onImport,
}: BulkImportDialogProps) {
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [sections, setSections] = useState<PreviewSection[]>([]);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(
    null,
  );

  useEffect(() => {
    if (open) {
      setStep("select");
      setFile(null);
      setSections([]);
      setImportResult(null);
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
      setSections(buildSections(res));
      setStep("preview");
    } catch (err) {
      toast.error(err, "Validation failed");
    } finally {
      setIsValidating(false);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setStep("importing");
    try {
      const res = await onImport(file);
      setImportResult(res);
      setStep("done");
      toast.success(`${res.created} ${entityName.toLowerCase()} imported`);
    } catch (err) {
      toast.error(err, "Import failed");
      setStep("preview");
    }
  };

  const allRows = sections.flatMap((s) => s.rows);
  const importableCount = allRows.filter(
    (r) => r.status === "new" || r.status === "existing",
  ).length;
  const hasErrors = allRows.some((r) => r.status === "error");

  // ── SELECT ────────────────────────────────────────────────────────────────
  if (step === "select") {
    return (
      <>
        {isDownloading && <FullScreenLoader message="Generating template…" />}
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Import {entityName}</DialogTitle>
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
                  <p className="text-sm font-medium">{templateLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {templateDescription}
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

  // ── PREVIEW ───────────────────────────────────────────────────────────────
  if (step === "preview") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Review Import</DialogTitle>
            <DialogDescription>
              {allRows.length} row{allRows.length === 1 ? "" : "s"} detected —
              review before importing.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
            {sections.map((section, i) => (
              <SectionTable key={i} section={section} />
            ))}
          </div>

          {importableCount === 0 && allRows.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning shrink-0">
              <AlertTriangle className="size-4 shrink-0" />
              No valid rows to import. Fix the errors in your file and try
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
              disabled={importableCount === 0}
            >
              <Upload />
              Import {importableCount} {entityName}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── IMPORTING ─────────────────────────────────────────────────────────────
  if (step === "importing") {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-sm">
          <div className="flex flex-col items-center justify-center gap-4 py-8">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">Importing…</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Please wait while we import the {entityName.toLowerCase()}.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── DONE ─────────────────────────────────────────────────────────────────
  if (step === "done" && importResult) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {importResult.errors.length === 0 ? (
                <Check className="h-5 w-5 text-success" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-warning" />
              )}
              Import Complete
            </DialogTitle>
            <DialogDescription>
              {importResult.created} of {importResult.total}{" "}
              {entityName.toLowerCase()} imported successfully.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check  /> {importResult.created} created
            </Badge>
            {importResult.errors.length > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X  /> {importResult.errors.length} failed
              </Badge>
            )}
          </div>

          {importResult.errors.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1 max-h-40 overflow-y-auto">
              {importResult.errors.map((err, i) => (
                <p key={i} className="text-xs text-destructive">
                  Row {err.row}: {err.error}
                </p>
              ))}
            </div>
          )}

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
