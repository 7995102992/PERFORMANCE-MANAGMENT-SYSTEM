import { useLocation } from "@tanstack/react-router";
import { Hourglass } from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";

const TITLES: Record<string, string> = {
  "my-goals": "My Goals",
  "self-appraisal": "Self Appraisal",
  "goal-approvals": "Goal Approvals",
  "target-revisions": "Target Revisions",
  "mid-year-review": "Mid-Year Review",
  "team-appraisal": "Team Appraisal",
  "appraisal-history": "Appraisal History",
  "lock-access": "Lock Access",
  "cycle-closure": "Cycle Closure",
};

/** Stand-in for PMS menu entries whose screens are not built yet. */
const PmsComingSoon = () => {
  const { pathname } = useLocation();
  const title = TITLES[pathname.split("/").filter(Boolean).pop() ?? ""] ?? "PMS";

  return (
    <div className="space-y-6 p-6">
      <PageHeader title={title} subtitle="Part of the PMS cycle" />
      <div className="rounded-xl border bg-card">
        <EmptyState
          icon={Hourglass}
          title="Coming soon"
          description={`${title} will be available here once the screen is designed.`}
        />
      </div>
    </div>
  );
};

export default PmsComingSoon;
