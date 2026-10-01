/**
 * OrgSetupLayout
 *
 * Dedicated layout shell for the org-admin wizard (setup_status !== 'active').
 * 2-panel layout: vertical step sidebar (left) + content panel (right, floating card).
 * On mobile a compact progress bar + menu toggle is shown inside the content area,
 * and the sidebar slides in as a drawer from the left.
 */

import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Award,
  Briefcase,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Layers,
  Lock,
  UserCog,
  Users,
  X,
} from "lucide-react";
import type { ElementType } from "react";
import { useState } from "react";
import logoIcon from "@/assets/logo-icon.svg";
import { Button } from "@/components/ui/button";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { OrgBootstrap } from "./OrgBootstrap";
import { OrgSetupTopbar } from "./OrgSetupTopbar";
import { SETUP_STEP_PATHS } from "@/modules/org-setup/menu-config";
import { useSetupSteps, type SetupStep } from "@/hooks/use-setup-steps";
import { useAppDispatch, useAppSelector } from "@/store";
import { organisationService } from "@/api/org-setup";
import { useQueryClient } from "@tanstack/react-query";
import {
  WizardTabProvider,
  useWizardTabContext,
} from "@/modules/org-setup/wizard-tab-context";
import { setSavedOrganisation } from "@/store/slices/organisation-slice";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { LayoutVariantContext } from "@/contexts/layout-variant-context";

const SIDEBAR_KEY = "sidebar_open";

// Light mode: always deep purple brand sidebar
// Dark mode: blend with the dark theme's sidebar palette
const ORG_SETUP_DARK_SIDEBAR_CLASS =
  "[--background:#24124F] [--foreground:oklch(0.95_0.01_285)] [--muted:#24124F] [--muted-foreground:oklch(0.65_0.02_285)] [--sidebar:#11023B] [--sidebar-foreground:oklch(0.92_0.01_285)] [--sidebar-accent:#24124F] [--sidebar-accent-foreground:oklch(0.95_0.01_285)] [--sidebar-border:oklch(1_0_0_/_10%)] [--sidebar-ring:#6F5CFF] dark:[--background:oklch(0.15_0.015_285)] dark:[--muted:oklch(0.25_0.02_285)] dark:[--sidebar:oklch(0.18_0.025_285)] dark:[--sidebar-accent:oklch(0.25_0.03_285)]";

const STEP_ICONS: Record<string, ElementType> = {
  organisation: Building2,
  "business-units": Briefcase,
  departments: Layers,
  "org-documents": FolderOpen,
  designations: Award,
  employees: Users,
  "assign-head": UserCog,
};

const STEP_TAGLINES: Record<string, string> = {
  organisation: "Foundation",
  "business-units": "Business structure",
  departments: "Teams & members",
  "org-documents": "Documents",
  designations: "Job levels",
  employees: "People",
  "assign-head": "Reporting heads",
};

export function OrgSetupLayout() {
  const defaultOpen = localStorage.getItem(SIDEBAR_KEY) !== "false";

  return (
    <WizardTabProvider>
      <SidebarProvider
        defaultOpen={defaultOpen}
        onOpenChange={(open) => localStorage.setItem(SIDEBAR_KEY, String(open))}
      >
        <OrgBootstrap />
        <OrgSetupShell />
      </SidebarProvider>
    </WizardTabProvider>
  );
}

// ─── Inner shell — uses useSidebar to drive the mobile drawer ────────────────

function OrgSetupShell() {
  const { openMobile, setOpenMobile } = useSidebar();
  const open = openMobile;
  const setOpen = setOpenMobile;

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-background p-2 md:p-4">
      {/* ── Mobile drawer backdrop ─────────────────────────────── */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-background/60 backdrop-blur-sm transition-opacity duration-300 md:hidden",
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none",
        )}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* ── Mobile drawer ──────────────────────────────────────── */}
      <aside
        aria-label="Setup wizard navigation"
        aria-hidden={!open}
        className={cn(
          ORG_SETUP_DARK_SIDEBAR_CLASS,
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar py-6 pl-6 pr-8 text-sidebar-foreground shadow-2xl transition-transform duration-300 md:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40"
          aria-label="Close sidebar"
        >
          <X className="size-4" />
        </button>

        <WizardSidebarInner />
      </aside>

      {/* ── Desktop sidebar ────────────────────────────────────── */}
      <aside
        aria-label="Setup wizard navigation"
        className={cn(
          ORG_SETUP_DARK_SIDEBAR_CLASS,
          "hidden h-[90vh] my-auto w-64 shrink-0 flex-col rounded-2xl border border-sidebar-border/20 bg-sidebar py-4 pl-4 pr-6 text-sidebar-foreground shadow-sm md:flex lg:w-72 lg:py-5 lg:pl-5 lg:pr-8",
        )}
      >
        <WizardSidebarInner />
      </aside>

      {/* ── Content panel ─────────────────────────────────────── */}
      <main
        id="main-content"
        className="relative z-10 flex h-full flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-xl md:-ml-4 lg:-ml-6"
      >
        <div className="shrink-0">
          <OrgSetupTopbar />
        </div>
        <MobileStepProgress />
        <div className="flex-1 overflow-y-auto">
          <LayoutVariantContext.Provider value="flat">
            <Outlet />
          </LayoutVariantContext.Provider>
        </div>
      </main>
    </div>
  );
}

// ─── Mobile step progress bar ─────────────────────────────────────────────────

function MobileStepProgress() {
  const location = useLocation();
  const { steps, completedCount, mandatoryDone } = useSetupSteps();
  const currentIndex = SETUP_STEP_PATHS.indexOf(location.pathname);

  if (currentIndex < 0) return null;

  const currentStep = steps[currentIndex];
  const percent = Math.round((completedCount / steps.length) * 100);

  return (
    <div
      className="md:hidden shrink-0 border-b bg-secondary/40 px-4 py-2.5"
      role="region"
      aria-label="Setup progress"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
        <span className="truncate">
          Step {currentIndex + 1} of {steps.length}
          {currentStep ? ` — ${currentStep.label}` : ""}
        </span>
        <span className="shrink-0 ml-2">{completedCount} done</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Setup ${percent}% complete`}
        className="h-1 w-full rounded-full bg-muted overflow-hidden"
      >
        <div
          className="h-full rounded-full bg-foreground/60 transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

// ─── Shared sidebar content ───────────────────────────────────────────────────

function WizardSidebarInner() {
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { steps, mandatoryDone, completedCount, totalCount } = useSetupSteps();
  const { current: wizardTabs } = useWizardTabContext();
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const org = useAppSelector((s) => s.organisation.savedOrganisation);
  const [finishing, setFinishing] = useState(false);

  const currentIndex = SETUP_STEP_PATHS.indexOf(location.pathname);
  const prevPath = currentIndex > 0 ? SETUP_STEP_PATHS[currentIndex - 1] : null;
  const nextPath =
    currentIndex < SETUP_STEP_PATHS.length - 1
      ? SETUP_STEP_PATHS[currentIndex + 1]
      : null;

  function handleNext() {
    if (wizardTabs) {
      const tabIndex = wizardTabs.tabs.indexOf(wizardTabs.activeTab);
      if (tabIndex < wizardTabs.tabs.length - 1) {
        wizardTabs.setActiveTab(wizardTabs.tabs[tabIndex + 1]);
        return;
      }
    }
    if (nextPath) navigate({ to: nextPath });
  }

  function handleBack() {
    if (wizardTabs) {
      const tabIndex = wizardTabs.tabs.indexOf(wizardTabs.activeTab);
      if (tabIndex > 0) {
        wizardTabs.setActiveTab(wizardTabs.tabs[tabIndex - 1]);
        return;
      }
    }
    if (prevPath) navigate({ to: prevPath });
  }

  const allDone = completedCount === totalCount;

  function handleFinishSetup() {
    confirm({
      title: allDone ? "Finish Setup" : "Skip and Finish Setup",
      description: allDone
        ? "All steps are complete. Ready to finish the organisation setup?"
        : "Are you sure you want to skip the remaining steps and finish the organisation setup?",
      confirmText: allDone ? "Complete Setup" : "Skip and Complete",
      onConfirm: async () => {
        if (!org?.id) return;
        setFinishing(true);
        try {
          const updated = await organisationService.update(org.id, {
            setup_status: "active",
          });
          // Drop every cached wizard query so post-setup screens refetch fresh data
          await queryClient.cancelQueries();
          queryClient.clear();
          // Flip the layout to post-setup in place (no logout) using the fresh payload
          dispatch(setSavedOrganisation(updated));
          // Land the org admin on the post-setup dashboard
          navigate({ to: "/" });
          toast.success("Organisation setup completed");
        } catch (err) {
          toast.error(err, "Failed to finish setup");
          setFinishing(false);
        }
      },
    });
  }

  const backDisabled =
    !prevPath &&
    !(wizardTabs && wizardTabs.tabs.indexOf(wizardTabs.activeTab) > 0);
  const nextDisabled =
    !nextPath &&
    !(
      wizardTabs &&
      wizardTabs.tabs.indexOf(wizardTabs.activeTab) < wizardTabs.tabs.length - 1
    );

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white">
          <img src={logoIcon} alt="Sentrifugo" className="size-6" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-lg font-bold text-sidebar-foreground">
            Sentrifugo
          </span>
          <span className="text-[10px] leading-snug text-sidebar-foreground/50">
            Innovate . Automate . Empower
          </span>
        </div>
      </div>

      {/* Progress summary — mobile drawer only */}
      <div className="md:hidden">
        <SetupProgressCard
          steps={steps}
          completedCount={steps.filter((s) => s.complete).length}
        />
      </div>

      {/* Step list — scrollable */}
      <nav
        aria-label="Setup steps"
        className="flex min-h-0 flex-1 flex-col overflow-hidden mt-4 px-0.5 lg:mt-5"
      >
        <div className="flex h-full flex-col">
          <StepList
            steps={steps}
            currentIndex={currentIndex}
            onStepClick={(s) => navigate({ to: s.path })}
          />
        </div>
      </nav>

      {/* Back / Next */}
      <div className="mt-2 flex shrink-0 items-center justify-between gap-3 lg:mt-3">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          disabled={backDisabled}
          onClick={handleBack}
          aria-label="Go to previous step"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </Button>

        {mandatoryDone ? (
          <Button
            size="sm"
            className="h-10 rounded-full bg-success px-4 text-sm font-medium text-success-foreground hover:bg-success/90 lg:h-9 lg:px-5"
            disabled={finishing}
            onClick={handleFinishSetup}
          >
            <Check aria-hidden="true" />
            {allDone ? "Finish Setup" : "Skip & Finish"}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-10 rounded-full px-4 text-sm font-medium lg:h-9 lg:px-5"
            disabled={nextDisabled}
            onClick={handleNext}
            aria-label="Go to next step"
          >
            Next Step
            <ChevronRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Progress summary card ────────────────────────────────────────────────────

function SetupProgressCard({
  steps,
  completedCount,
}: {
  steps: SetupStep[];
  completedCount: number;
}) {
  const total = steps.length;
  const percent = Math.round((completedCount / total) * 100);
  const mandatorySteps = steps.filter((s) => s.mandatory);
  const mandatoryDone = mandatorySteps.every((s) => s.complete);

  return (
    <div className="mt-4 lg:mt-5 rounded-xl bg-background/10 border border-sidebar-border/20 px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-sidebar-foreground/80">
          Setup Progress
        </span>
        <span className="text-xs font-bold text-sidebar-foreground">
          {percent}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-sidebar-border/30 overflow-hidden mb-2.5">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            mandatoryDone ? "bg-success" : "bg-amber-400",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-sidebar-foreground/50">
        <span>
          {completedCount} of {total} steps done
        </span>
        {mandatoryDone && (
          <span className="text-success font-medium flex items-center gap-1">
            <Check className="size-2.5" />
            Required complete
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Step list ───────────────────────────────────────────────────────────────

function StepList({
  steps,
  currentIndex,
  onStepClick,
}: {
  steps: SetupStep[];
  currentIndex: number;
  onStepClick: (step: SetupStep) => void;
}) {
  return (
    <div className="relative flex h-full flex-col">
      {/* Connector line */}
      <div
        className="pointer-events-none absolute bottom-4 top-4 w-px border-l border-dashed border-sidebar-foreground/25"
        style={{ left: "1.125rem" }}
        aria-hidden="true"
      />
      <ol className="relative flex h-full flex-col justify-between">
        {steps.map((step, idx) => (
          <StepRow
            key={step.id}
            step={step}
            index={idx}
            isActive={idx === currentIndex}
            isCompleted={step.complete}
            isLocked={!step.unlocked && !step.complete}
            onClick={() => onStepClick(step)}
          />
        ))}
      </ol>
    </div>
  );
}

function StepRow({
  step,
  index,
  isActive,
  isCompleted,
  isLocked,
  onClick,
}: {
  step: SetupStep;
  index: number;
  isActive: boolean;
  isCompleted: boolean;
  isLocked: boolean;
  onClick: () => void;
}) {
  const isClickable = !isLocked;
  const Icon = STEP_ICONS[step.id];
  const stateLabel = isCompleted
    ? ", completed"
    : isLocked
      ? ", locked"
      : isActive
        ? ", current step"
        : "";

  return (
    <li className="relative">
      <button
        type="button"
        onClick={isClickable ? onClick : undefined}
        disabled={!isClickable}
        aria-current={isActive ? "step" : undefined}
        aria-label={`Step ${index + 1}: ${step.label}${stateLabel}`}
        className={cn(
          "group flex w-full items-center gap-3 rounded-xl px-1.5 py-1 text-left transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isClickable && !isActive && "cursor-pointer hover:bg-background/30",
          !isClickable && "cursor-not-allowed opacity-40",
        )}
      >
        {/* Step status indicator — small, unobtrusive */}
        <div
          aria-hidden="true"
          className={cn(
            "z-10 flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
            isActive && "border-foreground bg-foreground text-background",
            isCompleted &&
              "border-[1.9px] border-success bg-sidebar-accent text-success",
            !isActive &&
              !isCompleted &&
              !isLocked &&
              "border-sidebar-border bg-sidebar text-sidebar-foreground/70",
            isLocked &&
              "border-sidebar-border/50 bg-sidebar text-sidebar-foreground/40",
          )}
        >
          {isCompleted ? (
            <Check className="size-3" strokeWidth={3} />
          ) : isLocked ? (
            <Lock className="size-3" />
          ) : (
            index + 1
          )}
        </div>

        {/* Module icon */}
        {Icon && (
          <div
            aria-hidden="true"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-colors",
              isActive
                ? "bg-foreground text-background"
                : "bg-sidebar-accent/50 text-sidebar-foreground/70",
              isLocked && "opacity-40",
            )}
          >
            <Icon className="size-[15px]" />
          </div>
        )}

        {/* Labels */}
        <div
          className="flex min-w-0 flex-1 flex-col gap-0.5"
          aria-hidden="true"
        >
          <span
            className={cn(
              "text-[9px] uppercase leading-none tracking-[0.1em]",
              isActive ? "text-white" : "text-sidebar-foreground/50",
            )}
          >
            Step {index + 1}
          </span>
          <span
            className={cn(
              "text-[13px] font-semibold leading-tight truncate",
              isActive ? "text-white font-bold" : "text-sidebar-foreground/70",
            )}
          >
            {step.label}
          </span>
          <span
            className={cn(
              "text-[10px] leading-tight truncate",
              isActive ? "text-white/90" : "text-sidebar-foreground/50",
            )}
          >
            {STEP_TAGLINES[step.id] ?? ""}
          </span>
        </div>
      </button>
    </li>
  );
}
