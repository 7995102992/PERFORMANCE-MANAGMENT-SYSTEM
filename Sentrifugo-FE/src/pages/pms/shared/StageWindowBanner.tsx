import { Info } from "lucide-react";
import { useGetPmsStageNoticesQuery } from "@/store/api/pmsApi";
import type { PmsStageNotice } from "@/types/pms-goals";
import { formatDisplayDate } from "./pms.utils";
import { stageNoticeSummary } from "./stageNotice.utils";

/** What the person does in the window, shown after the dates; the end date is always part of the line. */
const STAGE_HINT: Record<PmsStageNotice["stage"], string> = {
  goal_setting: "Targets are set for one employee at a time. Open an employee to enter the targets.",
  employee_acknowledgement: "Review the targets your manager sent, then acknowledge them or request a change.",
  hod_approval: "Review the goal sheets and target revisions your managers sent, then approve or return them.",
};

/** The part of the hint that is shown in bold, as in the design. */
const STAGE_EMPHASIS: Partial<Record<PmsStageNotice["stage"], string>> = {
  goal_setting: "one employee at a time",
};

/** Renders the hint with its emphasised phrase in bold. */
function Hint({ stage }: { stage: PmsStageNotice["stage"] }) {
  const text = STAGE_HINT[stage];
  const bold = STAGE_EMPHASIS[stage];
  if (!bold || !text.includes(bold)) return <>{text}</>;
  const [before, after] = text.split(bold);
  return (
    <>
      {before}
      <strong>{bold}</strong>
      {after}
    </>
  );
}

/**
 * The info banner under a PMS page title: when the stage opens and, always, when it ends. The dates come from
 * the cycle timeline Corporate HR configured (screen 1.3); it renders nothing when the cycle has no window.
 */
export function StageWindowBanner({
  stage,
  financialYear,
}: {
  stage: PmsStageNotice["stage"];
  financialYear: string;
}) {
  const { data = [] } = useGetPmsStageNoticesQuery(financialYear);
  const notice = data.find((n) => n.stage === stage);
  if (!notice) return null;
  const tone =
    notice.state === "closed"
      ? "bg-destructive/10 text-destructive"
      : notice.days_left !== null && notice.state === "open" && notice.days_left <= 3
        ? "bg-amber-500/10 text-amber-800"
        : "bg-primary/10 text-foreground";
  return (
    <div className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm ${tone}`} role="status">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong>{notice.title}</strong> {stageNoticeSummary(notice, formatDisplayDate)}{" "}
        {notice.state !== "closed" && <Hint stage={stage} />}
      </p>
    </div>
  );
}
