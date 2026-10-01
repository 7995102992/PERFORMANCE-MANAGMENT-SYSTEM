import * as React from "react";
import {
  Upload,
  FolderOpen,
  Check,
  Loader2,
  X,
  AlertTriangle,
  FileText,
  FileSpreadsheet,
  File,
  Info,
  ChevronDown,
  ChevronRight,
  Users,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { FormSheet } from "@/components/shared/FormSheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAppSelector } from "@/store";
import { useBusinessUnits } from "@/hooks/queries/use-business-unit";
import { useDepartments } from "@/hooks/queries/use-departments";
import type { DepartmentResponseDTO } from "@/api/org-setup/types";
import { assetService } from "@/api/assets";
import { foldersService, orgDocumentsService } from "@/api/org-setup";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/api/query-keys";
import type { DocumentFolder } from "@/modules/org-setup/types/org-documents";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DroppedEntry {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder";
  file?: File;
  children: DroppedEntry[];
  targetFolderId: string;
}

type FileStatus = "pending" | "uploading" | "done" | "failed" | "duplicate";

interface FileItem {
  file: File;
  allowDownload: boolean;
  requireAck: boolean;
  status: FileStatus;
  error?: string;
}

interface FolderRow {
  name: string;
  items: FileItem[];
  access: "all" | "restricted";
  businessUnits: string[];
  departments: string[];
  workerTypes: string[];
  expanded: boolean;
  isDuplicate: boolean;
  isExisting: boolean;
  /** Row built from loose files (dropped without a folder) — user must pick a destination */
  isLooseFiles: boolean;
  /** Destination for loose files: existing folder id, NEW_FOLDER, or "" (not chosen yet) */
  targetFolderId: string;
}

/** Sentinel for the "create a new folder" destination choice */
const NEW_FOLDER = "__new__";

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

const WORKER_TYPE_OPTIONS = [
  { label: "Full-Time", value: "full-time" },
  { label: "Contract", value: "contract" },
  { label: "Internship", value: "internship" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

let entryIdCounter = 0;
function genId() {
  return `drop-${Date.now()}-${++entryIdCounter}`;
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fIcon(name: string, cls?: string) {
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

function getExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// ─── Read dropped entries ───────────────────────────────────────────────────

async function readEntry(
  entry: FileSystemEntry,
  pp: string,
): Promise<DroppedEntry> {
  if (entry.isFile) {
    const f = entry as FileSystemFileEntry;
    const file = await new Promise<File>((r, j) => f.file(r, j));
    return {
      id: genId(),
      name: entry.name,
      path: pp ? `${pp}/${entry.name}` : entry.name,
      type: "file",
      file,
      children: [],
      targetFolderId: "",
    };
  }
  const d = entry as FileSystemDirectoryEntry,
    reader = d.createReader(),
    entries: FileSystemEntry[] = [];
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((r, j) =>
      reader.readEntries(r, j),
    );
    entries.push(...batch);
  } while (batch.length > 0);
  const p = pp ? `${pp}/${entry.name}` : entry.name;
  return {
    id: genId(),
    name: entry.name,
    path: p,
    type: "folder",
    children: await Promise.all(entries.map((e) => readEntry(e, p))),
    targetFolderId: "",
  };
}

// eslint-disable-next-line react-refresh/only-export-components
export async function readDroppedItems(
  dt: DataTransfer,
): Promise<DroppedEntry[]> {
  const items = Array.from(dt.items),
    entries: FileSystemEntry[] = [];
  for (const item of items) {
    const e = item.webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length > 0)
    return Promise.all(entries.map((e) => readEntry(e, "")));
  return Array.from(dt.files).map((file) => ({
    id: genId(),
    name: file.name,
    path: file.name,
    type: "file" as const,
    file,
    children: [],
    targetFolderId: "",
  }));
}

// ─── Build rows with validation ─────────────────────────────────────────────

function buildRows(
  entries: DroppedEntry[],
  existingFolders: DocumentFolder[],
): FolderRow[] {
  const rows: FolderRow[] = [];
  const seenFolderNames = new Set<string>();
  const existingNames = new Set(
    existingFolders.map((f) => f.name.toLowerCase()),
  );

  function walk(items: DroppedEntry[]) {
    for (const item of items) {
      if (item.type !== "folder") continue;
      const directFiles = item.children.filter(
        (c) => c.type === "file" && c.file,
      );
      if (directFiles.length > 0) {
        const nameLower = item.name.toLowerCase();
        const isDuplicate = seenFolderNames.has(nameLower);
        seenFolderNames.add(nameLower);

        const seenFileNames = new Set<string>();
        const fileItems: FileItem[] = directFiles.map((c) => {
          const titleLower = fileTitle(c.file!.name).toLowerCase();
          const ext = getExtension(c.file!.name);
          let status: FileStatus = "pending";
          let error: string | undefined;

          if (seenFileNames.has(titleLower)) {
            status = "duplicate";
            error = "Duplicate file name in this folder";
          } else if (c.file!.size > MAX_FILE_SIZE) {
            status = "failed";
            error = `File too large (max ${formatBytes(MAX_FILE_SIZE)})`;
          } else if (!ALLOWED_EXTENSIONS.has(ext)) {
            status = "failed";
            error = `File type .${ext} not allowed`;
          }
          seenFileNames.add(titleLower);

          return {
            file: c.file!,
            allowDownload: false,
            requireAck: false,
            status,
            error,
          };
        });

        rows.push({
          name: item.name,
          items: fileItems,
          access: "all",
          businessUnits: [],
          departments: [],
          workerTypes: [],
          expanded: true,
          isDuplicate,
          isExisting: existingNames.has(nameLower),
          isLooseFiles: false,
          targetFolderId: "",
        });
      }
      walk(item.children);
    }
  }
  walk(entries);

  const rootFiles = entries.filter((e) => e.type === "file" && e.file);
  if (rootFiles.length > 0) {
    const seenFileNames = new Set<string>();
    rows.push({
      name: "Uploaded Files",
      items: rootFiles.map((e) => {
        const titleLower = fileTitle(e.file!.name).toLowerCase();
        const ext = getExtension(e.file!.name);
        let status: FileStatus = "pending";
        let error: string | undefined;
        if (seenFileNames.has(titleLower)) {
          status = "duplicate";
          error = "Duplicate file name";
        } else if (e.file!.size > MAX_FILE_SIZE) {
          status = "failed";
          error = `File too large (max ${formatBytes(MAX_FILE_SIZE)})`;
        } else if (!ALLOWED_EXTENSIONS.has(ext)) {
          status = "failed";
          error = `File type .${ext} not allowed`;
        }
        seenFileNames.add(titleLower);
        return {
          file: e.file!,
          allowDownload: false,
          requireAck: false,
          status,
          error,
        };
      }),
      access: "all",
      businessUnits: [],
      departments: [],
      workerTypes: [],
      // Expanded so the destination picker is immediately visible
      expanded: true,
      isDuplicate: false,
      isExisting: false,
      isLooseFiles: true,
      // With existing folders the user must choose where these files go;
      // with none, default straight to creating a new folder.
      targetFolderId:
        existingFolders.filter((f) => f.isActive).length > 0 ? "" : NEW_FOLDER,
    });
  }
  return rows;
}

// ─── Tree preview ───────────────────────────────────────────────────────────

function TreeNode({
  entry,
  depth = 0,
}: {
  entry: DroppedEntry;
  depth?: number;
}) {
  const [open, setOpen] = React.useState(depth < 2);
  const isFolder = entry.type === "folder";
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 text-sm",
          isFolder && "cursor-pointer",
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => isFolder && setOpen(!open)}
      >
        {isFolder ? (
          <>
            {open ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {fIcon(entry.name, "h-3.5 w-3.5 shrink-0")}
          </>
        )}
        <span className="truncate text-xs">{entry.name}</span>
        {entry.file && (
          <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
            {formatBytes(entry.file.size)}
          </span>
        )}
      </div>
      {isFolder &&
        open &&
        entry.children.map((c) => (
          <TreeNode key={c.id} entry={c} depth={depth + 1} />
        ))}
    </div>
  );
}

// ─── Status icon ────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: FileStatus }) {
  switch (status) {
    case "done":
      return <Check className="h-3 w-3 text-green-600" />;
    case "failed":
      return <X className="h-3 w-3 text-red-500" />;
    case "duplicate":
      return <AlertTriangle className="h-3 w-3 text-amber-500" />;
    case "uploading":
      return <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />;
    default:
      return (
        <span className="h-3 w-3 rounded-full border border-muted-foreground/30" />
      );
  }
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  droppedEntries: DroppedEntry[];
  existingFolders: DocumentFolder[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDone: (results: {
    newFolders: DocumentFolder[];
    newDocuments: any[];
  }) => void;
}

type Step = "review" | "uploading" | "done";

export function DropUploadDialog({
  open,
  onOpenChange,
  droppedEntries,
  existingFolders,
  onDone,
}: Props) {
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const orgId = savedOrg?.id ?? "";
  const qc = useQueryClient();

  const { data: remoteBUs = [] } = useBusinessUnits(savedOrg?.id, {
    is_active: true,
  });
  const { data: allDepts = [] } = useDepartments(savedOrg?.id, {
    limit: 100,
    is_active: true,
  });
  const buOptions = remoteBUs.map((bu) => ({
    label: bu.business_unit_name,
    value: bu.id,
  }));
  const buNameMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const bu of remoteBUs) map[bu.id] = bu.business_unit_name;
    return map;
  }, [remoteBUs]);

  function getDeptOptions(selectedBuIds: string[]) {
    if (selectedBuIds.length === 0) return [];
    const buSet = new Set(selectedBuIds);
    return allDepts
      .filter((d: DepartmentResponseDTO) =>
        (d.businessUnits ?? []).some((buId: string) => buSet.has(buId)),
      )
      .map((d: DepartmentResponseDTO) => {
        const buNames = (d.businessUnits ?? [])
          .filter((id: string) => buSet.has(id))
          .map((id: string) => buNameMap[id])
          .filter(Boolean)
          .join(", ");
        return {
          label: d.departmentName,
          value: d.id,
          description: buNames || undefined,
        };
      });
  }

  const [step, setStep] = React.useState<Step>("review");
  const [rows, setRows] = React.useState<FolderRow[]>([]);
  // Upload-progress snapshot (see handleUpload)
  const [uploadTotal, setUploadTotal] = React.useState(0);
  const preFailedRef = React.useRef(0);

  // Single-BU org → the per-row BU picker is locked; auto-fill every row with
  // the only BU so the disabled picker is never left empty.
  const singleBuMode = !savedOrg?.is_multiple_business_units;
  React.useEffect(() => {
    if (buOptions.length !== 1) return;
    const onlyBu = buOptions[0].value;
    setRows((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        if (r.businessUnits.length > 0) return r;
        changed = true;
        return { ...r, businessUnits: [onlyBu] };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buOptions, rows.length]);

  React.useEffect(() => {
    if (!open || droppedEntries.length === 0) return;
    setStep("review");
    setRows(buildRows(droppedEntries, existingFolders));
    // Re-init only when the dialog opens — the entries are set before opening.
    // Rebuilding mid-flow would reset file statuses back to "pending" and
    // resurrect the Upload button after an upload already ran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function updateRow(idx: number, patch: Partial<FolderRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function updateFileItem(
    rowIdx: number,
    fileIdx: number,
    patch: Partial<FileItem>,
  ) {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        return {
          ...r,
          items: r.items.map((it, fi) =>
            fi === fileIdx ? { ...it, ...patch } : it,
          ),
        };
      }),
    );
  }

  function setAllDownload(rowIdx: number, val: boolean) {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        return {
          ...r,
          items: r.items.map((it) => ({ ...it, allowDownload: val })),
        };
      }),
    );
  }

  function setAllAck(rowIdx: number, val: boolean) {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        return {
          ...r,
          items: r.items.map((it) => ({ ...it, requireAck: val })),
        };
      }),
    );
  }

  const uploadableFiles = rows.flatMap((r) =>
    r.items.filter((it) => it.status === "pending"),
  );
  const activeExistingFolders = existingFolders.filter((f) => f.isActive);
  // A loose-files row with uploadable files must have a destination: an
  // existing folder, or "new folder" with a non-empty name.
  const looseNeedsTarget = rows.some(
    (r) =>
      r.isLooseFiles &&
      r.items.some((it) => it.status === "pending") &&
      (r.targetFolderId === "" ||
        (r.targetFolderId === NEW_FOLDER && !r.name.trim())),
  );
  const totalFiles = rows.reduce((s, r) => s + r.items.length, 0);
  const invalidCount = rows.reduce(
    (s, r) =>
      s +
      r.items.filter(
        (it) => it.status === "failed" || it.status === "duplicate",
      ).length,
    0,
  );
  const skippedCount = invalidCount;

  // ── Upload ──────────────────────────────────────────────────────────────

  async function handleUpload() {
    if (!orgId) return;
    // Snapshot totals before statuses start mutating — pending count shrinks
    // as files complete, and pre-invalid files already sit in "failed".
    setUploadTotal(uploadableFiles.length);
    preFailedRef.current = rows.reduce(
      (s, r) => s + r.items.filter((it) => it.status === "failed").length,
      0,
    );
    setStep("uploading");

    // Folders created during THIS run — a second row with the same name
    // (duplicate folder in the drop) must reuse it, not 409 on re-create.
    const createdByName = new Map<string, string>();

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];

      // Nothing uploadable in this row — never create/resolve a folder for it
      if (!row.items.some((it) => it.status === "pending")) continue;

      let folderId: string;
      if (
        row.isLooseFiles &&
        row.targetFolderId &&
        row.targetFolderId !== NEW_FOLDER
      ) {
        // Loose files → user-picked existing folder
        folderId = row.targetFolderId;
      } else {
        const rowName = row.name.trim();
        const nameKey = rowName.toLowerCase();
        const existing = existingFolders.find(
          (f) => f.name.toLowerCase() === nameKey,
        );
        const createdEarlier = createdByName.get(nameKey);
        if (existing) {
          folderId = existing.id;
        } else if (createdEarlier) {
          folderId = createdEarlier;
        } else {
          try {
            const created = await foldersService.create({
              name: rowName,
              custom_access: row.access === "restricted",
              access:
                row.access === "restricted"
                  ? {
                      business_units: row.businessUnits,
                      departments: row.departments,
                      worker_types: row.workerTypes,
                    }
                  : undefined,
            });
            folderId = created.id;
            createdByName.set(nameKey, created.id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (err: any) {
            for (let fi = 0; fi < row.items.length; fi++) {
              if (row.items[fi].status === "pending") {
                updateFileItem(ri, fi, {
                  status: "failed",
                  error: `Folder creation failed: ${err?.response?.data?.detail ?? err.message}`,
                });
              }
            }
            continue;
          }
        }
      }

      for (let fi = 0; fi < row.items.length; fi++) {
        const item = row.items[fi];
        if (item.status !== "pending") continue;

        updateFileItem(ri, fi, { status: "uploading" });
        try {
          const asset = await assetService.upload(item.file, "org-documents");
          await orgDocumentsService.create({
            folder_id: folderId,
            title: fileTitle(item.file.name),
            asset_id: asset.id,
            allow_download: item.allowDownload,
            require_acknowledgement: item.requireAck,
          });
          updateFileItem(ri, fi, { status: "done" });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          const detail =
            err?.response?.data?.detail ?? err.message ?? "Upload failed";
          updateFileItem(ri, fi, { status: "failed", error: detail });
        }
      }
    }

    qc.invalidateQueries({ queryKey: queryKeys.folders.all });
    qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all });
    setStep("done");
  }

  // ── Review step ─────────────────────────────────────────────────────────

  if (step === "review") {
    const reviewFooter = (
      <>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="soft"
          onClick={handleUpload}
          disabled={uploadableFiles.length === 0 || looseNeedsTarget}
        >
          <Upload />
          Upload {uploadableFiles.length}{" "}
          {uploadableFiles.length === 1 ? "File" : "Files"}
          {invalidCount > 0 && (
            <span className="ml-1 text-xs opacity-70">
              ({invalidCount} invalid)
            </span>
          )}
        </Button>
      </>
    );

    const reviewDescription = (
      <>
        {rows.length} {rows.length === 1 ? "folder" : "folders"} · {totalFiles}{" "}
        {totalFiles === 1 ? "file" : "files"}
        {invalidCount > 0 && (
          <span className="text-amber-600"> · {invalidCount} invalid</span>
        )}
      </>
    );

    return (
      <FormSheet
        open={open}
        onOpenChange={onOpenChange}
        title="Upload Files"
        description={reviewDescription}
        width="min(95vw, 1200px)"
        footer={reviewFooter}
        bodyClassName="!p-0 flex flex-col min-h-0 overflow-hidden"
      >
        <div className="flex flex-col gap-3 px-6 py-4 flex-1 min-h-0 overflow-hidden">
          {invalidCount > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning flex items-center gap-2 shrink-0">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {invalidCount} file{invalidCount > 1 ? "s" : ""} invalid
              (duplicates, too large, or unsupported type). Expand folders to
              see details.
            </div>
          )}

          {looseNeedsTarget && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning flex items-center gap-2 shrink-0">
              <Info className="h-4 w-4 shrink-0" />
              Choose a destination folder for the dropped files — pick an
              existing folder or create a new one.
            </div>
          )}

          {/* Two-column layout */}
          <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
            {/* LEFT — Tree preview */}
            <div className="w-[280px] shrink-0 rounded-lg border bg-muted/20 flex flex-col overflow-hidden">
              <p className="text-xs font-medium text-label px-3 py-2 border-b uppercase tracking-wide">
                Structure
              </p>
              <ScrollArea className="flex-1">
                <div className="p-2">
                  {droppedEntries.map((e) => (
                    <TreeNode key={e.id} entry={e} />
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* RIGHT — Folder settings */}
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <p className="text-xs font-medium text-label mb-2 uppercase tracking-wide shrink-0">
                Folder Settings
              </p>
              <ScrollArea className="flex-1">
                <div className="space-y-3 pr-2">
                  {rows.map((row, idx) => {
                    const allDownload = row.items.every(
                      (it) => it.allowDownload,
                    );
                    const allAck = row.items.every((it) => it.requireAck);
                    const validCount = row.items.filter(
                      (it) => it.status === "pending",
                    ).length;
                    const invalidFileCount = row.items.filter(
                      (it) => it.status !== "pending",
                    ).length;
                    const totalSize = row.items.reduce(
                      (s, it) => s + it.file.size,
                      0,
                    );
                    // Loose files headed into an existing folder → show its name
                    const looseDestName =
                      row.isLooseFiles &&
                      row.targetFolderId &&
                      row.targetFolderId !== NEW_FOLDER
                        ? activeExistingFolders.find(
                            (f) => f.id === row.targetFolderId,
                          )?.name
                        : null;

                    return (
                      <div
                        key={idx}
                        className={cn(
                          "rounded-lg border overflow-hidden",
                          (row.isDuplicate || row.isExisting) &&
                            "border-amber-300",
                        )}
                      >
                        {/* Header */}
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                          onClick={() =>
                            updateRow(idx, { expanded: !row.expanded })
                          }
                        >
                          {row.expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <FolderOpen className="h-5 w-5 text-amber-500 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-semibold truncate block">
                              {looseDestName ?? row.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {row.items.length} file
                              {row.items.length !== 1 ? "s" : ""} ·{" "}
                              {formatBytes(totalSize)}
                            </span>
                          </div>
                          {row.isLooseFiles && row.targetFolderId === "" && (
                            <Badge className="bg-amber-100 text-amber-700 text-[10px] h-5 px-1.5">
                              Choose destination folder
                            </Badge>
                          )}
                          {row.isLooseFiles && looseDestName && (
                            <Badge className="bg-blue-100 text-blue-700 text-[10px] h-5 px-1.5">
                              Adding to existing folder
                            </Badge>
                          )}
                          {row.isExisting && (
                            <Badge className="bg-blue-100 text-blue-700 text-[10px] h-5 px-1.5">
                              Folder already exists — files will be added
                            </Badge>
                          )}
                          {row.isDuplicate && (
                            <Badge className="bg-amber-100 text-amber-700 text-[10px] h-5 px-1.5">
                              Duplicate folder in upload
                            </Badge>
                          )}
                          <div className="flex items-center gap-2 shrink-0">
                            {validCount > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] h-5 px-1.5 text-green-600 border-green-300"
                              >
                                {validCount} valid
                              </Badge>
                            )}
                            {invalidFileCount > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] h-5 px-1.5 text-red-600 border-red-300"
                              >
                                {invalidFileCount} invalid
                              </Badge>
                            )}
                          </div>
                          {row.access === "restricted" ? (
                            <Lock className="h-4 w-4 text-amber-600 shrink-0" />
                          ) : (
                            <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                        </button>

                        {row.expanded && (
                          <div className="border-t">
                            {/* Settings bar */}
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 bg-muted/20 border-b">
                              {row.isLooseFiles && (
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[11px] text-muted-foreground">
                                    Upload to:
                                  </span>
                                  <Select
                                    value={row.targetFolderId || undefined}
                                    onValueChange={(v) =>
                                      updateRow(idx, { targetFolderId: v })
                                    }
                                  >
                                    <SelectTrigger className="h-6 w-[180px] text-[11px]">
                                      <SelectValue placeholder="Select folder..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {activeExistingFolders.map((f) => (
                                        <SelectItem key={f.id} value={f.id}>
                                          <span className="flex items-center gap-1">
                                            <FolderOpen className="h-3 w-3" />{" "}
                                            {f.name}
                                          </span>
                                        </SelectItem>
                                      ))}
                                      <SelectItem value={NEW_FOLDER}>
                                        + Create new folder
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                  {row.targetFolderId === NEW_FOLDER && (
                                    <Input
                                      value={row.name}
                                      onChange={(e) =>
                                        updateRow(idx, {
                                          name: e.target.value,
                                        })
                                      }
                                      placeholder="New folder name"
                                      className="h-6 w-[170px] text-[11px]"
                                    />
                                  )}
                                </div>
                              )}
                              {/* Access applies only to folders being created —
                                  an existing destination keeps its own access */}
                              {(!row.isLooseFiles ||
                                row.targetFolderId === NEW_FOLDER) && (
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] text-muted-foreground">
                                  Access:
                                </span>
                                <Select
                                  value={row.access}
                                  onValueChange={(v) =>
                                    updateRow(idx, {
                                      access: v as "all" | "restricted",
                                    })
                                  }
                                >
                                  <SelectTrigger className="h-6 w-[120px] text-[11px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="all">
                                      <span className="flex items-center gap-1">
                                        <Users className="h-3 w-3" /> All
                                      </span>
                                    </SelectItem>
                                    <SelectItem value="restricted">
                                      <span className="flex items-center gap-1">
                                        <Lock className="h-3 w-3" /> Restricted
                                      </span>
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              )}
                              <label className="flex items-center gap-1 cursor-pointer">
                                <Checkbox
                                  checked={allDownload}
                                  onCheckedChange={(v) =>
                                    setAllDownload(idx, !!v)
                                  }
                                  className="h-3 w-3"
                                />
                                <span className="text-[11px]">
                                  All Download
                                </span>
                              </label>
                              <label
                                className="flex items-center gap-1 cursor-pointer"
                                title="Employees must acknowledge they have read these documents"
                              >
                                <Checkbox
                                  checked={allAck}
                                  onCheckedChange={(v) => setAllAck(idx, !!v)}
                                  className="h-3 w-3"
                                />
                                <span className="text-[11px]">
                                  All Acknowledge
                                </span>
                                <Info className="h-3 w-3 text-muted-foreground" />
                              </label>
                            </div>

                            {/* Restricted selectors — only for folders being created */}
                            {row.access === "restricted" &&
                              (!row.isLooseFiles ||
                                row.targetFolderId === NEW_FOLDER) && (
                              <div className="px-3 py-2.5 space-y-3 bg-muted/10 border-b">
                                <div className="space-y-1">
                                  <Label className="text-[11px]">
                                    Business Units{" "}
                                    <span className="text-destructive">*</span>
                                  </Label>
                                  <SearchableSelect
                                    multi
                                    options={buOptions}
                                    value={row.businessUnits}
                                    onChange={(v) =>
                                      updateRow(idx, {
                                        businessUnits: v,
                                        departments: [],
                                      })
                                    }
                                    placeholder="Select..."
                                    disabled={singleBuMode}
                                  />
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="space-y-1">
                                    <Label className="text-[11px]">
                                      Departments{" "}
                                      <span className="text-destructive">
                                        *
                                      </span>
                                    </Label>
                                    <SearchableSelect
                                      multi
                                      options={getDeptOptions(
                                        row.businessUnits,
                                      )}
                                      value={row.departments}
                                      onChange={(v) =>
                                        updateRow(idx, { departments: v })
                                      }
                                      placeholder={
                                        row.businessUnits.length === 0
                                          ? "Select BUs first..."
                                          : "Select..."
                                      }
                                      disabled={row.businessUnits.length === 0}
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-[11px]">
                                      Worker Types{" "}
                                      <span className="text-destructive">
                                        *
                                      </span>
                                    </Label>
                                    <SearchableSelect
                                      multi
                                      options={WORKER_TYPE_OPTIONS}
                                      value={row.workerTypes}
                                      onChange={(v) =>
                                        updateRow(idx, { workerTypes: v })
                                      }
                                      placeholder="Select..."
                                    />
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* File table */}
                            <div>
                              <div className="grid grid-cols-[20px_1fr_50px_50px] gap-1 px-3 py-1 text-[10px] font-medium text-label uppercase tracking-wide bg-muted/30 border-b">
                                <span></span>
                                <span>File</span>
                                <span className="text-center">Download</span>
                                <span
                                  className="text-center flex items-center justify-center gap-0.5"
                                  title="Employees must acknowledge they have read this document"
                                >
                                  Ack <Info className="h-2.5 w-2.5" />
                                </span>
                              </div>
                              <ScrollArea className="max-h-[250px]">
                                {row.items.map((item, fi) => (
                                  <div
                                    key={fi}
                                    className={cn(
                                      "grid grid-cols-[20px_1fr_70px_70px] gap-1 items-center px-3 py-1 border-b last:border-b-0",
                                      item.status === "failed" &&
                                        "bg-red-50/50 dark:bg-red-950/10",
                                      item.status === "duplicate" &&
                                        "bg-amber-50/50 dark:bg-amber-950/10",
                                    )}
                                  >
                                    <StatusIcon status={item.status} />
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      {fIcon(
                                        item.file.name,
                                        "h-3 w-3 shrink-0",
                                      )}
                                      <span
                                        className={cn(
                                          "text-[11px] truncate",
                                          item.status !== "pending" &&
                                            "text-muted-foreground line-through",
                                        )}
                                      >
                                        {item.file.name}
                                      </span>
                                      <span className="text-[9px] text-muted-foreground shrink-0 ml-auto">
                                        {formatBytes(item.file.size)}
                                      </span>
                                      {item.error && (
                                        <span className="text-[9px] text-destructive shrink-0 ml-1">
                                          {item.error}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex justify-center">
                                      <Checkbox
                                        checked={item.allowDownload}
                                        onCheckedChange={(v) =>
                                          updateFileItem(idx, fi, {
                                            allowDownload: !!v,
                                          })
                                        }
                                        className="h-3 w-3"
                                        disabled={item.status !== "pending"}
                                      />
                                    </div>
                                    <div className="flex justify-center">
                                      <Checkbox
                                        checked={item.requireAck}
                                        onCheckedChange={(v) =>
                                          updateFileItem(idx, fi, {
                                            requireAck: !!v,
                                          })
                                        }
                                        className="h-3 w-3"
                                        disabled={item.status !== "pending"}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </ScrollArea>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      </FormSheet>
    );
  }

  // ── Uploading step (live per-file progress) ─────────────────────────────

  if (step === "uploading") {
    const doneOrFailed = rows.reduce(
      (s, r) =>
        s +
        r.items.filter((it) => it.status === "done" || it.status === "failed")
          .length,
      0,
    );
    // Exclude files that were already invalid before the upload started
    const currentDone = Math.max(0, doneOrFailed - preFailedRef.current);
    const currentUploading = rows
      .flatMap((r) => r.items)
      .find((it) => it.status === "uploading");
    const pct = uploadTotal
      ? Math.round((currentDone / uploadTotal) * 100)
      : 0;

    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              Uploading...
            </DialogTitle>
            <DialogDescription>
              {currentDone} of {uploadTotal} files processed
            </DialogDescription>
          </DialogHeader>

          <div className="h-2 rounded-full bg-muted overflow-hidden shrink-0">
            <div
              className="h-full bg-foreground/70 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>

          {currentUploading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              Uploading: {currentUploading.file.name}
            </div>
          )}

          <ScrollArea className="flex-1 min-h-0 border rounded-lg">
            <div className="divide-y">
              {rows.flatMap((row, ri) =>
                row.items.map((item, fi) => (
                  <div
                    key={`${ri}-${fi}`}
                    className="flex items-start gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="shrink-0 pt-0.5">
                      <StatusIcon status={item.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate",
                          item.status === "failed" && "text-destructive",
                        )}
                      >
                        {item.file.name}
                      </span>
                      {item.error && (
                        <p className="text-[10px] text-destructive break-words">
                          {item.error}
                        </p>
                      )}
                    </div>
                  </div>
                )),
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Done step ───────────────────────────────────────────────────────────

  const finalDone = rows.reduce(
    (s, r) => s + r.items.filter((it) => it.status === "done").length,
    0,
  );
  const failedNow = rows.reduce(
    (s, r) => s + r.items.filter((it) => it.status === "failed").length,
    0,
  );
  const duplicateNow = rows.reduce(
    (s, r) => s + r.items.filter((it) => it.status === "duplicate").length,
    0,
  );
  // Runtime upload failures vs files never attempted (invalid before upload)
  const finalFailed = Math.max(0, failedNow - preFailedRef.current);
  const finalSkipped = preFailedRef.current + duplicateNow;
  const allItems = rows.flatMap((r) => r.items);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {finalFailed === 0 && finalSkipped === 0 ? (
              <Check className="h-5 w-5 text-green-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            )}
            Upload Complete
          </DialogTitle>
          <DialogDescription>
            {finalDone} of {totalFiles} files uploaded successfully
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 shrink-0">
          {finalDone > 0 && (
            <Badge
              variant="secondary"
              className="text-success border-success/30 gap-1"
            >
              <Check className="h-3 w-3" /> {finalDone} succeeded
            </Badge>
          )}
          {finalFailed > 0 && (
            <Badge
              variant="secondary"
              className="text-destructive border-destructive/30 gap-1"
            >
              <X className="h-3 w-3" /> {finalFailed} failed
            </Badge>
          )}
          {finalSkipped > 0 && (
            <Badge
              variant="secondary"
              className="text-warning border-warning/30 gap-1"
            >
              <AlertTriangle className="h-3 w-3" /> {finalSkipped} skipped
            </Badge>
          )}
        </div>

        <ScrollArea className="flex-1 min-h-0 border rounded-lg">
          <div className="divide-y">
            {allItems.map((item, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-3 px-4 py-2.5 text-sm",
                  (item.status === "failed" || item.status === "duplicate") &&
                    "bg-red-50/40 dark:bg-red-950/10",
                )}
              >
                <span className="flex items-center gap-3 shrink-0 pt-0.5">
                  {item.status === "done" && (
                    <Check className="h-4 w-4 text-green-600" />
                  )}
                  {(item.status === "failed" ||
                    item.status === "duplicate") && (
                    <X className="h-4 w-4 text-red-500" />
                  )}
                  {item.status === "pending" && (
                    <span className="block h-4 w-4 rounded-full border border-muted-foreground/30" />
                  )}
                  {fIcon(item.file.name, "h-4 w-4")}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "truncate",
                        (item.status === "failed" ||
                          item.status === "duplicate") &&
                          "text-destructive",
                      )}
                    >
                      {item.file.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatBytes(item.file.size)}
                    </span>
                  </div>
                  {item.error && (
                    <p className="mt-0.5 text-xs text-destructive break-words">
                      {item.error}
                    </p>
                  )}
                </div>
                {item.status === "done" && (
                  <Badge
                    variant="outline"
                    className="text-[11px] text-green-600 border-green-300 bg-green-50 shrink-0"
                  >
                    Uploaded
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="soft"
            onClick={() => {
              onDone({ newFolders: [], newDocuments: [] });
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
