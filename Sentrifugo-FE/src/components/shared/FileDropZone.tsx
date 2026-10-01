import { useRef, useState, useCallback, useEffect } from "react";
import { Upload, FileSpreadsheet, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  file: File | null;
  onChange: (file: File | null) => void;
  accept?: string;
  acceptLabel?: string;
}

export function FileDropZone({
  file,
  onChange,
  accept = ".xlsx,.xls",
  acceptLabel = "XLSX or XLS",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // When parent clears the file (e.g. after import), reset the browser input
  // so the same file can be selected again and onChange fires correctly.
  useEffect(() => {
    if (!file && inputRef.current) inputRef.current.value = "";
  }, [file]);

  const handleFile = useCallback(
    (f: File | undefined | null) => {
      if (!f) return;
      onChange(f);
    },
    [onChange],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center cursor-pointer transition-colors select-none",
          dragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/40",
        )}
      >
        <Upload
          className={cn(
            "size-8 transition-colors",
            dragging ? "text-primary" : "text-muted-foreground",
          )}
        />
        <div>
          <p className="text-sm font-medium text-foreground">
            {dragging ? "Drop your file here" : "Drag & drop your file here"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            or click to browse · {acceptLabel}
          </p>
        </div>
      </div>

      {/* Hidden input */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {/* Selected file chip */}
      {file && (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <FileSpreadsheet className="size-4 shrink-0 text-primary" />
          <span className="flex-1 text-sm text-foreground truncate">
            {file.name}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="text-muted-foreground hover:text-destructive transition-colors"
          >
            <X  />
          </button>
        </div>
      )}
    </div>
  );
}
