import { useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { useAppDispatch } from "@/store";
import { useGetPmsCycleActivationQuery } from "@/store/api/pmsApi";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import type { PmsNotificationCount } from "@/types/pms";
import { PMS_CYCLE_LIST_PATH } from "./cycle.constants";
import { formatDisplayDate } from "../shared/pms.utils";

/** The rows of the mockup, in order: label and the audience whose count it shows. */
const NOTIFICATION_ROWS: { label: string; audience: PmsNotificationCount["audience"] }[] = [
  { label: "Plant Heads and Plant HR", audience: "hr" },
  { label: "Functional Heads", audience: "hod_reviewers" },
  { label: "Section Heads", audience: "reporting_managers" },
  { label: "Employees (goals)", audience: "employees" },
];

/** A count, or a dash while nothing has been recorded for it. */
const count = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString("en-IN");

/** Screen 1.6 — confirmation shown after a cycle is published. */
const CycleActivated = () => {
  const navigate = useNavigate();
  const { cycleId } = useParams({ strict: false }) as { cycleId: string };
  const dispatch = useAppDispatch();
  const { data, isLoading, isError } = useGetPmsCycleActivationQuery(cycleId);

  useEffect(() => {
    dispatch(setBreadcrumbDetail(data ? `${data.cycle.basic.name} · Activated` : null));
    return () => void dispatch(setBreadcrumbDetail(null));
  }, [data, dispatch]);

  /** Back to the cycle list. */
  const goToList = () => navigate({ to: PMS_CYCLE_LIST_PATH });

  if (isLoading) return <PageLoader message="Loading…" />;
  if (isError || !data) {
    return <RecordNotFound entity="appraisal cycle" backLabel="Back to PMS Cycle" onBack={goToList} />;
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Cycle Activated"
        subtitle="The system has activated the cycle and notified users"
      />

      <div className="rounded-xl border bg-card px-6 py-10 sm:px-10">
        <div className="mx-auto flex max-w-xl flex-col items-center text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-emerald-500/10 ring-8 ring-emerald-500/5 duration-500 animate-in zoom-in-50">
            <CheckCircle2 className="size-8 text-emerald-600" />
          </span>
          <h2 className="mt-5 text-lg font-semibold text-foreground">
            Cycle {data.cycle.basic.name} is Active
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Published on {formatDisplayDate(data.published_on)}. Eligibility check has started
            automatically.
          </p>

          <div className="mt-7 w-full overflow-hidden rounded-lg border text-sm">
            <div className="grid grid-cols-[1fr_6rem] bg-table-header px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span className="text-left">Notification</span>
              <span className="text-right">Sent</span>
            </div>
            {NOTIFICATION_ROWS.map((row) => (
              <div
                key={row.audience}
                className="grid grid-cols-[1fr_6rem] border-t px-4 py-3 text-foreground"
              >
                <span className="text-left">{row.label}</span>
                <span className="text-right font-medium tabular-nums">
                  {count(data.notifications.find((n) => n.audience === row.audience)?.sent)}
                </span>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_6rem] border-t px-4 py-3 text-foreground">
              <span className="text-left">Employees eligible for appraisal</span>
              <span className="text-right font-medium tabular-nums">{count(data.eligible)}</span>
            </div>
          </div>

          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button onClick={goToList}>Back to PMS Cycle</Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CycleActivated;
