/**
 * Rendering side of {@link RichTextEditor}.
 *
 * Anything the editor produces is author-supplied HTML, so it is sanitised on
 * the way out — never handed to `dangerouslySetInnerHTML` raw.
 *
 * Two variants: `inline` (default) strips block tags, for values shown inside
 * table cells and dialog headers; `block` keeps paragraphs and lists, for a
 * body of text.
 *
 * Plain strings saved before the editor existed render as plain text, newlines
 * intact — an announcement written last month must still read correctly.
 */
import DOMPurify from "dompurify";
import { BLOCK_SANITIZE_CONFIG, INLINE_SANITIZE_CONFIG } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

interface Props {
  html?: string | null;
  className?: string;
  variant?: "inline" | "block";
  /** Defaults to a `<span>` so it can sit inside a heading or a table cell. */
  as?: "span" | "div" | "p";
}

export function RichText({
  html,
  className,
  variant = "inline",
  as: Tag = variant === "block" ? "div" : "span",
}: Props) {
  if (!html) return null;

  // Pre-editor content: no markup, so honour its newlines instead of
  // collapsing them the way HTML would.
  if (!html.includes("<")) {
    return (
      <Tag className={cn(variant === "block" && "whitespace-pre-wrap", className)}>
        {html}
      </Tag>
    );
  }

  // A paragraph wrapper is what the editor emits for a single line; unwrap it
  // inline so the text inherits the surrounding typography.
  const content =
    variant === "block" ? html : html.replace(/^<p>([\s\S]*)<\/p>$/i, "$1");

  return (
    <Tag
      className={cn(
        "[&_a]:text-primary [&_a]:underline [&_strong]:font-semibold",
        variant === "block" &&
          "[&_p]:my-0 [&_p+p]:mt-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-0.5",
        className,
      )}
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(
          content,
          variant === "block" ? BLOCK_SANITIZE_CONFIG : INLINE_SANITIZE_CONFIG,
        ),
      }}
    />
  );
}
