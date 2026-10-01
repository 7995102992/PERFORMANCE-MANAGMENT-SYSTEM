/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useGetGrantPolicyQuery,
  useCreateGrantPolicyMutation,
} from "@/store/api/lmsApi";
import type { GrantPolicyCreate } from "@/types/leave";
import { useAppSelector } from "@/store";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { toast } from "@/lib/toast";

// The form keeps a boolean ``enabled`` flag for ergonomics; the BE expects
// ``status: 'ALLOWED' | 'NOT_ALLOWED'`` on the wire. We map at the I/O boundary.
interface FormExtraLeave {
  enabled: boolean;
  max_days: number;
}

type GrantPolicy = Omit<GrantPolicyCreate, "extra_leave" | "allocation"> & {
  extra_leave: FormExtraLeave;
};

const CUTOFF_DAYS = [21, 22, 23, 24, 25];

// Allocation moved to the leave type; extra leave is capped at a plain max here.
const MAX_EXTRA_DAYS = 365;

const DEFAULT_FORM = (orgId: string): GrantPolicy => ({
  org_id: orgId,
  joining_rule: { enabled: false, first_month_restriction: { enabled: false, cutoff_day: 0 } },
  extra_leave: { enabled: false, max_days: 1 },
});

function updateField<T extends object>(prev: T, path: string, value: unknown): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next = structuredClone(prev) as any;
  const keys = path.split(".");
  let node = next;
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
  node[keys[keys.length - 1]] = value;
  return next;
}

function isValid(form: GrantPolicy): boolean {
  if (form.joining_rule.enabled && form.joining_rule.first_month_restriction.enabled) {
    const cutoff = form.joining_rule.first_month_restriction.cutoff_day;
    if (cutoff < 1 || cutoff > 31) return false;
  }
  if (form.extra_leave.enabled) {
    if (form.extra_leave.max_days < 1) return false;
    if (form.extra_leave.max_days > MAX_EXTRA_DAYS) return false;
  }
  return true;
}

export interface LeavePlanGrantHandle {
  triggerSubmit: () => Promise<boolean>;
  triggerValidation: () => void;
  scrollToFirstError: () => void;
}

interface Props {
  planId?: string;
  readOnly?: boolean;
  onValidityChange?: (valid: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

const LeavePlanGrant = forwardRef<LeavePlanGrantHandle, Props>(function LeavePlanGrant({ planId, readOnly = false, onValidityChange, onDirtyChange }, ref) {
  const orgId = useAppSelector(s => s.auth.user?.organisation_id ?? "");

  const { data: initialData, isLoading: isFetching } = useGetGrantPolicyQuery(planId!, { skip: !planId });
  const [createPolicy, createResult] = useCreateGrantPolicyMutation();

  const [form, setForm] = useState<GrantPolicy>(DEFAULT_FORM(orgId));
  const [saved, setSaved] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const scrollToError = useScrollToError('[data-grant-form]');
  const baselineRef = useRef<string>(JSON.stringify(DEFAULT_FORM(orgId)));
  const isDirty = JSON.stringify(form) !== baselineRef.current;

  useEffect(() => {
    onValidityChange?.(isValid(form));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!initialData) return;
    const next: GrantPolicy = {
      org_id: orgId,
      joining_rule: initialData.joining_rule,
      extra_leave: {
        enabled: initialData.extra_leave?.status === "ALLOWED",
        max_days: initialData.extra_leave?.max_days ?? 1,
      },
    };
    baselineRef.current = JSON.stringify(next);
    setForm(next);
  }, [initialData, orgId]);

  const set = (path: string, value: unknown) =>
    setForm(prev => updateField(prev, path, value));

  const isLoading = createResult.isLoading;

  const handleSave = async () => {
    if (!planId) return;
    const draft = structuredClone(form);

    if (!draft.joining_rule.enabled) {
      draft.joining_rule.first_month_restriction.enabled = false;
    }
    if (!draft.extra_leave.enabled) {
      draft.extra_leave.max_days = 0;
    }

    // ``save_grant_policy`` on the BE is an upsert: POSTing the same
    // /leave-plans/{planId}/grant-policy endpoint either creates or replaces
    // the active policy. No separate update call is needed.
    const payload: GrantPolicyCreate = {
      org_id: draft.org_id,
      joining_rule: draft.joining_rule,
      extra_leave: {
        status: draft.extra_leave.enabled ? "ALLOWED" : "NOT_ALLOWED",
        max_days: draft.extra_leave.max_days,
      },
    };

    try {
      await createPolicy({ planId, ...payload }).unwrap();
      baselineRef.current = JSON.stringify(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      return true;
    } catch (err) {
      toast.error(err, "Failed to save grant policy");
      return false;
    }
  };

  useImperativeHandle(ref, () => ({
    triggerSubmit: async () => {
      if (!isValid(form)) {
        setShowErrors(true);
        requestAnimationFrame(() => scrollToError());
        toast.error("Please fix the highlighted fields.");
        return false;
      }
      return (await handleSave()) ?? false;
    },
    triggerValidation: () => {
      setShowErrors(true);
      requestAnimationFrame(() => scrollToError());
    },
    scrollToFirstError: scrollToError,
  }));

  if (!planId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-xl bg-muted/20">
        <p className="text-sm font-semibold text-muted-foreground mb-1">No plan selected</p>
        <p className="text-xs text-muted-foreground">Complete step 1 to create a leave plan first.</p>
      </div>
    );
  }

  if (isFetching) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading grant policy…
      </div>
    );
  }

  const ro = readOnly;
  const cardCls = "p-6 shadow-sm space-y-5";
  const sectionTitle = "text-sm font-bold mb-1";
  const sectionDesc = "text-xs text-muted-foreground mb-5";
  const fieldLabel = "text-xs font-medium text-muted-foreground uppercase tracking-wide block mb-1.5";

  // Helper: readable Yes/No flag with label for read-only mode
  const ReadOnlyFlag = ({ checked, title, desc }: { checked: boolean; title: string; desc?: string }) => (
    <div className="flex items-start gap-3">
      <span className={checked ? "text-sm font-medium text-success mt-0.5" : "text-sm text-muted-foreground mt-0.5"}>
        {checked ? "Yes" : "No"}
      </span>
      <div>
        <p className="text-sm font-semibold leading-none mb-1">{title}</p>
        {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      </div>
    </div>
  );

  return (
    <div data-grant-form className="w-full space-y-6">

      {/* ── Joining Rule ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Joining Rule</CardTitle>
          <CardDescription>Define pro-ration behaviour for employees who join mid-year.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              id="joiningEnabled"
              checked={form.joining_rule.enabled}
              onCheckedChange={v => {
                const enabled = Boolean(v);
                set("joining_rule.enabled", enabled);
                if (!enabled) set("joining_rule.first_month_restriction.enabled", false);
              }}
              disabled={ro}
              className="mt-0.5"
            />
            <div>
              <p className="text-sm font-semibold leading-none mb-1">Enable joining rule</p>
              <p className="text-xs text-muted-foreground">
                Pro-rate leave based on the month an employee joins the organisation.
              </p>
            </div>
          </label>

          {form.joining_rule.enabled && (
            <div className="pl-7 space-y-4 pt-1">
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox
                  id="firstMonthEnabled"
                  checked={form.joining_rule.first_month_restriction.enabled}
                  onCheckedChange={v => {
                    const enabled = Boolean(v);
                    setForm(prev => {
                      const next = updateField(prev, "joining_rule.first_month_restriction.enabled", enabled);
                      return enabled ? updateField(next, "joining_rule.first_month_restriction.cutoff_day", 0) : next;
                    });
                  }}
                  disabled={ro}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-semibold leading-none mb-1">Apply first-month cutoff restriction</p>
                  <p className="text-xs text-muted-foreground">
                    Employees joining after the cutoff day will not receive leave credit for that month.
                  </p>
                </div>
              </label>

              {form.joining_rule.first_month_restriction.enabled && (
                <Field>
                  <FieldLabel>Cutoff day of the month</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {CUTOFF_DAYS.map(d => (
                      <Button
                        key={d}
                        size="sm"
                        variant={form.joining_rule.first_month_restriction.cutoff_day === d ? "default" : "outline"}
                        onClick={() => set("joining_rule.first_month_restriction.cutoff_day", d)}
                        disabled={ro}
                        className="w-14"
                      >
                        {d}th
                      </Button>
                    ))}
                    <div className="flex items-center gap-2 ml-2">
                      <Label className="text-xs text-muted-foreground">Other:</Label>
                      <Input
                        type="number"
                        min={1}
                        max={31}
                        value={
                          CUTOFF_DAYS.includes(form.joining_rule.first_month_restriction.cutoff_day) ||
                          form.joining_rule.first_month_restriction.cutoff_day === 0
                            ? ""
                            : form.joining_rule.first_month_restriction.cutoff_day
                        }
                        placeholder="—"
                        onChange={e => {
                          const v = e.target.value === '' ? 0 : Number(e.target.value);
                          if (v === 0 || (v >= 1 && v <= 31)) set("joining_rule.first_month_restriction.cutoff_day", v);
                        }}
                        disabled={ro}
                        className="w-16 h-9 text-sm text-center"
                      />
                    </div>
                  </div>
                  {form.joining_rule.first_month_restriction.cutoff_day === 0 && (
                    <p className="text-xs text-destructive">Please select a cutoff day or enter a value between 1 and 31</p>
                  )}
                </Field>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Extra Leave ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Extra Leave</CardTitle>
          <CardDescription>Allow employees to take additional leave beyond their allocated balance.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Field>
              <FieldLabel>Extra leave</FieldLabel>
              <Select
                value={form.extra_leave.enabled ? "allowed" : "not_allowed"}
                onValueChange={v => set("extra_leave.enabled", v === "allowed")}
                disabled={ro}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="not_allowed">Not allowed</SelectItem>
                  <SelectItem value="allowed">Allowed</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {form.extra_leave.enabled && (
              <Field>
                <FieldLabel className="mb-1.5">Maximum extra days</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={MAX_EXTRA_DAYS}
                  value={form.extra_leave.max_days || ''}
                  onChange={e => set("extra_leave.max_days", e.target.value === '' ? 0 : Number(e.target.value))}
                  disabled={ro}
                  className="w-full"
                />
                {showErrors && form.extra_leave.max_days <= 0 && (
                  <p className="text-xs text-destructive">Maximum extra days is required</p>
                )}
                {form.extra_leave.max_days > MAX_EXTRA_DAYS && (
                  <p className="text-xs text-destructive">
                    Cannot exceed {MAX_EXTRA_DAYS} days
                  </p>
                )}
              </Field>
            )}
          </div>
        </CardContent>
      </Card>

    </div>
  );
});

export default LeavePlanGrant;
