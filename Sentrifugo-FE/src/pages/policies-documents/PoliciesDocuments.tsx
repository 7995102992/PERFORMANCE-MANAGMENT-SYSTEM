import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronLeft,
  Download,
  File,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  Lock,
  Search,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { SecurePdfViewer } from "@/components/shared/SecurePdfViewer";
import { useAppSelector } from "@/store";

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string;

/** In-app viewers fetch bytes via JS — the public bucket URL has no CORS
 *  headers, so they go through the authenticated API proxy instead. */
function documentContentUrl(docId: string) {
  return `${IAM_BASE_URL}/org-documents/my/documents/${docId}/content`;
}
import { cn } from "@/lib/utils";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import {
  useGetMyDocFoldersQuery,
  useGetMyDocumentsQuery,
  useAcknowledgeDocumentMutation,
  type MyDocFolder,
  type MyOrgDocument,
} from "@/store/api/orgDocumentsApi";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function DocIcon({
  mimeType,
  className,
}: {
  mimeType?: string | null;
  className?: string;
}) {
  const mt = mimeType ?? "";
  if (mt.includes("pdf"))
    return <FileText className={cn("text-destructive/70", className)} />;
  if (mt.includes("spreadsheet") || mt.includes("excel") || mt.includes("csv"))
    return <FileSpreadsheet className={cn("text-success/80", className)} />;
  if (mt.includes("word") || mt.includes("document"))
    return <FileText className={cn("text-muted-foreground", className)} />;
  return <File className={cn("text-muted-foreground", className)} />;
}

function AccessBadge({ restricted }: { restricted: boolean }) {
  return restricted ? (
    <Badge variant="outline" className="gap-1 text-xs font-normal">
      <Lock className="size-2.5" /> Restricted
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 text-xs font-normal">
      <Users className="size-2.5" /> All Employees
    </Badge>
  );
}

function Loading({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {message}
    </div>
  );
}

// ─── CSV preview (view-only table) ────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const CSV_PREVIEW_ROW_LIMIT = 200;

function CsvPreview({
  url,
  headers,
}: {
  url: string;
  headers?: Record<string, string>;
}) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(false);
    fetch(url, { headers })
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setRows(parseCsv(text));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn't load the preview. Please try again later.
      </div>
    );
  if (!rows) return <Loading message="Loading document..." />;

  const visible = rows.slice(0, CSV_PREVIEW_ROW_LIMIT);
  return (
    <div
      className="h-full overflow-auto p-4 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="rounded-xl border overflow-hidden bg-card inline-block min-w-full">
        <table className="w-full text-sm">
          <tbody>
            {visible.map((r, ri) => (
              <tr
                key={ri}
                className={
                  ri === 0
                    ? "bg-table-header border-b border-table-border"
                    : "border-b last:border-0"
                }
              >
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className={
                      ri === 0
                        ? "px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap"
                        : "px-3 py-1.5 text-sm text-foreground whitespace-nowrap"
                    }
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > CSV_PREVIEW_ROW_LIMIT && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing first {CSV_PREVIEW_ROW_LIMIT} of {rows.length} rows
        </p>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PoliciesDocuments() {
  // At most two levels: a main folder, then optionally one of its sub-folders.
  const [rootFolder, setRootFolder] = useState<MyDocFolder | null>(null);
  const [subFolder, setSubFolder] = useState<MyDocFolder | null>(null);
  const selectedFolder = subFolder ?? rootFolder;

  function openFolder(folder: MyDocFolder) {
    if (folder.parent_id) setSubFolder(folder);
    else {
      setRootFolder(folder);
      setSubFolder(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Policies & Documents"
        subtitle="Organisation policies and documents shared with you"
      />
      {selectedFolder ? (
        <DocumentList
          folder={selectedFolder}
          // Sub-folders are only listed when viewing a main folder
          parentFolder={subFolder ? rootFolder : null}
          onOpenSubFolder={openFolder}
          onBack={() => {
            setRootFolder(null);
            setSubFolder(null);
          }}
          onBackToParent={subFolder ? () => setSubFolder(null) : undefined}
        />
      ) : (
        <FolderGrid onOpen={openFolder} />
      )}
    </div>
  );
}

// ─── Folder grid ──────────────────────────────────────────────────────────────

function FolderGrid({ onOpen }: { onOpen: (folder: MyDocFolder) => void }) {
  const { data: folders = [], isLoading, isError } = useGetMyDocFoldersQuery();
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () =>
      folders.filter((f) =>
        f.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [folders, search],
  );

  if (isLoading) return <Loading message="Loading folders..." />;
  if (isError)
    return (
      <EmptyState
        icon={FolderOpen}
        variant="error"
        title="Couldn't load folders"
        description="Something went wrong while loading policies and documents. Please try again later."
      />
    );
  if (folders.length === 0)
    return (
      <EmptyState
        icon={FolderOpen}
        title="No policies or documents yet"
        description="Documents shared by your organisation will appear here."
      />
    );

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search folders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No folders found"
          description="No folders match your search."
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((folder) => (
            <div
              key={folder.id}
              className="rounded-xl border bg-card p-5 hover:shadow-md hover:border-primary/30 transition-all cursor-pointer"
              onClick={() => onOpen(folder)}
            >
              <div className="flex size-10 items-center justify-center rounded-[10px] bg-icon-bg text-icon mb-3">
                <FolderOpen className="size-5" />
              </div>
              <p className="text-sm font-semibold text-foreground truncate">
                {folder.name}
              </p>
              {folder.description && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                  {folder.description}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <AccessBadge restricted={folder.custom_access} />
                {!!folder.subfolder_count && folder.subfolder_count > 0 && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <FolderOpen className="size-2.5" />
                    {folder.subfolder_count} sub-folder
                    {folder.subfolder_count === 1 ? "" : "s"}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Document list (inside a folder) ─────────────────────────────────────────

function DocumentList({
  folder,
  parentFolder,
  onOpenSubFolder,
  onBack,
  onBackToParent,
}: {
  folder: MyDocFolder;
  /** The main folder above `folder`, when viewing a sub-folder. */
  parentFolder: MyDocFolder | null;
  onOpenSubFolder: (folder: MyDocFolder) => void;
  onBack: () => void;
  /** Only set when viewing a sub-folder — steps back up one level. */
  onBackToParent?: () => void;
}) {
  const {
    data: documents = [],
    isLoading,
    isError,
  } = useGetMyDocumentsQuery(folder.id);
  // Sub-folders only exist under a main folder, so skip the request entirely
  // when already inside one.
  const { data: subFolders = [] } = useGetMyDocFoldersQuery(folder.id, {
    skip: !!parentFolder,
  });
  const [search, setSearch] = useState("");
  // Viewer holds the id, not the object — the doc re-derives from the fresh
  // list after acknowledging, so the viewer updates in place.
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const viewDoc = documents.find((d) => d.id === viewDocId) ?? null;
  const [acknowledge, { isLoading: isAcknowledging }] =
    useAcknowledgeDocumentMutation();
  const accessToken = useAppSelector((s) => s.auth.accessToken);
  const authHeaders = useMemo<Record<string, string> | undefined>(
    () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined),
    [accessToken],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return documents.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.file_name ?? "").toLowerCase().includes(q),
    );
  }, [documents, search]);

  const handleAcknowledge = async () => {
    if (!viewDoc) return;
    try {
      await acknowledge({ docId: viewDoc.id, folderId: folder.id }).unwrap();
      toast.success(`"${viewDoc.title}" acknowledged`);
    } catch {
      toast.error("Couldn't record your acknowledgement. Please try again.");
    }
  };

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          // Step up one level: sub-folder → main folder → all folders
          onClick={onBackToParent ?? onBack}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <div className="flex items-center gap-1.5 text-sm">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={onBack}
          >
            All Folders
          </button>
          <span className="text-muted-foreground">/</span>
          {parentFolder && (
            <>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={onBackToParent}
              >
                {parentFolder.name}
              </button>
              <span className="text-muted-foreground">/</span>
            </>
          )}
          <span className="font-semibold text-foreground">{folder.name}</span>
        </div>
        <AccessBadge restricted={folder.custom_access} />
      </div>

      {folder.description && (
        <p className="text-sm text-muted-foreground -mt-2">
          {folder.description}
        </p>
      )}

      {/* Sub-folders, above this folder's own documents — files stored
          directly in the main folder stay visible alongside them. */}
      {subFolders.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">
            Sub-folders
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {subFolders.map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => onOpenSubFolder(sub)}
                className="flex items-center gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:shadow-md hover:border-primary/30"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-icon-bg text-icon">
                  <FolderOpen className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {sub.name}
                  </p>
                  {sub.description && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {sub.description}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <Loading message="Loading documents..." />
      ) : isError ? (
        <EmptyState
          icon={FileText}
          variant="error"
          title="Couldn't load documents"
          description="Something went wrong while loading this folder. Please try again later."
        />
      ) : documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents in this folder"
          description={
            subFolders.length > 0
              ? "Open a sub-folder above to see its documents."
              : "Documents added by your organisation will appear here."
          }
        />
      ) : (
        <>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search documents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No documents found"
              description="No documents match your search."
            />
          ) : (
            <div className="space-y-3">
              {filtered.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  onView={() => setViewDocId(doc.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Document viewer — read in-app; acknowledgement is taken here, after
          the employee has actually opened the document */}
      <Sheet
        open={!!viewDoc}
        onOpenChange={(open) => {
          if (!open) setViewDocId(null);
        }}
      >
        <SheetContent
          className="flex flex-col gap-0 p-0"
          // Inline style — the base SheetContent's data-side width variants
          // out-specify width classes.
          style={{ width: "min(92vw, 860px)", maxWidth: "min(92vw, 860px)" }}
        >
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle className="flex items-center gap-2">
              <DocIcon mimeType={viewDoc?.mime_type} className="size-4" />
              {viewDoc?.title}
            </SheetTitle>
            {viewDoc?.description && (
              <SheetDescription>{viewDoc.description}</SheetDescription>
            )}
            {/* Which revision this is and when it was published — employees
                sign off on a specific version, so it has to be on screen. */}
            {viewDoc && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant="secondary" className="text-xs">
                  Version {viewDoc.current_version_no}
                </Badge>
                {viewDoc.version_updated_at && (
                  <span className="text-xs text-muted-foreground">
                    Updated{" "}
                    {formatDateIST(viewDoc.version_updated_at)}
                  </span>
                )}
                {viewDoc.version_change_note && (
                  <span className="truncate text-xs text-muted-foreground">
                    · {viewDoc.version_change_note}
                  </span>
                )}
              </div>
            )}
          </SheetHeader>

          {/* Preview — always our own renderer, never the browser PDF viewer:
              no native toolbar, downloading only via our Download button
              (shown when the admin allows it) */}
          <div className="flex-1 min-h-0 bg-muted/30">
            {viewDoc?.file_url && (viewDoc.mime_type ?? "").includes("pdf") ? (
              <SecurePdfViewer
                url={documentContentUrl(viewDoc.id)}
                httpHeaders={authHeaders}
              />
            ) : viewDoc?.file_url &&
              (viewDoc.mime_type ?? "").includes("csv") ? (
              <CsvPreview
                url={documentContentUrl(viewDoc.id)}
                headers={authHeaders}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center px-6">
                <div className="flex size-12 items-center justify-center rounded-xl bg-icon-bg text-icon">
                  <DocIcon mimeType={viewDoc?.mime_type} className="size-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Preview not available
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
                    {viewDoc?.allow_download
                      ? "Word and Excel files can't be previewed in the browser. Download the file to read it."
                      : "Word and Excel files can't be previewed in the browser, and download is disabled for this document."}
                  </p>
                </div>
                {viewDoc?.allow_download && viewDoc.file_url && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => window.open(viewDoc.file_url!, "_blank")}
                  >
                    <Download className="size-4" />
                    Download
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Acknowledgement — prominent strip pinned above the footer */}
          {viewDoc?.require_acknowledgement &&
            (viewDoc.acknowledged && viewDoc.acknowledged_at ? (
              <div className="border-t bg-success/5 px-6 py-3 flex items-center gap-1.5 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" />
                Acknowledged on{" "}
                {formatDateTimeIST(viewDoc.acknowledged_at)}
                {viewDoc.current_version_no > 1 &&
                  ` (version ${viewDoc.current_version_no})`}
              </div>
            ) : (
              <div className="border-t bg-primary/5 px-6 py-3 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {/* An employee who signed an earlier revision hasn't seen
                      this one — say why they're being asked again. */}
                  {viewDoc.acknowledged_version_no ? (
                    <>
                      <span className="font-medium text-foreground">
                        This document has been updated
                      </span>{" "}
                      since you acknowledged version{" "}
                      {viewDoc.acknowledged_version_no}. Please read version{" "}
                      {viewDoc.current_version_no} and acknowledge it. The date
                      and time will be recorded.
                    </>
                  ) : (
                    <>
                      By acknowledging, you confirm you have read and understood
                      this document. The date and time will be recorded.
                    </>
                  )}
                </p>
                <Button
                  className="shrink-0 gap-1.5"
                  onClick={handleAcknowledge}
                  disabled={isAcknowledging}
                >
                  {isAcknowledging ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Acknowledge
                </Button>
              </div>
            ))}

          {/* Footer — download only when allowed */}
          {viewDoc?.allow_download && viewDoc.file_url && (
            <div className="border-t px-6 py-3 flex justify-end">
              <Button
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => window.open(viewDoc.file_url!, "_blank")}
              >
                <Download className="size-4" />
                Download
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Document card (read-only) ────────────────────────────────────────────────
// Clicking the card opens the in-app viewer; acknowledgement is taken there.

function DocumentCard({
  doc,
  onView,
}: {
  doc: MyOrgDocument;
  onView: () => void;
}) {
  return (
    <div
      className="flex items-start gap-4 rounded-xl border bg-card px-4 py-4 cursor-pointer hover:shadow-md hover:border-primary/30 transition-all"
      onClick={onView}
    >
      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <DocIcon mimeType={doc.mime_type} className="size-5" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground leading-tight">
          {doc.title}
        </p>
        {doc.description && (
          <p className="mt-0.5 text-sm text-muted-foreground line-clamp-1">
            {doc.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {doc.current_version_no > 1 && (
            <Badge
              variant="outline"
              className="h-5 gap-1 px-1.5 py-0 text-[11px] text-muted-foreground"
            >
              v{doc.current_version_no}
            </Badge>
          )}
          {/* Only meaningful once revised — on a v1 document this date is just
              the upload date and adds noise to every row. */}
          {doc.current_version_no > 1 && doc.version_updated_at && (
            <span className="text-xs text-muted-foreground">
              Updated {formatDateIST(doc.version_updated_at)}
            </span>
          )}
          {doc.require_acknowledgement &&
            (doc.acknowledged && doc.acknowledged_at ? (
              <span className="flex items-center gap-1 text-xs text-success">
                <CheckCircle2 className="size-3.5" />
                Acknowledged on{" "}
                {formatDateTimeIST(doc.acknowledged_at)}
              </span>
            ) : (
              <Badge
                variant="outline"
                className="h-5 gap-1 px-1.5 py-0 text-[11px] text-warning border-warning/30"
              >
                {/* Distinguish "never signed" from "signed an older version" —
                    the second is a re-read, not a first read. */}
                {doc.acknowledged_version_no
                  ? "Updated — acknowledge again"
                  : "Acknowledgement required"}
              </Badge>
            ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {doc.require_acknowledgement && !doc.acknowledged && (
          <Button variant="outline" size="sm" className="gap-1.5">
            <FileText className="size-4" />
            {doc.acknowledged_version_no
              ? "Read & Re-acknowledge"
              : "Read & Acknowledge"}
          </Button>
        )}
        {doc.allow_download && doc.file_url && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            title="Download"
            onClick={(e) => {
              e.stopPropagation();
              window.open(doc.file_url!, "_blank");
            }}
          >
            <Download className="size-4" />
            Download
          </Button>
        )}
      </div>
    </div>
  );
}
