import { useLocation, useNavigate } from "@tanstack/react-router"
import {
  Award,
  Briefcase,
  Building2,
  ChevronDown,
  FolderOpen,
  Layers,
  LogOut,
  Menu,
  Moon,
  Rocket,
  Settings,
  Shield,
  Sun,
  User,
  UserCog,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSidebar } from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSetupSteps } from "@/hooks/use-setup-steps"
import { useTheme } from "@/hooks/use-theme"
import { useAppSelector, useAppDispatch } from "@/store"
import { clearToken } from "@/store/slices/auth-slice"
import { clearSavedOrganisation } from "@/store/slices/organisation-slice"
import { authService } from "@/api/auth"
import { SETUP_STEP_PATHS } from "@/modules/org-setup/menu-config"

// ─── Step icon map ────────────────────────────────────────────────────────────

const STEP_ICONS: Record<string, LucideIcon> = {
  organisation:     Building2,
  "business-units": Briefcase,
  departments:      Layers,
  "org-documents":  FolderOpen,
  policies:         Shield,
  designations:     Award,
  employees:        Users,
  "assign-head":    UserCog,
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OrgSetupTopbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { isDark, toggle: toggleDarkMode } = useTheme()
  const user = useAppSelector((s) => s.auth.user)
  const refreshToken = useAppSelector((s) => s.auth.refreshToken)
  const { setOpenMobile } = useSidebar()
  const { steps, mandatoryDone, completedCount, totalCount } = useSetupSteps()

  // Resolve the current step from the URL
  const stepIndex = SETUP_STEP_PATHS.indexOf(location.pathname)
  const currentStep = steps[stepIndex] ?? null
  const StepIcon = currentStep ? (STEP_ICONS[currentStep.id] ?? null) : null
  const percent = Math.round((completedCount / totalCount) * 100)

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

  return (
    <header className="flex h-14 shrink-0 items-center border-b px-3 sm:h-16 sm:px-4 gap-3">
      {/* Mobile-only: open sidebar drawer */}
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => setOpenMobile(true)}
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </Button>

      {/* Left: Current step icon + name */}
      {currentStep && StepIcon ? (
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <StepIcon className="size-4" />
          </div>
          <span className="truncate text-sm font-semibold text-foreground">{currentStep.label}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm font-semibold text-foreground">Organisation Setup</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Center: Setup progress pill */}
      {!(mandatoryDone && completedCount === totalCount) && (
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
      )}

      {/* Right: Dark mode + User dropdown */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="icon" onClick={toggleDarkMode} className="text-muted-foreground hover:text-foreground">
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-muted"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary text-xs font-bold">
                {initials}
              </div>
              <span className="hidden sm:block max-w-[120px] truncate text-sm font-medium text-foreground">{fullName}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => navigate({ to: '/profile' as never })}>
              <User className="mr-2 size-4" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate({ to: '/settings' as never })}>
              <Settings className="mr-2 size-4" />
              Settings
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
  )
}
