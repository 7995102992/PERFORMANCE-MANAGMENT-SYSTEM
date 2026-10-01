import { useNavigate, useLocation, Link } from "@tanstack/react-router"
import {
  Bell,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock,
  LogOut,
  Ticket,
  User,
  Zap,
} from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { sidebarMenuConfig } from "./menu-config"
import { useAppSelector, useAppDispatch } from "@/store"
import { clearAuth } from "@/store/slices/authSlice"
import { resetAllApiState } from "@/store"
import { setBreadcrumbDetail } from "@/store/slices/uiSlice"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { RequestForm } from "@/pages/service-request/RequestForm"

// ─── Breadcrumb types ─────────────────────────────────────────────────────────

interface BreadcrumbSegment {
  label: string
  path?: string // present → clickable link
}

// Sub-routes that sit under a known list page (no entry in menu-config).
// Match by `prefix` (startsWith) or `test` (regex) — use `test` when a simple
// prefix would also catch unrelated sibling routes.
const SUB_ROUTE_PARENTS: Array<{
  prefix?: string
  test?: RegExp
  listPath: string
  parentLabel: string
  /** Present → the parent crumb is clickable too (e.g. Dashboard → "/"). */
  parentPath?: string
  listLabel: string
  defaultDetail: string
}> = [
  {
    prefix: '/leave-management/work-calendar/',
    listPath: '/leave-management/work-calendar',
    parentLabel: 'Leave Setup',
    listLabel: 'Work Calendar',
    defaultDetail: 'New Work Calendar',
  },
  {
    prefix: '/leave-management/holiday-calendar/',
    listPath: '/leave-management/holiday-calendar',
    parentLabel: 'Leave Setup',
    listLabel: 'Holiday Calendar',
    defaultDetail: 'New Holiday Plan',
  },
  {
    // Admin announcement detail — /announcements/<id>, under the list page,
    // which itself sits under the dashboard (see STANDALONE_LABELS).
    prefix: '/announcements/',
    listPath: '/announcements',
    parentLabel: 'Dashboard',
    parentPath: '/',
    listLabel: 'Announcements',
    defaultDetail: 'Announcement',
  },
  {
    // Employee announcement detail — /my-announcements/<id>, under the employee
    // feed at /my-announcements, which itself sits under the dashboard
    // (see STANDALONE_LABELS).
    prefix: '/my-announcements/',
    listPath: '/my-announcements',
    parentLabel: 'Dashboard',
    parentPath: '/',
    listLabel: 'Announcements',
    defaultDetail: 'Announcement',
  },
  {
    prefix: '/timesheet/my-timesheet/',
    listPath: '/timesheet/my-timesheet',
    parentLabel: 'Timesheet',
    listLabel: 'My Timesheet',
    defaultDetail: 'Timesheet Entry',
  },
  {
    // The project wizard: /timesheet/projects/setup, the project detail page
    // /<id>, and the per-project steps /<id>/edit, /<id>/tasks, /<id>/resources.
    // Tasks and Resources are steps 2 and 3 of the same flow; without them here
    // the header goes blank and nothing on screen names the project.
    test: /^\/timesheet\/projects\/(setup|[^/]+(\/(edit|tasks|resources))?)$/,
    listPath: '/timesheet/projects',
    parentLabel: 'Timesheet',
    listLabel: 'Projects',
    defaultDetail: 'New Project',
  },
]

// Routes reachable outside the sidebar menu (e.g. via Home shortcuts).
const STANDALONE_LABELS: Record<string, string> = {
  '/employee-journey/my-journey': 'My Journey',
  '/employee-journey/team-journey': 'Team Journey',
  '/announcements': 'Announcements',
  '/my-announcements': 'Announcements',
}

// ─── Resolve breadcrumb from route ────────────────────────────────────────────

function useBreadcrumb(): BreadcrumbSegment[] {
  const location = useLocation()
  const detail = useAppSelector((s) => s.ui.breadcrumbDetail)

  return useMemo(() => {
    // 0. Standalone routes not present in the sidebar menu
    const standaloneLabel = STANDALONE_LABELS[location.pathname]
    if (standaloneLabel) {
      return [{ label: 'Dashboard', path: '/' }, { label: standaloneLabel }]
    }

    // 1. Try exact match against menu config
    for (const section of sidebarMenuConfig) {
      for (const group of section.groups) {
        for (const child of group.children) {
          if (child.path === location.pathname) {
            const isMultiChild = group.children.length > 1
            const segments: BreadcrumbSegment[] = []

            const parentLabel = isMultiChild
              ? group.label
              : section.sectionTitle !== "Main"
                ? section.sectionTitle
                : null
            if (parentLabel) segments.push({ label: parentLabel })

            const currentLabel = isMultiChild ? child.label : group.label
            if (detail) {
              segments.push({ label: currentLabel, path: child.path })
            } else {
              segments.push({ label: currentLabel })
            }

            if (detail) segments.push({ label: detail })

            return segments
          }
        }
      }
    }

    // 2. Try prefix/regex match for sub-routes (add/edit pages under a list)
    for (const sub of SUB_ROUTE_PARENTS) {
      const matched = sub.test
        ? sub.test.test(location.pathname)
        : !!sub.prefix && location.pathname.startsWith(sub.prefix)
      if (matched) {
        const segments: BreadcrumbSegment[] = [
          { label: sub.parentLabel, path: sub.parentPath },
          { label: sub.listLabel, path: sub.listPath },
          { label: detail ?? sub.defaultDetail },
        ]
        // A parent that just repeats the list crumb (e.g. the announcement
        // detail, whose "list" is the dashboard itself) reads as
        // "Dashboard > Dashboard" — drop the duplicate.
        return sub.parentLabel === sub.listLabel ? segments.slice(1) : segments
      }
    }

    return []
  }, [location.pathname, detail])
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Topbar() {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const breadcrumb = useBreadcrumb()
  const user = useAppSelector((s) => s.auth.user)
  const fullName = user ? `${user.first_name} ${user.last_name}`.trim() : ''
  const { permissions, isOrgAdmin, timesheetActions } = useAuth()

  const canRaiseLeaveRequest =
    isOrgAdmin || (permissions['leave_management']?.includes('leave_request') ?? false)
  const canRaiseServiceRequest =
    isOrgAdmin || (permissions['service_request']?.length ?? 0) > 0
  const canFillTimesheet = isOrgAdmin || timesheetActions.my_timesheet
  const hasQuickActions =
    !isOrgAdmin && (canRaiseLeaveRequest || canRaiseServiceRequest || canFillTimesheet)
  const [newRequestOpen, setNewRequestOpen] = useState(false)

  function handleLogout() {
    resetAllApiState(dispatch)
    dispatch(clearAuth())
    navigate({ to: "/login" })
  }

  return (
    <>
    <header className="flex h-14 shrink-0 items-center border-b bg-card px-3 sm:h-16 sm:px-4 gap-2">
      <SidebarTrigger className="shrink-0 text-muted-foreground hover:text-foreground" />

      {/* Breadcrumb */}
      <nav className="flex flex-1 min-w-0 items-center gap-1.5 text-sm">
        {breadcrumb.map((segment, i) => {
          const isLast = i === breadcrumb.length - 1
          return (
            <span key={i} className="flex items-center gap-1.5 min-w-0">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />}
              {segment.path && !isLast ? (
                <Link
                  to={segment.path as any}
                  onClick={() => dispatch(setBreadcrumbDetail(null))}
                  className="truncate font-normal text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors cursor-pointer"
                >
                  {segment.label}
                </Link>
              ) : (
                <span
                  className={cn(
                    "truncate",
                    isLast
                      ? "font-semibold text-foreground"
                      : "font-normal text-muted-foreground",
                  )}
                >
                  {segment.label}
                </span>
              )}
            </span>
          )
        })}
      </nav>

      {/* Right actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Notifications */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground hidden">
              <Bell className="size-4" />
              <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <div className="p-2 font-semibold">Notifications</div>
            <DropdownMenuSeparator />
            <DropdownMenuItem>No new notifications</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Quick Actions */}
        {hasQuickActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="h-9 gap-2 rounded-lg bg-[var(--btn-soft)] px-3.5 text-sm font-medium text-[var(--btn-soft-fg)] shadow-none ring-1 ring-inset ring-primary/15 hover:bg-[var(--btn-soft)] hover:ring-primary/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-primary/40 transition-all"
              >
                <Zap className="size-4 text-primary" />
                <span className="tracking-tight">Quick Actions</span>
                <ChevronDown className="size-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60 p-1.5">
              <DropdownMenuLabel className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Quick Actions
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="my-1" />
              {canRaiseLeaveRequest && (
                <DropdownMenuItem
                  className="gap-2.5 rounded-md px-2 py-2 text-sm font-medium text-foreground focus:bg-primary/10 focus:text-primary"
                  onClick={() =>
                    navigate({
                      to: "/leave-management/employee-leave-management" as never,
                      search: { new: "true" } as never,
                    })
                  }
                >
                  <CalendarDays className="size-4 text-muted-foreground" />
                  New Leave Request
                </DropdownMenuItem>
              )}
              {canRaiseServiceRequest && (
                <DropdownMenuItem
                  className="gap-2.5 rounded-md px-2 py-2 text-sm font-medium text-foreground focus:bg-primary/10 focus:text-primary"
                  onClick={() => setNewRequestOpen(true)}
                >
                  <Ticket className="size-4 text-muted-foreground" />
                  New Service Ticket
                </DropdownMenuItem>
              )}
              {canFillTimesheet && (
                <DropdownMenuItem
                  className="gap-2.5 rounded-md px-2 py-2 text-sm font-medium text-foreground focus:bg-primary/10 focus:text-primary"
                  onClick={() => navigate({ to: "/timesheet/my-timesheet" as never })}
                >
                  <Clock className="size-4 text-muted-foreground" />
                  Fill your Timesheet
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* User menu — hidden: profile/logout live in the sidebar footer */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground hidden">
              <User className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {user && (
              <>
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{fullName}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={() => navigate({ to: "/profile" })}>
              <User className="mr-2 size-4" />
              My Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
              <LogOut className="mr-2 size-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

      {/* New Service Request — opened from Quick Actions */}
      <RequestForm open={newRequestOpen} onOpenChange={setNewRequestOpen} />
    </>
  )
}
