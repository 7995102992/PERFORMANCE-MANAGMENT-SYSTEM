import type { PmsRag } from "@/types/pms-manager";
import { cn } from "@/lib/utils";

/** Dot colour and label text colour per red / amber / green state. */
const RAG_META: Record<PmsRag, { label: string; dot: string; text: string }> = {
  on_track: { label: "On track", dot: "bg-emerald-500", text: "text-emerald-600" },
  at_risk: { label: "At risk", dot: "bg-amber-500", text: "text-amber-600" },
  off_track: { label: "Off track", dot: "bg-red-500", text: "text-red-600" },
};

/** Red / amber / green dot, with an optional label for places that can't rely on colour alone. */
export function RagDot({ rag, showLabel = false, className }: { rag: PmsRag; showLabel?: boolean; className?: string }) {
  const meta = RAG_META[rag];
  return (
    <span className={cn("inline-flex items-center gap-1.5", showLabel && meta.text, className)}>
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", meta.dot)} aria-hidden />
      {showLabel ? <span>{meta.label}</span> : <span className="sr-only">{meta.label}</span>}
    </span>
  );
}
