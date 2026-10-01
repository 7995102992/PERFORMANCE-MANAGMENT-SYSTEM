/**
 * Approval Settings (`approval-chain-hld.md` §7, §8, §12).
 *
 * One screen, one thing: the org's approval chains. Under the configurable
 * ladder there is nothing hardcoded left to explain — whether approval runs at
 * all, how many rungs there are, who is on each and in what order are all on
 * this page. Both routes behind it are gated on `manage_expense_config`, and the
 * endpoint check is the control; this page's presence in the nav is only a
 * convenience.
 *
 * **All three subjects are configurable here, and that is not cosmetic.** Chains
 * are keyed per subject, and an unconfigured subject does not fail — it falls
 * back to a single reporting-manager rung. So a page that could only reach
 * expenses left *advances*, which are cash out of the door, quietly approving on
 * one signature with no screen anywhere that would show it.
 *
 * The draft is held locally and PUT whole. Replacement, not patch: a partial
 * update of a *sequenced ladder* has no meaning an admin could predict — is a
 * posted level appended, or does it replace level 2?
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Copy, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/shared/EmptyState'
import { PageHeader } from '@/components/shared/PageHeader'
import {
  ApprovalChainBuilder,
  chainProblem,
  defaultFirstLevel,
  toLevelPayloads,
} from '@/components/expense/ApprovalChainBuilder'
import { useNavigationGuard } from '@/hooks/use-navigation-guard'
import { useConfirm } from '@/providers/confirm-dialog-provider'
import {
  useGetApprovalChainQuery,
  usePutApprovalChainMutation,
} from '@/store/api/expenseApi'
import type {
  ApprovalChain,
  ApprovalLevel,
  LevelOperator,
  SubjectType,
} from '@/types/expense'

/**
 * The subjects an org configures, in the order the tabs render.
 *
 * Each keeps its **own** chain, so an org can run a four-rung ladder on expenses
 * while trips clear on the manager alone. Switching tabs is switching documents,
 * not filtering one.
 */
const SUBJECTS: { value: SubjectType; label: string; hint: string }[] = [
  { value: 'expense', label: 'Expenses', hint: 'Who has to approve an expense claim, and in what order.' },
  { value: 'trip', label: 'Trips', hint: 'Who has to approve a trip before it is booked.' },
  { value: 'advance', label: 'Advances', hint: 'Who has to approve money paid out before it is spent.' },
]

// ─── Server errors ───────────────────────────────────────────────────────────

/**
 * A save failure, ready to render.
 *
 * `detail` is **always the server's own sentence**, never a substitute. Every
 * refusal this endpoint issues is specific and admin-actionable — which level
 * resolves to nobody, which role no longer exists, why `optional` cannot sit on
 * level 1 — and flattening those into "Something went wrong" would throw away
 * the only information that tells the admin what to do next (§12).
 */
interface ChainFailure {
  title: string
  detail: string
  /**
   * True only for the failures that are *not* the admin's fault: IAM could not
   * be reached, so the levels could not be resolved and nothing was changed.
   * Those get a Try again button rather than an instruction to correct a chain
   * that is already correct.
   */
  retryable: boolean
}

/** The service's code for "we could not check", keyed on rather than parsed. */
const CODE_VALIDATION_UNAVAILABLE = 'APPROVER_VALIDATION_UNAVAILABLE'

/** Pulls `{ detail, code }` out of the service's error envelope. */
function errorEnvelope(err: unknown): { detail: string | null; code: string | null } {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return { detail: data, code: null }
  const detail = (data as { detail?: unknown })?.detail
  const code = (data as { code?: unknown })?.code
  return {
    detail: typeof detail === 'string' ? detail : null,
    code: typeof code === 'string' ? code : null,
  }
}

function chainFailure(err: unknown): ChainFailure {
  const status = (err as { status?: unknown })?.status
  const { detail, code } = errorEnvelope(err)

  // 503 — IAM is unreachable, so the levels could not be resolved and the chain
  // was NOT saved. Transient, and emphatically not a verdict on the chain: tell
  // the admin to retry, not to go fix a configuration that is already right.
  if (code === CODE_VALIDATION_UNAVAILABLE || status === 503) {
    return {
      title: 'Could not resolve the approvers — nothing was saved',
      detail:
        detail ??
        'The directory is unreachable, so the levels you configured could not be checked. Nothing has been changed — try again in a few minutes.',
      retryable: true,
    }
  }

  // 403 — separation of duties, or the caller does not hold
  // `manage_expense_config` at all (§8.1).
  if (status === 403) {
    return {
      title: 'This change was refused',
      detail: detail ?? 'You are not allowed to edit the approval chain.',
      retryable: false,
    }
  }

  // 409 — another admin saved this org's chain in the meantime.
  if (status === 409) {
    return {
      title: 'The chain changed while you were editing',
      detail:
        detail ??
        'Someone else saved this organisation’s approval chain. Reload the page and re-apply your change.',
      retryable: false,
    }
  }

  // 400 / 422 — a level names a role that has gone, a permission nothing
  // grants, more levels than the ladder allows, or an `optional` rung where one
  // cannot sit. The server names the level; render exactly what it said.
  if (status === 400 || status === 422) {
    return {
      title: 'This chain was not saved',
      detail: detail ?? 'The chain was rejected. Check the levels above and try again.',
      retryable: false,
    }
  }

  // Anything else, including a dead connection — no verdict was reached, so
  // this is retryable too.
  return {
    title: 'Could not save the approval chain',
    detail: detail ?? 'The change did not reach the server. Please try again.',
    retryable: true,
  }
}

// ─── Draft helpers ───────────────────────────────────────────────────────────

/**
 * The saveable shape of a draft, as a comparable string.
 *
 * Deliberately built from the PUT payload rather than from the levels as held:
 * the live resolution the server attaches (`holder_count`, `holder_names`,
 * `blocked_reason`) is not part of what is saved, so a refetch that changes only
 * a holder count must not read as an unsaved edit.
 */
function draftKey(
  approvalRequired: boolean,
  levels: ApprovalLevel[],
  operator: LevelOperator,
): string {
  return JSON.stringify([approvalRequired, operator, toLevelPayloads(levels)])
}

function cloneLevels(levels: ApprovalLevel[]): ApprovalLevel[] {
  return levels.map((lvl) => ({
    ...lvl,
    role_ids: [...lvl.role_ids],
    user_ids: [...lvl.user_ids],
    holder_names: [...lvl.holder_names],
  }))
}

/**
 * The same levels, stripped of the resolution that belonged to another fetch.
 *
 * `holder_count`, `holder_names` and `blocked_reason` are **live server data
 * attached to the response they arrived on** — they describe the chain as saved
 * for *that* subject, at that moment. Carrying them into another subject's draft
 * would print counts and warnings this page never resolved, and they would sit
 * there looking authoritative until the next save.
 *
 * Cleared to *unknown* rather than to zero, which is the distinction the whole
 * resolution layer is built on: `null` means nobody has looked, `0` means nobody
 * holds it. Rendering the first as the second warns an admin that a chain they
 * just copied — correctly — can never clear. The builder refetches each rung's
 * candidates on its own and fills these back in.
 */
function copyLevels(levels: ApprovalLevel[]): ApprovalLevel[] {
  return cloneLevels(levels).map((lvl) => ({
    ...lvl,
    holder_count: null,
    holder_names: [],
    blocked_reason: null,
  }))
}

// ─── Copying a chain between subjects ────────────────────────────────────────

/**
 * One entry in the *Copy from* menu: another subject, and its chain.
 *
 * Fetched **per row, and only while the menu is open**. Every one of these is a
 * real `GET` that resolves holders live against IAM, so fetching all three with
 * the page would triple its load and let an outage on a subject the admin was not
 * looking at surface as a failure on one they were. No `skip` flag is needed for
 * that: the menu's content is unmounted while closed, so mounting *is* the
 * laziness — and a flag would risk the opposite failure, a row skipped on its
 * first render and stuck reading *Loading…* forever.
 *
 * A row that is still loading, that failed, or whose subject nobody has
 * configured renders as disabled with the reason on it — never as an absent row.
 * A menu that silently omits Trips is indistinguishable from one where Trips has
 * nothing to copy, and the admin cannot tell which without leaving the page.
 */
function CopySourceItem({
  subject,
  label,
  onPick,
}: {
  subject: SubjectType
  label: string
  onPick: (chain: ApprovalChain, label: string) => void
}) {
  const { data, isFetching, isError } = useGetApprovalChainQuery({ subject_type: subject })

  const unavailable = isFetching
    ? 'Loading…'
    : isError
      ? 'Could not be read just now'
      : !data
        ? 'Loading…'
        : !data.configured
          ? 'Not configured yet — nothing to copy'
          : null

  return (
    <DropdownMenuItem
      disabled={unavailable !== null}
      // `preventDefault` keeps a disabled row from closing the menu, so the
      // reason stays readable instead of vanishing on the click that asked for it.
      onSelect={(event) => {
        if (unavailable !== null || !data) {
          event.preventDefault()
          return
        }
        onPick(data, label)
      }}
      className="flex-col items-start gap-0.5 py-2"
    >
      <span className="text-sm font-medium text-foreground">{label}</span>
      {/* The server's own sentence for that chain — so the admin reads what they
          are about to import before importing it, not after. */}
      <span className="text-xs text-muted-foreground">
        {unavailable ?? data?.summary}
      </span>
    </DropdownMenuItem>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function ExpenseSettings() {
  const confirm = useConfirm()
  const [subject, setSubject] = useState<SubjectType>('expense')
  const {
    data: chain,
    isLoading,
    isError,
    refetch,
  } = useGetApprovalChainQuery({ subject_type: subject })
  const [saveChain, { isLoading: isSaving }] = usePutApprovalChainMutation()

  const [approvalRequired, setApprovalRequired] = useState(true)
  const [levels, setLevels] = useState<ApprovalLevel[]>([])
  const [levelsOperator, setLevelsOperator] = useState<LevelOperator>('and')
  const [failure, setFailure] = useState<ChainFailure | null>(null)

  // **Keyed by subject as well as content.** Two subjects sitting on identical
  // chains is the normal case for a fresh org — both default to a single
  // reporting-manager rung — and a content-only key would match across a switch,
  // skip the re-seed, and leave the draft holding the previous subject's state.
  const savedKey = chain
    ? `${subject}:${draftKey(chain.approval_required, chain.levels, chain.levels_operator)}`
    : null
  const [seededKey, setSeededKey] = useState<string | null>(null)

  /**
   * Seed the draft from the server, re-seeding only when the saved chain actually
   * changes.
   *
   * **Adjusted during render rather than in an effect.** This is server state the
   * admin then edits, and React's own answer to that is to compare against the
   * value last seeded and correct it in the render itself: the discarded render is
   * never committed, so nothing paints the stale ladder first. An effect commits
   * the previous subject's chain, then overwrites it a tick later — two paints and
   * a visible flash of the wrong ladder on every tab switch, which is what
   * `react-hooks/set-state-in-effect` is pointing at.
   *
   * The guard is **state, not a ref**, deliberately. A ref written during render
   * is invisible to the re-render React schedules, and under a replayed or
   * discarded render it would already read as set — so the seed would be skipped
   * and the draft would keep the previous subject's ladder, which is exactly the
   * bug this whole key exists to prevent.
   *
   * Keying on content as well as subject is what protects an edit in progress: a
   * refetch returning the same chain produces the same key and does nothing, where
   * a plain `[chain]` dependency would wipe the draft on every new response
   * object.
   */
  if (chain && savedKey !== seededKey) {
    setSeededKey(savedKey)
    setApprovalRequired(chain.approval_required)
    setLevels(cloneLevels(chain.levels))
    setLevelsOperator(chain.levels_operator)
  }

  const active = SUBJECTS.find((s) => s.value === subject) ?? SUBJECTS[0]
  const currentKey = draftKey(approvalRequired, levels, levelsOperator)
  const isDirty = savedKey !== null && `${subject}:${currentKey}` !== savedKey
  const problem = useMemo(
    () => chainProblem(approvalRequired, levels),
    [approvalRequired, levels],
  )

  useNavigationGuard(isDirty)

  /**
   * Turning approval back on with an empty ladder would leave the admin staring
   * at a validation error before they had done anything wrong, so the rung most
   * orgs start with is put there for them to edit or replace.
   */
  function handleApprovalRequiredChange(value: boolean) {
    setApprovalRequired(value)
    if (value && levels.length === 0) setLevels([defaultFirstLevel()])
  }

  /**
   * Switch subjects, refusing to carry a half-finished ladder across.
   *
   * `useNavigationGuard` cannot see this: the route does not change. And the
   * failure it would miss is worse than a lost edit — the draft state would stay
   * put while `subject` moved, so Save would write the ladder you built for
   * expenses onto trips, silently, and change who approves company travel.
   *
   * Deliberately the same dialog the guard raises, because it is the same
   * question. Answering "Stay" leaves the tab where it was.
   */
  function handleSubjectChange(next: SubjectType) {
    if (next === subject) return
    if (!isDirty) {
      setFailure(null)
      setSubject(next)
      return
    }
    confirm({
      title: 'Discard changes?',
      description:
        'You have unsaved changes to this approval chain. Switching will lose them.',
      confirmText: 'Discard and switch',
      cancelText: 'Stay',
      variant: 'destructive',
      onConfirm: () => {
        setFailure(null)
        setSubject(next)
      },
    })
  }

  function handleDiscard() {
    if (!chain) return
    setApprovalRequired(chain.approval_required)
    setLevels(cloneLevels(chain.levels))
    setLevelsOperator(chain.levels_operator)
    setFailure(null)
  }

  /**
   * Copy another subject's saved chain into this draft.
   *
   * **It fills the draft; it does not save.** The admin reviews the ladder on the
   * subject it now belongs to and presses Save, so a copy is reversible by
   * Discard and a wrong pick costs nothing. Writing straight through would apply
   * one subject's policy to another on a single click of a menu item.
   *
   * Nothing needs translating between subjects: chains are keyed per
   * `(org, subject)` but a level names roles, permissions and people — all
   * org-scoped — so a chain valid for expenses is valid for trips and advances by
   * construction. That is why this is a copy rather than a conversion.
   */
  function applyCopy(source: ApprovalChain, label: string) {
    const take = () => {
      setApprovalRequired(source.approval_required)
      setLevels(copyLevels(source.levels))
      setLevelsOperator(source.levels_operator)
      setFailure(null)
      toast.success(`Copied the ${label} chain`, {
        description: `Review it and press Save to apply it to ${active.label.toLowerCase()}. Nothing has been saved yet.`,
      })
    }

    // Same question the subject switcher and the navigation guard ask, and the
    // same dialog: a copy overwrites every rung, so a half-finished ladder would
    // go without warning.
    if (!isDirty) {
      take()
      return
    }
    confirm({
      title: 'Replace this chain?',
      description: `You have unsaved changes to the ${active.label.toLowerCase()} chain. Copying ${label} will replace every level.`,
      confirmText: 'Replace',
      cancelText: 'Keep editing',
      variant: 'destructive',
      onConfirm: take,
    })
  }

  async function handleSave() {
    setFailure(null)
    try {
      const saved = await saveChain({
        subject_type: subject,
        approval_required: approvalRequired,
        levels: toLevelPayloads(levels),
        levels_operator: levelsOperator,
      }).unwrap()
      // The server's `summary` is the saved chain's own sentence — echo that one
      // back so the confirmation describes what was actually stored.
      toast.success('Approval chain saved', { description: saved.summary })
    } catch (err) {
      const next = chainFailure(err)
      setFailure(next)
      toast.error(next.title, { description: next.detail })
    }
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Approval Settings"
        subtitle={active.hint}
        className="items-center"
        action={
          <div className="flex items-center gap-2">
            {/* Configure one subject, replicate it to the others. Offered even
                when nothing is configured yet: the menu says which subjects have
                nothing to copy, which is itself the answer to "why is this
                empty?" */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2" disabled={isSaving || !chain}>
                  <Copy className="size-4" /> Copy from
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Replace this chain with another subject's
                </DropdownMenuLabel>
                {SUBJECTS.filter((s) => s.value !== subject).map((s) => (
                  <CopySourceItem
                    key={s.value}
                    subject={s.value}
                    label={s.label}
                    onPick={applyCopy}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              onClick={handleDiscard}
              disabled={!isDirty || isSaving}
            >
              Discard
            </Button>
            <Button onClick={handleSave} disabled={!isDirty || !!problem || isSaving}>
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        }
      />

      {/* Switching tabs switches *documents* — each subject stores its own
          chain — so the dirty draft has to be dealt with first, exactly as it
          would be on leaving the page. */}
      <Tabs value={subject} onValueChange={(v) => handleSubjectChange(v as SubjectType)}>
        <TabsList>
          {SUBJECTS.map((s) => (
            <TabsTrigger key={s.value} value={s.value}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <Skeleton className="h-5 w-48" />
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : isError || !chain ? (
        // This endpoint never 404s — an org that has never opened this page gets
        // a default chain — so a failure here is the service being unreachable,
        // and there is nothing on screen to salvage.
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={AlertTriangle}
            variant="error"
            title="Could not load the approval chain"
            description="The expense service did not answer. Nothing has been changed."
            action={
              <Button variant="outline" className="gap-2" onClick={() => refetch()}>
                <RefreshCw className="size-4" /> Try again
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {failure && (
            <div
              className={
                failure.retryable
                  ? 'flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3'
                  : 'flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3'
              }
              role="alert"
            >
              <AlertTriangle
                className={
                  failure.retryable
                    ? 'size-4 shrink-0 text-warning mt-0.5'
                    : 'size-4 shrink-0 text-destructive mt-0.5'
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{failure.title}</p>
                {/* Verbatim. The server names the level, the role or the
                    structural fault, and that sentence is the fix. */}
                <p className="text-sm text-muted-foreground mt-0.5">{failure.detail}</p>
              </div>
              {failure.retryable && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 shrink-0"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  <RefreshCw className="size-3.5" /> Try again
                </Button>
              )}
            </div>
          )}

          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="border-b px-5 py-4">
              <h3 className="text-sm font-semibold text-foreground">Approval chain</h3>
              <p className="text-xs text-muted-foreground mt-1">
                A claim climbs up to five levels. Each one draws its approvers
                from the claimant&rsquo;s reporting line, from a permission, or
                from roles — Finance is simply a level configured on a
                permission, not a fixed step. Approvers never see the chain
                itself; they see only the buttons it produces. Records already in
                flight are unaffected: the chain is frozen onto a claim when it
                is submitted, so a change here cannot re-route one that has
                already set off.
              </p>
            </div>
            <div className="px-5 py-5">
              <ApprovalChainBuilder
                approvalRequired={approvalRequired}
                levels={levels}
                levelsOperator={levelsOperator}
                onApprovalRequiredChange={handleApprovalRequiredChange}
                onLevelsChange={setLevels}
                onLevelsOperatorChange={setLevelsOperator}
                // The chain as *saved*, in the server's own words. Not re-derived
                // from the draft: the sentence is generated beside the code that
                // evaluates claims precisely so the two can never disagree.
                // Only when something is genuinely in effect. `configured` false
                // means the server handed back the default it synthesises for a
                // subject nobody has set up — a sentence describing a chain no one
                // chose, and one that submit now refuses outright. A dirty draft is
                // excluded for the other reason: the sentence is server-generated,
                // so it would be describing the previous ladder, not the one on
                // screen.
                summary={chain.configured && !isDirty ? chain.summary : null}
                disabled={isSaving}
              />
            </div>
          </div>

          {problem ? (
            <p className="text-xs text-destructive">{problem}</p>
          ) : isDirty ? (
            <p className="text-xs text-muted-foreground">
              Unsaved changes. The sentence above still describes the chain that
              is live right now — it is rewritten by the server when you save.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
