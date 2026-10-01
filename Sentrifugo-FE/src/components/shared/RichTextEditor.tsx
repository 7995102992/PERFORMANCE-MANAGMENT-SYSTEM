/**
 * A single-line rich text field, built on TipTap (`@tiptap/react`).
 *
 * Used where a value is *typed as a title* but wants emphasis — announcements
 * being the first. It deliberately offers inline marks only (bold, italic,
 * underline, strike, link): headings, lists and block quotes are switched off
 * because the value is rendered inside table cells and dialog headers, and
 * Enter is swallowed so a title can never become two paragraphs.
 *
 * The value is HTML. Render it with `<RichText>`, which sanitises it — this
 * component never trusts what comes back from the editor either.
 */
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Strikethrough,
  Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { richTextToPlainText } from "@/lib/rich-text";

interface Props {
  value: string;
  onChange: (html: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** Red outline, matching an `<Input>` in its error state. */
  invalid?: boolean;
  /** Counted against the plain text, not the markup. */
  maxLength?: number;
  disabled?: boolean;
  id?: string;
  ariaDescribedBy?: string;
  /** Height of the typing area — a Tailwind `min-h-*` class. */
  minHeightClass?: string;
  /**
   * Allow paragraphs and lists. Off by default, which is the single-line
   * variant used for values rendered inside table cells and dialog headers.
   */
  multiline?: boolean;
}

export function RichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  invalid,
  maxLength,
  disabled,
  id,
  ariaDescribedBy,
  minHeightClass = "min-h-9",
  multiline = false,
}: Props) {
  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: multiline ? undefined : false,
        orderedList: multiline ? undefined : false,
        listItem: multiline ? undefined : false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        hardBreak: multiline ? undefined : false,
        link: { openOnClick: false, autolink: true },
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: cn(
          "w-full whitespace-normal px-3 py-2 text-sm outline-none",
          multiline
            ? "[&_p]:my-0 [&_p+p]:mt-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5"
            : "[&_p]:m-0",
          minHeightClass,
        ),
        ...(id ? { id } : {}),
        ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
        ...(invalid ? { "aria-invalid": "true" } : {}),
      },
      // One line means one paragraph — Enter is not a formatting choice in the
      // single-line variant.
      handleKeyDown: (_view, event) => !multiline && event.key === "Enter",
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML()),
    onBlur: () => onBlur?.(),
  });

  // Re-populate when the form resets or an edit target loads. Guarded on the
  // current HTML so typing does not fight the effect.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (value !== current) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  if (!editor) return null;

  const plainLength = richTextToPlainText(value).length;
  const linked = editor.isActive("link");

  const toggleLink = () => {
    if (linked) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const href = window.prompt("Link URL", "https://");
    if (!href) return;
    editor.chain().focus().setLink({ href, target: "_blank", rel: "noopener noreferrer" }).run();
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-input bg-transparent shadow-xs focus-within:ring-1 focus-within:ring-ring",
        invalid && "border-destructive focus-within:ring-destructive",
        disabled && "opacity-50",
      )}
    >
      <div className="flex items-center gap-0.5 border-b bg-table-header px-1.5 py-1">
        <ToolbarButton
          label="Bold"
          icon={Bold}
          active={editor.isActive("bold")}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolbarButton
          label="Italic"
          icon={Italic}
          active={editor.isActive("italic")}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <ToolbarButton
          label="Underline"
          icon={Underline}
          active={editor.isActive("underline")}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        />
        <ToolbarButton
          label="Strikethrough"
          icon={Strikethrough}
          active={editor.isActive("strike")}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />
        <ToolbarButton
          label={linked ? "Remove link" : "Add link"}
          icon={linked ? Link2Off : Link2}
          active={linked}
          disabled={disabled}
          onClick={toggleLink}
        />

        {multiline && (
          <>
            <ToolbarButton
              label="Bulleted list"
              icon={List}
              active={editor.isActive("bulletList")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            />
            <ToolbarButton
              label="Numbered list"
              icon={ListOrdered}
              active={editor.isActive("orderedList")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            />
          </>
        )}

        {maxLength !== undefined && (
          <span
            className={cn(
              "ml-auto pr-1 text-xs tabular-nums text-muted-foreground",
              plainLength > maxLength && "text-destructive",
            )}
          >
            {plainLength}/{maxLength}
          </span>
        )}
      </div>

      <div className="relative">
        <EditorContent editor={editor} />
        {editor.isEmpty && placeholder && (
          <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
            {placeholder}
          </span>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-7", active && "bg-accent text-foreground")}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
