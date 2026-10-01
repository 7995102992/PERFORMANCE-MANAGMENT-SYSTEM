import * as React from "react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import {
  FolderOpen,
  FolderPlus,
  Search,
  MoreVertical,
  Plus,
  FileText,
  FileSpreadsheet,
  File,
  Download,
  Pencil,
  Trash2,
  Users,
  Lock,
  FilePlus,
  Upload,
  ChevronLeft,
  Loader2,
  Check,
  X,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { PageLoader } from "@/components/shared/PageLoader";
import { SearchableSelect } from "@/components/shared/SearchableSelect";

const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];
import { FolderDialog } from "./FolderDialog";
import { DocumentDialog } from "./DocumentDialog";
import { DocumentViewSheet } from "./DocumentViewSheet";
import {
  DropUploadDialog,
  readDroppedItems,
  type DroppedEntry,
} from "./DropUploadDialog";

/** Recursively extract all File objects from a DroppedEntry tree */
function flattenFiles(entries: DroppedEntry[]): File[] {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.file) {
      files.push(entry.file);
    }
    if (entry.children.length > 0) {
      files.push(...flattenFiles(entry.children));
    }
  }
  return files;
}
import { useAppSelector } from "@/store";
import {
  useFolders,
  useCreateFolder,
  useUpdateFolder,
  useOrgDocuments,
  useUploadAndCreateDocument,
  useUpdateOrgDocument,
  useDeleteOrgDocument,
  useDeactivateAllDocuments,
} from "@/hooks/queries/use-org-documents";
import type { FolderResponseDTO } from "@/api/org-setup/types";
import type {
  DocumentFolder,
  OrgDocument,
} from "@/modules/org-setup/types/org-documents";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  if (mimeType.includes("pdf"))
    return <FileText className={cn("text-destructive/70", className)} />;
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType.includes("csv")
  )
    return <FileSpreadsheet className={cn("text-success/80", className)} />;
  if (mimeType.includes("word") || mimeType.includes("document"))
    return <FileText className={cn("text-muted-foreground", className)} />;
  return <File className={cn("text-muted-foreground", className)} />;
}

function mapFolder(f: FolderResponseDTO): DocumentFolder {
  return {
    id: f.id,
    name: f.name,
    description: f.description ?? "",
    customAccess: f.custom_access,
    access: {
      businessUnits: f.access?.business_units ?? [],
      departments: f.access?.departments ?? [],
      workerTypes: f.access?.worker_types ?? [],
    },
    isActive: f.is_active,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OrgDocumentsPage() {
  const confirm = useConfirm();
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const orgId = savedOrg?.id;

  const { data: remoteFolders = [], isLoading: foldersLoading } =
    useFolders(orgId);
  const folders = remoteFolders.map(mapFolder);

  const [selectedFolderId, setSelectedFolderId] = React.useState<string | null>(
    null,
  );
  const [folderSearch, setFolderSearch] = React.useState("");
  const [docSearch, setDocSearch] = React.useState("");

  // Clear the document search when moving between folders
  React.useEffect(() => {
    setDocSearch("");
  }, [selectedFolderId]);
  const [statusFilter, setStatusFilter] = React.useState<
    "all" | "active" | "inactive"
  >("all");

  const { data: remoteDocs = [], isLoading: docsLoading } = useOrgDocuments(
    selectedFolderId ?? undefined,
  );

  const createFolder = useCreateFolder();
  const updateFolder = useUpdateFolder();
  const deactivateAllDocsMut = useDeactivateAllDocuments();
  const uploadAndCreateDoc = useUploadAndCreateDocument();
  const updateDoc = useUpdateOrgDocument();
  const deleteDocMut = useDeleteOrgDocument();

  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false);
  const [editingFolder, setEditingFolder] =
    React.useState<DocumentFolder | null>(null);
  const [docDialogOpen, setDocDialogOpen] = React.useState(false);
  const [editingDoc, setEditingDoc] = React.useState<OrgDocument | null>(null);
  const [viewingDoc, setViewingDoc] = React.useState<OrgDocument | null>(null);

  // Drag & drop
  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  const [dropDialogOpen, setDropDialogOpen] = React.useState(false);
  const [droppedEntries, setDroppedEntries] = React.useState<DroppedEntry[]>(
    [],
  );
  const dragCounterRef = React.useRef(0);

  // Live upload dialog (for direct drag-drop into folder) — opens as soon as
  // the upload starts, shows per-file progress, then the final summary.
  const [uploadResultsOpen, setUploadResultsOpen] = React.useState(false);
  const [uploadItems, setUploadItems] = React.useState<
    {
      name: string;
      status: "pending" | "uploading" | "done" | "failed";
      error?: string;
    }[]
  >([]);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null;

  const filteredFolders = folders.filter(
    (f) =>
      f.name.toLowerCase().includes(folderSearch.toLowerCase()) &&
      (statusFilter === "all" ||
        (statusFilter === "active" ? f.isActive : !f.isActive)),
  );

  const folderDocs: OrgDocument[] = remoteDocs.map((d) => ({
    id: d.id,
    folderId: d.folder_id,
    title: d.title,
    description: d.description ?? "",
    allowDownload: d.allow_download,
    requireAcknowledgement: d.require_acknowledgement,
    isActive: d.is_active,
    file: {
      name: d.file_name ?? "unknown",
      size: d.file_size ?? 0,
      mimeType: d.mime_type ?? "application/octet-stream",
      url: d.file_url ?? undefined,
    },
    updatedAt: new Date().toISOString(),
  }));

  const docQuery = docSearch.trim().toLowerCase();
  const visibleDocs = folderDocs.filter(
    (d) =>
      d.title.toLowerCase().includes(docQuery) ||
      d.file.name.toLowerCase().includes(docQuery),
  );

  // ── Drag & drop ──────────────────────────────────────────────────────────────

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropDisabled) return;
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDraggingOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDraggingOver(false);
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }
  const [isUploading, setIsUploading] = React.useState(false);

  // While any dialog is open (or an upload is running) the page must not
  // react to drag & drop — drops targeted at dialog dropzones bubble up
  // through the React tree and would double-upload the same files.
  const dropDisabled =
    folderDialogOpen ||
    docDialogOpen ||
    dropDialogOpen ||
    uploadResultsOpen ||
    isUploading;

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    if (dropDisabled) return;
    const entries = await readDroppedItems(e.dataTransfer);
    if (entries.length === 0) return;

    // Case 1: Inside a folder → upload directly, with a live progress modal
    if (selectedFolderId && orgId) {
      const files = flattenFiles(entries);
      if (files.length === 0) return;
      setIsUploading(true);
      setUploadItems(
        files.map((f) => ({ name: f.name, status: "pending" as const })),
      );
      setUploadResultsOpen(true);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "uploading" } : it,
          ),
        );
        try {
          await uploadAndCreateDoc.mutateAsync({
            file,
            folderId: selectedFolderId,
            title: file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
          });
          setUploadItems((prev) =>
            prev.map((it, idx) =>
              idx === i ? { ...it, status: "done" } : it,
            ),
          );
        } catch (err: any) {
          const detail =
            err?.response?.data?.detail ?? err?.message ?? "Upload failed";
          setUploadItems((prev) =>
            prev.map((it, idx) =>
              idx === i ? { ...it, status: "failed", error: detail } : it,
            ),
          );
        }
      }
      setIsUploading(false);
      return;
    }

    // Case 2: On folder grid → show dialog
    setDroppedEntries(entries);
    setDropDialogOpen(true);
  }

  function handleDropUploadDone(results: {
    newFolders: DocumentFolder[];
    newDocuments: OrgDocument[];
  }) {
    const fid = results.newDocuments[0]?.folderId;
    if (fid) setSelectedFolderId(fid);
  }

  // ── Folder handlers ──────────────────────────────────────────────────────────

  function openNewFolder() {
    setEditingFolder(null);
    setFolderDialogOpen(true);
  }

  function openEditFolder(folder: DocumentFolder, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingFolder(folder);
    setFolderDialogOpen(true);
  }

  async function handleFolderSave(folder: DocumentFolder) {
    if (!orgId) return;
    if (editingFolder) {
      if (editingFolder.isActive && !folder.isActive) {
        await deactivateAllDocsMut.mutateAsync(editingFolder.id);
      }
      await updateFolder.mutateAsync({
        id: editingFolder.id,
        payload: {
          name: folder.name,
          description: folder.description || null,
          custom_access: folder.customAccess,
          access: {
            business_units: folder.access.businessUnits,
            departments: folder.access.departments,
            worker_types: folder.access.workerTypes,
          },
          is_active: folder.isActive,
        },
      });
    } else {
      const created = await createFolder.mutateAsync({
        name: folder.name,
        description: folder.description || null,
        custom_access: folder.customAccess,
        access: {
          business_units: folder.access.businessUnits,
          departments: folder.access.departments,
          worker_types: folder.access.workerTypes,
        },
      });
      setSelectedFolderId(created.id);
    }
    setFolderDialogOpen(false);
    setEditingFolder(null);
  }

  // ── Document handlers ────────────────────────────────────────────────────────

  function openNewDoc() {
    setEditingDoc(null);
    setDocDialogOpen(true);
  }
  function openEditDoc(doc: OrgDocument) {
    setEditingDoc(doc);
    setDocDialogOpen(true);
  }

  async function handleDocSave(doc: OrgDocument, file?: File | null) {
    if (!orgId || !selectedFolderId || !editingDoc) return;
    const payload: Record<string, unknown> = {
      title: doc.title,
      description: doc.description || null,
      allow_download: doc.allowDownload,
      require_acknowledgement: doc.requireAcknowledgement,
    };
    if (file) {
      const { assetService } = await import("@/api/assets");
      const asset = await assetService.upload(file, "org-documents");
      payload.asset_id = asset.id;
    }
    await updateDoc.mutateAsync({ id: editingDoc.id, payload });
    setDocDialogOpen(false);
    setEditingDoc(null);
  }

  async function handleUploadMultiple(
    files: {
      file: File;
      title: string;
      allowDownload: boolean;
      requireAck: boolean;
    }[],
    onItem?: (index: number, error?: string) => void,
  ): Promise<{ title: string; error?: string }[]> {
    if (!selectedFolderId)
      return files.map((f) => ({
        title: f.title,
        error: "No folder selected",
      }));
    const results: { title: string; error?: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      try {
        await uploadAndCreateDoc.mutateAsync({
          file: item.file,
          folderId: selectedFolderId,
          title: item.title,
          allowDownload: item.allowDownload,
          requireAcknowledgement: item.requireAck,
        });
        results.push({ title: item.title });
        onItem?.(i);
      } catch (err: unknown) {
        const detail =
          err instanceof Error && "response" in err
            ? (err.response as { data?: { detail?: unknown } })?.data?.detail
            : undefined;
        const message =
          typeof detail === "string"
            ? detail
            : err instanceof Error
              ? err.message
              : "Upload failed";
        results.push({ title: item.title, error: message });
        onItem?.(i, message);
      }
    }
    // The dialog stays open — it shows its own completion summary with a
    // Done button (closing it here used to hide failures from the admin).
    return results;
  }

  function handleDeleteDoc(id: string) {
    confirm({
      title: "Delete Document",
      description: "Are you sure you want to delete this document?",
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        await deleteDocMut.mutateAsync(id);
      },
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className="space-y-6 p-6"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm">
          <div className="rounded-full bg-muted p-6">
            <Upload className="h-12 w-12 text-foreground" />
          </div>
          <p className="text-lg font-semibold text-foreground">
            Drop files here
          </p>
          <p className="text-sm text-muted-foreground">
            Drop files or folders to upload
          </p>
        </div>
      )}

      {/* ── Folder Grid View ──────────────────────────────────────────────── */}
      {foldersLoading ? (
        <PageLoader message="Loading folders..." />
      ) : !selectedFolder ? (
        <>
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl">Organisation Documents</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Manage your document folders and files. You can also drag & drop
                folders from your computer.
              </p>
            </div>
            <Button variant="success" onClick={openNewFolder}>
              <FolderPlus />
              New Folder
            </Button>
          </div>

          {/* Search + Status Filter */}
          {folders.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="relative max-w-sm flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-icon" />
                <Input
                  placeholder="Search folders..."
                  value={folderSearch}
                  onChange={(e) => setFolderSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="w-40">
                <SearchableSelect
                  options={STATUS_OPTIONS}
                  value={statusFilter}
                  onChange={(v) =>
                    setStatusFilter(v as "all" | "active" | "inactive")
                  }
                  placeholder="Status"
                  searchable={false}
                />
              </div>
            </div>
          )}

          {/* Grid */}
          {filteredFolders.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
              <div className="rounded-full bg-muted p-5">
                <FolderOpen className="h-10 w-10 text-muted-foreground" />
              </div>
              <div>
                <p className="text-base font-semibold">No folders yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {folderSearch
                    ? "No folders match your search."
                    : "Create your first folder or drag & drop a folder from your computer."}
                </p>
              </div>
              {!folderSearch && (
                <Button variant="success" onClick={openNewFolder}>
                  <FolderPlus />
                  Create Folder
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredFolders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => setSelectedFolderId(folder.id)}
                  className="group relative rounded-xl border bg-card p-5 text-left transition-all hover:shadow-sm hover:border-foreground/20"
                >
                  {/* 3-dot menu */}
                  <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        asChild
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button variant="ghost" size="icon-sm">
                          <MoreVertical className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={(e) => openEditFolder(folder, e)}
                        >
                          <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Folder icon */}
                  <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-icon-bg text-icon mb-3">
                    <FolderOpen className="h-5 w-5" />
                  </div>

                  {/* Name + description */}
                  <p className="font-semibold truncate">{folder.name}</p>
                  {folder.description && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                      {folder.description}
                    </p>
                  )}

                  {/* Badges */}
                  <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                    {folder.isActive ? (
                      <Badge
                        variant="secondary"
                        className="gap-1 text-xs text-green-700 bg-green-100"
                      >
                        Active
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="gap-1 text-xs text-red-700 bg-red-100"
                      >
                        Inactive
                      </Badge>
                    )}
                    {folder.customAccess ? (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <Lock className="h-2.5 w-2.5" /> Restricted
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <Users className="h-2.5 w-2.5" /> All Employees
                      </Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        /* ── Document List View (inside a folder) ───────────────────────── */
        <>
          {/* Breadcrumb + actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSelectedFolderId(null)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex items-center gap-1.5 text-sm">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setSelectedFolderId(null)}
                >
                  All Folders
                </button>
                <span className="text-muted-foreground">/</span>
                <span className="font-semibold">{selectedFolder.name}</span>
              </div>
              {selectedFolder.customAccess ? (
                <Badge variant="secondary" className="gap-1 text-xs ml-2">
                  <Lock className="h-2.5 w-2.5" /> Restricted
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1 text-xs ml-2">
                  <Users className="h-2.5 w-2.5" /> All Employees
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {folderDocs.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    confirm({
                      title: "Delete All Documents",
                      description: `This will delete all documents in "${selectedFolder.name}". This action cannot be undone.`,
                      confirmText: "Delete All",
                      variant: "destructive",
                      onConfirm: async () => {
                        await deactivateAllDocsMut.mutateAsync(
                          selectedFolderId!,
                        );
                      },
                    });
                  }}
                >
                  <Trash2 />
                  Delete All
                </Button>
              )}
              <Button size="sm" variant="success" onClick={openNewDoc}>
                <Plus />
                Add Document
              </Button>
            </div>
          </div>

          {selectedFolder.description && (
            <p className="text-sm text-muted-foreground -mt-2">
              {selectedFolder.description}
            </p>
          )}

          {/* Document search */}
          {!docsLoading && folderDocs.length > 0 && (
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-icon" />
              <Input
                placeholder="Search documents..."
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          )}

          {/* Document list */}
          {docsLoading ? (
            <PageLoader message="Loading documents..." />
          ) : folderDocs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
              <div className="rounded-full bg-muted p-5">
                <FilePlus className="h-10 w-10 text-muted-foreground" />
              </div>
              <div>
                <p className="text-base font-semibold">No documents yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add your first document to{" "}
                  <span className="font-medium">{selectedFolder.name}</span>.
                </p>
              </div>
              <Button variant="success" onClick={openNewDoc}>
                <Plus />
                Add Document
              </Button>
            </div>
          ) : visibleDocs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No documents match your search.
            </div>
          ) : (
            <div className="space-y-3">
              {visibleDocs.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  onView={() => setViewingDoc(doc)}
                  onEdit={() => openEditDoc(doc)}
                  onDelete={() => handleDeleteDoc(doc.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────────── */}
      <FolderDialog
        open={folderDialogOpen}
        onOpenChange={(open) => {
          setFolderDialogOpen(open);
          if (!open) setEditingFolder(null);
        }}
        editingFolder={editingFolder}
        onSave={handleFolderSave}
        existingFolderNames={folders.map((f) => f.name)}
      />
      <DocumentDialog
        open={docDialogOpen}
        onOpenChange={(open) => {
          setDocDialogOpen(open);
          if (!open) setEditingDoc(null);
        }}
        folderId={selectedFolderId ?? ""}
        editingDoc={editingDoc}
        onSave={handleDocSave}
        onUploadMultiple={handleUploadMultiple}
        existingDocNames={folderDocs.map((d) => d.file.name)}
      />
      <DocumentViewSheet
        doc={viewingDoc}
        onOpenChange={(open) => {
          if (!open) setViewingDoc(null);
        }}
      />
      <DropUploadDialog
        open={dropDialogOpen}
        onOpenChange={(open) => {
          setDropDialogOpen(open);
          // Drop the stale entries so a later re-open never resurrects them
          if (!open) setDroppedEntries([]);
        }}
        droppedEntries={droppedEntries}
        existingFolders={folders}
        onDone={handleDropUploadDone}
      />

      {/* Live upload dialog (direct drag-drop into folder) */}
      <Dialog
        open={uploadResultsOpen}
        onOpenChange={(open) => {
          // Can't dismiss while files are still uploading
          if (!isUploading) setUploadResultsOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
          {(() => {
            const processed = uploadItems.filter(
              (it) => it.status === "done" || it.status === "failed",
            ).length;
            const succeeded = uploadItems.filter(
              (it) => it.status === "done",
            ).length;
            const failed = uploadItems.filter(
              (it) => it.status === "failed",
            ).length;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {isUploading ? (
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    ) : failed === 0 ? (
                      <Check className="h-5 w-5 text-green-600" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-600" />
                    )}
                    {isUploading ? "Uploading..." : "Upload Complete"}
                  </DialogTitle>
                  <DialogDescription>
                    {processed} of {uploadItems.length} file
                    {uploadItems.length !== 1 ? "s" : ""} processed
                  </DialogDescription>
                </DialogHeader>

                {isUploading ? (
                  <div className="h-2 rounded-full bg-muted overflow-hidden shrink-0">
                    <div
                      className="h-full bg-foreground/70 rounded-full transition-all duration-300"
                      style={{
                        width: `${uploadItems.length ? (processed / uploadItems.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    {succeeded > 0 && (
                      <Badge className="bg-green-100 text-green-700 gap-1">
                        <Check className="h-3 w-3" /> {succeeded} succeeded
                      </Badge>
                    )}
                    {failed > 0 && (
                      <Badge className="bg-red-100 text-red-700 gap-1">
                        <X className="h-3 w-3" /> {failed} failed
                      </Badge>
                    )}
                  </div>
                )}

                <ScrollArea className="flex-1 min-h-0 border rounded-lg">
                  <div className="divide-y">
                    {uploadItems.map((item, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex items-start gap-3 px-4 py-2.5 text-sm",
                          item.status === "failed" &&
                            "bg-red-50/40 dark:bg-red-950/10",
                        )}
                      >
                        <span className="shrink-0 pt-0.5">
                          {item.status === "done" && (
                            <Check className="h-4 w-4 text-green-600" />
                          )}
                          {item.status === "failed" && (
                            <X className="h-4 w-4 text-red-500" />
                          )}
                          {item.status === "uploading" && (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          )}
                          {item.status === "pending" && (
                            <span className="block h-4 w-4 rounded-full border border-muted-foreground/30" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate",
                              item.status === "failed" && "text-destructive",
                            )}
                          >
                            {item.name}
                          </span>
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
                    onClick={() => setUploadResultsOpen(false)}
                    disabled={isUploading}
                  >
                    Done
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Document card ────────────────────────────────────────────────────────────

function DocumentCard({
  doc,
  onView,
  onEdit,
  onDelete,
}: {
  doc: OrgDocument;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group flex items-start gap-4 rounded-xl border bg-card px-4 py-4 transition-shadow hover:shadow-sm cursor-pointer"
      onClick={onView}
    >
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <DocIcon mimeType={doc.file.mimeType} className="h-5 w-5" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="font-medium leading-tight">{doc.title}</p>
        {doc.description && (
          <p className="mt-0.5 text-sm text-muted-foreground line-clamp-1">
            {doc.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {doc.file.name.split(".").pop()?.toUpperCase()} ·{" "}
            {formatBytes(doc.file.size)}
          </span>
          {doc.requireAcknowledgement && (
            <Badge
              variant="outline"
              className="h-5 gap-1 px-1.5 py-0 text-[11px] text-warning border-warning/30"
            >
              Ack Required
            </Badge>
          )}
          {doc.allowDownload && (
            <Badge
              variant="outline"
              className="h-5 gap-1 px-1.5 py-0 text-[11px] text-muted-foreground border-border"
            >
              <Download className="h-2.5 w-2.5" /> Download
            </Badge>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {doc.allowDownload && doc.file.url && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            title="Download"
            onClick={(e) => {
              e.stopPropagation();
              window.open(doc.file.url, "_blank");
            }}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
