import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ColorPicker } from "@/components/shared/ColorPicker";
import { PageHeader } from "@/components/shared/PageHeader";
import { Trash2 } from "lucide-react";
import {
  useCreateLeaveTypeMutation,
  useUpdateLeaveTypeMutation,
  useDeleteLeaveTypeMutation,
} from "@/store/api/lmsApi";
import type { LeaveTypeResponse, LeaveAccrualFrequency } from "@/types/leave";
import { useAppSelector } from "@/store";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";

interface LeaveTypeFormProps {
  initialData?: LeaveTypeResponse | null;
  readOnly?: boolean;
  detailsReadOnly?: boolean;
  onCancel: () => void;
  onSuccess: () => void;
}

interface FormErrors {
  name?: string;
  code?: string;
  maxStatutoryDays?: string;
  expiryDays?: string;
  annualCount?: string;
  accrualFrequency?: string;
  carryForwardCount?: string;
  encashPercentage?: string;
}

const ACCRUAL_FREQUENCIES: { value: LeaveAccrualFrequency; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "half_yearly", label: "Half-Yearly" },
  { value: "yearly", label: "Yearly (all at once)" },
];

function validate(
  name: string,
  code: string,
  isStatutoryLeave: boolean,
  maxStatutoryDays: number | null,
  isPaidLeave: boolean,
  annualCount: number | null,
  accrualFrequency: LeaveAccrualFrequency | "",
  carryForward: boolean,
  carryForwardCount: number | null,
  encashable: boolean,
  encashPercentage: number | null,
  isCompOff: boolean,
  expiryDays: number | null,
  isUnrestricted: boolean,
): FormErrors {
  const errs: FormErrors = {};
  if (!name.trim()) errs.name = "Leave type name is required";
  else if (name.trim().length > 100)
    errs.name = "Name must be 100 characters or less";
  if (!code.trim()) errs.code = "Code is required";
  else if (code.trim().length > 20)
    errs.code = "Code must be 20 characters or less";

  // Comp-off / expiring leave carries no accrual or statutory config — only the
  // expiry window is required. Skip every other rule below.
  if (isCompOff) {
    if (expiryDays === null || expiryDays <= 0)
      errs.expiryDays = "Enter after how many days the leave expires (greater than 0)";
    else if (expiryDays > 365) errs.expiryDays = "Cannot exceed 365 days";
    return errs;
  }

  // Unrestricted leave tracks no balance either, so it carries no accrual and
  // nothing below applies. Name and code are the whole contract.
  if (isUnrestricted) return errs;

  if (isStatutoryLeave && (maxStatutoryDays === null || maxStatutoryDays <= 0))
    errs.maxStatutoryDays = "Required when statutory leave is enabled";
  else if (isStatutoryLeave && maxStatutoryDays !== null && maxStatutoryDays > 365)
    errs.maxStatutoryDays = "Cannot exceed 365 days";

  // Paid (non-statutory) leave must declare how many leaves accrue and how
  // often — mirrors the backend's accrual_rules_error validation. Statutory
  // leave takes its count from the statutory-days field, so it is exempt.
  if (isPaidLeave && !isStatutoryLeave) {
    if (annualCount === null || annualCount <= 0)
      errs.annualCount = "Number of leaves per year is required";
    else if (annualCount > 365)
      errs.annualCount = "Cannot exceed 365 days";
    if (!accrualFrequency)
      errs.accrualFrequency = "Accrual frequency is required";
  } else if (annualCount !== null && (annualCount < 0 || annualCount > 365)) {
    errs.annualCount = annualCount < 0 ? "Cannot be negative" : "Cannot exceed 365 days";
  }

  // Carry-forward only applies to paid leave.
  if (isPaidLeave && carryForward) {
    if (carryForwardCount === null || carryForwardCount <= 0)
      errs.carryForwardCount = "Enter how many can carry forward";
    // else if (annualCount !== null && carryForwardCount > annualCount)
    //   errs.carryForwardCount = "Cannot exceed the annual allocation";
  }

  // Encashment (paid leave only): when enabled, a 1–100% is mandatory.
  if (isPaidLeave && !isStatutoryLeave && encashable) {
    if (encashPercentage === null || encashPercentage <= 0 || encashPercentage > 100)
      errs.encashPercentage = "Enter an encashment percentage (1–100)";
  }
  return errs;
}

export function LeaveTypeForm({
  initialData,
  readOnly = false,
  detailsReadOnly = false,
  onCancel,
  onSuccess,
}: LeaveTypeFormProps) {
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id ?? "");
  const [createLeaveType, createResult] = useCreateLeaveTypeMutation();
  const [updateLeaveType, updateResult] = useUpdateLeaveTypeMutation();
  const [deleteLeaveType] = useDeleteLeaveTypeMutation();
  const confirm = useConfirm();
  const scrollToError = useScrollToError();


  const [name, setName] = useState(initialData?.name ?? "");
  const [code, setCode] = useState(initialData?.code ?? "");
  const [desc, setDesc] = useState(initialData?.description ?? "");
  const [color, setColor] = useState(initialData?.color ?? "#A8CAFF");
  const [unit, setUnit] = useState(
    initialData?.unit === "HOURS" ? "Hours" : "Days",
  );
  const [isPaidLeave, setIsPaidLeave] = useState(
    initialData?.is_paid_leave ?? true,
  );
  const [deductFromBalance, setDeductFromBalance] = useState(
    initialData?.deduct_from_leave_balance ?? true,
  );
  const [isStatutoryLeave, setIsStatutoryLeave] = useState(
    initialData?.is_statutory_leave ?? false,
  );
  const [maxStatutoryDays, setMaxStatutoryDays] = useState<number | null>(
    initialData?.max_statutory_days ?? null,
  );
  const [countCalendarDays, setCountCalendarDays] = useState(
    initialData?.count_calendar_days ?? false,
  );
  // Analytics visibility is OPT-IN: off unless explicitly turned on, matching
  // the backend default — and `?? false` also covers legacy types stored before
  // the field existed, which come back hidden. This holds only the admin's
  // explicit choice; the effective value is derived below so the paid+statutory
  // rule can stay reactive. See `showInAnalytics`.
  const [showInAnalyticsChoice, setShowInAnalyticsChoice] = useState(
    initialData?.show_in_analytics ?? false,
  );
  // Set once the admin touches the analytics toggle — from then on their choice
  // wins and the paid+statutory rule stops overriding it (including OFF).
  const [analyticsTouched, setAnalyticsTouched] = useState(false);
  // Leave-balance visibility is OPT-IN, same polarity as analytics above, so
  // legacy types with no stored value come back hidden. Unlike analytics there's
  // no reactive rule — plain state, driven only by the admin.
  const [showInLeaveBalance, setShowInLeaveBalance] = useState(
    initialData?.show_in_leave_balance ?? false,
  );

  // ── Expiring / comp-off leave ──────────────────────────────────────────────
  // No balance: each request compensates non-working days the employee worked,
  // and must be availed within `expiryDays` of each worked day. When on, only
  // "paid" applies (forced on) — accrual & every other setting are suppressed.
  const [isCompOff, setIsCompOff] = useState(initialData?.is_comp_off ?? false);
  const [expiryDays, setExpiryDays] = useState<number | null>(
    initialData?.expiry_days ?? null,
  );

  // ── Unrestricted leave ─────────────────────────────────────────────────────
  // No balance, no entitlement policy, no employment-status/probation gate —
  // anyone the type is offered to can apply. Approval rules still run. Like
  // comp-off it tracks no balance, so accrual is suppressed while it is on.
  const [isUnrestricted, setIsUnrestricted] = useState(
    initialData?.is_unrestricted ?? false,
  );
  // Defaults ON: an unrestricted type has no balance, so without the warning
  // neither the employee nor the approver has any number to judge a request by.
  // `??` only falls back on null/undefined, so a type explicitly saved with the
  // warning OFF still loads as off.
  const [showUsageWarning, setShowUsageWarning] = useState(
    initialData?.show_usage_warning ?? true,
  );
  // Advisory yearly cap. Enforces nothing — going past it emails the employee
  // and their approvers. It exists because the types that need that warning
  // carry no accrual, so there is no annual_count to measure against.
  const [annualLimit, setAnnualLimit] = useState<number | null>(
    initialData?.annual_limit ?? null,
  );

  // ── Derived category flags (single source for the form AND the payload) ────
  // Statutory leave is always paid; comp-off is always paid and never statutory.
  const paid = isCompOff || isPaidLeave || isStatutoryLeave;
  // Exactly what `sharedBody` persists — the analytics default keys off these so
  // it can never disagree with the flags actually stored on the record.
  const persistedStatutory = isCompOff ? false : isStatutoryLeave;
  const persistedSick = !paid;

  // Paid + statutory: these drive statutory-compliance reporting, which only
  // reads types with `show_in_analytics: true`, so ticking both switches
  // analytics ON automatically — in BOTH the add and edit forms.
  const paidStatutory = isPaidLeave && persistedStatutory;
  // …but only when the combination becomes NEWLY true. A stored paid+statutory
  // record keeps whatever was saved, so merely opening its edit form can't flip
  // the value (and can't mark an untouched form dirty).
  const storedPaidStatutory =
    !!initialData &&
    (initialData.is_paid_leave ?? true) &&
    (initialData.is_statutory_leave ?? false);

  /**
   * Effective "Show in Analytics" value.
   *
   * Derived rather than held in state so it tracks the paid/statutory toggles
   * live. Once the admin touches the control their choice wins outright —
   * including switching it back OFF on a paid statutory type.
   */
  const showInAnalytics =
    !analyticsTouched && paidStatutory && !storedPaidStatutory
      ? true
      : showInAnalyticsChoice;

  // ── Accrual & carry-forward (now lives on the leave type) ──────────────────
  const [annualCount, setAnnualCount] = useState<number | null>(
    initialData?.accrual?.annual_count ?? null,
  );
  const [accrualFrequency, setAccrualFrequency] = useState<LeaveAccrualFrequency | "">(
    initialData?.accrual?.accrual_frequency ?? "",
  );
  const [carryForward, setCarryForward] = useState(
    initialData?.accrual?.carry_forward ?? false,
  );
  const [carryForwardCount, setCarryForwardCount] = useState<number | null>(
    initialData?.accrual?.carry_forward_count ?? null,
  );
  const [encashable, setEncashable] = useState(
    initialData?.accrual?.encashable ?? false,
  );
  const [encashPercentage, setEncashPercentage] = useState<number | null>(
    initialData?.accrual?.encash_percentage ?? null,
  );

  const [hasGenderRestriction, setHasGenderRestriction] = useState(
    !!(initialData?.restrictions?.gender ?? initialData?.gender_restriction),
  );
  const [genderRestriction, setGenderRestriction] = useState<
    "MALE" | "FEMALE" | ""
  >(
    ((initialData?.restrictions?.gender ?? initialData?.gender_restriction) as
      | "MALE"
      | "FEMALE") ?? "",
  );
  const [hasMaritalRestriction, setHasMaritalRestriction] = useState(
    !!(
      initialData?.restrictions?.marital_status ??
      initialData?.marital_status_restriction
    ),
  );
  const [maritalRestriction, setMaritalRestriction] = useState<
    "SINGLE" | "MARRIED" | ""
  >(
    ((initialData?.restrictions?.marital_status ??
      initialData?.marital_status_restriction) as "SINGLE" | "MARRIED") ?? "",
  );

  const [touched, setTouched] = useState<
    Partial<Record<"name" | "code" | "maxStatutoryDays" | "expiryDays" | "annualCount" | "accrualFrequency" | "carryForwardCount" | "encashPercentage", boolean>>
  >({});
  const touch = (
    field: "name" | "code" | "maxStatutoryDays" | "expiryDays" | "annualCount" | "accrualFrequency" | "carryForwardCount" | "encashPercentage",
  ) => setTouched((t) => ({ ...t, [field]: true }));

  const errors = validate(
    name,
    code,
    isStatutoryLeave,
    maxStatutoryDays,
    isPaidLeave,
    annualCount,
    accrualFrequency,
    carryForward,
    carryForwardCount,
    encashable,
    encashPercentage,
    isCompOff,
    expiryDays,
    isUnrestricted,
  );
  const fieldError = (
    field: "name" | "code" | "maxStatutoryDays" | "expiryDays" | "annualCount" | "accrualFrequency" | "carryForwardCount" | "encashPercentage",
  ) => (touched[field] ? errors[field] : undefined);

  const isLoading = createResult.isLoading || updateResult.isLoading;
  const title = readOnly
    ? "View Leave Type"
    : initialData
      ? detailsReadOnly ? "Edit Leave Type (System)" : "Edit Leave Type"
      : "Add Leave Type";

  const isDirty: boolean =
    !readOnly &&
    (name !== (initialData?.name ?? "") ||
      code !== (initialData?.code ?? "") ||
      desc !== (initialData?.description ?? "") ||
      color !== (initialData?.color ?? "#A8CAFF") ||
      unit !== (initialData?.unit === "HOURS" ? "Hours" : "Days") ||
      isPaidLeave !== (initialData?.is_paid_leave ?? true) ||
      deductFromBalance !== (initialData?.deduct_from_leave_balance ?? true) ||
      isStatutoryLeave !== (initialData?.is_statutory_leave ?? false) ||
      maxStatutoryDays !== (initialData?.max_statutory_days ?? null) ||
      countCalendarDays !== (initialData?.count_calendar_days ?? false) ||
      showInAnalytics !== (initialData?.show_in_analytics ?? false) ||
      showInLeaveBalance !== (initialData?.show_in_leave_balance ?? false) ||
      isCompOff !== (initialData?.is_comp_off ?? false) ||
      expiryDays !== (initialData?.expiry_days ?? null) ||
      isUnrestricted !== (initialData?.is_unrestricted ?? false) ||
      // Baseline mirrors the state initialiser's default, or a freshly opened
      // Add form would read as dirty before the admin touches anything.
      showUsageWarning !== (initialData?.show_usage_warning ?? true) ||
      annualLimit !== (initialData?.annual_limit ?? null) ||
      annualCount !== (initialData?.accrual?.annual_count ?? null) ||
      accrualFrequency !== (initialData?.accrual?.accrual_frequency ?? "") ||
      carryForward !== (initialData?.accrual?.carry_forward ?? false) ||
      carryForwardCount !== (initialData?.accrual?.carry_forward_count ?? null) ||
      encashable !== (initialData?.accrual?.encashable ?? false) ||
      encashPercentage !== (initialData?.accrual?.encash_percentage ?? null) ||
      hasGenderRestriction !==
        !!(initialData?.restrictions?.gender ?? initialData?.gender_restriction) ||
      hasMaritalRestriction !==
        !!(initialData?.restrictions?.marital_status ?? initialData?.marital_status_restriction));

  useNavigationGuard(isDirty);

  const handleCancel = () => {
    if (isDirty) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to leave?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: onCancel,
      });
    } else {
      onCancel();
    }
  };

  const handleDelete = () => {
    if (!initialData) return;
    confirm({
      title: `Delete "${initialData.name}"?`,
      description:
        "This leave type will be permanently deleted and cannot be recovered.",
      variant: "destructive",
      confirmText: "Delete",
      onConfirm: async () => {
        try {
          await deleteLeaveType(initialData._id).unwrap();
          toast.success("Leave type deleted");
          onSuccess();
        } catch (err) {
          toast.error(err, "Failed to delete leave type");
        }
      },
    });
  };

  // Build the accrual payload. Statutory leave is a fixed annual lump sum;
  // unpaid (sick) leave can never carry forward or be encashed.
  const buildAccrual = () => ({
    annual_count: isStatutoryLeave ? maxStatutoryDays : annualCount,
    accrual_frequency: (isStatutoryLeave
      ? "yearly"
      : accrualFrequency || null) as LeaveAccrualFrequency | null,
    carry_forward: isPaidLeave && !isStatutoryLeave ? carryForward : false,
    carry_forward_count:
      isPaidLeave && !isStatutoryLeave && carryForward ? carryForwardCount : null,
    encashable: isPaidLeave && !isStatutoryLeave ? encashable : false,
    encash_percentage:
      isPaidLeave && !isStatutoryLeave && encashable ? encashPercentage : null,
  });

  const handleSave = async () => {
    if (readOnly) {
      // System leave types: allow saving max_statutory_days only
      if (isStatutoryLeave && initialData) {
        setTouched((t) => ({ ...t, maxStatutoryDays: true }));
        if (errors.maxStatutoryDays) {
          toast.error("Please enter a valid statutory days limit");
          return;
        }
        try {
          await updateLeaveType({
            id: initialData._id,
            body: { max_statutory_days: maxStatutoryDays },
          }).unwrap();
          toast.success("Statutory days updated");
          onSuccess();
        } catch (err) {
          toast.error(err, "Failed to update statutory days");
        }
      } else {
        onCancel();
      }
      return;
    }

    setTouched({ name: true, code: true, maxStatutoryDays: true, expiryDays: true, annualCount: true, accrualFrequency: true, carryForwardCount: true, encashPercentage: true });
    if (Object.keys(errors).length > 0) {
      toast.error("Please fill all required fields");
      requestAnimationFrame(() => scrollToError());
      return;
    }

    const restrictions = {
      gender: (hasGenderRestriction ? genderRestriction || null : null) as
        | "MALE"
        | "FEMALE"
        | null,
      marital_status: (hasMaritalRestriction
        ? maritalRestriction || null
        : null) as "SINGLE" | "MARRIED" | null,
    };

    // is_sick_leave is derived from the paid flag purely as a category tag; the
    // real behaviour of an unpaid type is Loss of Pay (weekends charged, no
    // balance check or debit) — see should_count_weekends_for_lop on the backend.
    // Statutory leave is always paid, regardless of the paid toggle state.
    // Comp-off (expiring) leave is always paid and never deducts from balance.
    // The description is always shown while applying (the toggle was removed).
    // `paid` / `persistedStatutory` / `persistedSick` are hoisted to component
    // scope so the analytics default reads the same values this body persists.
    // Only PAID, non-comp-off leave deducts. An unpaid (LOP) leave never debits
    // the balance — the backend ignores the flag — so don't persist a misleading
    // `true` that the UI no longer shows.
    // An unrestricted type tracks no balance either, so it never deducts —
    // the backend forces this too, but sending the truth keeps the two in step.
    const deduct =
      !isCompOff && !isUnrestricted && paid
        ? deductFromBalance || isStatutoryLeave
        : false;
    const sharedBody = {
      name: name.trim(),
      // Uppercased again here so a record whose code was saved in mixed case
      // before this normalisation is fixed on its next save, even if the field
      // is never edited.
      code: code.trim().toUpperCase(),
      unit: unit.toUpperCase() as "DAYS" | "HOURS",
      description: desc,
      color,
      show_description: true,
      is_paid: paid,
      is_paid_leave: paid,
      deduct_from_balance: deduct,
      deduct_from_leave_balance: deduct,
      is_sick_leave: persistedSick,
      is_statutory_leave: persistedStatutory,
      max_statutory_days: isStatutoryLeave && !isCompOff ? maxStatutoryDays : null,
      count_calendar_days: isCompOff ? false : countCalendarDays,
      // Always sent, so create/update carries the effective value — either the
      // admin's explicit choice or the paid+statutory default.
      show_in_analytics: showInAnalytics,
      // Independent of comp-off / statutory — any type can be hidden from the
      // employee's balance list.
      show_in_leave_balance: showInLeaveBalance,
      is_comp_off: isCompOff,
      expiry_days: isCompOff ? expiryDays : null,
      is_unrestricted: isUnrestricted,
      // Only meaningful on an unrestricted type — the backend clears it
      // otherwise, and so do we.
      show_usage_warning: isUnrestricted ? showUsageWarning : false,
      // Advisory cap; only offered where nothing else tracks a yearly count.
      annual_limit: isUnrestricted ? annualLimit : null,
      // Comp-off carries no accrual and no eligibility restrictions.
      restrictions: isCompOff ? { gender: null, marital_status: null } : restrictions,
      // Neither comp-off nor unrestricted leave accrues a balance.
      accrual: isCompOff || isUnrestricted ? undefined : buildAccrual(),
    };

    try {
      if (initialData) {
        await updateLeaveType({
          id: initialData._id,
          body: sharedBody,
        }).unwrap();
        toast.success("Leave type updated");
      } else {
        await createLeaveType({
          org_id: orgId,
          ...sharedBody,
        }).unwrap();
        toast.success("Leave type created");
      }
      onSuccess();
    } catch (err) {
      toast.error(
        err,
        initialData
          ? "Failed to update leave type"
          : "Failed to create leave type",
      );
    }
  };

  const checkboxLbl = `text-sm font-medium leading-none ${readOnly ? "cursor-default" : "cursor-pointer"}`;
  const unitLabel = unit === "Hours" ? "hours" : "days";
  const accrualDisabled = readOnly || detailsReadOnly;

  const round1 = (n: number) => Number(n.toFixed(1));
  // Year-end worked example, illustrated with the full annual allocation unused.
  // Mirrors the year-end engine: carry fills first (up to the limit); only the
  // leftover is encashed (pct%) and the remainder reset — never both on the same days.
  const exBalance = annualCount;
  const exCarried =
    carryForward && carryForwardCount != null && exBalance != null
      ? Math.min(exBalance, carryForwardCount)
      : 0;
  const exLeftover = exBalance != null ? Math.max(0, exBalance - exCarried) : 0;
  const exEncashed =
    encashable && encashPercentage != null && encashPercentage > 0
      ? (exLeftover * encashPercentage) / 100
      : 0;
  const exExpired = exLeftover - exEncashed;

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle={
          initialData
            ? `${readOnly ? "Viewing" : "Editing"} ${initialData.name}`
            : undefined
        }
      />

      <div className="space-y-6">
        {/* ─── Details ─────────────────────────────────────────────── */}
        <div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* Basic details */}
            <Card className="h-full">
              <CardContent className="space-y-5 pt-2">
                <div className="space-y-1 border-b pb-4">
                  <h3 className="text-base font-semibold">Leave Type Details</h3>
                  <p className="text-sm text-muted-foreground">
                    Name, code, and appearance for this leave type.
                  </p>
                </div>

                {/* Name + Color */}
                <div className="flex items-start gap-4">
                  <Field className="flex-1" data-invalid={!!fieldError("name")}>
                    <FieldLabel>
                      Name <span className="text-destructive">*</span>
                    </FieldLabel>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => touch("name")}
                      disabled={readOnly || detailsReadOnly}
                      placeholder="e.g. Annual Leave"
                      aria-invalid={!!fieldError("name")}
                    />
                    {fieldError("name") && (
                      <FieldError errors={[{ message: fieldError("name") }]} />
                    )}
                  </Field>

                  <div className="shrink-0 space-y-1.5">
                    <FieldLabel>Color</FieldLabel>
                    <ColorPicker
                      value={color}
                      onChange={setColor}
                      disabled={readOnly || detailsReadOnly}
                    />
                  </div>
                </div>

                {/* Code */}
                <Field className="max-w-xs" data-invalid={!!fieldError("code")}>
                  <FieldLabel>
                    Code <span className="text-destructive">*</span>
                  </FieldLabel>
                  {/* onChange uppercases the value itself, not just its
                      rendering — the `uppercase` class is presentational, so
                      without it the state (and the saved code) keeps the raw
                      casing typed while the field appears uppercased. */}
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onBlur={() => touch("code")}
                    disabled={readOnly || detailsReadOnly}
                    placeholder="e.g. AL"
                    aria-invalid={!!fieldError("code")}
                    className="font-mono uppercase"
                  />
                  {fieldError("code") && (
                    <FieldError errors={[{ message: fieldError("code") }]} />
                  )}
                </Field>

                {/* Description */}
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    disabled={readOnly || detailsReadOnly}
                    placeholder="Optional description..."
                    className="resize-y min-h-[80px]"
                  />
                </Field>

                {/* Unit */}
                <Field>
                  <FieldLabel>Unit</FieldLabel>
                  <RadioGroup
                    value={unit}
                    onValueChange={setUnit}
                    disabled={readOnly || detailsReadOnly}
                    className="flex gap-6"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="Days" id="unit-days" />
                      <Label
                        htmlFor="unit-days"
                        className="text-sm font-medium cursor-pointer"
                      >
                        Days
                      </Label>
                    </div>
                    {/* HOURS unit is not supported — product is days-only.
                        Existing HOURS leave types still load (see initialData
                        handling above) but new selection is hidden. */}
                  </RadioGroup>
                </Field>
              </CardContent>
            </Card>

            {/* Settings */}
            <Card className="h-full">
              <CardContent className="space-y-5 pt-2">
                <div className="space-y-1 border-b pb-4">
                  <h3 className="text-base font-semibold">Settings</h3>
                  <p className="text-sm text-muted-foreground">
                    Whether this leave is paid, and how it's counted.
                  </p>
                </div>

                <div className={`space-y-4 ${readOnly ? "opacity-75" : ""}`}>
                  {/* Paid is the master switch: paid leave can carry / encash;
                      unpaid leave becomes Loss of Pay (weekends charged, no
                      balance deducted). Forced on and locked for expiring leave —
                      "paid" is what keeps it OUT of the Loss-of-Pay path. */}
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="paid-leave"
                      checked={isPaidLeave || isStatutoryLeave || isCompOff}
                      onCheckedChange={(v) => setIsPaidLeave(Boolean(v))}
                      disabled={readOnly || isStatutoryLeave || isCompOff}
                      className="mt-0.5"
                    />
                    <span className={checkboxLbl}>
                      This is paid leave
                      <span className="block text-xs font-normal text-muted-foreground">
                        {isCompOff
                          ? "Expiring leave is always paid — it is never Loss of Pay."
                          : isStatutoryLeave
                            ? "Statutory leave is always paid."
                            : "When off, this leave is unpaid (Loss of Pay)."}
                      </span>
                    </span>
                  </label>

                  {/* Expiring / comp-off leave. When on, every other setting is
                      suppressed — the expiry window is the only thing to configure. */}
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="comp-off"
                      checked={isCompOff}
                      onCheckedChange={(v) => {
                        const checked = Boolean(v);
                        setIsCompOff(checked);
                        if (checked) {
                          // Expiring leave is always paid, never balance-deducting,
                          // never statutory, and has no accrual/restrictions.
                          setIsPaidLeave(true);
                          setIsStatutoryLeave(false);
                          setMaxStatutoryDays(null);
                          setDeductFromBalance(false);
                          setCountCalendarDays(false);
                          setHasGenderRestriction(false);
                          setGenderRestriction("");
                          setHasMaritalRestriction(false);
                          setMaritalRestriction("");
                        } else {
                          setExpiryDays(null);
                        }
                      }}
                      disabled={readOnly}
                      className="mt-0.5"
                    />
                    <span className={checkboxLbl}>
                      This leave can expire
                      <span className="block text-xs font-normal text-muted-foreground">
                        No balance is tracked — each request compensates non-working
                        days the employee worked, and must be taken within the expiry
                        window (e.g. a comp-off that expires in 60 days).
                      </span>
                    </span>
                  </label>

                  {isCompOff && (
                    <div className="pl-7">
                      <Field data-invalid={!!fieldError("expiryDays")}>
                        <FieldLabel>
                          Expires after (days){" "}
                          <span className="text-destructive">*</span>
                        </FieldLabel>
                        <Input
                          type="number"
                          min={1}
                          max={365}
                          value={expiryDays ?? ""}
                          onChange={(e) =>
                            setExpiryDays(
                              e.target.value === "" ? null : Number(e.target.value),
                            )
                          }
                          onBlur={() => touch("expiryDays")}
                          disabled={readOnly}
                          placeholder="e.g. 60"
                          className="h-9 max-w-[140px]"
                        />
                        {fieldError("expiryDays") && (
                          <FieldError
                            errors={[{ message: fieldError("expiryDays") }]}
                          />
                        )}
                      </Field>
                    </div>
                  )}

                  {/* Unrestricted leave. Lifts the entitlement, balance and
                      employment-status gates on apply (including the probation
                      leave-type restriction); approval and the gender/marital
                      eligibility rules still run. Available on comp-off types
                      too — the backend forbids only statutory + unrestricted,
                      and a comp-off type still has to point at worked dates. */}
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="unrestricted"
                      checked={isUnrestricted}
                      onCheckedChange={(v) => {
                        const checked = Boolean(v);
                        setIsUnrestricted(checked);
                        if (checked) {
                          // Nothing accrues, so nothing can be deducted.
                          setDeductFromBalance(false);
                          // The warning defaults ON whenever this section
                          // appears — see the state initialiser.
                          setShowUsageWarning(true);
                        } else {
                          // The warning only means anything while it is on.
                          setShowUsageWarning(false);
                        }
                      }}
                      disabled={readOnly || isStatutoryLeave}
                      className="mt-0.5"
                    />
                    <span className={checkboxLbl}>
                      This is an unrestricted leave
                      <span className="block text-xs font-normal text-muted-foreground">
                        {isStatutoryLeave
                          ? "Statutory leave must deduct from a tracked balance, so it cannot be unrestricted."
                          : "Anyone eligible to access this leave type can apply for it without an assigned balance, entitlement limit, or employment-status restriction. Approval rules still apply."}
                      </span>
                    </span>
                  </label>

                  {isUnrestricted && (
                    <div className="pl-7">
                      <Field>
                        <FieldLabel>Yearly Limit (Optional) </FieldLabel>
                        <Input
                          type="number"
                          min={1}
                          max={365}
                          value={annualLimit ?? ""}
                          onChange={(e) =>
                            setAnnualLimit(
                              e.target.value === "" ? null : Number(e.target.value),
                            )
                          }
                          disabled={readOnly}
                          placeholder="e.g. 24"
                          className="h-9 max-w-[140px]"
                        />
                        <p className="text-xs text-muted-foreground">
                          Nothing is blocked at this number. Once an employee goes
                          past it, they and their approvers are emailed that the
                          allocation for this leave type is exceeded.
                        </p>
                      </Field>
                    </div>
                  )}

                  {isUnrestricted && (
                    <label className="flex items-start gap-3 cursor-pointer pl-7">
                      <Checkbox
                        id="usage-warning"
                        checked={showUsageWarning}
                        onCheckedChange={(v) => setShowUsageWarning(Boolean(v))}
                        disabled={readOnly}
                        className="mt-0.5"
                      />
                      <span className={checkboxLbl}>
                        Show usage warning
                        <span className="block text-xs font-normal text-muted-foreground">
                          Show the employee and approver how much of this leave has
                          already been used.
                        </span>
                      </span>
                    </label>
                  )}

                  {/* Only meaningful for PAID, non-expiring leave. An unpaid (Loss
                      of Pay) leave never debits the balance — the backend ignores
                      this flag once loss_of_pay is set — so it's hidden there.
                      Expiring and unrestricted leave track no balance, so the
                      control is hidden for them. */}
                  {!isUnrestricted && (isPaidLeave || isStatutoryLeave || isCompOff) && (
                    <label className="flex items-center gap-3 cursor-pointer">
                      <Checkbox
                        id="deduct-balance"
                        checked={
                          isCompOff ? false : deductFromBalance || isStatutoryLeave
                        }
                        onCheckedChange={(v) => setDeductFromBalance(Boolean(v))}
                        disabled={readOnly || isStatutoryLeave || isCompOff}
                      />
                      <span className={checkboxLbl}>Deduct from leave balance</span>
                    </label>
                  )}

                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="count-calendar-days"
                      checked={isCompOff ? false : countCalendarDays}
                      onCheckedChange={(v) => setCountCalendarDays(Boolean(v))}
                      disabled={readOnly || isCompOff}
                      className="mt-0.5"
                    />
                    <span className={checkboxLbl}>
                      Count weekends &amp; holidays in leave duration
                      <span className="block text-xs font-normal text-muted-foreground">
                        Include non-working days in the booked duration (e.g.
                        Maternity / Paternity leave).
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="show-in-analytics"
                      checked={showInAnalytics}
                      onCheckedChange={(v) => {
                        setShowInAnalyticsChoice(Boolean(v));
                        // Pin the admin's choice so the paid+statutory rule
                        // stops overriding it for the rest of this form.
                        setAnalyticsTouched(true);
                      }}
                      disabled={readOnly}
                      className="mt-0.5"
                    />
                    <span className={checkboxLbl}>
                      Show in Analytics
                      <span className="block text-xs font-normal text-muted-foreground">
                        When on, this leave type appears in analytics reports
                        and dashboards.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="show-in-leave-balance"
                      checked={showInLeaveBalance}
                      onCheckedChange={(v) => setShowInLeaveBalance(Boolean(v))}
                      disabled={readOnly}
                      className="mt-0.5"
                    />
                    <span className={checkboxLbl}>
                      Show in Leave Balance
                      <span className="block text-xs font-normal text-muted-foreground">
                        When on, this leave type appears in the employee&apos;s
                        leave-balance view.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      id="statutory-leave"
                      checked={isCompOff ? false : isStatutoryLeave}
                      onCheckedChange={(v) => {
                        const checked = Boolean(v);
                        setIsStatutoryLeave(checked);
                        // Statutory leave is always paid, deducts from balance,
                        // and runs across calendar days — auto-tick all three.
                        if (checked) {
                          setIsPaidLeave(true);
                          setDeductFromBalance(true);
                          setCountCalendarDays(true);
                        }
                        if (!checked) setMaxStatutoryDays(null);
                      }}
                      disabled={readOnly || isCompOff}
                    />
                    <span className={checkboxLbl}>This is statutory leave</span>
                  </label>

                  {isStatutoryLeave && (
                    <div className="pl-7">
                      <Field data-invalid={!!fieldError("maxStatutoryDays")}>
                        <FieldLabel>
                          Maximum statutory days{" "}
                          <span className="text-destructive">*</span>
                        </FieldLabel>
                        <Input
                          type="number"
                          min={1}
                          max={365}
                          value={maxStatutoryDays ?? ""}
                          onChange={(e) =>
                            setMaxStatutoryDays(
                              e.target.value === "" ? null : Number(e.target.value),
                            )
                          }
                          onBlur={() => touch("maxStatutoryDays")}
                          placeholder="e.g. 90"
                          className="h-9 max-w-[140px]"
                        />
                        {fieldError("maxStatutoryDays") && (
                          <FieldError
                            errors={[{ message: fieldError("maxStatutoryDays") }]}
                          />
                        )}
                      </Field>
                    </div>
                  )}

                  {/* Eligibility restrictions */}
                  <div className="space-y-3 pt-3 border-t border-border">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <Checkbox
                        id="gender-restrict"
                        checked={isCompOff ? false : hasGenderRestriction}
                        onCheckedChange={(v) => {
                          setHasGenderRestriction(Boolean(v));
                          if (!v) setGenderRestriction("");
                        }}
                        disabled={readOnly || isCompOff}
                      />
                      <span className={checkboxLbl}>Restrict to gender</span>
                    </label>
                    {hasGenderRestriction && (
                      <div className="pl-7 max-w-xs">
                        <Select
                          value={genderRestriction || undefined}
                          onValueChange={(v) =>
                            setGenderRestriction(v as "MALE" | "FEMALE")
                          }
                          disabled={readOnly}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="Select gender" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="MALE">Male</SelectItem>
                            <SelectItem value="FEMALE">Female</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <Checkbox
                        id="marital-restrict"
                        checked={isCompOff ? false : hasMaritalRestriction}
                        onCheckedChange={(v) => {
                          setHasMaritalRestriction(Boolean(v));
                          if (!v) setMaritalRestriction("");
                        }}
                        disabled={readOnly || isCompOff}
                      />
                      <span className={checkboxLbl}>Restrict to marital status</span>
                    </label>
                    {hasMaritalRestriction && (
                      <div className="pl-7 max-w-xs">
                        <Select
                          value={maritalRestriction || undefined}
                          onValueChange={(v) =>
                            setMaritalRestriction(v as "SINGLE" | "MARRIED")
                          }
                          disabled={readOnly}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="Select marital status" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="SINGLE">Single</SelectItem>
                            <SelectItem value="MARRIED">Married</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ─── Accrual & Carry (paid leave only; never for comp-off or
             unrestricted leave — neither tracks a balance to accrue into) ── */}
        {isPaidLeave && !isCompOff && !isUnrestricted && (
        <div>
          <Card>
            <CardContent className="space-y-6 pt-2">
              <div className="space-y-1 border-b pb-4">
                <h3 className="text-base font-semibold">Accrual &amp; Carry-Forward</h3>
                <p className="text-sm text-muted-foreground">
                  How many leaves are granted per year, how they accrue, and what
                  happens to the unused balance.
                </p>
              </div>

              {isStatutoryLeave ? (
                <p className="text-sm text-muted-foreground rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
                  Statutory leave is granted as a fixed annual amount
                  {maxStatutoryDays ? ` of ${maxStatutoryDays} ${unitLabel}` : ""} at
                  the start of the year and does not carry forward.
                </p>
              ) : (
                <div className="grid gap-10 lg:grid-cols-2">
                  {/* LEFT — accrual inputs */}
                  <div className="space-y-6">
                  {/* Number of leaves + frequency */}
                  <div className="flex flex-wrap items-end gap-8">
                    <Field className="w-52" data-invalid={!!fieldError("annualCount")}>
                      <FieldLabel className="whitespace-nowrap">
                        Number of leaves / year
                        {isPaidLeave && <span className="text-destructive ml-0.5">*</span>}
                      </FieldLabel>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={365}
                          step="any"
                          value={annualCount ?? ""}
                          onChange={(e) =>
                            setAnnualCount(
                              e.target.value === "" ? null : parseFloat(e.target.value),
                            )
                          }
                          onBlur={() => touch("annualCount")}
                          disabled={accrualDisabled}
                          placeholder="e.g. 12"
                          className="h-9"
                        />
                        <span className="text-xs text-muted-foreground">{unitLabel}</span>
                      </div>
                      {fieldError("annualCount") && (
                        <FieldError errors={[{ message: fieldError("annualCount") }]} />
                      )}
                    </Field>

                    <Field className="w-56" data-invalid={!!fieldError("accrualFrequency")}>
                      <FieldLabel>
                        Accrual frequency
                        {isPaidLeave && <span className="text-destructive ml-0.5">*</span>}
                      </FieldLabel>
                      <Select
                        value={accrualFrequency || undefined}
                        onValueChange={(v) => {
                          setAccrualFrequency(v as LeaveAccrualFrequency)
                          touch("accrualFrequency")
                        }}
                        disabled={accrualDisabled}
                      >
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder="Select frequency" />
                        </SelectTrigger>
                        <SelectContent>
                          {ACCRUAL_FREQUENCIES.map((f) => (
                            <SelectItem key={f.value} value={f.value}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {fieldError("accrualFrequency") && (
                        <FieldError errors={[{ message: fieldError("accrualFrequency") }]} />
                      )}
                    </Field>
                  </div>

                  {/* Live distribution preview — mirrors how the accrual engine
                      credits the balance (annual count ÷ number of periods). */}
                  {annualCount != null && annualCount > 0 && accrualFrequency && (() => {
                    const periods: Record<LeaveAccrualFrequency, number> = {
                      monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1,
                    };
                    const cadence: Record<LeaveAccrualFrequency, string> = {
                      monthly: "each month", quarterly: "each quarter",
                      half_yearly: "every 6 months", yearly: "",
                    };
                    const n = periods[accrualFrequency];
                    const fmt = (v: number) => Number(v.toFixed(2)).toString();
                    const perPeriod = fmt(annualCount / n);
                    const total = fmt(annualCount);
                    return (
                      <p className="text-sm text-foreground rounded-md border border-dashed border-primary/40 bg-primary/5 px-3 py-2">
                        {accrualFrequency === "yearly" ? (
                          <>All <b>{total} {unitLabel}</b> are credited at the start of the leave year.</>
                        ) : (
                          <>
                            <b>{perPeriod} {unitLabel}</b> credited {cadence[accrualFrequency]}{" "}
                            ({n} installments) — totalling <b>{total} {unitLabel}</b> per year.
                          </>
                        )}
                      </p>
                    );
                  })()}

                  {/* Carry-forward + encashment */}
                  <div className="space-y-4 border-t border-border pt-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium">Carry forward unused balance</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Allow the unused balance to carry into the next year (up to
                            the limit below). The Year-End step decides payout.
                          </p>
                        </div>
                        <Switch
                          checked={carryForward}
                          onCheckedChange={setCarryForward}
                          disabled={accrualDisabled}
                        />
                      </div>

                      {carryForward && (
                        <Field
                          className="w-48 pl-1"
                          data-invalid={!!fieldError("carryForwardCount")}
                        >
                          <FieldLabel>
                            Carry forward count
                            <span className="text-destructive ml-0.5">*</span>
                          </FieldLabel>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              step="any"
                              value={carryForwardCount ?? ""}
                              onChange={(e) =>
                                setCarryForwardCount(
                                  e.target.value === ""
                                    ? null
                                    : parseFloat(e.target.value),
                                )
                              }
                              onBlur={() => touch("carryForwardCount")}
                              disabled={accrualDisabled}
                              placeholder="e.g. 10"
                              className="h-9"
                            />
                            <span className="text-xs text-muted-foreground">
                              {unitLabel}
                            </span>
                          </div>
                          {fieldError("carryForwardCount") && (
                            <FieldError
                              errors={[{ message: fieldError("carryForwardCount") }]}
                            />
                          )}
                        </Field>
                      )}

                      <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
                        <div>
                          <p className="text-sm font-medium">Allow encashment</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Pay out a percentage of the unused balance (after carry-forward)
                            at year-end; the rest is reset.
                          </p>
                        </div>
                        <Switch
                          checked={encashable}
                          onCheckedChange={setEncashable}
                          disabled={accrualDisabled}
                        />
                      </div>

                      {encashable && (
                        <Field
                          className="w-48 pl-1"
                          data-invalid={!!fieldError("encashPercentage")}
                        >
                          <FieldLabel>
                            Encashment percentage
                            <span className="text-destructive ml-0.5">*</span>
                          </FieldLabel>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={1}
                              max={100}
                              step="any"
                              value={encashPercentage ?? ""}
                              onChange={(e) =>
                                setEncashPercentage(
                                  e.target.value === "" ? null : parseFloat(e.target.value),
                                )
                              }
                              onBlur={() => touch("encashPercentage")}
                              disabled={accrualDisabled}
                              placeholder="e.g. 50"
                              className="h-9"
                            />
                            <span className="text-xs text-muted-foreground">%</span>
                          </div>
                          {fieldError("encashPercentage") && (
                            <FieldError
                              errors={[{ message: fieldError("encashPercentage") }]}
                            />
                          )}
                        </Field>
                      )}
                  </div>
                  </div>

                  {/* RIGHT — live year-end example, fills the space alongside the form */}
                  {exBalance != null && (
                    <aside className="self-start rounded-xl border border-border bg-muted/20 p-6 lg:sticky lg:top-6">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-sm font-semibold text-foreground">Year-end example</p>
                        <p className="text-xs text-muted-foreground">
                          if all{" "}
                          <span className="font-medium text-foreground">
                            {round1(exBalance)} {unitLabel}
                          </span>{" "}
                          are unused
                        </p>
                      </div>

                      {exBalance > 0 && (
                        <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-muted">
                          {exCarried > 0 && (
                            <div className="bg-primary" style={{ width: `${(exCarried / exBalance) * 100}%` }} />
                          )}
                          {exEncashed > 0 && (
                            <div className="bg-amber-500" style={{ width: `${(exEncashed / exBalance) * 100}%` }} />
                          )}
                          {exExpired > 0 && (
                            <div className="bg-muted-foreground/40" style={{ width: `${(exExpired / exBalance) * 100}%` }} />
                          )}
                        </div>
                      )}

                      <dl className="mt-5 space-y-3 text-sm">
                        <div className="flex items-center justify-between">
                          <dt className="flex items-center gap-2 text-muted-foreground">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
                            Carried forward
                          </dt>
                          <dd className="font-semibold text-foreground">
                            {round1(exCarried)} {unitLabel}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between">
                          <dt className="flex items-center gap-2 text-muted-foreground">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
                            Encashed (paid out)
                          </dt>
                          <dd className="font-semibold text-foreground">
                            {round1(exEncashed)} {unitLabel}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between">
                          <dt className="flex items-center gap-2 text-muted-foreground">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
                            Expired (reset)
                          </dt>
                          <dd className="font-semibold text-foreground">
                            {round1(exExpired)} {unitLabel}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between border-t border-border pt-3">
                          <dt className="font-medium text-foreground">Next year starts with</dt>
                          <dd className="text-base font-bold text-primary">
                            {round1(exCarried)} {unitLabel}
                          </dd>
                        </div>
                      </dl>

                      <p className="mt-5 text-[11px] leading-5 text-muted-foreground">
                        {carryForward || encashable ? (
                          <>
                            Carry fills first
                            {carryForward && carryForwardCount != null
                              ? ` (up to ${round1(carryForwardCount)} ${unitLabel})`
                              : ""}
                            ; only the leftover is{" "}
                            {encashable ? `${encashPercentage ?? 0}% encashed and the rest ` : ""}
                            reset. A day is never both carried and encashed.
                          </>
                        ) : (
                          "Carry-forward and encashment are off — the full unused balance resets at year-end."
                        )}
                      </p>
                    </aside>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        )}
      </div>

      <div className="flex justify-end gap-3 mt-6">
        <Button type="button" variant="outline" onClick={handleCancel}>
          {readOnly && !isStatutoryLeave ? "Back" : "Cancel"}
        </Button>
        {/* Delete is intentionally hidden from users for now (the API still
            supports it). Flip this guard to re-enable the button. */}
        {false && !readOnly && initialData && (
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="mr-2 size-4" />
            Delete
          </Button>
        )}
        {(!readOnly || (isStatutoryLeave && initialData)) && (
          <Button variant="soft" onClick={handleSave} disabled={isLoading}>
            {isLoading ? "Saving…" : initialData ? "Update" : "Create"}
          </Button>
        )}
      </div>
    </div>
  );
}
