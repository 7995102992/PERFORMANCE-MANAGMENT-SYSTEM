import { useNavigate } from "@tanstack/react-router";
import {
  Building2,
  Briefcase,
  Layers,
  Award,
  FolderOpen,
  Users,
  UserCog,
  Check,
  Lock,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useSetupSteps,
  type SetupStep,
  type SetupStepId,
} from "@/hooks/use-setup-steps";
import { useAppSelector } from "@/store";
import { OrgDashboard } from "./Dashboard";

const STEP_ICONS: Record<SetupStepId, React.ReactNode> = {
  organisation: <Building2 className="h-5 w-5" />,
  "business-units": <Briefcase className="h-5 w-5" />,
  departments: <Layers className="h-5 w-5" />,
  "org-documents": <FolderOpen className="h-5 w-5" />,
  designations: <Award className="h-5 w-5" />,
  employees: <Users className="h-5 w-5" />,
  "assign-head": <UserCog className="h-5 w-5" />,
};

const STEP_DESCRIPTIONS: Record<SetupStepId, string> = {
  organisation: "Set up your company name, address, logo, and core settings.",
  "business-units":
    "Define your business structure — single or multiple units.",
  departments: "Create departments and assign them to business units.",
  "org-documents":
    "Upload company policies, handbooks, and compliance documents.",
  designations: "Create designations, salary bands, and pay grades.",
  employees: "Add and manage employees across the organisation.",
  "assign-head": "Assign heads to business units and departments.",
};

export function Home() {
  const navigate = useNavigate();
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const {
    mandatorySteps,
    optionalSteps,
    mandatoryDone,
    completedCount,
    totalCount,
  } = useSetupSteps();

  if (savedOrg?.setup_status === "active") {
    return <OrgDashboard />;
  }

  const progressPercent = Math.round((completedCount / totalCount) * 100);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-xl">Organisation Setup</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {mandatoryDone
            ? "Core setup is complete. Review completed steps or continue with optional ones."
            : "Complete the steps below to configure your organisation."}
        </p>
      </div>

      {/* ── Progress bar ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-medium text-foreground">
              {completedCount} of {totalCount} steps completed
            </span>
            {mandatoryDone && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Check className="h-3 w-3" aria-hidden="true" />
                Core complete
              </span>
            )}
          </div>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {progressPercent}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Setup ${progressPercent}% complete`}
          className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
        >
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              mandatoryDone ? "bg-success" : "bg-amber-400",
            )}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* ── Step list ───────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-label uppercase tracking-wide">
          Setup Steps
        </h2>
        <div className="space-y-3">
          {[...mandatorySteps, ...optionalSteps].map((step, idx) => (
            <StepCard
              key={step.id}
              step={step}
              stepNumber={idx + 1}
              onNavigate={() => navigate({ to: step.path })}
            />
          ))}
        </div>
      </div>

      {/* ── Ready to go banner ──────────────────────────────────────────────── */}
      {mandatoryDone && (
        <div className="rounded-xl border border-border bg-muted/30 px-5 py-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Ready to manage employees
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              You can start adding employees or continue with the remaining
              optional steps.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate({ to: "/employees/list" })}
          >
            Manage Employees
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Step card ────────────────────────────────────────────────────────────────

function StepCard({
  step,
  stepNumber,
  onNavigate,
}: {
  step: SetupStep;
  stepNumber: number;
  onNavigate: () => void;
}) {
  const { complete, unlocked, blockingLabel } = step;
  const locked = !unlocked && !complete;

  return (
    <div
      className={cn(
        "group relative flex items-center gap-4 rounded-xl border px-5 py-3.5 transition-all",
        complete
          ? "border-border bg-muted/20"
          : locked
            ? "border-border/40 bg-transparent opacity-50"
            : "border-border bg-card hover:border-foreground/20 hover:shadow-sm cursor-pointer",
      )}
      onClick={!locked && !complete ? onNavigate : undefined}
    >
      {/* Step number / status indicator */}
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold border",
          complete
            ? "border-border/60 bg-muted text-muted-foreground  text-success"
            : locked
              ? "border-border/40 bg-transparent text-muted-foreground/50"
              : "border-border bg-transparent text-foreground/70",
        )}
        aria-hidden="true"
      >
        {complete ? (
          <Check className="h-3.5 w-3.5" />
        ) : locked ? (
          <Lock className="h-3 w-3" />
        ) : (
          stepNumber
        )}
      </div>

      {/* Icon */}
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]",
          complete || locked
            ? "bg-muted text-muted-foreground"
            : "bg-icon-bg text-icon",
        )}
      >
        {STEP_ICONS[step.id]}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-sm font-semibold leading-tight",
            complete ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {step.label}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {locked
            ? `Complete "${blockingLabel}" first`
            : STEP_DESCRIPTIONS[step.id]}
        </p>
      </div>

      {/* Action */}
      {!locked && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate();
          }}
          aria-label={`${complete ? "View" : "Set up"} ${step.label}`}
        >
          {complete ? "View" : "Set Up"}
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
