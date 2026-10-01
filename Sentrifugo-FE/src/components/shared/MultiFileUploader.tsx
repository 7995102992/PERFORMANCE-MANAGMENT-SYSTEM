import * as React from "react";
import {
  Upload,
  X,
  FileText,
  FileSpreadsheet,
  FileImage,
  File,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.includes("pdf"))
    return <FileText className="h-7 w-7 text-destructive shrink-0" />;
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType.includes("csv")
  )
    return <FileSpreadsheet className="h-7 w-7 text-success shrink-0" />;
  if (mimeType.includes("word") || mimeType.includes("document"))
    return <FileText className="h-7 w-7 text-info shrink-0" />;
  if (mimeType.startsWith("image/"))
    return <FileImage className="h-7 w-7 text-primary shrink-0" />;
  return <File className="h-7 w-7 text-muted-foreground shrink-0" />;
}

const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "image/jpeg": "JPG",
  "image/png": "PNG",
};

interface MultiFileUploaderProps {
  /** Controlled list of currently selected files. */
  value: File[];
  onChange: (files: File[]) => void;
  /** Allowed MIME types. Falls back to a doc + image bundle. */
  accept?: string[];
  /** Allowed file extensions (lowercase, including dot). Used as a fallback
   *  when the browser leaves file.type blank (some .csv/.docx variants). */
  acceptExtensions?: string[];
  maxSizeMB?: number;
  maxFiles?: number;
  className?: string;
}

const DEFAULT_ACCEPT_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
];
const DEFAULT_ACCEPT_EXT = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png"];

/**
 * Multi-file drop zone with size + MIME + count validation.
 *
 * Mirrors FileUploader visually but supports a growing list of files
 * up to `maxFiles`. Per-file rejections are surfaced inline; the parent
 * still gets the accepted ones via `onChange`.
 */
export function MultiFileUploader({
  value,
  onChange,
  accept = DEFAULT_ACCEPT_MIME,
  acceptExtensions = DEFAULT_ACCEPT_EXT,
  maxSizeMB = 10,
  maxFiles = 10,
  className,
}: MultiFileUploaderProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);

  const extLabels = accept.map(
    (t) => MIME_TO_EXT[t] ?? t.split("/")[1]?.toUpperCase() ?? t,
  );

  const getExtension = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot).toLowerCase();
  };

  function validate(file: File, currentCount: number): string | null {
    const ext = getExtension(file.name);
    const mimeOk = accept.length === 0 || accept.includes(file.type);
    const extOk = acceptExtensions.length === 0 || acceptExtensions.includes(ext);
    if (!mimeOk && !extOk)
      return `${file.name} — unsupported file type (allowed: ${extLabels.join(", ")})`;
    if (file.size > maxSizeMB * 1024 * 1024)
      return `${file.name} — exceeds ${maxSizeMB} MB`;
    if (currentCount >= maxFiles)
      return `${file.name} — attachment limit of ${maxFiles} reached`;
    return null;
  }

  function ingest(incoming: FileList | File[]) {
    const arr = Array.isArray(incoming) ? incoming : Array.from(incoming);
    const accepted: File[] = [];
    const rejects: string[] = [];
    let count = value.length;
    for (const f of arr) {
      const err = validate(f, count);
      if (err) {
        rejects.push(err);
        continue;
      }
      accepted.push(f);
      count += 1;
    }
    if (accepted.length) onChange([...value, ...accepted]);
    setErrors(rejects);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) ingest(e.target.files);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) ingest(e.dataTransfer.files);
  }

  const removeAt = (idx: number) => {
    const next = value.filter((_, i) => i !== idx);
    onChange(next);
    setErrors([]);
  };

  const atLimit = value.length >= maxFiles;

  return (
    <div className={cn("w-full space-y-3", className)}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={[...accept, ...acceptExtensions].join(",")}
        className="hidden"
        onChange={handleInputChange}
      />

      <div
        onClick={() => !atLimit && inputRef.current?.click()}
        onDragOver={(e) => {
          if (atLimit) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          if (atLimit) {
            e.preventDefault();
            return;
          }
          handleDrop(e);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-colors",
          atLimit
            ? "border-muted-foreground/20 bg-muted/20 text-muted-foreground cursor-not-allowed opacity-60"
            : isDragging
              ? "border-primary bg-primary/5 text-primary cursor-pointer"
              : "border-muted-foreground/20 bg-muted/30 text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/50 cursor-pointer",
        )}
      >
        <div
          className={cn(
            "flex items-center justify-center rounded-full p-3",
            isDragging ? "bg-primary/10" : "bg-background shadow-sm",
          )}
        >
          <Upload  />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">
            <span className={isDragging ? "text-primary" : "text-foreground"}>
              Click to upload
            </span>{" "}
            or drag &amp; drop
          </p>
          <p className="mt-0.5 text-xs">
            {extLabels.join(" · ")} &mdash; max {maxSizeMB} MB per file, up to{" "}
            {maxFiles} files
          </p>
          {value.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {value.length}/{maxFiles} attached
            </p>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((err, i) => (
            <li
              key={i}
              className="flex items-center gap-1.5 text-xs text-destructive"
            >
              <AlertCircle className="size-3 shrink-0" />
              {err}
            </li>
          ))}
        </ul>
      )}

      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center gap-3 rounded-md border bg-muted/30 p-2.5"
            >
              {getFileIcon(f.type)}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(f.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${f.name}`}
              >
                <X  />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
