import { useState, useEffect, useMemo } from "react";
import { Info, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useGetLeaveTypesQuery,
  useGetLeavePlanQuery,
  useSetLeavePlanLeaveTypesMutation,
} from "@/store/api/lmsApi";
import type { LeaveTypeResponse } from "@/types/leave";
import { useAppSelector } from "@/store";
import { LeaveTypeForm } from "./LeaveTypeForm";

interface Props {
  planId?: string;
}

const FREQ_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-Yearly",
  yearly: "Yearly",
};

interface TypeMeta {
  isPaid: boolean;
  isStatutory: boolean;
  isCompOff: boolean;
  expiryDays: number | null;
  maxStatutoryDays: number | null;
  annualCount: number | null;
  frequency: string | null;
  carryForward: boolean;
  carryForwardCount: number | null;
  encashable: boolean;
  encashPercentage: number | null;
  unit: string;
}

// Neutral setting chips (allocation, frequency, carry, encash) for a leave type.
function settingChips(t: TypeMeta): string[] {
  const u = t.unit === "Hours" ? "hrs" : "days";
  const chips: string[] = [];
  if (t.isCompOff) {
    chips.push(t.expiryDays ? `Expires in ${t.expiryDays} ${u}` : "Expiring");
    return chips; // no balance/accrual to show
  }
  if (t.isStatutory) {
    chips.push(t.maxStatutoryDays ? `${t.maxStatutoryDays} ${u}/yr` : "Statutory");
    return chips;
  }
  if (!t.isPaid) return chips; // unpaid (sick) — no accrual/carry to show
  if (t.annualCount != null) chips.push(`${t.annualCount} ${u}/yr`);
  if (t.frequency) chips.push(FREQ_LABEL[t.frequency] ?? t.frequency);
  chips.push(t.carryForward ? `Carry ${t.carryForwardCount ?? "—"}` : "No carry");
  if (t.encashable)
    chips.push(t.encashPercentage != null ? `Encash ${t.encashPercentage}%` : "Encashable");
  return chips;
}

function MetaChips({ t, className = "" }: { t: TypeMeta; className?: string }) {
  const paidTone = t.isCompOff
    ? "bg-warning/10 text-warning"
    : t.isStatutory
      ? "bg-primary/10 text-primary"
      : t.isPaid
        ? "bg-success/10 text-success"
        : "bg-muted text-muted-foreground";
  const paidLabel = t.isCompOff
    ? "Expiring"
    : t.isStatutory
      ? "Statutory"
      : t.isPaid
        ? "Paid"
        : "Unpaid · Sick";
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <span className={`text-[10px] leading-4 px-1.5 rounded ${paidTone}`}>{paidLabel}</span>
      {settingChips(t).map((c) => (
        <span
          key={c}
          className="text-[10px] leading-4 px-1.5 rounded bg-muted text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

export default function LeavePlanLeaveTypes({ planId }: Props) {
  const orgId = useAppSelector(s => s.auth.user?.organisation_id ?? "");
  const [createTypeDialogOpen, setCreateTypeDialogOpen] = useState(false);

  const { data: allTypesRaw, isLoading: allLoading, isError: allError } =
    useGetLeaveTypesQuery(orgId, { skip: !orgId });

  const { data: plan, isLoading: planLoading } =
    useGetLeavePlanQuery(planId!, { skip: !planId });

  const [setLeaveTypes] = useSetLeavePlanLeaveTypesMutation();

  // Server-derived assigned IDs
  const serverAssignedIds = useMemo(
    () => new Set(plan?.leave_type_ids ?? []),
    [plan],
  );

  // Optimistic state: track adds/removals that haven't been confirmed by a refetch yet
  const [optimisticAdded, setOptimisticAdded] = useState<Set<string>>(new Set());
  const [optimisticRemoved, setOptimisticRemoved] = useState<Set<string>>(new Set());

  // When the server refetch lands, clear optimistic overrides — server is now the truth
  useEffect(() => {
    setOptimisticAdded(new Set());
    setOptimisticRemoved(new Set());
  }, [plan?.leave_type_ids]);

  // True when any mutation is in flight
  const [isMutating, setIsMutating] = useState(false);
  // Track which single type is currently toggling (for per-card spinner)
  const [loadingTypeId, setLoadingTypeId] = useState<string | null>(null);

  // Effective selection: server truth + optimistic overrides
  const isSelected = (typeId: string) =>
    (serverAssignedIds.has(typeId) || optimisticAdded.has(typeId)) &&
    !optimisticRemoved.has(typeId);

  const allTypes = useMemo(() => {
    const arr = Array.isArray(allTypesRaw) ? allTypesRaw : [];
    return arr.map((t: LeaveTypeResponse) => ({
      id: t._id,
      name: t.name,
      color: t.color ?? "#007BFF",
      unit: t.unit === "HOURS" ? "Hours" : "Days",
      desc: t.description ?? "",
      isCustom: t.is_custom ?? false,
      isPaid: t.is_paid_leave ?? false,
      isStatutory: t.is_statutory_leave ?? false,
      isCompOff: t.is_comp_off ?? false,
      expiryDays: t.expiry_days ?? null,
      maxStatutoryDays: t.max_statutory_days ?? null,
      annualCount: t.accrual?.annual_count ?? null,
      frequency: t.accrual?.accrual_frequency ?? null,
      carryForward: t.accrual?.carry_forward ?? false,
      carryForwardCount: t.accrual?.carry_forward_count ?? null,
      encashable: t.accrual?.encashable ?? false,
      encashPercentage: t.accrual?.encash_percentage ?? null,
    }));
  }, [allTypesRaw]);

  const assignedTypes = useMemo(
    () => allTypes.filter(t => isSelected(t.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTypes, serverAssignedIds, optimisticAdded, optimisticRemoved],
  );

  const allIds = useMemo(() => allTypes.map(t => t.id), [allTypes]);
  const allSelected = allTypes.length > 0 && allTypes.every(t => isSelected(t.id));

  const applyBulk = async (
    newIds: string[],
    optimisticAdd: Set<string>,
    optimisticRemove: Set<string>,
    typeId?: string,
  ) => {
    setOptimisticAdded(optimisticAdd);
    setOptimisticRemoved(optimisticRemove);
    if (typeId) setLoadingTypeId(typeId);
    setIsMutating(true);
    try {
      await setLeaveTypes({ planId: planId!, leave_type_ids: newIds }).unwrap();
    } catch {
      // Revert optimistic state on failure
      setOptimisticAdded(new Set());
      setOptimisticRemoved(new Set());
    } finally {
      setLoadingTypeId(null);
      setIsMutating(false);
    }
  };

  const toggle = async (typeId: string) => {
    if (!planId || isMutating) return;

    const wasSelected = isSelected(typeId);
    const currentIds = allTypes.filter(t => isSelected(t.id)).map(t => t.id);
    const newIds = wasSelected
      ? currentIds.filter(id => id !== typeId)
      : [...currentIds, typeId];

    const newAdded = new Set(optimisticAdded);
    const newRemoved = new Set(optimisticRemoved);
    if (wasSelected) {
      newRemoved.add(typeId);
      newAdded.delete(typeId);
    } else {
      newAdded.add(typeId);
      newRemoved.delete(typeId);
    }

    await applyBulk(newIds, newAdded, newRemoved, typeId);
  };

  const selectAll = async () => {
    if (!planId || isMutating) return;
    const newAdded = new Set(allIds.filter(id => !serverAssignedIds.has(id)));
    await applyBulk(allIds, newAdded, new Set(), undefined);
  };

  const deselectAll = async () => {
    if (!planId || isMutating) return;
    const newRemoved = new Set(allIds.filter(id => serverAssignedIds.has(id)));
    await applyBulk([], new Set(), newRemoved, undefined);
  };

  if (!planId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-xl bg-muted/20">
        <p className="text-sm font-semibold text-muted-foreground mb-1">No plan selected</p>
        <p className="text-xs text-muted-foreground">Complete step 1 to create a leave plan first.</p>
      </div>
    );
  }

  if (allLoading || planLoading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading leave types…
      </div>
    );
  }

  if (allError) {
    return <p className="text-destructive text-sm py-8">Failed to load leave types. Please try again.</p>;
  }

  const systemTypes = allTypes.filter(t => !t.isCustom);
  const customTypes = allTypes.filter(t => t.isCustom);

  const TypeCard = ({ type }: { type: typeof allTypes[number] }) => {
    const selected = isSelected(type.id);
    const isThisLoading = loadingTypeId === type.id;

    return (
      <div
        role="button"
        tabIndex={isMutating ? -1 : 0}
        onClick={() => !isMutating && toggle(type.id)}
        onKeyDown={(e) => {
          if (!isMutating && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle(type.id);
          }
        }}
        className={`w-full text-left border rounded-md p-4 bg-card flex items-start gap-4 transition-colors
          ${isMutating ? "cursor-not-allowed opacity-60" : "cursor-pointer"}
          ${selected ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted-foreground"}
          ${isMutating && !isThisLoading ? "opacity-60" : ""}
        `}
      >
        {isThisLoading ? (
          <Loader2 className="w-4 h-4 mt-1 flex-shrink-0 animate-spin text-primary" />
        ) : (
          <Checkbox
            checked={selected}
            disabled={isMutating}
            className="mt-1 flex-shrink-0 pointer-events-none"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start mb-1">
            <div className="flex items-center gap-3">
              <span className="font-bold text-sm">{type.name}</span>
              <div className="w-4 h-4 rounded flex-shrink-0" style={{ backgroundColor: type.color }} />
            </div>
            <span className="text-xs font-bold text-muted-foreground ml-2">{type.unit}</span>
          </div>
          {type.desc && <p className="text-xs text-muted-foreground leading-snug pr-2">{type.desc}</p>}
          <MetaChips t={type} className="mt-2" />
        </div>
      </div>
    );
  };

  return (
    <>
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8">
      {/* Left: type lists */}
      <div className="md:col-span-8 space-y-8 min-w-0">
        {/* Select All / Deselect All */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {assignedTypes.length} of {allTypes.length} types selected
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={isMutating || allTypes.length === 0}
            onClick={allSelected ? deselectAll : selectAll}
          >
            {isMutating && !loadingTypeId ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <span
                className={`mr-1.5 inline-flex items-center justify-center w-4 h-4 rounded-sm border flex-shrink-0 pointer-events-none
                  ${allSelected ? "bg-primary border-primary" : "border-input bg-background"}`}
              >
                {allSelected && <Check className="w-3 h-3 text-primary-foreground" />}
              </span>
            )}
            {allSelected ? "Deselect All" : "Select All"}
          </Button>
        </div>

        <div>
          <h3 className="text-base font-semibold mb-4">System Leave Types</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {systemTypes.map(type => <TypeCard key={type.id} type={type} />)}
          </div>
        </div>

        <div>
          <h3 className="text-base font-semibold mb-4">Custom Leave Types</h3>
          {customTypes.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              {customTypes.map(type => <TypeCard key={type.id} type={type} />)}
            </div>
          )}
          <div className="w-full border-[1.5px] border-dashed border-primary/30 rounded-md h-[130px] bg-card flex flex-col items-center justify-center">
            <p className="text-sm font-semibold mb-1">Add Custom Leave Type</p>
            <p className="text-xs text-muted-foreground mb-3">Create a new leave type specific to your organisation</p>
            <Button
              variant="default"
              size="sm"
              onClick={() => setCreateTypeDialogOpen(true)}
            >
              Create Custom Type
            </Button>
          </div>
        </div>
      </div>

      {/* Right: assigned summary */}
      <div className="md:col-span-4 min-w-0">
        <h3 className="text-base font-extrabold mb-5">Assigned Leave Types</h3>
        <div className="space-y-3 mb-6 max-h-[420px] overflow-y-auto pr-1">
          {assignedTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No types assigned yet.</p>
          ) : (
            assignedTypes.map(type => (
              <div key={type.id} className="border rounded p-2.5 bg-card shadow-sm">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: type.color }} />
                  <span className="text-sm font-medium flex-1 truncate">{type.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{type.unit}</span>
                </div>
                <MetaChips t={type} />
              </div>
            ))
          )}
        </div>

        {assignedTypes.length > 0 && (
          <div className="bg-primary/10 rounded-md p-3 flex gap-3 items-start">
            <Info className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-xs text-primary font-medium leading-relaxed">
              {assignedTypes.length} leave type{assignedTypes.length !== 1 ? "s" : ""} assigned.
              Click any type to toggle it.
            </p>
          </div>
        )}
      </div>
    </div>

    <Dialog open={createTypeDialogOpen} onOpenChange={setCreateTypeDialogOpen}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogTitle className="sr-only">Add Custom Leave Type</DialogTitle>
        <LeaveTypeForm
          onCancel={() => setCreateTypeDialogOpen(false)}
          onSuccess={() => setCreateTypeDialogOpen(false)}
        />
      </DialogContent>
    </Dialog>
    </>
  );
}
