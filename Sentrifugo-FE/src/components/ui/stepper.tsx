import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepperStep {
  id: number;
  label: string;
}

interface StepperProps {
  steps: StepperStep[];
  current: number;
  completed: Set<number>;
  onStepClick?: (id: number) => void;
  className?: string;
}

function Stepper({
  steps,
  current,
  completed,
  onStepClick,
  className,
}: StepperProps) {
  return (
    <ol
      data-slot="stepper"
      className={cn(
        "flex w-full items-center justify-center list-none p-0 m-0",
        className,
      )}
    >
      {steps.map((step, idx) => {
        const isDone = completed.has(step.id);
        const isActive = current === step.id;
        const isLast = idx === steps.length - 1;

        return (
          <React.Fragment key={step.id}>
            <li className="shrink-0 flex flex-col items-center">
              <button
                type="button"
                onClick={() => onStepClick?.(step.id)}
                className={cn(
                  "group flex items-center rounded-full",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                aria-current={isActive ? "step" : undefined}
                aria-label={step.label}
                title={step.label}
              >
                <span
                  className={cn(
                    "size-7 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground border-primary ring-4 ring-primary/15"
                      : isDone
                        ? "bg-success text-white border-success"
                        : "bg-background border-border text-muted-foreground group-hover:border-foreground/40 group-hover:text-foreground",
                  )}
                >
                  {isDone && !isActive ? (
                    <Check  />
                  ) : (
                    step.id + 1
                  )}
                </span>
              </button>
              <span
                className={cn(
                  "mt-1.5 text-[10px] leading-tight font-medium text-center max-w-[80px]",
                  isActive
                    ? "text-primary"
                    : isDone
                      ? "text-success"
                      : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
            {!isLast && (
              <li
                aria-hidden
                className={cn(
                  "h-px flex-1 min-w-[12px] max-w-[800px] mx-1.5 sm:mx-2 mb-5 transition-colors",
                  isDone ? "bg-success" : "bg-border",
                )}
              />
            )}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

export { Stepper };
