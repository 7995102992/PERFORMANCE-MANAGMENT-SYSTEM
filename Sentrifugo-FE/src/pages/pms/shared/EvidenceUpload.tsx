import { useRef } from "react";
import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Upload" link / attached file name. Only the file name is kept: file storage is not connected yet,
 * so nothing is uploaded anywhere.
 */
export function EvidenceUpload({
  value,
  onChange,
  disabled = false,
  label,
  className,
}: {
  value: string | null;
  onChange: (name: string | null) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {value ? (
        <>
          <span className="max-w-[10rem] truncate text-foreground" title={value}>
            {value}
          </span>
          {!disabled && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => onChange(null)}
            >
              Remove
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          disabled={disabled}
          className="font-medium text-primary underline underline-offset-2 disabled:opacity-50"
          onClick={() => input.current?.click()}
        >
          Upload
        </button>
      )}
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={label}
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onChange(file.name);
          e.target.value = "";
        }}
      />
    </span>
  );
}
