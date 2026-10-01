import { Fragment } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepperStep } from "@/components/ui/stepper";

interface WizardStepperProps {
  steps: StepperStep[];
  current: number;
  completed: Set<number>;
  onStepClick?: (id: number) => void;
}

/**
 * Full-width stepper for the cycle wizard. The shared `Stepper` is sized for
 * dense 4-step flows in the leave setup; this one spreads the labels across
 * the card the way the PMS mockups do.
 */
export function WizardStepper({
  steps,
  current,
  completed,
  onStepClick,
}: WizardStepperProps) {
  return (
    <ol className="flex w-full items-start">
      {steps.map((step, i) => {
        const done = completed.has(step.id) && current !== step.id;
        const active = current === step.id;
        const reachable = done || step.id < current;
        return (
          <Fragment key={step.id}>
            <li className="flex shrink-0 flex-col items-center gap-1.5">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onStepClick?.(step.id)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border text-xs font-semibold transition-all",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active &&
                    "border-primary bg-primary text-primary-foreground ring-4 ring-primary/15",
                  done && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15",
                  !active && !done && "border-border bg-background text-muted-foreground",
                  !reachable && !active && "cursor-default",
                )}
              >
                {done ? <Check className="size-4" /> : step.id + 1}
              </button>
              <span
                className={cn(
                  "text-xs font-medium",
                  active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
            {i < steps.length - 1 && (
              <li
                aria-hidden
                className={cn(
                  "mx-3 mt-4 h-0.5 flex-1 rounded-full transition-colors",
                  completed.has(step.id) || step.id < current ? "bg-primary/40" : "bg-border",
                )}
              />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}
