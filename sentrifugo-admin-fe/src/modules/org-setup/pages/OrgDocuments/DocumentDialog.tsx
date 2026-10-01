import * as React from "react";
import {
  Check,
  X,
  Loader2,
  FileText,
  FileSpreadsheet,
  File,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormSheet } from "@/components/shared/FormSheet";
import { Upload } from "lucide-react";
import { FileUploader } from "@/components/shared/FileUploader";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { cn } from "@/lib/utils";
import type { OrgDocument } from "@/modules/org-setup/types/org-documents";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 2 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
]);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name: string, cls?: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["pdf"].includes(ext))
    return <FileText className={cn("text-destructive/70", cls)} />;
  if (["xls", "xlsx", "csv"].includes(ext))
    return <FileSpreadsheet className={cn("text-success/80", cls)} />;
  if (["doc", "docx"].includes(ext))
    return <FileText className={cn("text-muted-foreground", cls)} />;
  return <File className={cn("text-muted-foreground", cls)} />;
}

function fileTitle(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
}

// ─── Types ──────────────────────────────────────────────────────────────────

type FileStatus = "pending" | "uploading" | "done" | "failed" | "oversized";

interface FileEntry {
  file: File;
  title: string;
  status: FileStatus;
  error?: string;
}

// ─── Single-file edit mode ──────────────────────────────────────────────────

interface EditProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  editingDoc: OrgDocument;
  onSave: (doc: OrgDocument, file?: File | null) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function EditDocumentDialog({
  open,
  onOpenChange,
  folderId: _folderId,
  editingDoc,
  onSave,
}: EditProps) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [allowDownload, setAllowDownload] = React.useState(false);
  const [requireAck, setRequireAck] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  const isDirty = title.trim() !== editingDoc.title || !!file;
  const guardedOpenChange = useUnsavedGuard(isDirty, onOpenChange);

  React.useEffect(() => {
    if (!open) return;
    setTitle(editingDoc.title);
    setDescription(editingDoc.description);
    setAllowDownload(editingDoc.allowDownload);
    setRequireAck(editingDoc.requireAcknowledgement);
    setFile(null);
    setSubmitted(false);
    setIsSaving(false);
  }, [open, editingDoc]);

  const trimmedTitle = title.trim();
  const titleError =
    submitted && !trimmedTitle ? "Document title is required" : undefined;

  async function handleSave() {
    setSubmitted(true);
    if (!trimmedTitle) return;
    setIsSaving(true);
    try {
      await onSave(
        {
          ...editingDoc,
          title: trimmedTitle,
          description: description.trim(),
          allowDownload,
          requireAcknowledgement: requireAck,
        },
        file,
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={guardedOpenChange}
      title="Edit Document"
      width={520}
      submitting={isSaving}
      submitLabel={isSaving ? "Saving..." : "Save Changes"}
      onSubmit={handleSave}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <Label>
            Document Title <span className="text-destructive">*</span>
          </Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={150}
          />
          {titleError && (
            <p className="text-sm text-destructive">{titleError}</p>
          )}
        </div>
        <div className="space-y-3">
          <Label>
            Description{" "}
            <span className="text-muted-foreground font-normal text-xs">
              (optional)
            </span>
          </Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-3">
          <Label>
            Replace File{" "}
            <span className="text-muted-foreground font-normal text-xs">
              (leave empty to keep existing)
            </span>
          </Label>
          {!file && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Current:</span>
              <span className="font-medium truncate">
                {editingDoc.file.name}
              </span>
            </div>
          )}
          <FileUploader value={file} onChange={setFile} maxSizeMB={2} />
        </div>
        <div className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Allow download</p>
              <p className="text-xs text-muted-foreground">
                Employees can download a copy
              </p>
            </div>
            <Switch
              checked={allowDownload}
              onCheckedChange={setAllowDownload}
            />
          </div>
          <div className="border-t pt-3 flex items-start gap-3">
            <Checkbox
              id="edit-ack"
              checked={requireAck}
              onCheckedChange={(v) => setRequireAck(!!v)}
              className="mt-0.5"
            />
            <label
              htmlFor="edit-ack"
              className="text-sm font-medium cursor-pointer"
            >
              Require acknowledgment
            </label>
          </div>
        </div>
      </div>
    </FormSheet>
  );
}

// ─── Multi-file add mode ────────────────────────────────────────────────────

interface AddProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  existingDocNames?: string[];
  onUpload: (
    files: {
      file: File;
      title: string;
      allowDownload: boolean;
      requireAck: boolean;
    }[],
    onItem?: (index: number, error?: string) => void,
  ) => Promise<{ title: string; error?: string }[]>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AddDocumentsDialog({
  open,
  onOpenChange,
  folderId: _folderId,
  existingDocNames = [],
  onUpload,
}: AddProps) {
  const confirm = useConfirm();
  const [entries, setEntries] = React.useState<
    (FileEntry & { allowDownload: boolean; requireAck: boolean })[]
  >([]);
  const [step, setStep] = React.useState<"select" | "uploading" | "done">(
    "select",
  );

  React.useEffect(() => {
    if (!open) {
      setEntries([]);
      setStep("select");
    }
  }, [open]);

  const multiInputRef = React.useRef<HTMLInputElement>(null);
  const acceptTypes = Array.from(ALLOWED_MIME_TYPES).join(",");

  function addFiles(files: FileList | File[]) {
    const newEntries: (FileEntry & {
      allowDownload: boolean;
      requireAck: boolean;
    })[] = [];
    for (const file of Array.from(files)) {
      if (
        entries.some((e) => e.file.name === file.name) ||
        newEntries.some((e) => e.file.name === file.name)
      )
        continue;
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      let status: FileStatus = "pending";
      let error: string | undefined;
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        status = "oversized";
        error = `File type .${ext} not allowed. Accepted: PDF, Word, Excel, CSV`;
      } else if (file.size > MAX_FILE_SIZE) {
        status = "oversized";
        error = `File too large (max ${formatBytes(MAX_FILE_SIZE)})`;
      } else if (
        existingDocNames.some(
          (n) => n.toLowerCase() === file.name.toLowerCase(),
        )
      ) {
        status = "oversized";
        error = "A file with this name already exists in this folder";
      }
      newEntries.push({
        file,
        title: fileTitle(file.name),
        status,
        error,
        // Download is opt-in — admin enables it per file when needed
        allowDownload: false,
        requireAck: false,
      });
    }
    if (newEntries.length > 0) setEntries((prev) => [...prev, ...newEntries]);
  }

  function removeEntry(idx: number) {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateTitle(idx: number, title: string) {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, title } : e)));
  }

  function updateEntryAccess(
    idx: number,
    patch: { allowDownload?: boolean; requireAck?: boolean },
  ) {
    setEntries((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)),
    );
  }

  function setAllDownload(val: boolean) {
    setEntries((prev) =>
      prev.map((e) =>
        e.status === "pending" ? { ...e, allowDownload: val } : e,
      ),
    );
  }

  function setAllAck(val: boolean) {
    setEntries((prev) =>
      prev.map((e) => (e.status === "pending" ? { ...e, requireAck: val } : e)),
    );
  }

  const uploadable = entries.filter((e) => e.status === "pending");
  const allDownload =
    uploadable.length > 0 && uploadable.every((e) => e.allowDownload);
  const allAck = uploadable.length > 0 && uploadable.every((e) => e.requireAck);

  async function handleUpload() {
    if (uploadable.length === 0) return;
    setStep("uploading");

    // Remember which entry each upload slot maps to, then flip them all to
    // "uploading" so the progress modal shows live per-file status.
    const uploadEntryIdx: number[] = [];
    entries.forEach((e, i) => {
      if (e.status === "pending") uploadEntryIdx.push(i);
    });
    setEntries((prev) =>
      prev.map((e) =>
        e.status === "pending"
          ? { ...e, status: "uploading" as FileStatus }
          : e,
      ),
    );

    const toUpload = uploadable.map((e) => ({
      file: e.file,
      title: e.title.trim() || fileTitle(e.file.name),
      allowDownload: e.allowDownload,
      requireAck: e.requireAck,
    }));

    const results = await onUpload(toUpload, (index, error) => {
      const entryIdx = uploadEntryIdx[index];
      setEntries((prev) =>
        prev.map((e, i) =>
          i === entryIdx
            ? {
                ...e,
                status: (error ? "failed" : "done") as FileStatus,
                error,
              }
            : e,
        ),
      );
    });

    // Safety net: resolve any entry the per-item callback missed
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.status !== "uploading") return entry;
        const result = results.find(
          (r) => r.title === (entry.title.trim() || fileTitle(entry.file.name)),
        );
        if (!result) return { ...entry, status: "done" as FileStatus };
        return result.error
          ? { ...entry, status: "failed" as FileStatus, error: result.error }
          : { ...entry, status: "done" as FileStatus };
      }),
    );
    setStep("done");
  }

  const doneCount = entries.filter((e) => e.status === "done").length;
  const failedCount = entries.filter((e) => e.status === "failed").length;

  // ── Select step ─────────────────────────────────────────────────────────

  if (step === "select") {
    const selectFooter = (
      <>
        <Button
          variant="outline"
          onClick={() => {
            if (entries.length === 0) {
              onOpenChange(false);
              return;
            }
            confirm({
              title: "Discard files?",
              description:
                "You have files selected. Are you sure you want to cancel?",
              confirmText: "Discard",
              onConfirm: async () => onOpenChange(false),
            });
          }}
        >
          Cancel
        </Button>
        <Button
          variant="soft"
          onClick={handleUpload}
          disabled={uploadable.length === 0}
        >
          Upload {uploadable.length}{" "}
          {uploadable.length === 1 ? "File" : "Files"}
        </Button>
      </>
    );

    const description =
      entries.length === 0
        ? "Select one or more files to upload to this folder."
        : `${entries.length} file${entries.length > 1 ? "s" : ""} selected · ${uploadable.length} ready to upload`;

    return (
      <FormSheet
        open={open}
        onOpenChange={onOpenChange}
        title="Add Documents"
        description={description}
        width={680}
        footer={selectFooter}
      >
        <div className="space-y-3">
          <input
            ref={multiInputRef}
            type="file"
            multiple
            accept={acceptTypes}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div
            className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-4 cursor-pointer hover:border-foreground/30 hover:bg-muted/30 transition-colors"
            onClick={() => multiInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              // stopPropagation: without it the drop bubbles up to the page
              // container's onDrop and uploads the same files directly.
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
            }}
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Click to browse or drag files here
            </p>
            <p className="text-[11px] text-muted-foreground">
              PDF, Word, Excel, CSV · Max {formatBytes(MAX_FILE_SIZE)} per file
            </p>
          </div>

          {entries.length > 0 && (
            <>
              <div className="flex items-center gap-4 rounded-lg border px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Set all:
                </span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={allDownload}
                    onCheckedChange={(v) => setAllDownload(!!v)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-xs font-medium">Allow download</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={allAck}
                    onCheckedChange={(v) => setAllAck(!!v)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-xs font-medium">
                    Require acknowledgement
                  </span>
                </label>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="grid grid-cols-[1fr_70px_70px_32px] gap-1 px-3 py-1.5 text-[10px] font-medium text-label uppercase tracking-wide bg-muted/30 border-b">
                  <span>File</span>
                  <span className="text-center">Download</span>
                  <span className="text-center">Acknowledge</span>
                  <span></span>
                </div>
                <div className="divide-y">
                  {entries.map((entry, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "grid grid-cols-[1fr_80px_100px_32px] gap-1 items-center px-3 py-2",
                        entry.status === "oversized" &&
                          "bg-red-50/50 dark:bg-red-950/10",
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {fileIcon(entry.file.name, "h-4 w-4 shrink-0")}
                        <div className="min-w-0 flex-1">
                          <Input
                            value={entry.title}
                            onChange={(e) => updateTitle(idx, e.target.value)}
                            className="h-7 text-xs"
                            disabled={entry.status === "oversized"}
                          />
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-muted-foreground truncate">
                              {entry.file.name} · {formatBytes(entry.file.size)}
                            </span>
                            {entry.error && (
                              <span className="text-[10px] text-destructive">
                                {entry.error}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-center">
                        <Checkbox
                          checked={entry.allowDownload}
                          onCheckedChange={(v) =>
                            updateEntryAccess(idx, { allowDownload: !!v })
                          }
                          className="h-3.5 w-3.5"
                          disabled={entry.status === "oversized"}
                        />
                      </div>
                      <div className="flex justify-center">
                        <Checkbox
                          checked={entry.requireAck}
                          onCheckedChange={(v) =>
                            updateEntryAccess(idx, { requireAck: !!v })
                          }
                          className="h-3.5 w-3.5"
                          disabled={entry.status === "oversized"}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0"
                        onClick={() => removeEntry(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </FormSheet>
    );
  }

  // ── Uploading / Done step — centered modal with live per-file progress ───

  const processedCount = entries.filter(
    (e) => e.status === "done" || e.status === "failed",
  ).length;
  const uploadingTotal = entries.filter(
    (e) => e.status !== "oversized",
  ).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Can't dismiss while files are still uploading
        if (step === "done") onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === "uploading" && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            {step === "done" && failedCount === 0 && (
              <Check className="h-5 w-5 text-success" />
            )}
            {step === "done" && failedCount > 0 && (
              <AlertTriangle className="h-5 w-5 text-warning" />
            )}
            {step === "uploading" ? "Uploading..." : "Upload Complete"}
          </DialogTitle>
          <DialogDescription>
            {step === "uploading"
              ? `${processedCount} of ${uploadingTotal} files processed`
              : `${doneCount} of ${uploadingTotal} files uploaded successfully`}
          </DialogDescription>
        </DialogHeader>

        {step === "uploading" && (
          <div className="h-2 rounded-full bg-muted overflow-hidden shrink-0">
            <div
              className="h-full bg-foreground/70 rounded-full transition-all duration-300"
              style={{
                width: `${uploadingTotal ? (processedCount / uploadingTotal) * 100 : 0}%`,
              }}
            />
          </div>
        )}

        {step === "done" && (
          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check className="h-3 w-3" /> {doneCount} succeeded
            </Badge>
            {failedCount > 0 && (
              <Badge
                variant="secondary"
                className="text-destructive border-destructive/30 gap-1"
              >
                <X className="h-3 w-3" /> {failedCount} failed
              </Badge>
            )}
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0 border rounded-lg">
          <div className="divide-y">
            {entries
              .filter((e) => e.status !== "oversized")
              .map((entry, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "flex items-start gap-2 px-3 py-1.5 text-xs",
                    entry.status === "failed" &&
                      "bg-red-50/40 dark:bg-red-950/10",
                  )}
                >
                  <span className="flex items-center gap-2 shrink-0 pt-0.5">
                    {entry.status === "done" && (
                      <Check className="h-3 w-3 text-success" />
                    )}
                    {entry.status === "failed" && (
                      <X className="h-3 w-3 text-destructive" />
                    )}
                    {entry.status === "uploading" && (
                      <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
                    )}
                    {entry.status === "pending" && (
                      <span className="block h-3 w-3 rounded-full border border-muted-foreground/30" />
                    )}
                    {fileIcon(entry.file.name, "h-3 w-3")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate",
                          entry.status === "failed" && "text-destructive",
                        )}
                      >
                        {entry.title || entry.file.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {formatBytes(entry.file.size)}
                      </span>
                    </div>
                    {entry.error && (
                      <p className="mt-0.5 text-[10px] text-destructive break-words">
                        {entry.error}
                      </p>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </ScrollArea>

        {step === "done" && (
          <DialogFooter className="shrink-0">
            <Button variant="soft" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Exported wrapper ───────────────────────────────────────────────────────

interface DocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  onSave: (doc: OrgDocument, file?: File | null) => void;
  onUploadMultiple?: (
    files: {
      file: File;
      title: string;
      allowDownload: boolean;
      requireAck: boolean;
    }[],
    onItem?: (index: number, error?: string) => void,
  ) => Promise<{ title: string; error?: string }[]>;
  editingDoc?: OrgDocument | null;
  existingDocNames?: string[];
}

export function DocumentDialog({
  open,
  onOpenChange,
  folderId,
  onSave,
  onUploadMultiple,
  editingDoc = null,
  existingDocNames = [],
}: DocumentDialogProps) {
  if (editingDoc) {
    return (
      <EditDocumentDialog
        open={open}
        onOpenChange={onOpenChange}
        folderId={folderId}
        editingDoc={editingDoc}
        onSave={onSave}
      />
    );
  }

  if (onUploadMultiple) {
    return (
      <AddDocumentsDialog
        open={open}
        onOpenChange={onOpenChange}
        folderId={folderId}
        existingDocNames={existingDocNames}
        onUpload={onUploadMultiple}
      />
    );
  }

  return null;
}
