import { useState, useRef, useEffect } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

export interface Option {
  label: string
  value: string
  /** Optional group heading. When any option carries one, the list renders
   *  under sticky group headers (options keep their given order within a group). */
  group?: string
}

interface SearchableSelectProps {
  options: Option[]
  value?: string | string[]
  onChange: (value: string | string[]) => void
  placeholder?: string
  emptyMessage?: string
  disabled?: boolean
  searchable?: boolean
  multi?: boolean
  className?: string
  // Server-side search: when provided, the consumer owns filtering and we
  // forward keystrokes here instead of filtering `options` locally.
  onSearchChange?: (q: string) => void
  loading?: boolean
  /** Server-side paging: called when the list is scrolled near the bottom and
   *  `hasMore` is true. The consumer appends the next page to `options`. */
  onLoadMore?: () => void
  /** Whether another page exists. Drives the load-more trigger + footer row. */
  hasMore?: boolean
  /** True while a follow-up page is in flight (distinct from `loading`, which
   *  blanks the whole list for the first page). */
  loadingMore?: boolean
  /** Show the clear (✕) affordance on a single select. Turn off where the list
   *  already carries its own "all"/"none" entry — there, clearing has no
   *  meaning and the ✕ just crowds the chevron. */
  clearable?: boolean
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select an option...',
  emptyMessage = 'No options found.',
  disabled = false,
  searchable = true,
  multi = false,
  className,
  onSearchChange,
  loading = false,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  clearable = true,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedValues = multi ? (Array.isArray(value) ? value : []) : []
  const singleValue = multi ? '' : (value as string) ?? ''
  const selected = !multi ? options.find((o) => o.value === singleValue) : null

  const serverSide = typeof onSearchChange === 'function'
  const paged = typeof onLoadMore === 'function'
  // Always filter locally too: when the server returns the full set under
  // the cap, typing should feel instant; the server search just supplements
  // with results beyond the initial page.
  //
  // EXCEPT when the consumer pages server-side: there `options` is only the
  // pages fetched so far, and hiding rows the server already matched would make
  // the list look empty while more pages are still loading. The server's `q`
  // owns filtering in that mode.
  const filtered =
    search && !paged
      ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
      : options

  /** Pull the next page once the list is within ~48px of the bottom. */
  function handleListScroll() {
    if (!paged || !hasMore || loadingMore || loading) return
    const el = listRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) onLoadMore!()
  }

  // A short first page can leave the list unscrollable, so the scroll handler
  // would never fire and the remaining pages stay unreachable. Top it up until
  // the list overflows.
  useEffect(() => {
    if (!open || !paged || !hasMore || loadingMore || loading) return
    const el = listRef.current
    if (el && el.scrollHeight <= el.clientHeight) onLoadMore!()
    // `onLoadMore` is deliberately omitted: consumers pass an inline arrow, so
    // including it would re-run this on every render and request pages in a
    // loop. The guards above plus `options.length` are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paged, hasMore, loadingMore, loading, options.length])

  useEffect(() => {
    if (open && searchable) {
      setTimeout(() => inputRef.current?.focus(), 10)
      setSearch('')
      if (serverSide) onSearchChange!('')
    }
  }, [open, searchable])

  function handleSelect(val: string) {
    if (multi) {
      const current = Array.isArray(value) ? value : []
      const next = current.includes(val)
        ? current.filter((v) => v !== val)
        : [...current, val]
      onChange(next)
    } else {
      onChange(val)
      setOpen(false)
      setSearch('')
    }
  }

  function handleClearSingle(e: React.MouseEvent) {
    e.stopPropagation()
    onChange('')
  }

  function handleRemoveChip(e: React.MouseEvent, val: string) {
    e.stopPropagation()
    const current = Array.isArray(value) ? value : []
    onChange(current.filter((v) => v !== val))
  }

  const triggerLabel = multi
    ? selectedValues.length === 0
      ? placeholder
      : null
    : selected
      ? selected.label
      : placeholder

  const renderOption = (o: Option) => {
    const isSelected = multi
      ? selectedValues.includes(o.value)
      : singleValue === o.value
    return (
      <button
        key={o.value}
        type="button"
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer',
          isSelected && 'bg-accent font-medium',
        )}
        onClick={() => handleSelect(o.value)}
      >
        <Check className={cn('h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
        {o.label}
      </button>
    )
  }

  // Group the (filtered) options when any of them declare a group — preserving
  // first-seen group order. Null when the caller passed a flat list.
  const groups: [string, Option[]][] | null = filtered.some((o) => o.group)
    ? (() => {
        const map = new Map<string, Option[]>()
        for (const o of filtered) {
          const g = o.group ?? 'Other'
          const bucket = map.get(g)
          if (bucket) bucket.push(o)
          else map.set(g, [o])
        }
        return Array.from(map.entries())
      })()
    : null

  return (
    // `modal` so the list can be wheel-scrolled when this select sits inside a
    // Sheet/Dialog: that parent's scroll-lock otherwise swallows wheel events on
    // the popover, which is portaled outside it.
    <Popover modal open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex min-h-10 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm shadow-xs ring-offset-background',
            'focus:outline-none focus:ring-1 focus:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
            multi && selectedValues.length > 0 ? 'flex-wrap gap-1' : '',
            !selected && !selectedValues.length && 'text-muted-foreground',
            className,
          )}
          aria-expanded={open}
        >
          {multi && selectedValues.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1 flex-1">
                {selectedValues.map((v) => {
                  const opt = options.find((o) => o.value === v)
                  return (
                    <Badge key={v} variant="secondary" className="gap-1 pr-1">
                      {opt?.label ?? v}
                      {/* Wrap the X in a span: <Badge> sets `pointer-events-none`
                          on its direct child <svg>, so the icon itself can't
                          receive clicks — the span becomes the click target. */}
                      <span
                        role="button"
                        aria-label={`Remove ${opt?.label ?? v}`}
                        className="inline-flex cursor-pointer items-center rounded-sm hover:text-foreground"
                        onPointerDown={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => handleRemoveChip(e, v)}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </Badge>
                  )
                })}
              </div>
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 ml-1" />
            </>
          ) : (
            <>
              <span className="truncate">{triggerLabel}</span>
              <span className="flex items-center gap-1 shrink-0 ml-2">
                {!multi && selected && !disabled && clearable && (
                  <X
                    className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground"
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={handleClearSingle}
                  />
                )}
                <ChevronDown className="h-4 w-4 text-icon" />
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="p-0 w-[var(--radix-popper-anchor-width)]"
        align="start"
        sideOffset={4}
      >
        {searchable && (
          <div className="p-2 border-b">
            <Input
              ref={inputRef}
              placeholder="Search..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                if (serverSide) onSearchChange!(e.target.value)
              }}
              className="h-8"
            />
          </div>
        )}
        <div
          ref={listRef}
          onScroll={handleListScroll}
          className="max-h-60 min-h-0 overflow-y-auto overscroll-contain"
        >
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading...</p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
          ) : (
            <>
              {groups
                ? groups.map(([group, opts]) => (
                    <div key={group}>
                      <div className="sticky top-0 z-10 bg-muted/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
                        {group}
                      </div>
                      {opts.map(renderOption)}
                    </div>
                  ))
                : filtered.map(renderOption)}
              {paged && loadingMore && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  Loading more…
                </p>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
