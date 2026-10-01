import { useNavigate, useLocation } from "@tanstack/react-router"
import {
  ChevronDown,
  ChevronRight,
  Rocket,
} from "lucide-react"
import { useMemo } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { superAdminMenuConfig, orgSetupMenuConfig, orgPostSetupMenuConfig } from "./menu-config"
import { useSetupSteps } from "@/hooks/use-setup-steps"
import { useAppSelector } from "@/store"

// ─── Resolve breadcrumb info from route ───────────────────────────────────────

function useBreadcrumb() {
  const location = useLocation()
  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const isSetupComplete = useAppSelector((s) => s.organisation.savedOrganisation?.setup_status === 'active')
  const menuConfig = isSuperAdmin
    ? superAdminMenuConfig
    : isSetupComplete
      ? orgPostSetupMenuConfig
      : orgSetupMenuConfig

  return useMemo(() => {
    for (const section of menuConfig) {
      for (const group of section.groups) {
        for (const child of group.children) {
          if (child.path === location.pathname) {
            return {
              parent: section.sectionTitle !== "Main" ? section.sectionTitle : null,
              current: child.label || group.label,
              groupLabel: group.label,
            }
          }
        }
      }
    }
    return null
  }, [location.pathname, menuConfig])
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Topbar() {
  const navigate = useNavigate()
  const breadcrumb = useBreadcrumb()
  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const isSetupComplete = useAppSelector((s) => s.organisation.savedOrganisation?.setup_status === 'active')

  return (
    <header className="flex h-14 shrink-0 items-center border-b bg-card px-3 sm:h-16 sm:px-4 gap-2">
      <SidebarTrigger className="shrink-0 text-muted-foreground hover:text-foreground" />

      {/* Breadcrumb */}
      <div className="flex flex-1 min-w-0 items-center gap-1.5 text-sm">
        {breadcrumb?.parent ? (
          <>
            <span className="text-muted-foreground font-normal truncate">{breadcrumb.parent}</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
            <span className="font-semibold text-foreground truncate">{breadcrumb.groupLabel}</span>
          </>
        ) : breadcrumb ? (
          <span className="font-semibold text-foreground truncate">{breadcrumb.groupLabel}</span>
        ) : null}
      </div>

      {/* Setup pill */}
      <SetupPill />

      {/* Right actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Create New */}
        {isSuperAdmin ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 px-4 text-sm font-medium">
                Create New
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => navigate({ to: "/super-admin/organisations/new" as never })}>
                New Organisation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  )
}

// ─── Setup progress pill ──────────────────────────────────────────────────────

function SetupPill() {
  const navigate = useNavigate()
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation)
  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const { mandatoryDone, completedCount, totalCount } = useSetupSteps()
  const percent = Math.round((completedCount / totalCount) * 100)

  if (isSuperAdmin) return null
  if (savedOrg?.setup_status === 'active') return null
  if (mandatoryDone && completedCount === totalCount) return null

  return (
    <button
      type="button"
      onClick={() => navigate({ to: '/' })}
      className={cn(
        'flex items-center gap-2 rounded-full border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted',
      )}
    >
      <Rocket className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Setup {percent}%</span>
      <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", mandatoryDone ? "bg-success" : "bg-amber-400")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </button>
  )
}
