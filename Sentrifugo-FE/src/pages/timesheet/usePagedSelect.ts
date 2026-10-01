import { useEffect, useState } from "react";
import type { Option } from "@/components/shared/SearchableSelect";

/**
 * NOTE: a deliberate copy of src/pages/service-request/usePagedSelect.ts, kept
 * per-module so a change to a Timesheet picker can't affect a Service Request
 * one. If a third module needs it, promote it to src/hooks/ and collapse the
 * three — until then the duplication is cheaper than the coupling.
 */

/** Shape a paginated list endpoint returns. */
interface PagedResult<T> {
  items: T[];
  total: number;
}

/** The subset of an RTK Query hook's result this needs. */
interface QueryResult<T> {
  data?: PagedResult<T>;
  isFetching: boolean;
}

/**
 * Drives a `<SearchableSelect>` off a server-paginated list endpoint.
 *
 * The SRM list APIs (/categories, /request-types) cap a page at 25 rows and
 * return no `total_pages`. A picker that queries without `page` / `page_size`
 * therefore shows only the first 25 rows and silently hides the rest — the user
 * simply cannot select what isn't there.
 *
 * The query hook is passed in and called here, so paging state and the request
 * that consumes it live in one place (the caller can't order them correctly
 * otherwise — each needs the other's output):
 *
 *   const cats = usePagedSelect({
 *     useQuery: useGetCategoriesQuery,
 *     args: { status: 'active' },
 *     toOption: (c) => ({ label: c.name, value: c.id }),
 *   })
 *   <SearchableSelect {...cats.selectProps} value={id} onChange={setId} />
 */
// The row type can't be inferred through an RTK Query hook's signature, so call
// sites name it: `usePagedSelect<Category>({ ... })`.
export function usePagedSelect<T>({
  useQuery,
  args,
  toOption,
  resetKey = "",
  pageSize = 25,
  selected,
  skip = false,
}: {
  /** e.g. `useGetCategoriesQuery`. Called unconditionally, hook-rules safe. */
  useQuery: (
    args: Record<string, unknown>,
    opts?: { skip?: boolean },
  ) => QueryResult<T>;
  /** Caller's own filters, merged with the paging args. */
  args?: Record<string, unknown>;
  toOption: (row: T) => Option;
  /** Changing this drops the accumulated pages (e.g. the parent category id). */
  resetKey?: string;
  pageSize?: number;
  /**
   * The selected option when the caller resolved it independently (usually a
   * fetch-by-id). Merged in if absent from the loaded pages — without it an
   * edit form whose saved value lives on page 3 renders a blank trigger.
   */
  selected?: Option | null;
  skip?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loaded, setLoaded] = useState<Option[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A new search — or a new parent — is a new result set, so pages accumulated
  // for the old one must go.
  useEffect(() => {
    setPage(1);
    setLoaded([]);
  }, [debouncedSearch, resetKey]);

  const { data, isFetching } = useQuery(
    { ...args, page, page_size: pageSize, q: debouncedSearch || undefined },
    { skip },
  );

  // Append each page as it lands, de-duped by value so a refetch of the same
  // page can't double rows.
  useEffect(() => {
    const items = data?.items;
    if (!items) return;
    setLoaded((prev) => {
      const seen = new Set(prev.map((o) => o.value));
      const added = items.map(toOption).filter((o) => !seen.has(o.value));
      return added.length ? [...prev, ...added] : prev;
    });
    // `toOption` is an inline arrow at every call site; including it would
    // re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const total = data?.total ?? 0;
  const options =
    selected && !loaded.some((o) => o.value === selected.value)
      ? [selected, ...loaded]
      : loaded;

  return {
    data,
    isFetching,
    /** Spread into `<SearchableSelect>`; add `value` / `onChange` / `placeholder`. */
    selectProps: {
      options,
      onSearchChange: setSearch,
      // Only blank the list for the first page — later pages render beneath the
      // rows already on screen.
      loading: isFetching && loaded.length === 0,
      loadingMore: isFetching && loaded.length > 0,
      hasMore: loaded.length < total,
      onLoadMore: () => setPage((p) => p + 1),
    },
    /**
     * Genuinely empty — only true once a response has landed. Before that the
     * picker is loading and must not claim there is nothing to pick.
     */
    isEmpty: !!data && !isFetching && options.length === 0,
    /** Clear search + accumulated pages (e.g. when a drawer closes). */
    reset: () => {
      setSearch("");
      setPage(1);
      setLoaded([]);
    },
  };
}
