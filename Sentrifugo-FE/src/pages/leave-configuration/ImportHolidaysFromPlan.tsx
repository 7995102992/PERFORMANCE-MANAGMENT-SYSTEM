import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, Check, Copy, Search } from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import {
  useGetHolidayPlansQuery,
  useGetHolidayPlanQuery,
  useGetHolidaysQuery,
  useBulkImportHolidaysMutation,
} from "@/store/api/lmsApi";
import { PageLoader } from "@/components/shared/PageLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";

interface Props {
  targetPlanId: string;
  targetPlanYear?: number;
  onClose: () => void;
}

export function ImportHolidaysFromPlan({
  targetPlanId,
  targetPlanYear,
  onClose,
}: Props) {
  const confirm = useConfirm();
  const [sourcePlanId, setSourcePlanId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const { data: plansData } = useGetHolidayPlansQuery();
  const { data: targetPlanData } = useGetHolidayPlanQuery(targetPlanId, {
    skip: !targetPlanId,
  });
  const { data: holidaysData, isFetching } = useGetHolidaysQuery(
    { planId: sourcePlanId },
    { skip: !sourcePlanId },
  );
  const [bulkImport, { isLoading: isImporting }] =
    useBulkImportHolidaysMutation();

  // Target plan's BU/dept IDs — every imported holiday is applied to the
  // target plan's full scope regardless of the source holiday's own BU/dept.
  // This avoids HOLIDAY_BU_OUT_OF_PLAN_SCOPE / HOLIDAY_DEPT_OUT_OF_PLAN_SCOPE
  // errors that would otherwise 400 the bulk import mid-loop when the source
  // plan was scoped to a different BU/dept set than the target plan.
  const targetPlanBuIds = useMemo(
    () =>
      (targetPlanData?.business_units ?? []).map(
        (bu: any) => bu.id ?? bu._id ?? bu,
      ) as string[],
    [targetPlanData],
  );
  const targetPlanDeptIds = useMemo(
    () =>
      (targetPlanData?.departments ?? []).map(
        (d: any) => d.id ?? d._id ?? d,
      ) as string[],
    [targetPlanData],
  );

  const plans = useMemo(() => {
    if (!plansData) return [];
    return plansData.filter((p) => p._id !== targetPlanId);
  }, [plansData, targetPlanId]);

  const planOptions = useMemo<Option[]>(
    () => plans.map((p) => ({ label: p.name, value: p._id })),
    [plans],
  );

  const holidays = holidaysData?.items ?? [];

  const filteredHolidays = useMemo(() => {
    if (!search.trim()) return holidays;
    const q = search.toLowerCase();
    return holidays.filter(
      (h) => h.name.toLowerCase().includes(q) || h.date.includes(q),
    );
  }, [holidays, search]);

  useEffect(() => {
    setSelectedIds(new Set());
    setSearch("");
  }, [sourcePlanId]);

  useEffect(() => {
    if (holidays.length > 0 && selectedIds.size === 0) {
      setSelectedIds(new Set(holidays.map((h) => h._id)));
    }
  }, [holidays]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredHolidays.map((h) => h._id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const allSelected =
    filteredHolidays.length > 0 &&
    filteredHolidays.every((h) => selectedIds.has(h._id));

  const selectedHolidays = useMemo(
    () => holidays.filter((h) => selectedIds.has(h._id)),
    [holidays, selectedIds],
  );

  const adjustDate = (dateStr: string): string => {
    if (!targetPlanYear) return dateStr;
    const [, mm, dd] = dateStr.split("-");
    const adjusted = new Date(targetPlanYear, Number(mm) - 1, Number(dd));
    if (adjusted.getMonth() !== Number(mm) - 1) {
      const lastDay = new Date(targetPlanYear, Number(mm), 0).getDate();
      return `${targetPlanYear}-${mm}-${String(lastDay).padStart(2, "0")}`;
    }
    return `${targetPlanYear}-${mm}-${dd}`;
  };

  const formatDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const weekday = dt.toLocaleDateString("en-GB", { weekday: "short" });
    const dayMonth = dt
      .toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      .replace(/ /g, "-");
    return `${weekday}, ${dayMonth}`;
  };

  const handleImport = () => {
    if (selectedHolidays.length === 0) return;
    confirm({
      title: `Import ${selectedHolidays.length} Holiday${selectedHolidays.length !== 1 ? "s" : ""}?`,
      description: `This will add the selected holidays to your plan.${targetPlanYear ? ` Dates will be adjusted to ${targetPlanYear}.` : ""}`,
      confirmText: "Import",
      onConfirm: async () => {
        // Ignore each source holiday's own BU/dept scope. Instead,
        // apply every imported holiday to the TARGET plan's full
        // business unit and department scope. This avoids the source
        // plan's narrower (or simply different) scope causing
        // HOLIDAY_BU_OUT_OF_PLAN_SCOPE / HOLIDAY_DEPT_OUT_OF_PLAN_SCOPE
        // errors mid-loop on the BE. The legacy singular
        // business_unit_id field on older holidays is also irrelevant
        // here for the same reason.
        const payloadHolidays = selectedHolidays.map((source) => ({
          name: source.name,
          date: adjustDate(source.date),
          classification_id: source.classification?.id ?? "",
          business_unit_ids: targetPlanBuIds,
          applicable_department_ids: targetPlanDeptIds,
        }));

        try {
          const result = await bulkImport({
            plan_id: targetPlanId,
            holidays: payloadHolidays,
          }).unwrap();

          const parts: string[] = [];
          if (result.imported > 0) parts.push(`${result.imported} imported`);
          if (result.skipped > 0)
            parts.push(`${result.skipped} skipped (duplicate dates)`);
          toast.success("Holidays imported", parts.join(", "));
          onClose();
        } catch (err) {
          toast.error(err, "Failed to import holidays");
        }
      },
    });
  };

  const handleClose = () => {
    if (selectedIds.size > 0) {
      confirm({
        title: "Discard selection?",
        description:
          "You have holidays selected. Are you sure you want to go back?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: onClose,
      });
    } else {
      onClose();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={handleClose}>
            <ArrowLeft />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Import Holidays from Plan</h1>
            <p className="text-sm text-muted-foreground">
              Select a source plan and pick which holidays to import. Imported
              holidays will be applied to this plan's full business unit and
              department scope.
            </p>
          </div>
          {plans.length > 0 && (
            <Button
              disabled={selectedIds.size === 0 || isImporting}
              onClick={handleImport}
            >
              {isImporting ? (
                "Importing..."
              ) : (
                <>
                  <Check />
                  Import {selectedIds.size > 0 ? `${selectedIds.size} ` : ""}
                  Holiday{selectedIds.size !== 1 ? "s" : ""}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {plans.length === 0 ? (
        <EmptyState
          icon={Copy}
          title="No other plans to import from"
          description="Create another holiday plan first, then you can import its holidays here."
        />
      ) : (
        <>
          {/* Source plan selector + filters */}
          <div className="px-6 py-4 border-b border-border space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-72">
                <SearchableSelect
                  options={planOptions}
                  value={sourcePlanId}
                  onChange={(v) => setSourcePlanId(v as string)}
                  placeholder="Select source plan..."
                  searchable={planOptions.length > 5}
                />
              </div>
              {sourcePlanId && holidays.length > 0 && (
                <>
                  <div className="relative flex-1 max-w-sm">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search holidays..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {selectedIds.size} of {holidays.length} selected
                  </Badge>
                </>
              )}
            </div>
          </div>

          {/* Holiday list */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {!sourcePlanId ? (
              <EmptyState
                icon={CalendarDays}
                title="Select a source plan"
                description="Choose a holiday plan above to see its holidays."
              />
            ) : isFetching ? (
              <PageLoader message="Loading holidays..." />
            ) : holidays.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="No holidays yet"
                description="This plan has no holidays. Try selecting a different plan."
              />
            ) : filteredHolidays.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="No holidays match your search"
                description="Try a different search term."
              />
            ) : (
              <div className="rounded-xl border overflow-x-auto bg-card">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-table-header">
                    <tr className="border-b">
                      <th className="w-10 px-3 py-2.5">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={(checked) => toggleAll(!!checked)}
                        />
                      </th>
                      <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                        Holiday Name
                      </th>
                      <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                        Date
                      </th>
                      <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                        Classification
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHolidays.map((h) => (
                      <tr
                        key={h._id}
                        className={`border-b last:border-b-0 cursor-pointer transition-colors ${selectedIds.has(h._id) ? "bg-primary/5" : "hover:bg-muted/30"}`}
                        onClick={() => toggleSelect(h._id)}
                      >
                        <td
                          className="px-3 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={selectedIds.has(h._id)}
                            onCheckedChange={() => toggleSelect(h._id)}
                          />
                        </td>
                        <td className="px-3 py-2.5 font-medium">{h.name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {formatDate(h.date)}
                          {targetPlanYear &&
                            h.date.split("-")[0] !== String(targetPlanYear) && (
                              <span className="text-xs text-primary ml-1.5">
                                → {targetPlanYear}
                              </span>
                            )}
                        </td>
                        <td className="px-3 py-2.5">
                          {h.classification && (
                            <Badge
                              className="border-0 text-[10px]"
                              style={{
                                backgroundColor: `${h.classification.color}18`,
                                color: h.classification.color,
                              }}
                            >
                              {h.classification.name}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
