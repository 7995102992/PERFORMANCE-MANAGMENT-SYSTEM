/**
 * The participant conversation on a record (§11.4).
 *
 * **Both the list and the composer, on every role's view.** As drawn the panel
 * is input-only and Finance-only, which makes the thread useless: the claimant
 * can neither see the question nor answer it.
 *
 * Why this exists at all: without it, the only way an approver can ask "which
 * client was this for?" is to send the expense back — which resets it to draft,
 * releases its advance draw and forces a full resubmission. A comment leaves
 * the ledger byte-identical (§19.3). That contrast is the feature.
 *
 * Commentable at **any** status including SETTLED and REJECTED — a question
 * about settled money is exactly when the answer matters.
 */
import { useState } from 'react'
import { Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/expense-utils'
import {
  useCreateCommentMutation,
  useDeleteCommentMutation,
  useGetCommentsQuery,
} from '@/store/api/expenseApi'
import type { RecordStatus, SubjectType } from '@/types/expense'

const MAX_LENGTH = 2000

interface Props {
  subjectType: SubjectType
  subjectId: string
  /**
   * The record's status, so a terminal one closes the composer.
   *
   * The thread shuts to *new* comments once the record is finished — see
   * `CLOSED_STATUSES` — and the server enforces it with `COMMENT_THREAD_CLOSED`.
   * This only stops someone typing a comment that was always going to be
   * refused; omitting it leaves the composer open and the server still refuses,
   * so it is a courtesy rather than a control.
   *
   * Reading is never affected. Everything already said stays on screen.
   */
  status?: RecordStatus | null
}

/**
 * The statuses a record does not come back from, mirroring the server's
 * `THREAD_CLOSING_STATUSES`.
 *
 * Which one a subject reaches differs: an expense settles and is never `CLOSED`,
 * a trip and an advance close and never settle. `REJECTED` is shared.
 */
const CLOSED_STATUSES: RecordStatus[] = ['REJECTED', 'SETTLED', 'CLOSED']

/** The past-tense word for a shut thread's notice. */
const CLOSED_WORD: Partial<Record<RecordStatus, string>> = {
  REJECTED: 'rejected',
  SETTLED: 'settled',
  CLOSED: 'closed',
}

export function CommentThread({ subjectType, subjectId, status }: Props) {
  const closed = status != null && CLOSED_STATUSES.includes(status)
  const [body, setBody] = useState('')
  const { data: comments = [], isLoading } = useGetCommentsQuery({
    subjectType,
    subjectId,
  })
  const [createComment, { isLoading: sending }] = useCreateCommentMutation()
  const [deleteComment] = useDeleteCommentMutation()

  const send = async () => {
    const text = body.trim()
    if (!text) return
    try {
      await createComment({
        subject_type: subjectType,
        subject_id: subjectId,
        body: text,
      }).unwrap()
      setBody('')
    } catch {
      toast.error('Could not post that comment')
    }
  }

  const remove = async (commentId: string) => {
    try {
      await deleteComment({ commentId, subjectId }).unwrap()
    } catch {
      toast.error('Could not delete that comment')
    }
  }

  return (
    <div className="rounded-xl border bg-card px-5 py-4">
      <h3 className="mb-4 text-sm font-semibold text-foreground">Comments</h3>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/50" />
          ))}
        </div>
      )}

      {!isLoading && comments.length === 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          No comments yet. Ask a question here to keep the record moving — sending
          it back would reset it to a draft.
        </p>
      )}

      {/* Flat rows divided by a rule, matching the service-request thread: a
          card per comment boxed each one twice inside a card that already reads
          as the thread, and the nesting made a long conversation hard to scan. */}
      <div className="mb-4 space-y-4">
        {comments.map((c, idx) => {
          const divider = idx < comments.length - 1 ? 'border-b border-border pb-4' : ''
          return c.deleted ? (
            // A tombstone, not a disappearance: an approver who acted partly on
            // what a comment said must not find it silently gone.
            <div key={c.id} className={divider}>
              <p className="text-xs italic text-muted-foreground">
                Comment deleted by {c.author_name ?? 'the author'}
              </p>
            </div>
          ) : (
            <div key={c.id} className={cn('group', divider)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {c.author_name ?? 'Unknown'}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {c.author_role ? `${c.author_role} · ` : ''}
                    {formatDateTime(c.at)}
                  </p>
                </div>
                {c.can_delete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => remove(c.id)}
                    aria-label="Delete comment"
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                )}
              </div>
              {/* Rendered as text, never as markup. */}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
                {c.body}
              </p>
            </div>
          )
        })}
      </div>

      {/* A closed thread loses its composer, not its contents — the box is
          replaced rather than disabled, because a disabled textarea invites
          someone to work out why it will not take their text. */}
      {closed ? (
        <p className="rounded-lg border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          This {subjectType} is {(status && CLOSED_WORD[status]) ?? 'finished'}{' '}
          and its comment thread is closed. Everything above stays on the record.
        </p>
      ) : (
        // A labelled button below the box rather than a ghost icon floating
        // inside it, as the service-request thread has: the icon-in-textarea sat
        // where the text goes and said nothing about what it would do.
        <div className="space-y-2 pt-2">
          <Textarea
            className="min-h-[80px] resize-none"
            placeholder="Type your comment here..."
            maxLength={MAX_LENGTH}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!body.trim() || sending}
              onClick={send}
              aria-label="Post comment"
            >
              <Send />
              {sending ? 'Sending...' : 'Add Comment'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
