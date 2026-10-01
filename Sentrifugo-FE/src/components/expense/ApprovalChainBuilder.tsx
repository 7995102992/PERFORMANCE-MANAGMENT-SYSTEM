/**
 * Approval chain builder (`approval-chain-hld.md` §2, §4, §7).
 *
 * The chain is a **ladder of 1–5 rungs**. Nothing about it is hardcoded any
 * more: the reporting manager is one source among three, Finance is an ordinary
 * level that happens to draw on a permission, and the order is whatever the
 * admin put on screen. So this builder renders the whole ladder as editable —
 * there is no locked head to draw above it.
 *
 * Three operators live on this screen and they are deliberately kept apart,
 * because conflating any two of them yields a chain weaker or stronger than the
 * person configuring it believed:
 *
 *   - `quorum` acts **inside** one rung — one signature, or everybody's.
 *   - `levels_operator` acts **between** rungs — every rung, or any one rung.
 *   - `optional` lets the rung *before* an escalation **skip it**; it is the
 *     button an approver sees, not a property of who may sign. Skipping is per
 *     rung, not an exit — the claim still climbs to the next mandatory rung, and
 *     only a skippable tail settles.
 *
 * Sequencing is not a fourth control. It falls out of `and`: an `and` chain is
 * ordered, an `or` chain is a race, and the divider between the cards says which
 * one is on screen.
 *
 * Controlled throughout: the settings page owns the draft so it can diff it
 * against the saved chain for its dirty state and nav guard. What is fetched
 * here is only what a picker needs to render ids as names — org roles and the
 * employee directory — which is presentation, not state the page has a use for.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Info, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SearchableSelect, type Option } from '@/components/shared/SearchableSelect'
import { useGetRolesQuery } from '@/store/api/iamApi'
import { useGetLevelCandidatesMutation } from '@/store/api/expenseApi'
import { cn } from '@/lib/utils'
import type {
  ActorSnapshot,
  ApprovalLevel,
  ApprovalLevelPayload,
  LevelOperator,
  LevelSource,
  Quorum,
} from '@/types/expense'

/**
 * The server's ceiling, mirrored here.
 *
 * Mirrored rather than merely handled: a chain that only fails on save teaches
 * the admin the limit by punishing them for it, and the sixth rung they spent a
 * minute filling in is thrown away by the refusal.
 */
export const MAX_LEVELS = 5

/** The server's `name` bound. Enforced on the input so it cannot be exceeded. */
export const MAX_LEVEL_NAME = 40

const SOURCE_OPTIONS: { value: LevelSource; label: string; detail: string }[] = [
  {
    value: 'reporting_manager',
    label: "The claimant's reporting manager",
    detail:
      'Resolved from the claimant’s own reporting line when they submit, so it is a different person for every employee. There is nobody to name here, and naming anyone would be wrong for everyone else.',
  },
  {
    value: 'permission',
    label: 'Everyone holding a permission',
    detail:
      'Membership follows the permission, not a list. Grant or revoke it in IAM and this level changes with it — this is how Finance is normally configured.',
  },
  {
    value: 'roles',
    label: 'Everyone in a role',
    detail:
      'Membership follows the roles you pick. Somebody added to the role later can approve without this chain being touched.',
  },
]

/**
 * The permissions a level may draw its approvers from.
 *
 * **Only the approval grants**, not every code on the expense module. The others
 * are not merely irrelevant, they are dangerous as a source: `submit_expense` is
 * held by essentially every employee, so a level drawn from it means *anyone may
 * approve* — and it would look perfectly healthy here, with a large holder count
 * and no warning. `manage_expense_config` is the admin's own grant, which would
 * let whoever configures the chain approve against it.
 *
 * Mirrors `Perm` in `src/expense_common/enums.py`, and the same three the queue
 * treats as its floor (`SEEDED_APPROVAL_CODES`). The server accepts any string
 * here, so this list is the only thing narrowing it — a fourth approval code
 * added there has to be added here too, or it cannot be picked.
 */
const APPROVAL_PERMISSIONS: { value: string; label: string; detail: string }[] = [
  {
    value: 'expense_manager_approval',
    label: 'Manager approval',
    detail:
      'Everyone in the organisation holding the manager approval grant — not the claimant’s own manager. For that, use the reporting manager source instead.',
  },
  {
    value: 'expense_finance_approval',
    label: 'Finance approval',
    detail:
      'The money grant. It is also what lets an approver lower a claim’s approved amount, so a level here can both sign and adjust.',
  },
  {
    value: 'expense_l2_approval',
    label: 'Leadership approval',
    detail:
      'The senior grant, usually the rung an approver escalates to rather than one every claim climbs.',
  },
]

/**
 * The operator WITHIN one rung, worded as a sentence about people.
 *
 * Deliberately never reads "ANY"/"ALL". This and the levels operator are
 * different questions that look alike, and conflating them is how a chain ends
 * up weaker than the person who configured it believed — so neither is offered
 * as a bare boolean word.
 *
 * @param count How many people the rung resolves to, or `null` when that is not
 *   known (an unsaved edit, a `reporting_manager` rung). Interpolated into the
 *   `all` option because "All 4 must approve" is a fact an admin can check and
 *   "All of them" is not.
 */
function quorumOptions(count: number | null): { value: Quorum; label: string; detail: string }[] {
  return [
    {
      value: 'any',
      label: 'Any one of them',
      detail:
        'The first signature clears this level, so one person being on leave never holds a claim up.',
    },
    {
      value: 'all',
      label: 'All of them',
      detail: everyoneSigns(count),
    },
  ]
}

/**
 * "All of them", said with the actual number.
 *
 * The count lives here rather than in the option label on purpose. In the label
 * it changes under the admin as they add and remove people — and it has to be
 * phrased for every value, where `All 2 must approve` is simply bad English. The
 * explanation line only has to read well for the option actually chosen.
 *
 * @param count How many the level resolves to, or `null` when unknown — an
 *   unsaved edit, or a lookup that has not landed. Never rendered as a number,
 *   because a wrong one here misstates how many signatures a claim needs.
 */
function everyoneSigns(count: number | null): string {
  if (count === null) {
    return 'Everyone this level resolves to has to sign before the claim moves on.'
  }
  if (count === 2) {
    return 'Both of them have to sign before the claim moves on — two-person sign-off.'
  }
  return `All ${count} of them have to sign before the claim moves on.`
}

/**
 * The operator ACROSS levels, worded as the sentence it makes at the join.
 *
 * Read where it applies — between two rungs — rather than as a setting at the
 * top of the page. It is the one control on this screen that changes what the
 * whole chain means, and an admin should meet it at the point the meaning
 * changes. Written as sentences rather than "AND"/"OR" because conflating this
 * with a level's own quorum is how a chain ends up weaker than the person who
 * configured it believed.
 */
const OPERATOR_OPTIONS: { value: LevelOperator; label: string; detail: string }[] = [
  {
    value: 'and',
    label: 'AND — this level too, after the last',
    detail:
      'The claim climbs the ladder one rung at a time. Level 2 cannot act until level 1 has signed, and the claim is approved only once the last rung clears.',
  },
  {
    value: 'or',
    label: 'OR — either level alone is enough',
    detail:
      'The levels race: whichever one signs first approves the claim outright. Nothing is sequential, and nothing can be skipped, because no level has to run at all.',
  },
]

/** A rung the admin has just added — real, but not yet resolved by the server. */
function blankLevel(level: number): ApprovalLevel {
  return {
    level,
    name: `Level ${level}`,
    source: 'roles',
    role_ids: [],
    permission_code: null,
    user_ids: [],
    quorum: 'any',
    optional: false,
    can_verify: false,
    // Genuinely unknown until this chain is saved and re-resolved, which is
    // exactly what `null` means — never 0, which would claim the level is
    // already broken.
    holder_count: null,
    holder_names: [],
    blocked_reason: null,
  }
}

/**
 * The rung most orgs start with: the claimant's own manager. Used when a chain
 * arrives with no levels at all, so the ladder is never an empty box.
 */
export function defaultFirstLevel(): ApprovalLevel {
  return { ...blankLevel(1), name: 'Reporting Manager', source: 'reporting_manager' }
}

/**
 * Restore the two invariants the server enforces, after any edit that could
 * break them.
 *
 * `level` is positional — it is the rung's index, not an identity — so it is
 * rewritten on every reorder rather than carried around. And `optional` is
 * cleared wherever it has become meaningless: on the first rung, which has
 * nothing before it to decide whether to escalate, and throughout an `or`
 * chain, where any single level already ends the claim so "may end here" says
 * nothing. Both are refusals server-side; clearing them here keeps the draft
 * saveable instead of letting the admin discover it at the end.
 */
function normaliseLevels(
  levels: ApprovalLevel[],
  operator: LevelOperator,
): ApprovalLevel[] {
  return levels.map((lvl, i) => {
    const mayBeOptional = i > 0 && operator === 'and'
    const optional = mayBeOptional ? lvl.optional : false
    return lvl.level === i + 1 && lvl.optional === optional
      ? lvl
      : { ...lvl, level: i + 1, optional }
  })
}

/**
 * The PUT body's `levels`: ids only, and only the ids this source can carry.
 *
 * A `reporting_manager` rung still holding the roles it had a moment before the
 * admin switched its source would be refused, so the irrelevant fields are
 * dropped here rather than trusted to have been cleared upstream.
 */
export function toLevelPayloads(levels: ApprovalLevel[]): ApprovalLevelPayload[] {
  return levels.map((lvl, i) => ({
    level: i + 1,
    name: lvl.name.trim(),
    source: lvl.source,
    role_ids: lvl.source === 'roles' ? lvl.role_ids : [],
    permission_code:
      lvl.source === 'permission' ? lvl.permission_code?.trim() || null : null,
    user_ids: lvl.source === 'reporting_manager' ? [] : lvl.user_ids,
    quorum: lvl.quorum,
    optional: lvl.optional,
    // Sent explicitly rather than left to the server's default: an admin
    // *unticking* verification has to be a change the PUT carries, and an
    // omitted optional field is indistinguishable from one never touched.
    can_verify: lvl.can_verify ?? false,
  }))
}

/**
 * Why the draft cannot be saved yet, or null when it can.
 *
 * These are the same shape checks the server runs at save, done here only so
 * the admin is stopped before a round trip. The server's copy stays the
 * authority and its refusals are rendered verbatim by the page — this is a
 * courtesy, not a second rulebook.
 */
export function chainProblem(
  approvalRequired: boolean,
  levels: ApprovalLevel[],
): string | null {
  // Nothing about the ladder matters when no approval runs, and blocking the
  // save on a level the admin has just switched off would be a trap.
  if (!approvalRequired) return null
  if (levels.length === 0) return 'Add at least one level, or turn approval off.'
  if (levels.length > MAX_LEVELS) {
    return `A chain can have at most ${MAX_LEVELS} levels.`
  }
  for (const [i, lvl] of levels.entries()) {
    const where = `Level ${i + 1}`
    if (!lvl.name.trim()) return `${where} needs a name.`
    if (lvl.name.trim().length > MAX_LEVEL_NAME) {
      return `${where}'s name is longer than ${MAX_LEVEL_NAME} characters.`
    }
    if (lvl.source === 'roles' && lvl.role_ids.length === 0) {
      return `${where} draws on roles but names none — pick at least one.`
    }
    if (lvl.source === 'permission' && !lvl.permission_code?.trim()) {
      return `${where} draws on a permission but names none — pick one.`
    }
  }
  return null
}

/**
 * The separator between two rungs, spelling out `levels_operator` in the gap
 * the claim actually travels through.
 *
 * "and then" rather than a bare "and": the ordering is the half of `and` an
 * admin is most likely to miss, and this is the only place on screen that shows
 * it, since sequencing has no control of its own.
 */
/**
 * The join between two rungs — and the control that decides what it means.
 *
 * One operator governs the whole ladder, so every join edits the same value and
 * they all move together. That is the model, not a limitation of the UI: `and`
 * and `or` are a property of the chain, and a ladder where rung 1→2 was `and`
 * while 2→3 was `or` would need precedence rules no admin should have to hold in
 * their head.
 *
 * Rendered on every join anyway, rather than once, because this reads as a
 * sentence: *Manager, AND this level too, after the last, Finance.*
 */
function OperatorDivider({
  operator,
  onChange,
  disabled,
}: {
  operator: LevelOperator
  onChange: (operator: LevelOperator) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <Select
        value={operator}
        disabled={disabled}
        onValueChange={(value) => onChange(value as LevelOperator)}
      >
        <SelectTrigger
          className="h-7 w-auto gap-2 border-dashed px-3 text-[11px] font-medium"
          aria-label="How this level combines with the one before it"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPERATOR_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  )
}

/**
 * Keep already-chosen ids selectable and legible.
 *
 * Both pickers are backed by a *current* list — active roles, one page of
 * directory hits — while the draft may hold an id that list does not contain: a
 * role since deactivated, somebody beyond the search results. Dropping those
 * would silently rewrite the chain the admin opened, so they are appended,
 * labelled from whatever name has been seen and otherwise by their raw id.
 */
function withSelected(
  options: Option[],
  selected: string[],
  labels?: Map<string, string>,
): Option[] {
  const present = new Set(options.map((o) => o.value))
  const missing = selected
    .filter((id) => id && !present.has(id))
    .map((id) => ({ value: id, label: labels?.get(id) ?? id }))
  return missing.length ? [...options, ...missing] : options
}

/**
 * What a level names, as a cache key — or `''` when it names nothing yet.
 *
 * Deliberately excludes `user_ids`: the narrowing is a *subset of* the candidate
 * set, not an input to it, so picking people must not invalidate the very list
 * being picked from. Excludes the level's number and name too, so reordering the
 * ladder or renaming a rung refetches nothing.
 */
function membershipKey(level: ApprovalLevel): string {
  if (level.source === 'reporting_manager') return ''
  if (level.source === 'permission') {
    return level.permission_code ? `permission:${level.permission_code}` : ''
  }
  return level.role_ids.length ? `roles:${[...level.role_ids].sort().join(',')}` : ''
}

/**
 * The level as a *question about membership*, stripped of everything else.
 *
 * Not {@link toLevelPayloads}, and the difference is load-bearing. That builds
 * the level to **save**; this builds a level to **ask about**, and the server
 * validates both the same way — so reusing the save shape makes a half-composed
 * rung fail validation instead of answering:
 *
 * - `level: 1` is forced, because a lone level in a one-level chain must be
 *   rung 1 — which means `optional` has to be dropped, since the server refuses
 *   an optional first rung. The Leadership rung is the *most* likely one to be
 *   narrowed, so keeping it would break exactly the common case.
 * - The name is a placeholder: a rung is routinely narrowed before it is named,
 *   and an empty name is refused.
 *
 * None of it affects the answer. Who a level resolves to depends on its source,
 * roles and permission code, and nothing else here.
 */
function candidateProbe(level: ApprovalLevel): ApprovalLevelPayload {
  return {
    level: 1,
    name: level.name.trim() || 'Level',
    source: level.source,
    role_ids: level.source === 'roles' ? level.role_ids : [],
    permission_code:
      level.source === 'permission' ? level.permission_code?.trim() || null : null,
    // Cleared here as well as on the server: the picker offers the set being
    // narrowed *from*, so sending the current selection asks the wrong question.
    user_ids: [],
    quorum: 'any',
    optional: false,
  }
}

/** This level's candidates, defaulting to "nothing to fetch" for a rung naming nobody. */
function candidateStateFor(
  cache: Record<string, CandidateState>,
  level: ApprovalLevel,
): CandidateState {
  const key = membershipKey(level)
  if (!key) return { people: [], loading: false, error: null }
  return cache[key] ?? { people: null, loading: true, error: null }
}

/**
 * The server's sentence for a failed candidate lookup.
 *
 * Falls back only when the envelope is not the shape this API always sends —
 * i.e. the request never reached the service. Substituting our own wording for a
 * refusal the server explained would throw away the one thing telling the admin
 * whether the role is unheld or the directory is down.
 */
function candidateFailure(err: unknown): string {
  const detail = (err as { data?: { detail?: unknown } } | undefined)?.data?.detail
  return typeof detail === 'string' && detail
    ? detail
    : 'Could not work out who holds this level. Nothing has been changed.'
}

/** Fields that decide *who* a level resolves to, and so invalidate its count. */
const MEMBERSHIP_KEYS = ['source', 'role_ids', 'permission_code', 'user_ids'] as const

interface ApprovalChainBuilderProps {
  approvalRequired: boolean
  levels: ApprovalLevel[]
  levelsOperator: LevelOperator
  onApprovalRequiredChange: (value: boolean) => void
  onLevelsChange: (levels: ApprovalLevel[]) => void
  onLevelsOperatorChange: (operator: LevelOperator) => void
  /**
   * The saved chain's sentence, straight from the server — or `null` to render no
   * preview at all.
   *
   * Rendered verbatim and never re-derived here: a client-side version of this
   * operator precedence would be a second implementation, free to drift from the
   * one that actually evaluates claims. That is exactly why it cannot follow the
   * draft, and why the caller passes `null` rather than a stale sentence whenever
   * there is nothing truly in effect to describe — an unconfigured subject, or an
   * edit in progress. A panel captioned *currently in effect* that disagrees with
   * the ladder above it is worse than no panel.
   */
  summary: string | null
  /** Locks the whole builder — e.g. while a save is in flight. */
  disabled?: boolean
}

export function ApprovalChainBuilder({
  approvalRequired,
  levels,
  levelsOperator,
  onApprovalRequiredChange,
  onLevelsChange,
  onLevelsOperatorChange,
  summary,
  disabled = false,
}: ApprovalChainBuilderProps) {
  const {
    data: roles = [],
    isLoading: rolesLoading,
    isError: rolesError,
  } = useGetRolesQuery()

  const roleOptions: Option[] = useMemo(
    () => roles.filter((r) => r.is_active).map((r) => ({ value: r.id, label: r.name })),
    [roles],
  )

  // ── Candidate sets, one per distinct membership ───────────────────────────
  //
  // Keyed by *what a level names* rather than by its position, so two levels
  // drawing on the same roles share one lookup and reordering the ladder does
  // not refetch anything. A level whose roles change gets a new key, which is
  // what makes the stale set fall away rather than having to be invalidated.
  const [fetchCandidates] = useGetLevelCandidatesMutation()
  const [candidates, setCandidates] = useState<Record<string, CandidateState>>({})
  const inFlight = useRef<Set<string>>(new Set())

  const load = useCallback(
    async (key: string, level: ApprovalLevel) => {
      if (inFlight.current.has(key)) return
      inFlight.current.add(key)
      setCandidates((prev) => ({
        ...prev,
        [key]: { people: prev[key]?.people ?? null, loading: true, error: null },
      }))
      try {
        const { candidates: people } = await fetchCandidates(candidateProbe(level)).unwrap()
        setCandidates((prev) => ({ ...prev, [key]: { people, loading: false, error: null } }))
      } catch (err) {
        // The server's own sentence — it distinguishes "nobody holds this" from
        // "IAM could not be reached", which look identical in a picker and lead
        // an admin to opposite conclusions.
        setCandidates((prev) => ({
          ...prev,
          [key]: {
            people: prev[key]?.people ?? null,
            loading: false,
            error: candidateFailure(err),
          },
        }))
      } finally {
        inFlight.current.delete(key)
      }
    },
    [fetchCandidates],
  )

  // Fetched eagerly rather than on the switch, so the control is usable the
  // moment it is reached: switching on pre-selects everyone, which needs the set
  // already in hand.
  useEffect(() => {
    for (const level of levels) {
      const key = membershipKey(level)
      if (!key || candidates[key]) continue
      void load(key, level)
    }
  }, [levels, candidates, load])

  /** `false` freezes the ladder rather than discarding it — see the banner. */
  const ladderDisabled = disabled || !approvalRequired

  function updateLevel(index: number, patch: Partial<ApprovalLevel>) {
    // Any change to *who* a level resolves to makes the server's count stale,
    // and a stale count is worse than none: it would report the holders of the
    // configuration the admin has just replaced. Drop back to `null` — unknown —
    // until the save returns re-resolved.
    const touchesMembership = MEMBERSHIP_KEYS.some((k) => k in patch)
    const next = levels.map((lvl, i) =>
      i !== index
        ? lvl
        : {
            ...lvl,
            ...patch,
            ...(touchesMembership
              ? { holder_count: null, holder_names: [], blocked_reason: null }
              : {}),
          },
    )
    onLevelsChange(normaliseLevels(next, levelsOperator))
  }

  /**
   * Switching a level's source clears what the new source cannot carry, so the
   * draft never holds values the server would refuse — and so an admin who
   * switches away and back does not silently resurrect an old role list.
   */
  function setSource(index: number, source: LevelSource) {
    updateLevel(index, {
      source,
      role_ids: source === 'roles' ? levels[index].role_ids : [],
      permission_code: source === 'permission' ? levels[index].permission_code : null,
      user_ids: source === 'reporting_manager' ? [] : levels[index].user_ids,
      // A reporting-manager rung is one person, so `all` and `any` say the same
      // thing — but the control that would let an admin see and change it is
      // hidden for exactly that reason. Leaving a stale `all` behind would put a
      // value in the payload that nothing on screen accounts for, so it is
      // normalised here rather than left to mean nothing quietly.
      quorum: source === 'reporting_manager' ? 'any' : levels[index].quorum,
    })
  }

  function addLevel() {
    if (levels.length >= MAX_LEVELS) return
    onLevelsChange(
      normaliseLevels([...levels, blankLevel(levels.length + 1)], levelsOperator),
    )
  }

  function removeLevel(index: number) {
    onLevelsChange(
      normaliseLevels(
        levels.filter((_, i) => i !== index),
        levelsOperator,
      ),
    )
  }

  /** Move a rung one place; `level` is renumbered by the normaliser. */
  function moveLevel(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= levels.length) return
    const next = [...levels]
    ;[next[index], next[target]] = [next[target], next[index]]
    onLevelsChange(normaliseLevels(next, levelsOperator))
  }

  /** Changing the operator can invalidate `optional`, so re-normalise with it. */
  function setOperator(operator: LevelOperator) {
    onLevelsOperatorChange(operator)
    onLevelsChange(normaliseLevels(levels, operator))
  }

  return (
    <div className="space-y-6">
      {/* ── Does approval run at all? ────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 rounded-xl border bg-card px-4 py-3">
        <div className="min-w-0">
          <Label htmlFor="approval-required" className="text-sm font-medium">
            Require approval
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {approvalRequired
              ? 'A submitted claim climbs the ladder below before it can be paid.'
              : 'No approval step at all. A submitted claim is approved the moment it arrives, and nobody is asked to sign anything.'}
          </p>
        </div>
        <Switch
          id="approval-required"
          checked={approvalRequired}
          onCheckedChange={onApprovalRequiredChange}
          disabled={disabled}
        />
      </div>

      {/* The ladder is kept, not wiped, when approval is switched off: doing so
          is usually temporary and must not cost the admin the chain they built.
          It is drawn inert so nobody mistakes it for something that runs. */}
      {!approvalRequired && levels.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed bg-muted/30 px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Approval is off, so none of these levels run — they are kept exactly
            as they are. Switch approval back on and the chain returns intact.
          </p>
        </div>
      )}

      <div
        className={cn(
          'space-y-6',
          !approvalRequired && 'pointer-events-none select-none opacity-50',
        )}
        aria-disabled={!approvalRequired}
      >
        {/* ── The rungs ────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Levels</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {levels.length} of {MAX_LEVELS} used.
            </p>
          </div>

          {rolesError && (
            <p className="text-xs text-destructive">
              The organisation&rsquo;s roles could not be loaded, so no role can
              be picked right now. Reload the page to try again.
            </p>
          )}

          {levels.map((lvl, index) => (
            <Fragment key={index}>
              {index > 0 && (
                <OperatorDivider
                  operator={levelsOperator}
                  onChange={setOperator}
                  disabled={ladderDisabled}
                />
              )}
              <LevelCard
                level={lvl}
                index={index}
                total={levels.length}
                skipsTo={skipDestination(levels, index)}
                verifies={verifyOrder(levels, index)}
                levelsOperator={levelsOperator}
                disabled={ladderDisabled}
                roleOptions={roleOptions}
                rolesLoading={rolesLoading}
                candidates={candidateStateFor(candidates, lvl)}
                onLoadCandidates={() => {
                  const key = membershipKey(lvl)
                  if (key) void load(key, lvl)
                }}
                onChange={(patch) => updateLevel(index, patch)}
                onSourceChange={(source) => setSource(index, source)}
                onMove={(delta) => moveLevel(index, delta)}
                onRemove={() => removeLevel(index)}
              />
            </Fragment>
          ))}

          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 border-dashed"
            disabled={ladderDisabled || levels.length >= MAX_LEVELS}
            onClick={addLevel}
          >
            <Plus className="size-4" /> Add level
          </Button>
          {levels.length >= MAX_LEVELS && (
            <p className="text-xs text-muted-foreground">
              A chain can have at most {MAX_LEVELS} levels. Remove one to add
              another.
            </p>
          )}
        </div>
      </div>

      {/* ── Preview ──────────────────────────────────────────────────────
          The server's own sentence for the chain as *saved*, written beside the
          code that evaluates claims so this page and the API cannot disagree
          about what a chain means. Absent unless something is genuinely in
          effect — see the `summary` prop. */}
      {summary && (
        <div className="rounded-xl border bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Currently in effect</p>
          <p className="mt-0.5 text-sm font-medium text-foreground">{summary}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Where a claim lands when this rung is skipped — or `null` when skipping it
 * ends the claim.
 *
 * **Skipping is per rung, not an exit.** The evaluator marks every skippable rung
 * nobody escalated to as `skipped` and hands the claim to the first *mandatory*
 * rung after them, so a run of skippable rungs collapses onto the next mandatory
 * one and only a skippable tail actually settles. Saying "approving ends the
 * claim" on a rung with something mandatory behind it tells an admin their
 * manager can settle claims outright, which the engine will refuse.
 */
function skipDestination(levels: ApprovalLevel[], index: number): string | null {
  const ahead = levels.slice(index + 1).findIndex((lvl) => !lvl.optional)
  if (ahead === -1) return null
  const at = index + 1 + ahead
  // Positional fallback: a rung being configured may not be named yet, and the
  // number is what its own header shows.
  return levels[at].name.trim() || `level ${at + 1}`
}

/**
 * Where this rung sits in the *verification* sequence, or null when it verifies
 * nothing.
 *
 * **The order is the ticked levels only, and levels are never renumbered for
 * it.** Untick level 1 and level 2 marks first — the sequence is a subsequence
 * of the ladder, so its position has to be counted rather than read off the
 * rung number. Getting that wrong on screen would tell an admin their Finance
 * rung marks third when the engine will ask it to mark first.
 */
function verifyOrder(
  levels: ApprovalLevel[],
  index: number,
): { position: number; total: number; after: string | null } | null {
  if (!levels[index].can_verify) return null
  const verifying = levels
    .map((lvl, i) => ({ lvl, i }))
    .filter(({ lvl }) => lvl.can_verify)
  const at = verifying.findIndex(({ i }) => i === index)
  const previous = at > 0 ? verifying[at - 1] : null
  return {
    position: at + 1,
    total: verifying.length,
    // Positional fallback: a rung being configured may not be named yet, and
    // the number is what its own header shows.
    after: previous ? previous.lvl.name.trim() || `level ${previous.i + 1}` : null,
  }
}

/** "1st", "2nd", "3rd" — the rung's place in a sequence, in plain English. */
function ordinal(n: number): string {
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

// ─── One rung ────────────────────────────────────────────────────────────────

interface LevelCardProps {
  level: ApprovalLevel
  index: number
  total: number
  /** See {@link skipDestination}. `null` means skipping this rung ends the claim. */
  skipsTo: string | null
  /** See {@link verifyOrder}. `null` means this rung marks nothing. */
  verifies: { position: number; total: number; after: string | null } | null
  levelsOperator: LevelOperator
  disabled: boolean
  roleOptions: Option[]
  rolesLoading: boolean
  /** This rung's own candidate set — see {@link NarrowToPeople}. */
  candidates: CandidateState
  onLoadCandidates: () => void
  onChange: (patch: Partial<ApprovalLevel>) => void
  onSourceChange: (source: LevelSource) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}

function LevelCard({
  level,
  index,
  total,
  skipsTo,
  verifies,
  levelsOperator,
  disabled,
  roleOptions,
  rolesLoading,
  candidates,
  onLoadCandidates,
  onChange,
  onSourceChange,
  onMove,
  onRemove,
}: LevelCardProps) {
  const isFirst = index === 0
  const source = level.source
  /** Only a level with org-wide membership can be narrowed, or needs to be. */
  const namesPeople = source !== 'reporting_manager'

  /**
   * How many people this rung resolves to, or `null` when that is not known.
   *
   * Prefers the candidate set, which is live and reflects the roles currently on
   * screen, over the server's `holder_count`, which describes the chain as
   * *saved* and is cleared to `null` the moment membership is edited. `null` is
   * never rendered as a number — see {@link ApprovalLevel.holder_count}.
   */
  const resolvedCount = candidates.people
    ? narrowedCount(level, candidates.people)
    : level.holder_count
  const quorum = quorumOptions(resolvedCount)

  /**
   * Why `optional` cannot be set here, or null when it can.
   *
   * Shown beside the disabled switch rather than left to the save: both of these
   * are refusals, and a control that is off for a reason the admin cannot see
   * reads as a broken screen rather than as a rule.
   */
  const optionalBlockedBecause = isFirst
    ? 'Level 1 has nothing before it, so there is no approver who could choose to skip it.'
    : levelsOperator === 'or'
      ? 'In an any-one-level chain every level already ends the claim on its own, so there is nothing to skip.'
      : null

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* ── Header: what this rung is called, and where it sits ─────────── */}
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="shrink-0 rounded-full border bg-muted/50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Level {index + 1}
        </span>
        <Input
          value={level.name}
          maxLength={MAX_LEVEL_NAME}
          disabled={disabled}
          aria-label={`Name for level ${index + 1}`}
          placeholder="Name this level"
          className="h-8 max-w-[280px]"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {level.optional && (
          <span className="shrink-0 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
            Can be skipped
          </span>
        )}
        {verifies && (
          <span className="shrink-0 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
            {verifies.total > 1
              ? `Verifies ${ordinal(verifies.position)}`
              : 'Verifies'}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Move level ${index + 1} up`}
            disabled={disabled || isFirst}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Move level ${index + 1} down`}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Remove level ${index + 1}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        <div className="grid gap-4 md:grid-cols-2">
          {/* ── Where the approvers come from ──────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor={`level-source-${index}`}>Approvers come from</Label>
            <Select
              value={source}
              disabled={disabled}
              onValueChange={(value) => onSourceChange(value as LevelSource)}
            >
              <SelectTrigger id={`level-source-${index}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {SOURCE_OPTIONS.find((o) => o.value === source)?.detail}
            </p>
          </div>

          {/* ── The operator WITHIN this rung ────────────────────────────
              Hidden whenever the rung can only ever resolve to one person, where
              the two options mean the same thing. Offering a choice that cannot
              change anything invites an admin to believe it did.

              Two ways that happens, and the first is not a special case of the
              second: a `reporting_manager` rung is *one person by construction* —
              the claimant's own manager — and it has no org-wide count at all, so
              it arrives here as `0` rather than `1`. The other is a rung that
              currently resolves to exactly one holder, which is a fact about
              today's org chart and may stop being true tomorrow. */}
          {namesPeople && resolvedCount !== 1 && (
            <div className="space-y-1.5">
              <Label htmlFor={`level-quorum-${index}`}>How many must sign</Label>
              <Select
                value={level.quorum}
                disabled={disabled}
                onValueChange={(value) => onChange({ quorum: value as Quorum })}
              >
                <SelectTrigger id={`level-quorum-${index}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {quorum.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {quorum.find((o) => o.value === level.quorum)?.detail}
              </p>
            </div>
          )}
        </div>

        {/* ── Source-specific membership ──────────────────────────────────
            Hidden, not merely ignored, for `reporting_manager`: that source
            resolves per claimant and the server refuses roles, a permission code
            or named users alongside it, so offering those controls would be
            offering a save that cannot succeed. */}
        {source === 'roles' && (
          <div className="space-y-1.5">
            <Label>Roles</Label>
            <SearchableSelect
              multi
              options={withSelected(roleOptions, level.role_ids)}
              value={level.role_ids}
              onChange={(value) => onChange({ role_ids: value as string[] })}
              placeholder="Select one or more roles"
              emptyMessage="No roles found."
              disabled={disabled}
              loading={rolesLoading}
            />
            <p className="text-xs text-muted-foreground">
              Anyone holding any of these roles approves at this level.
            </p>
          </div>
        )}

        {source === 'permission' && (
          <div className="space-y-1.5">
            <Label htmlFor={`level-permission-${index}`}>Permission</Label>
            <Select
              value={level.permission_code ?? ''}
              disabled={disabled}
              onValueChange={(value) => onChange({ permission_code: value })}
            >
              <SelectTrigger
                id={`level-permission-${index}`}
                className="w-full max-w-[420px]"
              >
                <SelectValue placeholder="Pick an approval permission" />
              </SelectTrigger>
              <SelectContent>
                {APPROVAL_PERMISSIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {APPROVAL_PERMISSIONS.find((o) => o.value === level.permission_code)
                ?.detail ??
                'Whoever holds this permission approves at this level, resolved live — a grant made tomorrow takes effect tomorrow.'}
            </p>
            {/* An existing chain may name something not on this list — a code
                since retired, or one typed in when this was a free-text field.
                Said plainly rather than silently reset: changing who may approve
                company spending is the admin's decision, not a side effect of
                opening the page. */}
            {level.permission_code &&
              !APPROVAL_PERMISSIONS.some((o) => o.value === level.permission_code) && (
                <p className="text-xs text-warning">
                  This level currently names{' '}
                  <span className="font-mono">{level.permission_code}</span>, which
                  is not one of the approval permissions. Pick one above to replace
                  it; until then it stays exactly as it is.
                </p>
              )}
          </div>
        )}

        {namesPeople && (
          <NarrowToPeople
            level={level}
            candidates={candidates}
            disabled={disabled}
            onLoad={onLoadCandidates}
            onChange={onChange}
          />
        )}

        {/* ── The early exit ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <Label
              htmlFor={`level-optional-${index}`}
              className={cn(
                'text-sm font-medium',
                optionalBlockedBecause && 'text-muted-foreground',
              )}
            >
              The level before may skip this level
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {optionalBlockedBecause ??
                (level.optional
                  ? `Level ${index} sees a Send to ${
                      level.name.trim() || `level ${index + 1}`
                    } button beside Approve and chooses which to press. Approving there ${
                      skipsTo
                        ? `passes the claim straight to ${skipsTo} without this level seeing it`
                        : 'ends the claim without this level ever seeing it'
                    }.`
                  : `Level ${index} cannot skip ahead — everything it approves comes here next.`)}
            </p>
          </div>
          <Switch
            id={`level-optional-${index}`}
            checked={level.optional}
            onCheckedChange={(checked) => onChange({ optional: checked })}
            disabled={disabled || !!optionalBlockedBecause}
          />
        </div>

        {/* ── Verifying trip expenses ────────────────────────────────────────
            Not a second kind of approval. Approving is what this rung does to
            the record in front of it; verifying is what it does to the
            *expenses filed under a trip*, which are never submitted one at a
            time once anybody verifies. The two are set independently because a
            level can do either, both, or neither. */}
        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <Label htmlFor={`level-can-verify-${index}`} className="text-sm font-medium">
              Can verify and mark
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {verifies
                ? `This level marks trip expenses ${
                    verifies.total > 1
                      ? `${ordinal(verifies.position)} of ${verifies.total}`
                      : 'itself'
                  }${verifies.after ? `, once ${verifies.after} has marked them` : ''}. An expense every verifying level has marked can be settled with its trip in one action.`
                : 'This level plays no part in verifying trip expenses. With nobody ticked here, a trip expense is submitted on its own exactly as it is today.'}
            </p>
          </div>
          <Switch
            id={`level-can-verify-${index}`}
            checked={level.can_verify ?? false}
            onCheckedChange={(checked) => onChange({ can_verify: checked })}
            disabled={disabled}
          />
        </div>

        <LevelResolution level={level} />
      </div>
    </div>
  )
}

/**
 * The server's live read on one rung: who it resolves to, and what blocks it.
 *
 * `holder_count` carries three distinct answers and each gets its own rendering.
 * `null` is *unknown* — always so for a reporting-manager rung, which has no
 * org-wide membership to count, and also for a rung edited since the last save.
 * Printing "0 holders" for either would tell an admin their perfectly ordinary
 * level 1 is broken. `0` is the real finding: nobody resolves, and a claim that
 * reaches this rung stops there for good.
 */
function LevelResolution({ level }: { level: ApprovalLevel }) {
  const sample = level.holder_names.filter(Boolean)

  return (
    <div className="space-y-2">
      {level.source === 'reporting_manager' ? (
        // Not unknown by accident — there is no number to give. Say so, rather
        // than leaving a gap that reads as a lookup that failed.
        <p className="text-xs text-muted-foreground">
          Resolved per claimant from their own reporting line, so there is no
          org-wide count to show here.
        </p>
      ) : level.holder_count === 0 ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">
            Nobody resolves to this level right now, so a claim that reaches it
            can never be approved. Widen it, or grant the role or permission to
            someone.
          </p>
        </div>
      ) : level.holder_count === null ? null : (
        <p className="text-xs text-muted-foreground">
          {level.holder_count === 1
            ? '1 person can approve here'
            : `${level.holder_count} people can approve here`}
          {sample.length > 0 && (
            // A sample, said out loud — the count above is the truth, and reading
            // this handful as the eligible set is how an admin concludes the
            // wrong people are on a level.
            <span> — including {sample.join(', ')}</span>
          )}
          .
        </p>
      )}

      {level.blocked_reason && (
        <div
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          {/* The server's own sentence. It names the role, the permission or the
              person, and that naming is the fix. */}
          <p className="text-xs text-warning">{level.blocked_reason}</p>
        </div>
      )}
    </div>
  )
}

// ─── Narrowing a rung to named people ────────────────────────────────────────

/** One rung's candidate set, and how the fetch for it is going. */
interface CandidateState {
  /** Everyone the rung resolves to, before narrowing. `null` until fetched. */
  people: ActorSnapshot[] | null
  loading: boolean
  /** The server's own sentence when the lookup failed. Never a substitute. */
  error: string | null
}

/**
 * What to call a person on screen — their name, or the id if IAM sent none.
 *
 * Never fabricates: an id is ugly, and it is still the truth. A blank chip an
 * admin cannot tell from the next blank chip is worse.
 */
function personName(person: ActorSnapshot): string {
  return person.name?.trim() || person.id
}

/**
 * The employee code, when there is one to show.
 *
 * Rendered only when present — see {@link ActorSnapshot.emp_code}. IAM does not
 * send it yet, so the common case today is `null`, and the chip must read
 * correctly without it rather than showing a dangling separator.
 */
function personCode(person: ActorSnapshot): string | null {
  return person.emp_code?.trim() || null
}

/**
 * How many people a rung actually resolves to, narrowing applied.
 *
 * Intersects, exactly as the server does, so the number on screen is the number
 * that will really be eligible. A name that no longer holds the role counts for
 * nothing here — which is the whole point.
 */
function narrowedCount(level: ApprovalLevel, candidates: ActorSnapshot[]): number {
  if (!level.user_ids.length) return candidates.length
  const named = new Set(level.user_ids)
  return candidates.filter((person) => named.has(person.id)).length
}

/**
 * Optionally narrow a rung to specific people **inside** the set it resolves to.
 *
 * A deliberate trade: it reintroduces exactly the brittleness roles exist to
 * avoid, so it is opt-in per rung and off by default.
 *
 * **The picker offers only the rung's own candidates.** The server *intersects*
 * — it never unions — so a name that does not hold the rung's roles is dropped
 * silently, and the rung quietly resolves to fewer approvers than intended, or
 * to nobody. An org-wide people search would make that state one click away;
 * choosing from the candidates makes it unrepresentable.
 *
 * Two behaviours worth stating, both borrowed from payroll's tab because both
 * are the kind of thing that is only obviously right once someone has got it
 * wrong:
 *
 * - Switching **on** pre-selects everyone, so the rung's meaning does not change
 *   the instant the switch is touched. The admin then removes people.
 * - Switching **off** clears rather than remembers. A hidden filter that returns
 *   when somebody re-enables the switch months later is a trap.
 */
function NarrowToPeople({
  level,
  candidates,
  disabled,
  onLoad,
  onChange,
}: {
  level: ApprovalLevel
  candidates: CandidateState
  disabled: boolean
  onLoad: () => void
  onChange: (patch: Partial<ApprovalLevel>) => void
}) {
  const limiting = level.user_ids.length > 0
  const people = candidates.people ?? []

  /**
   * Named ids that are not in the candidate set any more.
   *
   * The server drops these silently, so without saying so the rung would just
   * get quietly smaller than the admin believes. Shown as a finding rather than
   * cleaned up automatically: removing somebody from an approval chain is the
   * admin's decision, not a side effect of opening the page.
   */
  const stranded = candidates.people
    ? level.user_ids.filter((id) => !people.some((person) => person.id === id))
    : []

  function toggleLimiting(on: boolean) {
    // Off clears rather than remembers; on pre-selects everyone so the rung's
    // meaning does not change the instant the switch is touched.
    onChange({ user_ids: on ? people.map((person) => person.id) : [] })
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 px-3 py-2.5">
      <label className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Switch
          checked={limiting}
          onCheckedChange={toggleLimiting}
          // Held until the candidates are in hand: switching on pre-selects them,
          // so flipping it early would turn "everyone" into "nobody" — the one
          // state that makes a level unclearable.
          disabled={disabled || !candidates.people}
        />
        Limit to specific people
      </label>

      {!limiting && (
        <p className="text-xs text-muted-foreground">
          Off, everyone the source above resolves to may approve. Turning it on
          filters that list — it never adds anyone.
        </p>
      )}

      {candidates.loading && (
        <p className="text-xs text-muted-foreground">Looking up who holds this…</p>
      )}

      {/* Verbatim. "Nobody holds this" and "we could not ask" look identical in a
          picker, and the server distinguishes them so the admin does not have to
          guess which one they are looking at. */}
      {candidates.error && (
        <div className="space-y-1">
          <p className="text-xs text-destructive">{candidates.error}</p>
          <button
            type="button"
            onClick={onLoad}
            className="text-xs font-medium underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      )}

      {limiting && candidates.people && (
        <>
          {people.length === 0 ? (
            <p className="text-xs text-destructive">
              This level resolves to nobody right now, so there is no one to
              narrow it to.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {people.map((person) => {
                const picked = level.user_ids.includes(person.id)
                return (
                  <button
                    key={person.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={picked}
                    // Spelled out because the icon alone is ambiguous to a screen
                    // reader: an X on a chip could mean "remove" or "not included".
                    aria-label={[
                      picked ? 'Remove' : 'Add',
                      personName(person),
                      personCode(person),
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() =>
                      onChange({
                        user_ids: picked
                          ? level.user_ids.filter((id) => id !== person.id)
                          : [...level.user_ids, person.id],
                      })
                    }
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                      picked
                        ? 'border-primary/30 bg-primary/10 text-foreground hover:border-destructive/40 hover:bg-destructive/10'
                        : 'bg-card text-muted-foreground hover:bg-muted',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <span>{personName(person)}</span>
                    {/* The code, and only when IAM supplied one. Muted because it
                        disambiguates rather than identifies — two Anita Desais
                        are told apart by it, but nobody reads the list by code. */}
                    {personCode(person) && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {personCode(person)}
                      </span>
                    )}
                    {/* The icon names the *action*, not the state — the colour
                        already carries the state. A tick would say "included",
                        which an admin can see, and leave them guessing what a
                        click does. */}
                    {picked ? (
                      <X className="size-3 shrink-0 opacity-60" aria-hidden />
                    ) : (
                      <Plus className="size-3 shrink-0 opacity-60" aria-hidden />
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {stranded.length > 0 && (
            <p className="text-xs text-warning">
              {stranded.length === 1
                ? 'One named person no longer holds'
                : `${stranded.length} named people no longer hold`}{' '}
              what this level draws from, so they are already not approvers — the
              server intersects, and drops them. Saving removes them from the chain.
            </p>
          )}

        </>
      )}
    </div>
  )
}
