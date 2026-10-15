import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { toast } from "@/lib/toast";
import { useGetPmsCyclesQuery, usePublishPmsCycleMutation } from "@/store/api/pmsApi";
import type { PmsCycleListItem, PmsCycleListParams } from "@/types/pms";
import { CycleStatusBadge } from "./components/CycleStatusBadge";
import { APPRAISAL_TYPE_LABEL } from "./cycle.constants";
import { financialYearLabel, formatDisplayDate } from "../shared/pms.utils";

/** Status tabs of the mockup. "Closed" also lists cancelled cycles, which have no tab of their own. */
type Tab = "all" | "active" | "draft" | "closed";

/** Column titles of the cycle table. */
const HEADERS = ["Cycle Name", "Period", "Type", "Status", "Actions"];

/** Last three financial years plus the next one. */
const YEAR_OPTIONS = (() => {
  const now = new Date();
  const current = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return [current + 1, current, current - 1, current - 2, current - 3];
})();

/** The financial year the list opens on. */
const CURRENT_YEAR = (() => {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
})();

/**
 * Screen 1.1 - PMS Cycle (route /pms/cycle): the financial-year selector, the "Initialize New Appraisal"
 * button, the All / Active / Draft / Closed tabs and the cycle table. A draft is edited or published from
 * its row; a closed cycle is viewed or cloned into a new one.
 */
const PmsCycleList = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("all");
  const [year, setYear] = useState(String(CURRENT_YEAR));
  const [publishCycle, { isLoading: publishing }] = usePublishPmsCycleMutation();

  // Query parameters: the closed tab asks for closed cycles; cancelled ones are filtered in with them below.
  const params = useMemo<PmsCycleListParams>(
    () => ({
      year: Number(year),
      status: tab === "all" ? undefined : tab,
      skip: 0,
      limit: 100,
    }),
    [year, tab],
  );
  const { data, isLoading, isFetching } = useGetPmsCyclesQuery(params);
  const items = data?.items ?? [];

  /** Opens the wizard for a cycle: the edit route when `edit` is true, otherwise the read-only view. */
  const openCycle = (cycle: PmsCycleListItem, edit = false) =>
    navigate({
      to: edit ? "/pms/cycle/$cycleId/edit" : "/pms/cycle/$cycleId",
      params: { cycleId: cycle.id },
    });

  /** Clone: a new cycle starts from this one, with the dates left to pick. */
  const clone = (cycle: PmsCycleListItem) =>
    navigate({ to: "/pms/cycle/new", search: { clone: cycle.id } as never });

  /** Publishes a draft and opens the Cycle Activated screen. */
  const publish = async (cycle: PmsCycleListItem) => {
    try {
      await publishCycle(cycle.id).unwrap();
      navigate({ to: "/pms/cycle/$cycleId/activated", params: { cycleId: cycle.id } });
    } catch (e) {
      // An incomplete draft lists what is missing; open it so the gaps can be fixed.
      toast.error(e, "Could not publish the cycle. Complete every step first.");
    }
  };

  const link = "font-medium text-primary hover:underline disabled:opacity-50";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="PMS Cycle"
        subtitle="View all appraisal cycles and start a new one"
        action={
          <div className="flex items-center gap-3">
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger aria-label="Financial year" className="w-40 font-medium">
                <CalendarDays className="size-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {YEAR_OPTIONS.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {financialYearLabel(y)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => navigate({ to: "/pms/cycle/new" })}>
              <Plus /> Initialize New Appraisal
            </Button>
          </div>
        }
      />

      <div className="overflow-hidden rounded-xl border bg-card">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="px-3">
            <TabsTrigger value="all">All Cycles</TabsTrigger>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="draft">Draft</TabsTrigger>
            <TabsTrigger value="closed">Closed</TabsTrigger>
          </TabsList>
        </Tabs>

        <Table>
          <TableHeader>
            <TableRow className="border-y border-table-border bg-table-header hover:bg-table-header">
              {HEADERS.map((h) => (
                <TableHead
                  key={h}
                  className="h-10 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className={isFetching && !isLoading ? "opacity-60 transition-opacity" : ""}>
            {isLoading ? (
              Array.from({ length: 4 }, (_, r) => (
                <TableRow key={r}>
                  {HEADERS.map((h) => (
                    <TableCell key={h}>
                      <Skeleton className="h-4 w-full max-w-[9rem]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={HEADERS.length}>
                  <EmptyState
                    icon={CalendarDays}
                    title="No appraisal cycles"
                    description="Initialize a new appraisal to get started."
                    action={
                      <Button onClick={() => navigate({ to: "/pms/cycle/new" })}>
                        <Plus /> Initialize New Appraisal
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              items.map((cycle) => (
                <TableRow key={cycle.id}>
                  <TableCell className="font-medium text-foreground">{cycle.name}</TableCell>
                  <TableCell className="whitespace-nowrap text-foreground">
                    {formatDisplayDate(cycle.period_start)} – {formatDisplayDate(cycle.period_end)}
                  </TableCell>
                  <TableCell className="text-foreground">{APPRAISAL_TYPE_LABEL[cycle.type]}</TableCell>
                  <TableCell>
                    <CycleStatusBadge status={cycle.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {cycle.status === "draft" ? (
                      <>
                        <button type="button" className={link} onClick={() => openCycle(cycle, true)}>
                          Edit
                        </button>
                        <span className="px-1.5 text-muted-foreground">·</span>
                        <button
                          type="button"
                          className={link}
                          disabled={publishing}
                          onClick={() => publish(cycle)}
                        >
                          Publish
                        </button>
                      </>
                    ) : cycle.status === "active" ? (
                      <>
                        <button type="button" className={link} onClick={() => openCycle(cycle)}>
                          View
                        </button>
                        <span className="px-1.5 text-muted-foreground">·</span>
                        <button type="button" className={link} onClick={() => openCycle(cycle, true)}>
                          Edit
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={link} onClick={() => openCycle(cycle)}>
                          View
                        </button>
                        <span className="px-1.5 text-muted-foreground">·</span>
                        <button type="button" className={link} onClick={() => clone(cycle)}>
                          Clone
                        </button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

export default PmsCycleList;
