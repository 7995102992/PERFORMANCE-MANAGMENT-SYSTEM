import { useMemo } from "react"
import { useLocation, useNavigate, Link } from "@tanstack/react-router"
import { Check, ChevronDown, ChevronRight, HelpCircle, Lock, LogOut, Moon, Rocket, Settings, Sun } from "lucide-react"
import logoIcon from "@/assets/logo-icon.svg"
import { cn } from "@/lib/utils"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { superAdminMenuConfig, orgSetupMenuConfig, orgPostSetupMenuConfig } from "./menu-config"
import type { MenuGroup, MenuSection } from "./menu-config"
import { filterMenuByPermissions } from "@/lib/permissions"
import { useAuth } from "@/hooks/use-auth"
import { useSetupSteps, type SetupStepId } from "@/hooks/use-setup-steps"
import { useTheme } from "@/hooks/use-theme"
import { useAppSelector, useAppDispatch } from "@/store"
import { clearToken } from "@/store/slices/auth-slice"
import { clearSavedOrganisation } from "@/store/slices/organisation-slice"
import { authService } from "@/api/auth"
import { toast } from "@/lib/toast"

export function AppSidebar() {
  const location = useLocation()
  const user = useAuth()
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation)
  const isSetupComplete = savedOrg?.setup_status === 'active'
  const isActive = (path: string) => location.pathname === path
  const { stepById, currentStep, mandatoryDone, completedCount, totalCount, isInitialLoading } = useSetupSteps()

  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const menuConfig = isSuperAdmin
    ? superAdminMenuConfig
    : isSetupComplete
      ? orgPostSetupMenuConfig
      : orgSetupMenuConfig

  const filteredMenu = useMemo(
    () => filterMenuByPermissions(menuConfig, user),
    [user, menuConfig]
  )

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white">
                  <img src={logoIcon} alt="Sentrifugo" className="size-6" />
                </div>
                <div className="flex flex-col text-left leading-tight">
                  <span className="text-lg font-bold text-sidebar-foreground">Sentrifugo</span>
                  <span className="text-[10px] leading-snug text-sidebar-foreground/40">Innovate . Automate . Empower</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {filteredMenu.map((section, idx) => (
          <SectionRenderer
            key={section.sectionTitle}
            section={section}
            sectionIndex={idx}
            isActive={isActive}
            stepById={stepById}
            currentStepId={currentStep?.id}
            isInitialLoading={isInitialLoading}
            isSetupComplete={isSetupComplete || isSuperAdmin}
          />
        ))}
      </SidebarContent>

      <SidebarFooter className="pb-1">
        {!isSuperAdmin && !isSetupComplete && (
          <SetupProgressWidget
            mandatoryDone={mandatoryDone}
            completedCount={completedCount}
            totalCount={totalCount}
          />
        )}
        <UtilityFooter />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

// ─── Section renderer ─────────────────────────────────────────────────────────

function SectionRenderer({
  section,
  sectionIndex,
  isActive,
  stepById,
  currentStepId,
  isInitialLoading,
  isSetupComplete,
}: {
  section: MenuSection
  sectionIndex: number
  isActive: (path: string) => boolean
  stepById: Map<SetupStepId, ReturnType<typeof useSetupSteps>['steps'][number]>
  currentStepId: SetupStepId | undefined
  isInitialLoading: boolean
  isSetupComplete: boolean
}) {
  const stepperGroups = section.groups.filter((g) => g.setupStepId)
  const normalGroups = section.groups.filter((g) => !g.setupStepId)
  const location = useLocation()
  const sectionHasActiveChild = section.groups.some((g) =>
    g.children.some((c) => location.pathname === c.path)
  )

  if (section.collapsible) {
    return (
      <SidebarGroup className="py-0.5">
        <CollapsibleSection section={section} isActive={isActive} />
      </SidebarGroup>
    )
  }

  return (
    <>
      {normalGroups.length > 0 && (
        <SidebarGroup className={cn(sectionIndex > 0 && "pt-0")}>
          {section.sectionTitle !== "Main" && (
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/35 group-data-[collapsible=icon]:hidden">
              {section.sectionTitle}
            </p>
          )}
          <SidebarMenu>
            {normalGroups.map((group) => (
              <NormalMenuItem key={group.key} group={group} isActive={isActive} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}

      {stepperGroups.length > 0 && !isSetupComplete && (
        <SidebarGroup>
          <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/35 group-data-[collapsible=icon]:hidden">
            Setup Steps
          </p>
          {isInitialLoading ? (
            <StepperSkeleton count={stepperGroups.length} />
          ) : (
            <Stepper
              groups={stepperGroups}
              isActive={isActive}
              stepById={stepById}
              currentStepId={currentStepId}
            />
          )}
        </SidebarGroup>
      )}
    </>
  )
}

// ─── Normal top-level nav item ────────────────────────────────────────────────

function NormalMenuItem({
  group,
  isActive,
}: {
  group: MenuGroup
  isActive: (path: string) => boolean
}) {
  const child = group.children[0]
  const active = isActive(child.path)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={group.label}
        className={cn(
          "h-auto rounded-xl px-3 py-2 transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
        )}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Link to={child.path as any}>
          <div className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
            active ? "bg-primary/20 text-primary" : "bg-sidebar-accent/60 text-sidebar-foreground/60",
          )}>
            <group.icon className="size-4" />
          </div>
          <span className="flex-1 text-sm font-medium">{group.label}</span>
          <ChevronRight className={cn(
            "size-3.5 shrink-0 transition-colors group-data-[collapsible=icon]:hidden",
            active ? "text-sidebar-foreground/60" : "text-sidebar-foreground/25",
          )} />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// ─── Collapsible section with circle-bullet sub-items ────────────────────────

function CollapsibleSection({
  section,
  isActive,
}: {
  section: MenuSection
  isActive: (path: string) => boolean
}) {
  const location = useLocation()
  const { state: sidebarState, toggleSidebar } = useSidebar()
  const isCollapsed = sidebarState === 'collapsed'
  const sectionHasActiveChild = section.groups.some((g) =>
    g.children.some((c) => location.pathname === c.path)
  )
  const SectionIcon = section.groups[0]?.icon

  const iconBox = SectionIcon ? (
    <div className={cn(
      "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
      sectionHasActiveChild ? "bg-primary/20 text-primary" : "bg-sidebar-accent/60 text-sidebar-foreground/60",
    )}>
      <SectionIcon className="size-4" />
    </div>
  ) : null

  return (
    <Collapsible defaultOpen={sectionHasActiveChild && !isCollapsed}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CollapsibleTrigger
            onClick={isCollapsed ? (e) => { e.preventDefault(); toggleSidebar() } : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
              sectionHasActiveChild
                ? "bg-sidebar-accent/60 text-sidebar-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground",
              "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
            )}
          >
            {iconBox}
            <span className="flex-1 text-sm font-medium group-data-[collapsible=icon]:hidden">
              {section.sectionTitle}
            </span>
            <ChevronDown className="size-4 shrink-0 text-sidebar-foreground/35 transition-transform duration-200 [[data-state=open]>&]:rotate-180 group-data-[collapsible=icon]:hidden" />
          </CollapsibleTrigger>
        </TooltipTrigger>
        {isCollapsed && (
          <TooltipContent side="right">{section.sectionTitle} — expand to navigate</TooltipContent>
        )}
      </Tooltip>

      <CollapsibleContent className="group-data-[collapsible=icon]:hidden">
        <div className="relative ml-10 mt-1 pb-1">
          <div className="absolute left-0 top-1 bottom-1 w-px bg-sidebar-border/60" />
          {section.groups.map((group) => {
            const child = group.children[0]
            const active = isActive(child.path)
            return (
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              <Link
                key={group.key}
                to={child.path as any}
                className={cn(
                  "relative flex items-center gap-2.5 py-1.5 pl-4 text-sm transition-colors",
                  active
                    ? "text-sidebar-foreground font-medium"
                    : "text-sidebar-foreground/50 hover:text-sidebar-foreground/80",
                )}
              >
                <div className={cn(
                  "absolute left-[-3px] z-10 size-[7px] rounded-full transition-colors",
                  active
                    ? "bg-primary ring-2 ring-primary/30"
                    : "border border-sidebar-foreground/30 bg-sidebar",
                )} />
                {group.label}
              </Link>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ─── Stepper skeleton ─────────────────────────────────────────────────────────

function StepperSkeleton({ count }: { count: number }) {
  return (
    <div className="px-2 py-1">
      {Array.from({ length: count }).map((_, idx) => (
        <div key={idx} className="flex items-stretch gap-3">
          <div className="relative flex flex-col items-center w-9 shrink-0 py-2">
            <div className="size-7 rounded-full bg-sidebar-accent animate-pulse" />
            {idx < count - 1 && <div className="w-0.5 flex-1 -mt-px bg-sidebar-border" />}
          </div>
          <div className="flex-1 min-w-0 py-2 space-y-2 group-data-[collapsible=icon]:hidden">
            <div className="h-3 w-24 rounded bg-sidebar-accent animate-pulse" />
            <div className="h-2.5 w-32 rounded bg-sidebar-accent/60 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Stepper for setup-step groups ───────────────────────────────────────────

function Stepper({
  groups,
  isActive,
  stepById,
  currentStepId,
}: {
  groups: MenuGroup[]
  isActive: (path: string) => boolean
  stepById: Map<SetupStepId, ReturnType<typeof useSetupSteps>['steps'][number]>
  currentStepId: SetupStepId | undefined
}) {
  return (
    <div className="px-2 py-1">
      {groups.map((group, idx) => {
        const step = stepById.get(group.setupStepId as SetupStepId)
        if (!step) return null
        const isLast = idx === groups.length - 1
        const path = group.children[0]?.path ?? '/'
        const active = isActive(path)
        const isCurrent = currentStepId === step.id
        const locked = !step.unlocked && !step.complete
        const lineFilled = step.complete

        return (
          <StepperRow
            key={group.key}
            group={group}
            path={path}
            active={active}
            isCurrent={isCurrent}
            isLast={isLast}
            complete={step.complete}
            locked={locked}
            lineFilled={lineFilled}
            blockingLabel={step.blockingLabel}
          />
        )
      })}
    </div>
  )
}

function StepperRow({
  group,
  path,
  active,
  isCurrent,
  isLast,
  complete,
  locked,
  lineFilled,
  blockingLabel,
}: {
  group: MenuGroup
  path: string
  active: boolean
  isCurrent: boolean
  isLast: boolean
  complete: boolean
  locked: boolean
  lineFilled: boolean
  blockingLabel: string | null
}) {
  const Icon = group.icon

  function handleLockedClick(e: React.MouseEvent) {
    e.preventDefault()
    toast.info(`Complete "${blockingLabel ?? 'previous step'}" first to unlock this step`)
  }

  const content = (
    <Link
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      to={locked ? undefined : (path as any)}
      onClick={locked ? handleLockedClick : undefined}
      disabled={locked}
      className={cn(
        "group/step relative flex items-stretch gap-3 rounded-lg transition-colors",
        "group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center",
        active && !locked && "bg-sidebar-accent",
        !locked && !active && "hover:bg-sidebar-accent/50",
        locked && "cursor-not-allowed",
      )}
    >
      <div className="relative flex flex-col items-center w-9 shrink-0 py-2 group-data-[collapsible=icon]:w-full">
        <div className={cn(
          "z-10 flex size-7 shrink-0 items-center justify-center rounded-full ring-2 transition-colors",
          complete
            ? "bg-green-500 text-white ring-green-500"
            : locked
              ? "bg-sidebar-accent text-sidebar-foreground/40 ring-sidebar-border"
              : isCurrent || active
                ? "bg-primary text-white ring-primary/30"
                : "bg-sidebar text-sidebar-foreground/60 ring-sidebar-border",
        )}>
          {complete ? (
            <Check className="size-3.5" strokeWidth={3} />
          ) : locked ? (
            <Lock className="size-3" />
          ) : (
            <Icon className="size-3.5" />
          )}
        </div>

        {!isLast && (
          <div className={cn(
            "w-0.5 flex-1 -mt-px",
            lineFilled ? "bg-green-500" : "bg-sidebar-border",
          )} />
        )}
      </div>

      <div className="flex-1 min-w-0 py-2 group-data-[collapsible=icon]:hidden">
        <div className="flex items-center gap-1.5">
          <span className={cn(
            "text-sm font-medium leading-tight",
            complete && "text-green-400",
            locked && "text-sidebar-foreground/40",
            !complete && !locked && "text-sidebar-foreground",
          )}>
            {group.label}
          </span>
          {isCurrent && !complete && (
            <span className="inline-block size-1.5 rounded-full bg-primary animate-pulse" />
          )}
        </div>
        {group.description && (
          <span className={cn(
            "block text-[11px] leading-snug truncate",
            locked ? "text-sidebar-foreground/30" : "text-sidebar-foreground/40",
          )}>
            {locked ? `Complete "${blockingLabel}" first` : group.description}
          </span>
        )}
      </div>
    </Link>
  )

  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">Complete "{blockingLabel}" first</TooltipContent>
      </Tooltip>
    )
  }

  return content
}

// ─── Setup progress widget ────────────────────────────────────────────────────

function SetupProgressWidget({
  mandatoryDone,
  completedCount,
  totalCount,
}: {
  mandatoryDone: boolean
  completedCount: number
  totalCount: number
}) {
  const navigate = useNavigate()
  const percent = Math.round((completedCount / totalCount) * 100)

  if (mandatoryDone && completedCount === totalCount) return null

  return (
    <button
      type="button"
      onClick={() => navigate({ to: '/' })}
      className="mb-1 rounded-xl bg-sidebar-accent p-3 text-left transition-colors hover:bg-sidebar-accent/80 group-data-[collapsible=icon]:hidden"
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          mandatoryDone ? 'bg-green-500/20 text-green-400' : 'bg-primary/20 text-primary',
        )}>
          {mandatoryDone ? <Check className="size-3.5" /> : <Rocket className="size-3.5" />}
        </div>
        <span className="text-xs font-semibold text-sidebar-foreground truncate">
          {mandatoryDone ? 'Almost done!' : 'Complete setup'}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-sidebar-border overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            mandatoryDone ? 'bg-green-500' : 'bg-primary',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-sidebar-foreground/40">
        {completedCount} of {totalCount} steps completed
      </p>
    </button>
  )
}

// ─── Utility footer (Help / Settings / Dark Mode / User) ─────────────────────

function UtilityFooter() {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { isDark, toggle: toggleDarkMode } = useTheme()
  const user = useAppSelector((s) => s.auth.user)
  const refreshToken = useAppSelector((s) => s.auth.refreshToken)

  const initials = user
    ? `${user.first_name?.[0] ?? ''}${user.last_name?.[0] ?? ''}`.toUpperCase()
    : '?'
  const fullName = user ? `${user.first_name} ${user.last_name}` : ''

  async function handleLogout() {
    try {
      await authService.logout({ refresh_token: refreshToken })
    } finally {
      dispatch(clearToken())
      dispatch(clearSavedOrganisation())
      navigate({ to: '/login' as never })
    }
  }

  const utilityItems = [
    { icon: HelpCircle, label: 'Help & Support', onClick: () => {} },
    { icon: Settings, label: 'Settings', onClick: () => navigate({ to: '/settings' as never }) },
    {
      icon: isDark ? Sun : Moon,
      label: isDark ? 'Light Mode' : 'Dark Mode',
      onClick: toggleDarkMode,
      rightSlot: (
        <div className={cn(
          "ml-auto flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
          isDark ? "bg-primary" : "bg-sidebar-foreground/25",
        )}>
          <div className={cn(
            "size-3.5 rounded-full bg-white shadow-sm transition-transform",
            isDark ? "translate-x-4" : "translate-x-0.5",
          )} />
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-0.5">
      <div className="mb-1 h-px bg-sidebar-border/50 group-data-[collapsible=icon]:hidden" />

      {utilityItems.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <item.icon className="size-4 shrink-0" />
          <span className="flex-1 text-left group-data-[collapsible=icon]:hidden">{item.label}</span>
          {item.rightSlot && <span className="group-data-[collapsible=icon]:hidden">{item.rightSlot}</span>}
        </button>
      ))}

      <div className="my-1 h-px bg-sidebar-border/50" />

      {/* User profile row */}
      <div className="flex w-full items-center gap-3 rounded-xl px-3 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <button
          type="button"
          onClick={() => navigate({ to: '/profile' as never })}
          title="View profile"
          className="flex min-w-0 flex-1 items-center gap-3 transition-colors hover:opacity-80 group-data-[collapsible=icon]:justify-center"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary text-xs font-bold">
            {initials}
          </div>
          <div className="flex min-w-0 flex-1 flex-col text-left group-data-[collapsible=icon]:hidden">
            <span className="truncate text-xs font-semibold text-sidebar-foreground">{fullName}</span>
            <span className="truncate text-[10px] text-sidebar-foreground/40">{user?.email}</span>
          </div>
        </button>
        <button
          type="button"
          onClick={handleLogout}
          title="Log out"
          className="shrink-0 rounded-lg p-1 text-sidebar-foreground/40 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/80 group-data-[collapsible=icon]:hidden"
        >
          <LogOut className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
