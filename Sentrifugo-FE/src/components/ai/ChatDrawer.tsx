import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BotIcon,
  CalendarDays,
  CalendarPlus,
  CheckIcon,
  ClipboardList,
  SendIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { sendAgentChat, confirmWorkflow } from "@/api/agent-chat";
import type { ChatMessage } from "@/types/agent-chat";
import { useAppSelector } from "@/store";

interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

const PROMPT_CARDS = [
  {
    icon: CalendarPlus,
    title: "Create a leave request",
    description: "Apply for time off with specific dates",
    prompt: "Create a leave request from [start date] to [end date]",
  },
  {
    icon: CalendarDays,
    title: "My current leaves",
    description: "View your approved and pending leave requests",
    prompt: "Show a list of my current leaves",
  },
  {
    icon: ClipboardList,
    title: "Pending approvals",
    description: "Review leaves waiting for your approval",
    prompt: "Show the list of leaves pending my approval",
  },
];

function RecommendationCard({ rec }: { rec: Record<string, unknown> }) {
  const recommendation = rec.recommendation as string | undefined;
  const risk = rec.risk_level as string | undefined;
  const summary = rec.summary as string | undefined;
  const confidence = rec.confidence as number | undefined;

  const riskColor =
    risk === "HIGH"
      ? "text-destructive bg-destructive/10 border-destructive/20"
      : risk === "MEDIUM"
        ? "text-badge-pending-text bg-badge-pending-bg border-badge-pending-text/20"
        : "text-success bg-success/10 border-success/20";

  return (
    <div className="mt-3 rounded-xl border bg-muted/40 p-4 text-xs space-y-2">
      <p className="font-semibold text-foreground uppercase tracking-wide text-[10px]">
        AI Recommendation
      </p>
      {recommendation && (
        <p
          className={cn(
            "inline-flex rounded-md px-2 py-0.5 font-bold border",
            riskColor,
          )}
        >
          {recommendation}
        </p>
      )}
      {risk && (
        <p className="text-muted-foreground">
          Risk: <span className="font-medium text-foreground">{risk}</span>
        </p>
      )}
      {confidence !== undefined && (
        <p className="text-muted-foreground">
          Confidence:{" "}
          <span className="font-medium text-foreground">
            {Math.round(confidence * 100)}%
          </span>
        </p>
      )}
      {summary && (
        <p className="text-muted-foreground leading-relaxed">{summary}</p>
      )}
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="max-w-[65%] space-y-1">
        <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
        <p className="text-[10px] text-muted-foreground text-right px-1">
          {message.timestamp.toLocaleTimeString("en-IN", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "Asia/Kolkata",
          })}
        </p>
      </div>
    </div>
  );
}

function AgentMessage({
  message,
  onConfirm,
  onCancel,
  confirming,
}: {
  message: ChatMessage;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirming?: boolean;
}) {
  return (
    <div className="px-4 py-4 flex gap-4 w-full hover:bg-muted/30 transition-colors">
      {/* Bot avatar */}
      <div className="flex-shrink-0 size-8 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
        <BotIcon className="size-4 text-primary" />
      </div>

      {/* Content — fills all remaining space */}
      <div className="flex-1 min-w-0 space-y-4">
        <div className="text-sm leading-relaxed text-foreground prose-custom">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => (
                <p className="mb-3 last:mb-0 leading-7">{children}</p>
              ),
              ul: ({ children }) => (
                <ul className="list-disc pl-5 mb-3 space-y-1.5">{children}</ul>
              ),
              ol: ({ children }) => (
                <ol className="list-decimal pl-5 mb-3 space-y-1.5">
                  {children}
                </ol>
              ),
              li: ({ children }) => (
                <li className="leading-relaxed">{children}</li>
              ),
              h1: ({ children }) => (
                <h1 className="text-xl font-bold mb-3 mt-4 first:mt-0">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className="text-base font-semibold mb-2 mt-4 first:mt-0">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-sm font-semibold mb-1.5 mt-3 first:mt-0">
                  {children}
                </h3>
              ),
              strong: ({ children }) => (
                <strong className="font-semibold text-foreground">
                  {children}
                </strong>
              ),
              em: ({ children }) => <em className="italic">{children}</em>,
              blockquote: ({ children }) => (
                <blockquote className="border-l-4 border-primary/40 pl-4 italic text-muted-foreground mb-3">
                  {children}
                </blockquote>
              ),
              code: ({ children, className }) => {
                const isBlock = Boolean(className?.includes("language-"));
                return isBlock ? (
                  <code
                    className={cn("block font-mono text-[0.82em]", className)}
                  >
                    {children}
                  </code>
                ) : (
                  <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground border border-border/50">
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => (
                <pre className="rounded-xl bg-muted border border-border p-4 overflow-x-auto font-mono text-[0.82em] mb-3">
                  {children}
                </pre>
              ),
              table: ({ children }) => (
                <div className="overflow-x-auto mb-3 rounded-lg border border-border">
                  <table className="w-full text-sm border-collapse">
                    {children}
                  </table>
                </div>
              ),
              thead: ({ children }) => (
                <thead className="bg-muted/60">{children}</thead>
              ),
              tbody: ({ children }) => <tbody>{children}</tbody>,
              tr: ({ children }) => (
                <tr className="border-b border-border/40 last:border-b-0">
                  {children}
                </tr>
              ),
              th: ({ children }) => (
                <th className="px-4 py-2.5 text-left font-semibold text-xs uppercase tracking-wide border-b border-border">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="px-4 py-2.5 text-sm">{children}</td>
              ),
              hr: () => <hr className="border-border my-4" />,
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        {message.recommendation && (
          <RecommendationCard rec={message.recommendation} />
        )}

        {message.missingFields && message.missingFields.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.missingFields.map((f) => (
              <span
                key={f}
                className="text-[11px] rounded-full bg-badge-pending-bg text-badge-pending-text border border-badge-pending-text/20 px-2.5 py-0.5 font-medium"
              >
                {f}
              </span>
            ))}
          </div>
        )}

        {message.status === "WAITING_FOR_CONFIRMATION" &&
          onConfirm &&
          onCancel && (
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8 text-xs gap-1.5 px-4"
                onClick={onConfirm}
                disabled={confirming}
              >
                <CheckIcon className="size-3" />
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs gap-1.5 px-4"
                onClick={onCancel}
                disabled={confirming}
              >
                <XCircleIcon className="size-3" />
                Cancel
              </Button>
            </div>
          )}

        <p className="text-[10px] text-muted-foreground">
          {message.timestamp.toLocaleTimeString("en-IN", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "Asia/Kolkata",
          })}
        </p>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onConfirm,
  onCancel,
  confirming,
}: {
  message: ChatMessage;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirming?: boolean;
}) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center my-2 px-4">
        <span className="text-[11px] text-muted-foreground bg-muted rounded-full px-3 py-0.5">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return <UserMessage message={message} />;
  }

  return (
    <AgentMessage
      message={message}
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirming={confirming}
    />
  );
}

export function ChatDrawer({ open, onClose }: ChatDrawerProps) {
  const { user } = useAppSelector((s) => s.auth);
  const firstName = user?.first_name ?? "there";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [nextActions, setNextActions] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addMessage = useCallback(
    (msg: Omit<ChatMessage, "id" | "timestamp">) => {
      setMessages((prev) => [
        ...prev,
        {
          ...msg,
          id:
            crypto.randomUUID?.() ??
            Math.random().toString(36).slice(2) + Date.now().toString(36),
          timestamp: new Date(),
        },
      ]);
    },
    [],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      setInput("");
      setNextActions([]);
      addMessage({ role: "user", content: trimmed });
      setLoading(true);

      try {
        const response = await sendAgentChat({
          message: trimmed,
          thread_id: threadId,
          channel: "WEB",
        });

        setThreadId(response.thread_id);
        addMessage({
          role: "agent",
          content: response.reply,
          threadId: response.thread_id,
          status: response.status,
          recommendation: response.recommendation,
          nextActions: response.next_actions,
          missingFields: response.missing_fields,
          leaveRequestId: response.leave_request_id,
        });

        if (response.next_actions && response.next_actions.length > 0) {
          setNextActions(response.next_actions);
        }
      } catch {
        addMessage({
          role: "system",
          content: "Something went wrong. Please try again.",
        });
      } finally {
        setLoading(false);
        textareaRef.current?.focus();
      }
    },
    [loading, threadId, addMessage],
  );

  const handleConfirm = useCallback(
    async (msgThreadId: string, confirmed: boolean) => {
      setConfirming(true);
      setNextActions([]);
      try {
        const result = await confirmWorkflow(msgThreadId, { confirmed });
        const resultMsg = (result as Record<string, unknown>).message as string;
        addMessage({
          role: "agent",
          content:
            resultMsg ??
            (confirmed
              ? "Leave confirmed and submitted successfully."
              : "Leave application cancelled."),
          status: confirmed ? "COMPLETED" : "CANCELLED",
        });
        if (confirmed) {
          setThreadId(null);
        }
      } catch {
        addMessage({
          role: "system",
          content: "Failed to process confirmation. Please try again.",
        });
      } finally {
        setConfirming(false);
      }
    },
    [addMessage],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="!w-[75vw] !max-w-[75vw] p-0 flex flex-col gap-0"
        showCloseButton={false}
      >
        {/* Header */}
        <SheetHeader className="flex-row items-center justify-between border-b px-5 py-3.5 gap-0 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-full bg-primary/10 flex items-center justify-center">
              <BotIcon className="size-5 text-primary" />
            </div>
            <div>
              <SheetTitle className="text-sm font-semibold leading-none">
                FugoAI
              </SheetTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {threadId
                  ? `Thread: ${threadId.slice(0, 8)}…`
                  : "AI-powered HRMS"}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XCircleIcon className="size-4" />
            <span className="sr-only">Close</span>
          </Button>
        </SheetHeader>

        {/* Messages / Welcome */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {messages.length === 0 ? (
            <div className="relative flex flex-col items-center justify-center h-full px-6 py-10 text-center gap-8 overflow-hidden">
              {/* Circular radial gradient blob */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="size-[420px] rounded-full bg-primary/10 blur-3xl" />
              </div>

              <div className="relative space-y-1.5">
                <h2 className="text-2xl font-semibold tracking-tight">
                  Hello {firstName} 👋
                </h2>
                <p className="text-muted-foreground text-sm">
                  How can I help you?
                </p>
              </div>

              <div className="relative w-full grid grid-cols-3 gap-3">
                {PROMPT_CARDS.map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.title}
                      onClick={() => {
                        setInput(card.prompt);
                        textareaRef.current?.focus();
                      }}
                      className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-3 py-5 text-center hover:bg-muted/50 hover:border-primary/30 transition-colors group"
                    >
                      <div className="size-11 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/15 transition-colors">
                        <Icon className="size-5 text-primary" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs font-semibold leading-snug">
                          {card.title}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          {card.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="py-2 divide-y divide-border/40">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onConfirm={
                    msg.status === "WAITING_FOR_CONFIRMATION" && msg.threadId
                      ? () => handleConfirm(msg.threadId!, true)
                      : undefined
                  }
                  onCancel={
                    msg.status === "WAITING_FOR_CONFIRMATION" && msg.threadId
                      ? () => handleConfirm(msg.threadId!, false)
                      : undefined
                  }
                  confirming={confirming}
                />
              ))}

              {loading && (
                <div className="px-4 py-4 flex gap-4">
                  <div className="flex-shrink-0 size-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <BotIcon className="size-4 text-primary" />
                  </div>
                  <div className="flex gap-1 items-center h-8 mt-0.5">
                    <span className="size-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                    <span className="size-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                    <span className="size-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Suggested actions */}
        {nextActions.length > 0 && !loading && messages.length > 0 && (
          <div className="px-5 py-3 border-t border-border flex flex-wrap gap-2">
            {nextActions.map((action) => (
              <button
                key={action}
                onClick={() => handleSend(action)}
                className="text-xs rounded-full border border-primary/30 bg-primary/5 text-primary px-3.5 py-1.5 hover:bg-primary/10 transition-colors font-medium"
              >
                {action}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="border-t px-4 py-3.5 flex gap-2.5 items-end flex-shrink-0">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Leave Assistant… (Enter to send, Shift+Enter for new line)"
            className="min-h-[44px] max-h-[160px] resize-none text-sm py-2.5"
            disabled={loading || confirming}
            rows={1}
          />
          <Button
            size="icon"
            onClick={() => handleSend(input)}
            disabled={!input.trim() || loading || confirming}
            className="flex-shrink-0 mb-0.5 size-10"
          >
            <SendIcon className="size-4" />
            <span className="sr-only">Send</span>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
