/**
 * Multi-file drop zone matching the "Attach Receipts" design: a dashed card
 * with a cloud icon, a Browse Files button and the size/format hint.
 *
 * Picker plus validation only — the caller owns the file list and decides when
 * to upload, because a form that stages files before its record exists (the
 * announcement Sheet) and one that uploads immediately need the same picker but
 * different lists.
 *
 * Distinct from `FileDropZone`, which is the single-file import-wizard variant.
 */
import * as React from "react";
import { AlertCircle, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEFAULT_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
];

interface Props {
  /** Files picked in this session — used for the per-file count limit. */
  value: File[];
  onChange: (files: File[]) => void;
  /** Counted alongside `value` when enforcing `maxFiles`. */
  alreadyAttached?: number;
  accept?: string[];
  maxSizeMB?: number;
  maxFiles?: number;
  disabled?: boolean;
  /** Red border, to flag a failed required check. */
  invalid?: boolean;
  className?: string;
}

export function AttachmentDropzone({
  value,
  onChange,
  alreadyAttached = 0,
  accept = DEFAULT_EXTENSIONS,
  maxSizeMB = 10,
  maxFiles = 10,
  disabled = false,
  invalid = false,
  className,
}: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);

  const getExtension = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot).toLowerCase();
  };

  const validate = (file: File, currentCount: number): string | null => {
    if (!accept.includes(getExtension(file.name)))
      return `${file.name} — unsupported file type`;
    if (file.size > maxSizeMB * 1024 * 1024)
      return `${file.name} — exceeds ${maxSizeMB} MB`;
    if (currentCount >= maxFiles)
      return `${file.name} — attachment limit of ${maxFiles} reached`;
    return null;
  };

  const ingest = (incoming: FileList | File[]) => {
    const arr = Array.isArray(incoming) ? incoming : Array.from(incoming);
    const accepted: File[] = [];
    const rejects: string[] = [];
    let count = value.length + alreadyAttached;
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
  };

  const atLimit = value.length + alreadyAttached >= maxFiles;
  const blocked = disabled || atLimit;

  const formatLabels = accept
    .map((e) => e.replace(".", "").toUpperCase())
    // .jpg and .jpeg are one format to a reader.
    .filter((label, i, all) => all.indexOf(label) === i && label !== "JPEG");

  return (
    <div className={cn("w-full space-y-3", className)}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept.join(",")}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) ingest(e.target.files);
          e.target.value = "";
        }}
      />

      <div
        onDragOver={(e) => {
          if (blocked) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (blocked) return;
          if (e.dataTransfer.files?.length) ingest(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          blocked
            ? "cursor-not-allowed border-muted-foreground/20 bg-muted/20 opacity-60"
            : isDragging
              ? "border-primary bg-primary/5"
              : invalid
                ? "border-destructive bg-card"
                : "border-muted-foreground/25 bg-card",
        )}
      >
        <UploadCloud
          className="size-9 text-muted-foreground"
          strokeWidth={1.5}
        />
        <p className="text-sm font-semibold text-foreground">
          Drag and drop your files here or
        </p>
        <Button
          type="button"
          variant="secondary"
          className="bg-primary/10 text-primary hover:bg-primary/15"
          disabled={blocked}
          onClick={() => inputRef.current?.click()}
        >
          Browse Files
        </Button>
        <p className="text-xs text-muted-foreground">
          Maximum file size : {maxSizeMB}MB. Supported formats :{" "}
          {formatLabels.join(", ")}
        </p>
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
    </div>
  );
}
