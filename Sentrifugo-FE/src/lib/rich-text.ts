/**
 * Helpers for the rich text produced by `<RichTextEditor>`.
 *
 * Kept out of the component file so the plain-text helper can be imported by
 * validation schemas and dialog copy without dragging a component along.
 */
import DOMPurify from "dompurify";

/** Inline formatting only — no block tags, no images, no scripts. */
export const INLINE_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "s", "strike", "a", "br", "span"],
  ALLOWED_ATTR: ["href", "target", "rel"],
};

/** Inline marks plus paragraphs and lists — for a body of text. */
export const BLOCK_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    ...INLINE_SANITIZE_CONFIG.ALLOWED_TAGS,
    "p",
    "ul",
    "ol",
    "li",
  ],
  ALLOWED_ATTR: INLINE_SANITIZE_CONFIG.ALLOWED_ATTR,
};

/** Strips every tag — for `string`-typed slots (dialog copy, aria labels, exports). */
export function richTextToPlainText(html?: string | null): string {
  if (!html) return "";
  if (!html.includes("<")) return html.trim();
  const doc = new DOMParser().parseFromString(
    DOMPurify.sanitize(html),
    "text/html",
  );
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
