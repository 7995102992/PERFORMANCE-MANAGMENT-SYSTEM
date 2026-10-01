import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Stepper } from "@/components/ui/stepper";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Info,
  Loader2,
  Minus,
  Zap,
} from "lucide-react";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { usePagedSelect } from "../usePagedSelect";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";

const STEPS = [
  { id: 0, label: "Ticket Type Details" },
  { id: 1, label: "SLA Configuration" },
];
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useGetRequestTypeByIdQuery,
  useGetCategoriesQuery,
  useGetCategoryByIdQuery,
  useGetEmployeesQuery,
  useCreateRequestTypeMutation,
  useUpdateRequestTypeMutation,
} from "@/store/api/srmApi";
import type { Category, RequestTypeFormData } from "@/types/service-request";
import { toast } from "@/lib/toast";

const NAME_MIN = 3;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 250;
const SLA_DESCRIPTION_MAX = 500;

const slaSchema = z
  .object({
    firstResponseMinutes: z
      .number({ message: "First response time is required" })
      .int()
      .min(1, "First response time must be at least 1 minute"),
    resolutionMinutes: z
      .number({ message: "Resolution time is required" })
      .int()
      .min(1, "Resolution time must be at least 1 minute"),
    slaDescription: z
      .string()
      .max(
        SLA_DESCRIPTION_MAX,
        `SLA description must be ${SLA_DESCRIPTION_MAX} characters or fewer`,
      )
      .optional(),
    slaStatus: z.enum(["active", "inactive"]),
    violationActions: z.array(z.string()),
    notificationRecipients: z.array(z.string()),
  })
  .superRefine((data, ctx) => {
    // Mirror the backend rule: first response must be ≤ resolution.
    if (
      Number.isFinite(data.firstResponseMinutes) &&
      Number.isFinite(data.resolutionMinutes) &&
      data.firstResponseMinutes > data.resolutionMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolutionMinutes"],
        message:
          "Resolution time must be greater than or equal to first response time",
      });
    }
  });

const requestTypeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Ticket type name is required")
    .min(NAME_MIN, `Ticket type name must be at least ${NAME_MIN} characters`)
    .max(NAME_MAX, `Ticket type name must be ${NAME_MAX} characters or fewer`),
  categoryId: z.string().min(1, "Category is required"),
  description: z
    .string()
    .max(
      DESCRIPTION_MAX,
      `Description must be ${DESCRIPTION_MAX} characters or fewer`,
    )
    .optional(),
  status: z.enum(["active", "inactive"]),
  slas: z.object({
    low: slaSchema,
    medium: slaSchema,
    high: slaSchema,
    urgent: slaSchema,
  }),
});

type RequestTypeFormValues = z.infer<typeof requestTypeSchema>;

type PriorityKey = "low" | "medium" | "high" | "urgent";

const PRIORITY_KEYS: PriorityKey[] = ["low", "medium", "high", "urgent"];
// Mirrors the API's per-rule cap on notification_recipients.
const MAX_RECIPIENTS = 20;

// Blank form. Kept as a constant so reset() can always be given explicit
// values — a bare reset() would restore whatever the last reset(record) set as
// the defaults, i.e. the previously edited ticket type.
const EMPTY_FORM: RequestTypeFormValues = {
  name: "",
  categoryId: "",
  description: "",
  status: "active",
  slas: {
    low: {
      firstResponseMinutes: 480,
      resolutionMinutes: 2880,
      slaDescription: "",
      slaStatus: "active",
      violationActions: [],
      notificationRecipients: [],
    },
    medium: {
      firstResponseMinutes: 240,
      resolutionMinutes: 1440,
      slaDescription: "",
      slaStatus: "active",
      violationActions: [],
      notificationRecipients: [],
    },
    high: {
      firstResponseMinutes: 60,
      resolutionMinutes: 480,
      slaDescription: "",
      slaStatus: "active",
      violationActions: [],
      notificationRecipients: [],
    },
    urgent: {
      firstResponseMinutes: 15,
      resolutionMinutes: 120,
      slaDescription: "",
      slaStatus: "active",
      violationActions: [],
      notificationRecipients: [],
    },
  },
};

// User-visible violation actions. "send_notification" is hidden — it is
// auto-included in the payload whenever the user checks Change Priority or
// Reassign, so the configured recipients always get an email on breach.
// "send_alert" is intentionally absent too (overlaps with send_notification).
const violationOptions = [
  { value: "change_priority", label: "Change Priority" },
  { value: "reassign", label: "Reassign" },
];

const priorityCards = [
  {
    value: "low" as const,
    label: "Low",
    icon: ArrowDown,
    colorClass: "text-success",
    bgClass: "bg-success/10",
    borderClass: "border-success",
  },
  {
    value: "medium" as const,
    label: "Medium",
    icon: Minus,
    colorClass: "text-warning",
    bgClass: "bg-warning/10",
    borderClass: "border-warning",
  },
  {
    value: "high" as const,
    label: "High",
    icon: ArrowUp,
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
    borderClass: "border-destructive",
  },
  {
    value: "urgent" as const,
    label: "Urgent",
    icon: Zap,
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
    borderClass: "border-destructive",
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId?: string | null;
}

export const RequestTypeForm = ({ open, onOpenChange, editId }: Props) => {
  const isEditing = !!editId;

  const { data: existingData, isLoading: isLoadingDetail } =
    useGetRequestTypeByIdQuery(editId!, { skip: !editId });
  // Paged + server-searched: /categories caps a page at 25, so a plain query
  // silently hid every category beyond the first page from this picker.
  const categoryPicker = usePagedSelect<Category>({
    useQuery: useGetCategoriesQuery,
    args: { status: "active" },
    toOption: (c) => ({ label: c.name, value: c.id }),
  });
  const categoriesLoading = categoryPicker.isFetching;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    trigger,
    getValues,
    formState: { errors, isDirty },
  } = useForm<RequestTypeFormValues>({
    resolver: zodResolver(requestTypeSchema),
    defaultValues: EMPTY_FORM,
  });

  const [populated, setPopulated] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(
    new Set([0]),
  );
  const [activePriority, setActivePriority] = useState<PriorityKey>("low");

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && isDirty) {
        setDiscardOpen(true);
      } else {
        onOpenChange(open);
      }
    },
    [isDirty, onOpenChange],
  );

  // Always start from a blank form whenever the sheet opens/closes or the
  // target record changes — edit mode then re-populates in the effect below.
  useEffect(() => {
    reset(EMPTY_FORM);
    setPopulated(false);
    setActiveStep(0);
    setCompletedSteps(new Set([0]));
    setActivePriority("low");
  }, [open, editId, reset]);

  useEffect(() => {
    if (
      populated ||
      !open ||
      !editId ||
      !existingData ||
      // Ignore a cached result belonging to a previously opened ticket type.
      existingData.id !== editId ||
      categoriesLoading
    )
      return;

    const buildSla = (
      priority: string,
      defaultFirst: number,
      defaultRes: number,
    ) => {
      const sla = existingData.sla_rules.find((r) => r.priority === priority);
      return {
        firstResponseMinutes: sla?.first_response_minutes ?? defaultFirst,
        resolutionMinutes: sla?.resolution_minutes ?? defaultRes,
        slaDescription: sla?.description ?? "",
        slaStatus: (sla?.status ?? "active") as "active" | "inactive",
        violationActions: (sla?.violation_actions ?? []).filter(
          (a) => a !== "send_notification",
        ),
        notificationRecipients: sla?.notification_recipients ?? [],
      };
    };

    reset({
      name: existingData.name,
      categoryId: existingData.category_id,
      description: existingData.description,
      status: existingData.status,
      slas: {
        low: buildSla("low", 480, 2880),
        medium: buildSla("medium", 240, 1440),
        high: buildSla("high", 60, 480),
        urgent: buildSla("urgent", 15, 120),
      },
    });
    setPopulated(true);
  }, [existingData, categoriesLoading, populated, reset, open, editId]);

  const [createRequestType, { isLoading: isCreating }] =
    useCreateRequestTypeMutation();
  const [updateRequestType, { isLoading: isUpdating }] =
    useUpdateRequestTypeMutation();
  const isPending = isCreating || isUpdating;

  const watchedViolationActions = watch(
    `slas.${activePriority}.violationActions`,
  ) as string[];
  const watchedRecipients = watch(
    `slas.${activePriority}.notificationRecipients`,
  ) as string[];

  // Live cross-field check: resolution must be >= first response. Mirrors the
  // zod superRefine + backend rule but renders the warning the moment the user
  // types instead of waiting until they click Save.
  const watchedFirst = watch(`slas.${activePriority}.firstResponseMinutes`);
  const watchedResolution = watch(`slas.${activePriority}.resolutionMinutes`);
  const liveResolutionError =
    Number.isFinite(watchedFirst) &&
    Number.isFinite(watchedResolution) &&
    watchedFirst > watchedResolution
      ? "Resolution time must be greater than or equal to first response time"
      : null;

  // Notification recipients are scoped to the selected category's departments
  // — picking notifiers from outside them doesn't make sense for an SLA tied
  // to that category's ticket type.
  const selectedCategoryId = watch("categoryId");
  // Resolved by id, not from the paged list: on edit the saved category may sit
  // beyond the loaded pages, and deriving the department from the list would
  // then leave the notifier dropdown permanently empty.
  const { data: selectedCategory } = useGetCategoryByIdQuery(
    selectedCategoryId,
    { skip: !selectedCategoryId },
  );
  // A category can span several departments. Tolerate one saved before the list
  // existed; the API still emits the deprecated scalar for exactly this case.
  const selectedDeptIds = selectedCategory?.department_ids?.length
    ? selectedCategory.department_ids
    : selectedCategory?.department_id
      ? [selectedCategory.department_id]
      : [];
  const { data: employees = [], isFetching: employeesFetching } =
    useGetEmployeesQuery(
      selectedDeptIds.length
        ? { department_ids: selectedDeptIds, limit: 100 }
        : undefined,
      { skip: selectedDeptIds.length === 0 },
    );

  const toggleViolationAction = (action: string) => {
    const current = watchedViolationActions;
    setValue(
      `slas.${activePriority}.violationActions`,
      current.includes(action)
        ? current.filter((a) => a !== action)
        : [...current, action],
      { shouldDirty: true },
    );
  };

  // ── Prefill recipients from the category's executor roster ────────────────
  // Primaries first, then secondaries. Two hard limits from the API: at most
  // MAX_RECIPIENTS ids per priority, and a recipient with no email address
  // fails the whole save with 422 (NOTIFICATION_RECIPIENT_UNRESOLVED) — the
  // same guard the manual picker already applies on userId.
  const rosterEligible = (selectedCategory?.executors ?? []).filter(
    (e) => e.user_id && e.email,
  );
  const rosterRecipients = [
    ...rosterEligible.filter((e) => e.role === "primary"),
    ...rosterEligible.filter((e) => e.role === "secondary"),
  ].map((e) => e.user_id);
  const rosterTruncated = rosterRecipients.length > MAX_RECIPIENTS;
  const rosterPrefill = rosterRecipients.slice(0, MAX_RECIPIENTS);

  const applyRosterToPriority = (priority: PriorityKey) =>
    setValue(`slas.${priority}.notificationRecipients`, rosterPrefill, {
      shouldDirty: true,
    });

  // Fill on category selection. First pass only fills priorities the user (or
  // the saved record) left empty, so re-opening a ticket type never clobbers a
  // hand-picked list. A later category *change* replaces all four — the old
  // lists belong to the previous category's department.
  const prefilledForCategory = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedCategoryId || !selectedCategory) return;
    if (prefilledForCategory.current === selectedCategoryId) return;
    const isFirstPass = prefilledForCategory.current === null;
    prefilledForCategory.current = selectedCategoryId;
    if (!rosterPrefill.length) return;
    for (const priority of PRIORITY_KEYS) {
      const current =
        (getValues(`slas.${priority}.notificationRecipients`) as string[]) ?? [];
      if (isFirstPass && current.length) continue;
      setValue(`slas.${priority}.notificationRecipients`, rosterPrefill, {
        shouldDirty: !isFirstPass,
      });
    }
    // rosterPrefill is derived from selectedCategory; keying on the id keeps
    // this to one run per category rather than one per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategoryId, selectedCategory]);

  // A fresh sheet must be able to prefill again for the same category.
  useEffect(() => {
    if (!open) prefilledForCategory.current = null;
  }, [open]);

  const addRecipient = (id: string) => {
    if (!watchedRecipients.includes(id)) {
      setValue(
        `slas.${activePriority}.notificationRecipients`,
        [...watchedRecipients, id],
        {
          shouldDirty: true,
        },
      );
    }
  };

  const removeRecipient = (id: string) => {
    setValue(
      `slas.${activePriority}.notificationRecipients`,
      watchedRecipients.filter((r) => r !== id),
      { shouldDirty: true },
    );
  };

  const toPayload = (data: RequestTypeFormValues): RequestTypeFormData => ({
    category_id: data.categoryId,
    name: data.name,
    description: data.description ?? "",
    status: data.status,
    sla_rules: (["low", "medium", "high", "urgent"] as const).map(
      (priority) => {
        const slaData = data.slas[priority];
        return {
          priority: priority,
          first_response_minutes: slaData.firstResponseMinutes,
          resolution_minutes: slaData.resolutionMinutes,
          business_hours_only: true,
          description: slaData.slaDescription ?? "",
          violation_actions: (slaData.violationActions.length > 0
            ? [...slaData.violationActions, "send_notification"]
            : []) as RequestTypeFormData["sla_rules"][number]["violation_actions"],
          notification_recipients: slaData.notificationRecipients,
          status: slaData.slaStatus,
        };
      },
    ),
  });

  const onSubmit = async (data: RequestTypeFormValues) => {
    try {
      if (isEditing) {
        await updateRequestType({
          id: editId!,
          body: toPayload(data),
        }).unwrap();
        toast.success("Ticket type updated");
      } else {
        await createRequestType(toPayload(data)).unwrap();
        toast.success("Ticket type created");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err,
        isEditing
          ? "Failed to update ticket type"
          : "Failed to create ticket type",
      );
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>
              {isEditing
                ? "Edit Ticket Type &  Define SLA"
                : "Create Ticket Type & Define SLA"}
            </SheetTitle>
            <SheetDescription>
              Define a ticket type and configure its SLA policy as per
              priority.
            </SheetDescription>
            <div className="mt-4 pb-2">
              <Stepper
                steps={STEPS}
                current={activeStep}
                completed={completedSteps}
                onStepClick={(id) => {
                  if (id < activeStep) setActiveStep(id);
                }}
              />
            </div>
          </SheetHeader>

          {isEditing && (isLoadingDetail || !populated) ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form
              onSubmit={handleSubmit(onSubmit)}
              className="flex flex-col flex-1 overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                {activeStep === 0 && (
                  <>
                    {/* Ticket Type Details */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-4">
                        Ticket Type Details
                      </h3>
                      <div
                        className={cn(
                          "grid gap-4 items-start",
                          isEditing
                            ? "grid-cols-[1fr_1fr_auto]"
                            : "grid-cols-2",
                        )}
                      >
                        <div className="space-y-2">
                          <Label htmlFor="name">
                            Ticket Type Name{" "}
                            <span className="text-destructive">*</span>
                          </Label>
                          <Input
                            id="name"
                            placeholder="e.g., Laptop Ticket"
                            maxLength={NAME_MAX}
                            className={`h-9 ${errors.name ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            aria-invalid={errors.name ? "true" : undefined}
                            aria-describedby={
                              errors.name ? "rt-name-error" : "rt-name-count"
                            }
                            {...register("name")}
                          />
                          <div className="flex items-start justify-between gap-2">
                            {errors.name ? (
                              <p
                                id="rt-name-error"
                                role="alert"
                                className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                              >
                                <AlertCircle className="size-3.5 shrink-0" />
                                {errors.name.message}
                              </p>
                            ) : (
                              <span />
                            )}
                            <span
                              id="rt-name-count"
                              className={`shrink-0 text-xs tabular-nums ${
                                (watch("name")?.length ?? 0) > NAME_MAX
                                  ? "text-destructive"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {watch("name")?.length ?? 0}/{NAME_MAX}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>
                            Category <span className="text-destructive">*</span>
                          </Label>
                          <div
                            className={
                              errors.categoryId
                                ? "rounded-md ring-1 ring-destructive"
                                : ""
                            }
                            aria-invalid={
                              errors.categoryId ? "true" : undefined
                            }
                          >
                            <SearchableSelect
                              {...categoryPicker.selectProps}
                              value={watch("categoryId")}
                              onChange={(val) =>
                                setValue("categoryId", val as string, {
                                  shouldValidate: true,
                                  shouldDirty: true,
                                })
                              }
                              placeholder={
                                categoriesLoading
                                  ? "Loading..."
                                  : "Select Category"
                              }
                              disabled={categoriesLoading}
                            />
                          </div>
                          {errors.categoryId && (
                            <p
                              role="alert"
                              className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                            >
                              <AlertCircle className="size-3.5 shrink-0" />
                              {errors.categoryId.message}
                            </p>
                          )}
                        </div>

                        {isEditing && (
                          <div className="space-y-2">
                            <Label className="text-sm font-medium">
                              Status
                            </Label>
                            <div className="flex h-9 items-center gap-2">
                              <Switch
                                checked={watch("status") === "active"}
                                onCheckedChange={(checked) =>
                                  setValue(
                                    "status",
                                    checked ? "active" : "inactive",
                                    {
                                      shouldDirty: true,
                                    },
                                  )
                                }
                              />
                              <Badge
                                variant={
                                  watch("status") === "active"
                                    ? "default"
                                    : "secondary"
                                }
                              >
                                {watch("status") === "active"
                                  ? "Active"
                                  : "Inactive"}
                              </Badge>
                            </div>
                          </div>
                        )}

                        <div
                          className={cn(
                            "space-y-2",
                            isEditing ? "col-span-3" : "col-span-2",
                          )}
                        >
                          <Label htmlFor="description">Description</Label>
                          <Textarea
                            id="description"
                            placeholder="Brief description..."
                            className={`resize-none min-h-[80px] ${
                              errors.description
                                ? "border-destructive focus-visible:ring-destructive"
                                : ""
                            }`}
                            maxLength={DESCRIPTION_MAX}
                            aria-invalid={
                              errors.description ? "true" : undefined
                            }
                            aria-describedby={
                              errors.description
                                ? "rt-desc-error"
                                : "rt-desc-count"
                            }
                            {...register("description")}
                          />
                          <div className="flex items-start justify-between gap-2">
                            {errors.description ? (
                              <p
                                id="rt-desc-error"
                                role="alert"
                                className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                              >
                                <AlertCircle className="size-3.5 shrink-0" />
                                {errors.description.message}
                              </p>
                            ) : (
                              <span />
                            )}
                            <span
                              id="rt-desc-count"
                              className={`shrink-0 text-xs tabular-nums ${
                                (watch("description")?.length ?? 0) >
                                DESCRIPTION_MAX
                                  ? "text-destructive"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {watch("description")?.length ?? 0}/
                              {DESCRIPTION_MAX}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {activeStep === 1 && (
                  <>
                    {/* Priority Level */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-1">
                        Priority Level
                      </h3>
                      <p className="text-xs text-muted-foreground mb-4">
                        Please attach SLA Configuration for all priority levels.
                      </p>

                      {/* Priority Cards */}
                      <div className="grid grid-cols-4 gap-3 mb-4">
                        {priorityCards.map((card) => {
                          const selected = activePriority === card.value;
                          const Icon = card.icon;
                          return (
                            <button
                              key={card.value}
                              type="button"
                              className={cn(
                                "flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all cursor-pointer",
                                selected
                                  ? `${card.borderClass} ${card.bgClass}`
                                  : "border-border hover:border-muted-foreground/40",
                              )}
                              onClick={async () => {
                                const priorityOrder = [
                                  "low",
                                  "medium",
                                  "high",
                                  "urgent",
                                ] as const;
                                const targetIndex = priorityOrder.indexOf(
                                  card.value,
                                );
                                const currentIndex =
                                  priorityOrder.indexOf(activePriority);

                                if (targetIndex > currentIndex) {
                                  let allValid = true;
                                  for (
                                    let i = currentIndex;
                                    i < targetIndex;
                                    i++
                                  ) {
                                    const p = priorityOrder[i];
                                    const valid = await trigger([
                                      `slas.${p}.firstResponseMinutes` as any,
                                      `slas.${p}.resolutionMinutes` as any,
                                      `slas.${p}.slaDescription` as any,
                                    ]);
                                    if (!valid) {
                                      setActivePriority(p);
                                      toast.error(
                                        `Please fill out mandatory fields for ${p.toUpperCase()} priority first.`,
                                      );
                                      allValid = false;
                                      break;
                                    }
                                  }
                                  if (allValid) {
                                    setActivePriority(card.value);
                                  }
                                } else {
                                  setActivePriority(card.value);
                                }
                              }}
                            >
                              <div
                                className={cn(
                                  "size-10 rounded-xl flex items-center justify-center",
                                  selected ? card.bgClass : "bg-muted",
                                )}
                              >
                                <Icon
                                  className={cn(
                                    "size-5",
                                    selected
                                      ? card.colorClass
                                      : "text-muted-foreground",
                                  )}
                                />
                              </div>
                              <span
                                className={cn(
                                  "text-sm font-semibold",
                                  selected
                                    ? "text-foreground"
                                    : "text-muted-foreground",
                                )}
                              >
                                {card.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <Separator />

                    {/* SLA Configuration */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-1">
                        SLA Details
                      </h3>
                      <div className="rounded-xl border bg-card p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-semibold text-foreground">
                            {
                              priorityCards.find(
                                (c) => c.value === activePriority,
                              )?.label
                            }{" "}
                            Priority — SLA Details
                          </h4>
                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-muted-foreground">
                              SLA Status
                            </Label>
                            <Switch
                              checked={
                                watch(`slas.${activePriority}.slaStatus`) ===
                                "active"
                              }
                              onCheckedChange={(checked) =>
                                setValue(
                                  `slas.${activePriority}.slaStatus`,
                                  checked ? "active" : "inactive",
                                  { shouldDirty: true },
                                )
                              }
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>
                              First Response Within (minutes){" "}
                              <span className="text-destructive">*</span>
                            </Label>
                            <Input
                              type="number"
                              min={1}
                              className={`h-9 ${errors.slas?.[activePriority]?.firstResponseMinutes ? "border-destructive focus-visible:ring-destructive" : ""}`}
                              aria-invalid={
                                errors.slas?.[activePriority]
                                  ?.firstResponseMinutes
                                  ? "true"
                                  : undefined
                              }
                              {...register(
                                `slas.${activePriority}.firstResponseMinutes`,
                                {
                                  valueAsNumber: true,
                                },
                              )}
                            />
                            {errors.slas?.[activePriority]
                              ?.firstResponseMinutes && (
                              <p
                                role="alert"
                                className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                              >
                                <AlertCircle className="size-3.5 shrink-0" />
                                {
                                  errors.slas?.[activePriority]
                                    ?.firstResponseMinutes?.message
                                }
                              </p>
                            )}
                          </div>
                          <div className="space-y-2">
                            <Label>
                              Resolution Time (minutes){" "}
                              <span className="text-destructive">*</span>
                            </Label>
                            <Input
                              type="number"
                              min={1}
                              className={`h-9 ${errors.slas?.[activePriority]?.resolutionMinutes || liveResolutionError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                              aria-invalid={
                                errors.slas?.[activePriority]
                                  ?.resolutionMinutes || liveResolutionError
                                  ? "true"
                                  : undefined
                              }
                              {...register(
                                `slas.${activePriority}.resolutionMinutes`,
                                {
                                  valueAsNumber: true,
                                },
                              )}
                            />
                            {(errors.slas?.[activePriority]
                              ?.resolutionMinutes ||
                              liveResolutionError) && (
                              <p
                                role="alert"
                                className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                              >
                                <AlertCircle className="size-3.5 shrink-0" />
                                {errors.slas?.[activePriority]
                                  ?.resolutionMinutes?.message ??
                                  liveResolutionError}
                              </p>
                            )}
                          </div>

                          <div className="col-span-2 space-y-2">
                            <Label htmlFor="slaDescription">
                              SLA Description
                            </Label>
                            <Textarea
                              id="slaDescription"
                              placeholder="Optional SLA notes..."
                              maxLength={SLA_DESCRIPTION_MAX}
                              className={`resize-none min-h-[60px] ${
                                errors.slas?.[activePriority]?.slaDescription
                                  ? "border-destructive focus-visible:ring-destructive"
                                  : ""
                              }`}
                              aria-invalid={
                                errors.slas?.[activePriority]?.slaDescription
                                  ? "true"
                                  : undefined
                              }
                              {...register(
                                `slas.${activePriority}.slaDescription`,
                              )}
                            />
                            <div className="flex items-start justify-between gap-2">
                              {errors.slas?.[activePriority]?.slaDescription ? (
                                <p
                                  role="alert"
                                  className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                                >
                                  <AlertCircle className="size-3.5 shrink-0" />
                                  {
                                    errors.slas?.[activePriority]
                                      ?.slaDescription?.message
                                  }
                                </p>
                              ) : (
                                <span />
                              )}
                              <span
                                className={`shrink-0 text-xs tabular-nums ${
                                  (watch(
                                    `slas.${activePriority}.slaDescription`,
                                  )?.length ?? 0) > SLA_DESCRIPTION_MAX
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {watch(`slas.${activePriority}.slaDescription`)
                                  ?.length ?? 0}
                                /{SLA_DESCRIPTION_MAX}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <Separator />

                    {/* Violation & Notifications */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-1">
                        Violations & Notifications
                      </h3>
                      <p className="text-xs text-muted-foreground mb-4">
                        Pick what should happen when an SLA deadline is
                        breached. Any action you select will also notify the
                        recipients listed below.
                      </p>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 space-y-3">
                          <Label>SLA Violation Actions</Label>
                          <div className="rounded-xl border p-4 flex items-center gap-8">
                            {violationOptions.map((option) => (
                              <label
                                key={option.value}
                                className="flex items-center gap-2.5 cursor-pointer select-none"
                              >
                                <Checkbox
                                  className="size-4.5 border-2"
                                  checked={watchedViolationActions.includes(
                                    option.value,
                                  )}
                                  onCheckedChange={() =>
                                    toggleViolationAction(option.value)
                                  }
                                />
                                <span className="text-sm">{option.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="col-span-2 space-y-2">
                          <Label className="flex items-center gap-2">
                            Notification Recipients
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    className="inline-flex items-center text-muted-foreground hover:text-foreground"
                                    aria-label="Notification recipients info"
                                  >
                                    <Info className="size-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="top"
                                  className="max-w-[260px] text-xs"
                                >
                                  Apart from the department head, notifications
                                  will be sent to the people selected here.
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {watchedRecipients.length > 0 && (
                              <Badge
                                variant="secondary"
                                className="h-5 px-2 text-xs tabular-nums"
                              >
                                {watchedRecipients.length} selected
                              </Badge>
                            )}
                            {rosterPrefill.length > 0 && (
                              <button
                                type="button"
                                className="ml-auto text-xs font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                onClick={() =>
                                  applyRosterToPriority(activePriority)
                                }
                              >
                                Reset to category executors
                              </button>
                            )}
                          </Label>
                          {rosterTruncated && (
                            <p className="text-xs text-muted-foreground">
                              This category has more than {MAX_RECIPIENTS}{" "}
                              executors — only the first {MAX_RECIPIENTS}{" "}
                              (primaries first) are prefilled.
                            </p>
                          )}
                          <SearchableSelect
                            options={(
                              employees as Array<{
                                id: string;
                                userId: string;
                                firstName: string;
                                lastName: string;
                                empCode: string;
                              }>
                            )
                              // notification_recipients are USER ids, not
                              // employee-record ids — sending emp.id makes the
                              // API reject the save with 422
                              // NOTIFICATION_RECIPIENT_UNRESOLVED. Skip anyone
                              // with no linked user account (same guard as
                              // WorkflowForm's escalate-to picker).
                              .filter(
                                (emp) =>
                                  emp.userId &&
                                  !watchedRecipients.includes(emp.userId),
                              )
                              // Department first: the list merges several of
                              // them, so it is what tells two similarly-named
                              // people apart.
                              .map((emp) => ({
                                label: `${emp.firstName} ${emp.lastName} (${[
                                  emp.departmentName,
                                  emp.empCode,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")})`,
                                value: emp.userId,
                              }))}
                            value=""
                            onChange={(val) => addRecipient(val as string)}
                            placeholder={
                              selectedDeptIds.length === 0
                                ? "Pick a category first to see its team"
                                : employeesFetching
                                  ? "Loading team..."
                                  : (employees as unknown[]).length === 0
                                    ? "No employees in these departments"
                                    : "Add recipients..."
                            }
                            disabled={
                              selectedDeptIds.length === 0 || employeesFetching
                            }
                          />
                          {watchedRecipients.length > 0 && (
                            <div className="flex gap-2 flex-wrap mt-2">
                              {watchedRecipients.map((id) => {
                                // `id` is a USER id (see the picker above and
                                // the API's notification_recipients contract).
                                const recipient = (
                                  employees as Array<{
                                    userId: string;
                                    firstName: string;
                                    lastName: string;
                                    empCode?: string;
                                    departmentName?: string;
                                  }>
                                ).find((emp) => emp.userId === id);
                                // Prefilled roster members can sit beyond the
                                // 100-employee page, so fall back to the
                                // snapshot the category carries.
                                const rosterEntry = (
                                  selectedCategory?.executors ?? []
                                ).find((e) => e.user_id === id);
                                const label = recipient
                                  ? `${recipient.firstName} ${recipient.lastName}`
                                  : rosterEntry?.name || id;
                                // Department code + employee code, so a chip
                                // can be told apart at a glance when it comes
                                // time to remove one.
                                const qualifier = [
                                  rosterEntry?.department_code ||
                                    recipient?.departmentName,
                                  rosterEntry?.emp_code || recipient?.empCode,
                                ]
                                  .filter(Boolean)
                                  .join(" · ");
                                return (
                                  <Badge
                                    key={id}
                                    variant="secondary"
                                    className="gap-1"
                                  >
                                    {qualifier ? `${label} (${qualifier})` : label}
                                    <button
                                      type="button"
                                      className="ml-1 hover:text-destructive"
                                      onClick={() => removeRecipient(id)}
                                    >
                                      ×
                                    </button>
                                  </Badge>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="border-t px-6 py-4 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (activeStep > 0) {
                      if (activePriority === "urgent")
                        setActivePriority("high");
                      else if (activePriority === "high")
                        setActivePriority("medium");
                      else if (activePriority === "medium")
                        setActivePriority("low");
                      else setActiveStep(activeStep - 1);
                    } else {
                      handleOpenChange(false);
                    }
                  }}
                >
                  {activeStep === 0 ? "Cancel" : "Back"}
                </Button>
                {activeStep === 0 ? (
                  <Button
                    type="button"
                    variant="soft"
                    onClick={async (e) => {
                      e.preventDefault();
                      const valid = await trigger([
                        "name",
                        "categoryId",
                        "description",
                        "status",
                      ]);
                      if (valid) {
                        setCompletedSteps((prev) => new Set([...prev, 0]));
                        setActiveStep(1);
                      }
                    }}
                  >
                    Next
                  </Button>
                ) : activePriority !== "urgent" ? (
                  <Button
                    type="button"
                    variant="soft"
                    onClick={async (e) => {
                      e.preventDefault();
                      const valid = await trigger([
                        `slas.${activePriority}.firstResponseMinutes` as any,
                        `slas.${activePriority}.resolutionMinutes` as any,
                        `slas.${activePriority}.slaDescription` as any,
                      ]);
                      if (valid) {
                        if (activePriority === "low")
                          setActivePriority("medium");
                        else if (activePriority === "medium")
                          setActivePriority("high");
                        else if (activePriority === "high")
                          setActivePriority("urgent");
                      } else {
                        toast.error(
                          `Please fill out mandatory fields for ${activePriority.toUpperCase()} priority first.`,
                        );
                      }
                    }}
                  >
                    Save changes and Next
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="soft"
                    disabled={isPending || (!isDirty && isEditing)}
                    onClick={async (e) => {
                      const valid = await trigger([
                        `slas.urgent.firstResponseMinutes` as any,
                        `slas.urgent.resolutionMinutes` as any,
                        `slas.urgent.slaDescription` as any,
                      ]);
                      if (!valid) e.preventDefault();
                    }}
                  >
                    {isPending && <Loader2 className="animate-spin" />}
                    {isEditing ? "Update" : "Save"}
                  </Button>
                )}
              </div>
            </form>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Unsaved changes"
        description="You have unsaved changes. Are you sure you want to leave without saving?"
        cancelLabel="Stay"
        confirmLabel="Leave without saving"
        onConfirm={() => {
          setDiscardOpen(false);
          onOpenChange(false);
        }}
      />
    </>
  );
};
