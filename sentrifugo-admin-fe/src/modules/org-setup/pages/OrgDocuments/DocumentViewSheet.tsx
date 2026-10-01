import * as React from "react";
import { Download, FileText, FileSpreadsheet, File, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAppSelector } from "@/store";
import { SecurePdfViewer } from "@/components/shared/SecurePdfViewer";
import type { OrgDocument } from "@/modules/org-setup/types/org-documents";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

/** In-app viewers fetch bytes via JS — the public bucket URL has no CORS
 *  headers, so they go through the authenticated API endpoint instead. */
function documentContentUrl(docId: string) {
  return `${API_BASE_URL}/org-documents/documents/${docId}/content`;
}

function docIcon(mimeType: string, cls?: string) {
  if (mimeType.includes("pdf"))
    return <FileText className={cn("text-destructive/70", cls)} />;
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType.includes("csv")
  )
    return <FileSpreadsheet className={cn("text-success/80", cls)} />;
  if (mimeType.includes("word") || mimeType.includes("document"))
    return <FileText className={cn("text-muted-foreground", cls)} />;
  return <File className={cn("text-muted-foreground", cls)} />;
}

// ─── CSV preview (simple table) ──────────────────────────────────────────────

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
  const [rows, setRows] = React.useState<string[][] | null>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
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
  if (!rows)
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading document...
      </div>
    );

  const visible = rows.slice(0, CSV_PREVIEW_ROW_LIMIT);
  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-lg border overflow-hidden bg-card inline-block min-w-full">
        <table className="w-full text-sm">
          <tbody>
            {visible.map((r, ri) => (
              <tr
                key={ri}
                className={
                  ri === 0 ? "bg-muted/40 border-b" : "border-b last:border-0"
                }
              >
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className={
                      ri === 0
                        ? "px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap"
                        : "px-3 py-1.5 whitespace-nowrap"
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

// ─── View sheet ──────────────────────────────────────────────────────────────

export function DocumentViewSheet({
  doc,
  onOpenChange,
}: {
  doc: OrgDocument | null;
  onOpenChange: (open: boolean) => void;
}) {
  const token = useAppSelector((s) => s.auth.token);
  const authHeaders = React.useMemo<Record<string, string> | undefined>(
    () => (token ? { Authorization: `Bearer ${token}` } : undefined),
    [token],
  );

  const mime = doc?.file.mimeType ?? "";

  return (
    <Sheet open={!!doc} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex flex-col gap-0 p-0"
        // Inline style — the base SheetContent's data-[side=right]:sm:max-w-sm
        // out-specifies width classes (same approach as FormSheet).
        style={{ width: "min(92vw, 860px)", maxWidth: "min(92vw, 860px)" }}
      >
        <SheetHeader className="px-6 py-5 border-b">
          <SheetTitle className="flex items-center gap-2">
            {docIcon(mime, "h-4 w-4")}
            {doc?.title}
          </SheetTitle>
          {doc?.description && (
            <SheetDescription>{doc.description}</SheetDescription>
          )}
        </SheetHeader>

        {/* Preview */}
        <div className="flex-1 min-h-0 bg-muted/30">
          {doc && mime.includes("pdf") ? (
            <SecurePdfViewer
              url={documentContentUrl(doc.id)}
              httpHeaders={authHeaders}
            />
          ) : doc && mime.includes("csv") ? (
            <CsvPreview
              url={documentContentUrl(doc.id)}
              headers={authHeaders}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center px-6">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-icon-bg text-icon">
                {docIcon(mime, "h-5 w-5")}
              </div>
              <div>
                <p className="text-sm font-semibold">Preview not available</p>
                <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
                  Word and Excel files can't be previewed in the browser.
                  Download the file to read it.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer — admins can always download their own documents */}
        {doc?.file.url && (
          <div className="border-t px-6 py-3 flex justify-end">
            <Button
              variant="outline"
              onClick={() => window.open(doc.file.url, "_blank")}
            >
              <Download />
              Download
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
