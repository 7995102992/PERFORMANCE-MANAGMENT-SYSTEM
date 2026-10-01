import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Network,
  Building2,
  ChevronRight,
  ChevronDown,
  Loader2,
  AlertCircle,
  Search,
  RotateCcw,
  Users,
  Minus,
  Plus,
  Maximize2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/EmptyState";
import { useAppSelector } from "@/store";
import {
  useGetEmployeeByUserIdQuery,
  useGetOrgStructureQuery,
  useGetOrgTreeQuery,
  useGetDirectReportsQuery,
  useGetReportingChainQuery,
  useGetEmployeesQuery,
  useGetDirectoryQuery,
} from "@/store/api/iamApi";
import { useAuth } from "@/hooks/use-auth";
import { permissionLevel } from "@/lib/permissions";
import type { GraphPerson, OrgTreeNode } from "@/types/iam";

/**
 * A 503 from /graph means the Neo4j projection is down — the chart is
 * temporarily unavailable, which is NOT the same as "this person has no
 * reports". Everything that renders graph data checks this first.
 */
function isGraphDown(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { status?: number }).status === 503
  );
}

function GraphUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      variant="warning"
      icon={AlertCircle}
      title="Chart temporarily unavailable"
      description="The org graph service isn't responding. Your data is safe — try again in a moment."
      action={
        <Button variant="outline" className="gap-2" onClick={onRetry}>
          <RotateCcw className="size-4" />
          Retry
        </Button>
      }
    />
  );
}

const personLabel = (p: { name: string | null; emp_code: string | null }) =>
  p.name?.trim() || p.emp_code || "Unlinked employee";

// ─── Shared line-tree primitives ─────────────────────────────────────────────

/** Vertical connector segment. */
const Stem = ({ className = "h-6" }: { className?: string }) => (
  <div className={`w-px shrink-0 bg-border ${className}`} />
);

/** Columns of siblings before wrapping — caps how wide one level can get. */
const PER_ROW = 3;

/**
 * A node with its direct reports grouped beneath it.
 *
 * One stem drops from the node into a single panel holding ALL its children;
 * inside that panel there are no connectors at all. Drawing a bar between
 * wrapped siblings made the second row look like it reported to the middle card
 * of the first — the panel says "everyone in this box is one level, under the
 * node above it" without any line to misread.
 */
function Branch({
  node,
  items,
}: {
  node: ReactNode;
  items?: ReactNode[];
}) {
  const count = items?.length ?? 0;
  return (
    <div className="flex flex-col items-center">
      {node}
      {count > 0 && (
        <>
          <Stem />
          <div className="rounded-xl border border-dashed border-border bg-muted/20 p-4">
            <div
              className="grid items-start gap-x-4 gap-y-6"
              style={{
                gridTemplateColumns: `repeat(${Math.min(count, PER_ROW)}, auto)`,
              }}
            >
              {items!.map((child, i) => (
                <div key={i} className="flex justify-center">
                  {child}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// The whole-org tree is several times wider than any viewport, so fit-to-width
// needs far more headroom than a single branch does.
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

/**
 * Scrollable canvas the charts are drawn on, with its own zoom. The zoom is a
 * CSS transform on the content, so it scales the drawing without re-laying it
 * out — the scroll container keeps working at every level.
 */
function ChartCanvas({
  children,
  toolbar,
  fitSignal,
}: {
  children: ReactNode;
  /** Extra controls rendered to the left of the zoom buttons. */
  toolbar?: ReactNode;
  /** Whenever this changes, zoom out just enough to fit the chart's width. */
  fitSignal?: unknown;
}) {
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const clamp = (z: number) =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

  /**
   * Fit-to-width. Measured from the rendered box rather than a node count, so it
   * works whatever the chart is showing. The measurement is divided back by the
   * current zoom to recover the chart's intrinsic width — `zoom` reflows, so a
   * raw reading would depend on the zoom it is about to set and the result
   * wouldn't be idempotent.
   */
  useEffect(() => {
    if (fitSignal === undefined) return;
    const frames: number[] = [];
    const next = (fn: () => void) => frames.push(requestAnimationFrame(fn));

    // One frame's grace so the swapped-in chart has laid out before measuring.
    next(() => {
      const box = scrollRef.current;
      const inner = contentRef.current;
      if (!box || !inner) return;
      const available = box.clientWidth - 48; // the p-6 padding
      setZoom((z) => {
        const intrinsic = inner.getBoundingClientRect().width / z;
        if (intrinsic <= 0 || available <= 0) return z;
        return clamp(intrinsic > available ? available / intrinsic : 1);
      });
      // Anything still too wide to fit (a big org bottoms out at ZOOM_MIN)
      // otherwise opens hard against its left edge, hiding the root. Two frames:
      // one for React to commit the zoom, one for the reflow it triggers.
      next(() =>
        next(() => {
          const el = scrollRef.current;
          if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
        }),
      );
    });
    return () => frames.forEach(cancelAnimationFrame);
  }, [fitSignal]);

  /**
   * Ctrl/⌘ + wheel zooms, and so does a trackpad pinch — browsers report pinch
   * as a wheel event with `ctrlKey` set, so both gestures land here.
   *
   * A plain wheel is deliberately left alone so the canvas can still be
   * scrolled. The listener is attached manually because React's onWheel is
   * passive, and a passive listener can't preventDefault the browser's own
   * page zoom.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) =>
        Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z - e.deltaY * 0.002) * 100) / 100)),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="relative h-full rounded-xl border bg-card">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
        {toolbar}
        <div className="flex items-center gap-0.5 rounded-lg border bg-card p-1 shadow-sm">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom((z) => clamp(z - ZOOM_STEP))}
          disabled={zoom <= ZOOM_MIN}
          aria-label="Zoom out"
        >
          <Minus className="size-4" />
        </Button>
        <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom((z) => clamp(z + ZOOM_STEP))}
          disabled={zoom >= ZOOM_MAX}
          aria-label="Zoom in"
        >
          <Plus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
          aria-label="Reset zoom"
        >
          <Maximize2 className="size-3.5" />
        </Button>
        </div>
      </div>

      <div ref={scrollRef} className="h-full overflow-auto p-6">
        {/* CSS `zoom`, not `transform: scale` — a transform shrinks the drawing
            but leaves its layout box at full size, which left a wide band of
            dead space either side of a zoomed-out chart. `zoom` reflows, so the
            scrollable area shrinks with the content. */}
        <div
          ref={contentRef}
          className="flex w-max min-w-full justify-center"
          style={{ zoom }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Structural chart: Business Unit → Department ────────────────────────────

function StructuralChart() {
  const { data, isLoading, isError, error, refetch } =
    useGetOrgStructureQuery();
  const [activeBu, setActiveBu] = useState<string>("");

  const units = useMemo(() => data ?? [], [data]);
  const selected =
    units.find((b) => b.business_unit_id === activeBu) ?? units[0];

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError) {
    return isGraphDown(error) ? (
      <GraphUnavailable onRetry={refetch} />
    ) : (
      <EmptyState
        variant="error"
        icon={AlertCircle}
        title="Failed to load the org structure"
        description="Please try again."
      />
    );
  }
  if (units.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No business units"
        description="Nothing has been mapped in the org structure yet."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* One tab per business unit. */}
      <div className="flex flex-wrap gap-1.5">
        {units.map((bu) => {
          const isActive = bu.business_unit_id === selected?.business_unit_id;
          return (
            <button
              key={bu.business_unit_id}
              type="button"
              onClick={() => setActiveBu(bu.business_unit_id)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                isActive
                  ? "border-primary/40 bg-primary/5 text-primary font-medium"
                  : "border-border bg-card text-muted-foreground hover:border-primary/30"
              }`}
            >
              {bu.business_unit || "—"}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">
        {selected && (
          <ChartCanvas>
            <Branch
              node={
                <div className="w-56 shrink-0 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <Building2 className="size-4 shrink-0 text-primary" />
                    <p className="truncate text-sm font-semibold text-foreground">
                      {selected.business_unit || "—"}
                    </p>
                  </div>
                  <p className="truncate pt-0.5 text-xs text-muted-foreground">
                    Head: {selected.head || "—"}
                  </p>
                </div>
              }
              items={
                selected.departments.length > 0
                  ? selected.departments.map((d) => (
                      <div
                        key={d.id}
                        className="w-44 shrink-0 rounded-xl border bg-card px-3 py-2.5 text-center"
                      >
                        <p className="truncate text-sm text-foreground">
                          {d.name}
                        </p>
                      </div>
                    ))
                  : undefined
              }
            />
          </ChartCanvas>
        )}
      </div>
    </div>
  );
}

// ─── Whole hierarchy (read-only) ─────────────────────────────────────────────

/**
 * One node of the fully-expanded tree. Purely presentational: /graph/org-tree
 * arrives already nested, so there is nothing to fetch, expand or collapse —
 * every level is drawn at once.
 *
 * Siblings sit in a single non-wrapping row, so the connector bar spans only
 * true peers. A whole org gets very wide; the canvas zoom and scroll are how
 * you navigate it.
 */
function FullTreeNode({
  node,
  focusedId,
}: {
  node: OrgTreeNode;
  focusedId?: string | null;
}) {
  const count = node.children.length;
  const isFocused = focusedId === node.employee_id;
  const ref = useRef<HTMLDivElement>(null);

  // Bring the searched person into view. The tree is far wider than the
  // viewport, so without this a match could be highlighted off-screen.
  useEffect(() => {
    if (isFocused) {
      ref.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
    }
  }, [isFocused]);

  return (
    <div className="flex flex-col items-center">
      <div
        ref={ref}
        className={`w-44 shrink-0 rounded-xl border px-3 py-2 text-center transition-colors ${
          isFocused
            ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
            : "border-border bg-card"
        }`}
      >
        <p className="truncate text-sm font-medium text-foreground">
          {personLabel(node)}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {node.designation ?? node.emp_code ?? "—"}
        </p>
      </div>

      {count > 0 && (
        <>
          <Stem />
          <div className="flex items-start">
            {node.children.map((c, i) => (
              <div
                key={c.employee_id}
                className="relative flex flex-col items-center px-2 pt-6"
              >
                {count > 1 && (
                  <span
                    className={`absolute top-0 h-px bg-border ${
                      i === 0
                        ? "left-1/2 right-0"
                        : i === count - 1
                          ? "left-0 right-1/2"
                          : "left-0 right-0"
                    }`}
                  />
                )}
                <span className="absolute top-0 h-6 w-px bg-border" />
                <FullTreeNode node={c} focusedId={focusedId} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FullHierarchy({ focusedId }: { focusedId?: string | null }) {
  const { data, isLoading, isError, error, refetch } = useGetOrgTreeQuery();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading the full hierarchy…
      </div>
    );
  }
  if (isError) {
    return isGraphDown(error) ? (
      <GraphUnavailable onRetry={refetch} />
    ) : (
      <EmptyState
        variant="error"
        icon={AlertCircle}
        title="Failed to load the hierarchy"
        description="Please try again."
      />
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No hierarchy to show"
        description="No active employees are mapped in the reporting graph."
      />
    );
  }

  // Usually one root, but an active employee whose manager is inactive surfaces
  // as an extra root — render them side by side rather than assuming data[0].
  return (
    <div className="flex items-start gap-10">
      {data.map((root) => (
        <FullTreeNode key={root.employee_id} node={root} focusedId={focusedId} />
      ))}
    </div>
  );
}

// ─── People chart: lazy-expanding reporting tree ─────────────────────────────

/** A person box in the chart. Fixed width so the connectors line up. */
function PersonCard({
  person,
  variant = "default",
  onClick,
  expanded,
  loading,
  title,
  wide,
}: {
  person: GraphPerson;
  variant?: "default" | "focus" | "ancestor";
  onClick?: () => void;
  /** Omit on cards that don't toggle (ancestors) — hides the chevron. */
  expanded?: boolean;
  loading?: boolean;
  title?: string;
  /** Pulled-out cards sit on their own line, so they get more room. */
  wide?: boolean;
}) {
  const styles = {
    default: "bg-card border-border hover:border-primary/40",
    focus: "bg-primary/5 border-primary/40 ring-1 ring-primary/20",
    ancestor: "bg-muted/40 border-border hover:border-primary/40",
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-expanded={expanded}
      className={`${wide ? "w-72" : "w-52"} shrink-0 rounded-xl border px-3 py-2.5 text-left transition-colors ${styles}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
          {(person.name ?? person.emp_code ?? "?").slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {personLabel(person)}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {person.emp_code ?? "—"}
          </p>
        </div>
        {/* The card itself is the toggle, so this is a state indicator rather
            than a separate control. */}
        {expanded !== undefined &&
          (loading ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          ))}
      </div>
    </button>
  );
}
/**
 * The unexpanded siblings of one parent, collapsed into a single card.
 *
 * Keeping every un-opened peer in one box is what stops the chart fanning out:
 * only the people you actually open become their own column.
 */
function GroupCard({
  people,
  onPick,
}: {
  people: GraphPerson[];
  onPick: (p: GraphPerson) => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3">
      <p className="pb-2 text-center text-[11px] font-medium text-muted-foreground">
        {people.length} more
      </p>
      <div
        className="grid items-start justify-center gap-x-3 gap-y-3"
        style={{
          gridTemplateColumns: `repeat(${Math.min(people.length, PER_ROW)}, auto)`,
        }}
      >
        {people.map((p) => (
          <PersonCard
            key={p.employee_id}
            person={p}
            expanded={false}
            title="Show direct reports"
            onClick={() => onPick(p)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One person and everything opened beneath them.
 *
 * A parent's children are split in two: the ones the user has opened each
 * become their OWN column (recursively, so they can be opened further), and
 * everything still closed shares a single group card at the end of the row.
 * Opening more people widens the row; the result is a pyramid that only grows
 * where you've actually drilled in.
 *
 * The query has no `skip` — a node only mounts once its parent opened it, so
 * mounting IS the lazy fetch. RTK's per-arg cache stops a reopened branch
 * refetching.
 */
function Node({
  person,
  expandedIds,
  onToggle,
  isRoot = false,
}: {
  person: GraphPerson;
  expandedIds: Set<string>;
  onToggle: (p: GraphPerson) => void;
  isRoot?: boolean;
}) {
  const { data, isFetching, isError, error, refetch } = useGetDirectReportsQuery(
    person.employee_id,
  );

  const opened = (data ?? []).filter((c) => expandedIds.has(c.employee_id));
  const closed = (data ?? []).filter((c) => !expandedIds.has(c.employee_id));
  // Each opened child is a column; anything left over shares one group card.
  const columns = opened.length + (closed.length > 0 ? 1 : 0);

  return (
    <div className="flex flex-col items-center">
      <PersonCard
        person={person}
        variant={isRoot ? "focus" : "default"}
        wide={isRoot}
        expanded={!isRoot ? true : undefined}
        title={isRoot ? undefined : "Collapse"}
        onClick={isRoot ? undefined : () => onToggle(person)}
      />

      {isFetching && !data && (
        <div className="flex items-center gap-2 pt-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading reports…
        </div>
      )}

      {isError && (
        <div className="pt-3 text-xs">
          {isGraphDown(error) ? (
            <span className="text-warning">
              Chart unavailable.{" "}
              <button
                type="button"
                onClick={() => refetch()}
                className="underline underline-offset-2"
              >
                Retry
              </button>
            </span>
          ) : (
            <span className="text-destructive">Couldn&apos;t load reports.</span>
          )}
        </div>
      )}

      {!isError && data && data.length === 0 && (
        <p className="pt-3 text-xs text-muted-foreground">No direct reports.</p>
      )}

      {columns > 0 && (
        <>
          <Stem />
          {/* Siblings sit in ONE row — no wrapping — so the classic connector
              bar is unambiguous here: it spans only true peers. */}
          <div className="flex items-start">
            {[
              ...opened.map((c) => (
                <Node
                  key={c.employee_id}
                  person={c}
                  expandedIds={expandedIds}
                  onToggle={onToggle}
                />
              )),
              ...(closed.length > 0
                ? [
                    <GroupCard
                      key="__group"
                      people={closed}
                      onPick={onToggle}
                    />,
                  ]
                : []),
            ].map((child, i) => (
              <div
                key={i}
                className="relative flex flex-col items-center px-3 pt-6"
              >
                {columns > 1 && (
                  <span
                    className={`absolute top-0 h-px bg-border ${
                      i === 0
                        ? "left-1/2 right-0"
                        : i === columns - 1
                          ? "left-0 right-1/2"
                          : "left-0 right-0"
                    }`}
                  />
                )}
                <span className="absolute top-0 h-6 w-px bg-border" />
                {child}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function AncestorChain({
  employeeId,
  onSelect,
}: {
  employeeId: string;
  onSelect: (p: GraphPerson) => void;
}) {
  const { data, isFetching, isError, error } =
    useGetReportingChainQuery(employeeId);

  if (isFetching) {
    return (
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading reporting line…
      </div>
    );
  }
  if (isError) {
    return (
      <p className="pb-2 text-xs text-muted-foreground">
        {isGraphDown(error)
          ? "Reporting line unavailable — graph service is down."
          : "Couldn't load the reporting line."}
      </p>
    );
  }

  const ancestors = (data ?? [])
    .filter((p) => p.level > 0)
    .sort((a, b) => b.level - a.level);
  if (ancestors.length === 0) return null;

  return (
    <div className="flex flex-col items-center">
      {ancestors.map((p) => (
        <div key={p.employee_id} className="flex flex-col items-center">
          <PersonCard
            person={p}
            variant="ancestor"
            onClick={() => onSelect(p)}
          />
          <Stem />
        </div>
      ))}
    </div>
  );
}

function PeopleChart() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Only a deliberate pick is stored; the default is derived from the session,
  // so there's no effect syncing state and "Back to me" is just a reset.
  const [pickedRoot, setPickedRoot] = useState<GraphPerson | null>(null);
  /**
   * Every person the user has opened, anywhere in the chart. An opened person
   * becomes their own column beside their still-closed peers, so several
   * branches can be open at once — the chart widens only where you drill in.
   */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  /**
   * Swaps the interactive drill-down for the fully-expanded read-only tree from
   * /graph/org-tree. Search still applies there, but it scrolls to and
   * highlights the person instead of re-rooting — the whole org is already on
   * screen, so there's nothing to re-root.
   */
  const [wholeHierarchy, setWholeHierarchy] = useState(false);
  /** Person highlighted + scrolled to in whole-hierarchy mode. */
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Default root: the logged-in user. The graph is keyed by EMPLOYEE id and the
  // session only carries a user id, so the id has to be resolved first.
  //
  // GET /employees/{userId} is the richest source but it is HR-gated behind
  // core_hr → resource_management and 403s for anyone else. The organogram is
  // not an HR screen — it must not inherit that gate — so without the
  // permission we resolve through GET /directory instead, which any
  // authenticated user may read and whose `id` IS the same employee record id.
  const currentUser = useAppSelector((s) => s.auth.user);
  const currentUserId = currentUser?.id ?? "";
  const auth = useAuth();
  const canReadHrEmployees = !!permissionLevel(
    auth,
    "core_hr",
    "resource_management",
  );

  const { data: me } = useGetEmployeeByUserIdQuery(currentUserId, {
    skip: !currentUserId || !canReadHrEmployees,
  });

  // Search hits name, code and email; the row is then matched on userId, since
  // that is the only field the session and the directory share.
  const { data: selfDirectory } = useGetDirectoryQuery(
    { search: currentUser?.email ?? "", limit: 20, includeInactive: true },
    { skip: canReadHrEmployees || !currentUser?.email },
  );
  const selfRow = selfDirectory?.items.find((e) => e.userId === currentUserId);

  const self: GraphPerson | null = useMemo(() => {
    if (me) {
      return {
        employee_id: me.id,
        emp_code: me.empCode ?? null,
        name:
          [me.firstName, me.lastName].filter(Boolean).join(" ").trim() ||
          me.empCode ||
          null,
      };
    }
    // `id` postdates the rest of the directory payload — an older API omits it,
    // and there is no employee id to root the chart at without it.
    if (selfRow?.id) {
      return {
        employee_id: selfRow.id,
        emp_code: selfRow.empCode ?? null,
        name:
          selfRow.fullName?.trim() ||
          [selfRow.firstName, selfRow.lastName].filter(Boolean).join(" ").trim() ||
          selfRow.empCode ||
          null,
      };
    }
    return null;
  }, [me, selfRow]);

  const root = pickedRoot ?? self;

  // Same cache entry FullHierarchy subscribes to — no extra request. It's read
  // here only so the fit-to-width can wait for the tree to actually be on
  // screen; fitting while the loader is showing would measure nothing.
  const { data: orgTree } = useGetOrgTreeQuery(undefined, {
    skip: !wholeHierarchy,
  });
  const fitSignal = wholeHierarchy ? (orgTree ? "tree" : "loading") : "branch";

  const rootAt = (p: GraphPerson) => {
    setPickedRoot(p);
    setExpandedIds(new Set());
  };

  /** Open a person into their own column, or fold them back into the group. */
  const toggle = (p: GraphPerson) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(p.employee_id)) next.delete(p.employee_id);
      else next.add(p.employee_id);
      return next;
    });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Same split as the self lookup above: /employees is org-wide but HR-gated,
  // /directory is open to every employee. The directory is BU-scoped, so a user
  // without resource_management searches within their own business unit rather
  // than not at all.
  const searchTooShort = debouncedSearch.length < 2;
  const { data: employeeHits } = useGetEmployeesQuery(
    { search: debouncedSearch, limit: 8 },
    { skip: searchTooShort || !canReadHrEmployees },
  );
  const { data: directoryHits } = useGetDirectoryQuery(
    { search: debouncedSearch, limit: 8 },
    { skip: searchTooShort || canReadHrEmployees },
  );

  const suggestions: GraphPerson[] = canReadHrEmployees
    ? (employeeHits ?? []).map((e) => ({
        employee_id: e.id,
        emp_code: e.empCode ?? null,
        name:
          [e.firstName, e.lastName].filter(Boolean).join(" ").trim() ||
          e.empCode ||
          null,
      }))
    : (directoryHits?.items ?? [])
        // Rooting the chart needs an employee id; an older directory payload
        // without one can't be offered as a suggestion.
        .filter((e): e is typeof e & { id: string } => !!e.id)
        .map((e) => ({
          employee_id: e.id,
          emp_code: e.empCode ?? null,
          name:
            e.fullName?.trim() ||
            [e.firstName, e.lastName].filter(Boolean).join(" ").trim() ||
            e.empCode ||
            null,
        }));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search a person..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9"
          />
          {debouncedSearch.length >= 2 && suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border bg-card shadow-md">
              {suggestions.map((s) => (
                <button
                  key={s.employee_id}
                  type="button"
                  onClick={() => {
                    // Whole-hierarchy mode is read-only and already shows
                    // everyone, so a hit focuses the node rather than re-roots.
                    if (wholeHierarchy) setFocusedId(s.employee_id);
                    else rootAt(s);
                    setSearch("");
                  }}
                  className="flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/50"
                >
                  <span className="truncate text-sm text-foreground">
                    {personLabel(s)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.emp_code ?? ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Rooting is a drill-down concept — it says nothing in whole-org view. */}
        {!wholeHierarchy && root && (
          <p className="text-xs text-muted-foreground">
            Rooted at{" "}
            <span className="font-medium text-foreground">
              {personLabel(root)}
            </span>
          </p>
        )}

        {!wholeHierarchy && me && root && root.employee_id !== me.id && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              // Clearing the pick falls back to the derived self root.
              setPickedRoot(null);
              setExpandedIds(new Set());
            }}
          >
            <RotateCcw className="size-3.5" />
            Back to me
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <ChartCanvas
          // Re-fits on mode switch and again once the tree lands — the whole org
          // is far wider than one branch and would otherwise open off-screen.
          fitSignal={fitSignal}
          toolbar={
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs text-foreground shadow-sm">
              <Checkbox
                checked={wholeHierarchy}
                onCheckedChange={(v) => {
                  setWholeHierarchy(v === true);
                  setFocusedId(null);
                }}
              />
              Show whole hierarchy
            </label>
          }
        >
          {wholeHierarchy ? (
            <FullHierarchy focusedId={focusedId} />
          ) : !root ? (
            <EmptyState
              icon={Users}
              title="Loading your chart…"
              description="Search above to root the chart at someone else."
            />
          ) : (
            <div className="flex flex-col items-center">
              <AncestorChain employeeId={root.employee_id} onSelect={rootAt} />

              {/* The root renders its own subtree: closed peers share a group
                  card, opened ones each become a column beside it. */}
              <Node
                key={root.employee_id}
                person={root}
                expandedIds={expandedIds}
                onToggle={toggle}
                isRoot
              />
            </div>
          )}
        </ChartCanvas>
      </div>
    </div>
  );
}

export default function Organogram() {
  // AdminLayout already applies p-6 and owns the outer scroll container, so
  // this fills that height rather than adding padding or a second scrollbar.
  return (
    <Tabs
      defaultValue="people"
      // A viewport-relative height rather than h-full: AdminLayout's content
      // div gets its height from `flex-1`, which isn't a definite height for a
      // percentage child, so h-full collapsed to auto and the PAGE scrolled
      // instead of the chart. 7rem covers the topbar plus this area's p-6.
      className="flex h-[calc(100svh-7rem)] min-h-0 w-full flex-col gap-3"
    >
      <TabsList className="shrink-0 self-start">
        <TabsTrigger value="people" className="gap-2">
          <Network className="size-4" />
          Reporting Chart
        </TabsTrigger>
        <TabsTrigger value="structure" className="gap-2">
          <Building2 className="size-4" />
          Organisation Structure
        </TabsTrigger>
      </TabsList>

      <TabsContent value="people" className="mt-0 min-h-0 flex-1">
        <PeopleChart />
      </TabsContent>

      <TabsContent value="structure" className="mt-0 min-h-0 flex-1">
        <StructuralChart />
      </TabsContent>
    </Tabs>
  );
}
