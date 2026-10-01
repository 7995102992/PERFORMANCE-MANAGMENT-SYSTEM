import { Fragment } from "react";
import { Check } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

const STEPS = [
  { num: 1, label: "Project Setup" },
  { num: 2, label: "Task" },
  { num: 3, label: "Resource" },
];

interface ProjectStepperProps {
  currentStep: 1 | 2 | 3;
  projectId?: string;
}

export function ProjectStepper({ currentStep, projectId }: ProjectStepperProps) {
  const navigate = useNavigate();

  const goToStep = (stepNum: number) => {
    if (stepNum === 1) {
      if (projectId) navigate({ to: "/timesheet/projects/$projectId/edit", params: { projectId } });
      else navigate({ to: "/timesheet/projects/setup" });
    } else if (stepNum === 2 && projectId) {
      navigate({ to: "/timesheet/projects/$projectId/tasks", params: { projectId } });
    } else if (stepNum === 3 && projectId) {
      navigate({ to: "/timesheet/projects/$projectId/resources", params: { projectId } });
    }
  };

  return (
    <div className="flex items-center justify-center py-6">
      <div className="flex items-center w-full max-w-lg">
        {STEPS.map((step, idx) => {
          const isCurrent = step.num === currentStep;
          const isCompleted = step.num < currentStep;
          const isClickable = isCompleted || (step.num > currentStep && !!projectId);

          return (
            <Fragment key={step.num}>
              <div className="flex flex-col items-center shrink-0">
                <button
                  type="button"
                  onClick={() => (isClickable || isCurrent) && goToStep(step.num)}
                  disabled={!isClickable && !isCurrent}
                  className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                    isCurrent
                      ? "bg-primary text-white"
                      : isCompleted
                        ? "bg-success text-white cursor-pointer"
                        : projectId
                          ? "bg-card border-2 border-border text-muted-foreground hover:border-primary hover:text-primary cursor-pointer"
                          : "bg-card border-2 border-border text-muted-foreground/50 cursor-not-allowed"
                  }`}
                >
                  {isCompleted ? <Check  /> : step.num}
                </button>
                <span
                  className={`mt-2 text-sm whitespace-nowrap ${
                    isCurrent
                      ? "text-foreground font-medium"
                      : isCompleted
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-px mx-4 mb-6 ${
                    step.num < currentStep ? "bg-success/40" : "bg-border"
                  }`}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
