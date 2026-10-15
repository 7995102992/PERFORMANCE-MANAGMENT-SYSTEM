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
import { useEffect, useMemo, useRef, useState } from "react"

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
import {
  useGetPmsNotificationsQuery,
  useGetPmsStageNoticesQuery,
  useMarkPmsNotificationsReadMutation,
} from "@/store/api/pmsApi"
import { toast } from "@/lib/toast"
import { fyToApi } from "@/store/api/pmsMappers"
import { currentFinancialYear } from "@/pages/pms/configuration/config.constants"
import { formatDisplayDate } from "@/pages/pms/shared/pms.utils"
import { stageNoticePath, stageNoticeSummary } from "@/pages/pms/shared/stageNotice.utils"

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
    // Goal template wizard / view - /pms/configuration/goal-templates/new, /<id>[/edit].
    prefix: '/pms/configuration/goal-templates/',
    listPath: '/pms/configuration/goal-templates',
    parentLabel: 'Configuration',
    listLabel: 'Goal Templates',
    defaultDetail: 'New Template',
  },
  {
    // PMS cycle wizard / view / activated — /pms/cycle/new, /pms/cycle/<id>[/edit|/activated].
    prefix: '/pms/cycle/',
    listPath: '/pms/cycle',
    parentLabel: 'PMS Cycle',
    listLabel: 'Initiate Appraisal',
    defaultDetail: 'New Appraisal',
  },
  {
    // Select Employee - /pms/team-goal-setting/<fy>/role.
    test: /^\/pms\/team-goal-setting\/\d+\/role\/?$/,
    listPath: `/pms/team-goal-setting/${currentFinancialYear()}`,
    parentLabel: 'PMS Cycle',
    listLabel: 'My Team Goals',
    defaultDetail: 'Select Employee',
  },
  {
    // Target assignment / revise / transfer - /pms/team-goal-setting/<fy>/employee/<id>[/...].
    test: /^\/pms\/team-goal-setting\/\d+\/employee\//,
    listPath: `/pms/team-goal-setting/${currentFinancialYear()}`,
    parentLabel: 'PMS Cycle',
    listLabel: 'My Team Goals',
    defaultDetail: 'Target Assignment',
  },
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

/** PMS > Configuration > KRA Master style crumbs for routes nested in the menu. */
function findNestedBreadcrumb(pathname: string): BreadcrumbSegment[] | null {
  for (const section of sidebarMenuConfig) {
    for (const group of section.groups) {
      for (const child of group.children) {
        const sub = child.children?.find((c) => c.path === pathname)
        if (sub) return [{ label: group.label }, { label: child.label }, { label: sub.label }]
      }
    }
  }
  return null
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

    // 1b. Items nested one level down (e.g. PMS > Configuration > KRA Master)
    const nested = findNestedBreadcrumb(location.pathname)
    if (nested) return nested

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
  // PMS stage windows (goal setting, acknowledgement, HOD approval) the cycle timeline set for this user.
  const pmsYear = currentFinancialYear()
  const { data: stageNotices = [] } = useGetPmsStageNoticesQuery(fyToApi(pmsYear))
  const bellNotices = stageNotices.filter((n) => n.notify && n.state !== "closed")
  // Notifications written when a cycle is published; polled so a new one arrives without a reload.
  const { data: inbox } = useGetPmsNotificationsQuery(undefined, { pollingInterval: 60_000 })
  const [markRead] = useMarkPmsNotificationsReadMutation()
  const unread = inbox?.unread ?? 0
  // The message also pops up once when a new notification arrives while the app is open.
  const announced = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!inbox) return
    const fresh = inbox.items.filter((n) => !n.read)
    if (announced.current === null) {
      // First load: whatever is already unread sits in the bell, no pop-up.
      announced.current = new Set(fresh.map((n) => n.id))
      return
    }
    for (const n of fresh) {
      if (!announced.current.has(n.id)) {
        announced.current.add(n.id)
        toast.info(`${n.title}: ${n.message}`)
      }
    }
  }, [inbox])
  // On PMS pages the bell and Quick Actions are always there, as in the mockups.
  const pathname = useLocation().pathname
  const onPms = pathname.startsWith("/pms")
  const pmsCodes = permissions["performance_management"] ?? []
  const has = (code: string) => isOrgAdmin || pmsCodes.includes(code)
  const pmsQuickItems = [
    has("pms_cycle") && { label: "Initialize New Appraisal", to: "/pms/cycle/new" },
    has("my_goals") && { label: "My Goals", to: `/pms/my-goals/${pmsYear}` },
    has("self_appraisal") && { label: "Self Appraisal", to: `/pms/self-appraisal/${pmsYear}` },
    has("team_goals") && { label: "My Team Goals", to: `/pms/team-goal-setting/${pmsYear}` },
    has("goal_approval") && { label: "Goal Approvals", to: `/pms/goal-approvals/${pmsYear}` },
  ].filter((i): i is { label: string; to: string } => !!i)

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
            <Button
              variant="ghost"
              size="icon"
              aria-label="Notifications"
              className={cn(
                "relative text-muted-foreground hover:text-foreground",
                // Nothing else raises notifications yet, so the bell appears only when there is one.
                bellNotices.length === 0 && unread === 0 && !onPms && "hidden",
              )}
            >
              <Bell className="size-4" />
              {(bellNotices.length > 0 || unread > 0) && (
                <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
                  {unread > 0 ? (unread > 9 ? "9+" : unread) : ""}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-96">
            <div className="flex items-center justify-between p-2">
              <span className="font-semibold">Notifications</span>
              {unread > 0 && (
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => markRead()}
                >
                  Mark all as read
                </button>
              )}
            </div>
            <DropdownMenuSeparator />
            {bellNotices.length === 0 && (inbox?.items.length ?? 0) === 0 && (
              <DropdownMenuItem>No new notifications</DropdownMenuItem>
            )}
            {(inbox?.items ?? []).slice(0, 10).map((n) => (
              <DropdownMenuItem
                key={n.id}
                className="flex cursor-pointer flex-col items-start gap-1 whitespace-normal py-2.5"
                onClick={() => {
                  if (!n.read) markRead({ ids: [n.id] })
                  if (n.link_path) navigate({ to: n.link_path as never })
                }}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {!n.read && <span className="size-2 shrink-0 rounded-full bg-primary" />}
                  {n.title}
                </span>
                <span className="text-xs text-muted-foreground">{n.message}</span>
              </DropdownMenuItem>
            ))}
            {bellNotices.length > 0 && (inbox?.items.length ?? 0) > 0 && <DropdownMenuSeparator />}
            {bellNotices.map((n) => (
              <DropdownMenuItem
                key={n.stage}
                className="flex cursor-pointer flex-col items-start gap-1 whitespace-normal py-2.5"
                onClick={() => navigate({ to: stageNoticePath(n.stage, pmsYear) as never })}
              >
                <span className="text-sm font-semibold text-foreground">{n.title}</span>
                <span className="text-xs text-muted-foreground">
                  {n.title} {stageNoticeSummary(n, formatDisplayDate)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Quick Actions */}
        {(hasQuickActions || pmsQuickItems.length > 0) && (
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
              {pmsQuickItems.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    className="gap-2.5 rounded-md px-2 py-2 text-sm font-medium text-foreground focus:bg-primary/10 focus:text-primary"
                    onClick={() => navigate({ to: item.to as never })}
                  >
                    <Zap className="size-4 text-muted-foreground" />
                    {item.label}
                  </DropdownMenuItem>
                ))}
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
