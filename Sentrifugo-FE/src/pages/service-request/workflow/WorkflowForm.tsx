import { useState, useEffect, useMemo, useCallback } from "react";
import { AlertCircle, Info, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { usePagedSelect } from "../usePagedSelect";
import { toast } from "@/lib/toast";
import {
  useGetCategoriesQuery,
  useGetCategoryByIdQuery,
  useGetRequestTypesQuery,
  useGetRequestTypeByIdQuery,
  useGetEmployeesQuery,
  useGetWorkflowByIdQuery,
  useCreateWorkflowMutation,
  useUpdateWorkflowMutation,
} from "@/store/api/srmApi";
import type {
  Category,
  RequestTypeListItem,
  WorkflowCreatePayload,
} from "@/types/service-request";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId?: string | null;
}

export const WorkflowForm = ({ open, onOpenChange, editId }: Props) => {
  const isEditing = !!editId;

  const [categoryId, setCategoryId] = useState("");
  const [requestTypeId, setRequestTypeId] = useState("");
  const [escalationEnabled, setEscalationEnabled] = useState(false);
  const [escalateAfterMinutes, setEscalateAfterMinutes] = useState(1440);
  const [escalateTo, setEscalateTo] = useState("");
  const [notifyBeforeEscalation, setNotifyBeforeEscalation] = useState(false);
  const [notifyBeforeMinutes, setNotifyBeforeMinutes] = useState(120);
  const [notifyMethods, setNotifyMethods] = useState<string[]>(["email"]);
  const [notifyEvents, setNotifyEvents] = useState<string[]>(["assignment"]);
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [populated, setPopulated] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // True once the user has clicked Save at least once. Until then, missing-
  // field errors stay hidden so the form doesn't yell at you on first open.
  const [attempted, setAttempted] = useState(false);

  const { data: existingData, isLoading: isLoadingDetail } =
    useGetWorkflowByIdQuery(editId!, { skip: !editId });
  const effectiveCategoryId = categoryId || existingData?.category_id || "";

  // The saved category may sit on any page of /categories, so fetch it by id.
  // This keeps the trigger labelled AND — more importantly — supplies
  // `department_id` for the approver lookup below, which would otherwise be
  // undefined on edit and leave every approver dropdown empty.
  const { data: selectedCategory } = useGetCategoryByIdQuery(
    effectiveCategoryId,
    { skip: !effectiveCategoryId },
  );

  const categoryPicker = usePagedSelect<Category>({
    useQuery: useGetCategoriesQuery,
    args: { status: "active" },
    toOption: (c) => ({ label: c.name, value: c.id }),
    selected: selectedCategory
      ? { label: selectedCategory.name, value: selectedCategory.id }
      : null,
  });
  const isLoadingCategories = categoryPicker.isFetching;

  // Same story for the saved request type — resolve it by id so edit mode can
  // label and select it even when it isn't on a loaded page.
  const savedRequestTypeId = existingData?.request_type_id ?? "";
  const { data: savedRequestType } = useGetRequestTypeByIdQuery(
    savedRequestTypeId,
    { skip: !savedRequestTypeId },
  );

  const requestTypePicker = usePagedSelect<RequestTypeListItem>({
    useQuery: useGetRequestTypesQuery,
    args: { category_id: effectiveCategoryId },
    toOption: (rt) => ({
      label: rt.request_type_name,
      value: rt.request_type_id,
    }),
    selected:
      savedRequestType && savedRequestType.category_id === effectiveCategoryId
        ? { label: savedRequestType.name, value: savedRequestType.id }
        : null,
    // Switching category is a different result set — drop the loaded pages.
    resetKey: effectiveCategoryId,
    skip: !effectiveCategoryId,
  });

  // Approver dropdowns (L1, L2, escalate-to) only list employees who hold at
  // least one IAM policy — i.e. managers / leadership-policy users. Regular
  // employees can't access the Approvals page so they shouldn't be selectable
  // as approvers in the workflow config.
  //
  // Scoped to the selected category's departments, like RequestTypeForm does:
  // SRM's /employees REQUIRES at least one department (400 MISSING_DEPARTMENT_ID
  // without it), so an unscoped call errors and `data` stays undefined — which
  // renders as a permanently empty "No options found." list rather than as a
  // failure.
  //
  // Read off the fetch-by-id result above, NOT the paged list: the selected
  // category is only in the list if it happened to land on a loaded page, so
  // deriving the department from there silently emptied the approver dropdowns
  // on edit. The scalar fallback covers categories saved before the list existed.
  const selectedCategoryDeptIds = selectedCategory?.department_ids?.length
    ? selectedCategory.department_ids
    : selectedCategory?.department_id
      ? [selectedCategory.department_id]
      : [];
  // The roster, split by role. The panel below used to show the category's
  // department name under a "Primary Assignee (auto)" label — a department is
  // not an assignee, and the people who actually hold those powers are right
  // here on the category.
  const categoryPrimaries = (selectedCategory?.executors ?? []).filter(
    (e) => e.role === "primary",
  );
  const categorySecondaries = (selectedCategory?.executors ?? []).filter(
    (e) => e.role === "secondary",
  );
  // Auto-escalation targets: the category's primaries, and only those.
  //
  // This dropdown used to list every policy-holding employee in the category's
  // departments, so a workflow could be configured to auto-escalate to someone
  // the manual escalate path refuses — that path resolves targets through
  // `_eligible_escalation_targets`, which is the roster's primaries and nobody
  // else. The two disagreed about who may receive an escalated ticket, and the
  // SLA tick would hand tickets to people with no authority over the category.
  const escalateToOptions = (() => {
    const opts = categoryPrimaries.map((e) => ({
      label: e.emp_code ? `${e.name} (${e.emp_code})` : e.name,
      value: e.user_id,
    }));
    // An existing workflow may point at someone since removed from the roster.
    // Keep them visible rather than silently blanking the field on open, which
    // reads as "no target was ever set" and loses the audit trail.
    if (escalateTo && !opts.some((o) => o.value === escalateTo)) {
      opts.push({
        label: "Current target — no longer a primary on this category",
        value: escalateTo,
      });
    }
    return opts;
  })();
  const onlyPrimaryUserId =
    categoryPrimaries.length === 1 ? categoryPrimaries[0].user_id : "";
  // One primary means there is no choice to make — preselect it rather than
  // blocking submit on a dropdown with a single entry. Deliberately does not
  // overwrite an existing pick, so editing a workflow keeps its stored target.
  useEffect(() => {
    if (!escalationEnabled || escalateTo || !onlyPrimaryUserId) return;
    setEscalateTo(onlyPrimaryUserId);
  }, [escalationEnabled, escalateTo, onlyPrimaryUserId]);
  const { data: employees = [] } = useGetEmployeesQuery(
    selectedCategoryDeptIds.length
      ? {
          has_policies: true,
          department_ids: selectedCategoryDeptIds,
          limit: 100,
        }
      : undefined,
    { skip: selectedCategoryDeptIds.length === 0 },
  );

  const resetForm = () => {
    setCategoryId("");
    setRequestTypeId("");
    setEscalationEnabled(false);
    setEscalateAfterMinutes(1440);
    setEscalateTo("");
    setNotifyBeforeEscalation(false);
    setNotifyBeforeMinutes(120);
    setNotifyMethods(["email"]);
    setNotifyEvents(["assignment"]);
    setStatus("active");
    setPopulated(false);
    setAttempted(false);
    setIsDirty(false);
  };

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
    resetForm();
  }, [open, editId]);

  useEffect(() => {
    if (
      populated ||
      !open ||
      !editId ||
      !existingData ||
      // Ignore a cached result belonging to a previously opened workflow.
      existingData.id !== editId ||
      isLoadingCategories
    )
      return;
    setCategoryId(existingData.category_id);
    setStatus(existingData.status ?? "active");
    // Set the saved subtype directly. It used to be gated on the value being
    // present in the loaded list, which under paging silently left the field
    // blank whenever the saved subtype sat beyond the first page.
    setRequestTypeId(existingData.request_type_id);
    const esc = existingData.escalation_config;
    if (esc) {
      setEscalationEnabled(esc.auto_escalate_enabled);
      setEscalateAfterMinutes(esc.escalate_after_minutes);
      setEscalateTo(esc.escalate_to_user_id);
      setNotifyBeforeEscalation(esc.pre_notify_enabled);
      setNotifyBeforeMinutes(esc.pre_notify_minutes_before);
      // "system" notification method was removed from the UI — drop it if it
      // exists in saved data so it can't quietly persist. Email is always on
      // and not user-toggleable, so force it into the list.
      {
        const cleaned = esc.notification_methods.filter((m) => m !== "system");
        setNotifyMethods(
          cleaned.includes("email") ? cleaned : [...cleaned, "email"],
        );
      }
      setNotifyEvents(esc.notify_on);
    }
    setPopulated(true);
  }, [existingData, populated, isLoadingCategories, open, editId]);

  useEffect(() => {
    if (!populated || requestTypeId || !existingData) return;
    // Set the saved subtype directly. It used to be gated on the value being
    // present in the loaded list, which under paging silently left the field
    // blank whenever the saved subtype sat beyond the first page.
    setRequestTypeId(existingData.request_type_id);
  }, [populated, requestTypeId, existingData]);

  const toggleArrayItem = (
    arr: string[],
    item: string,
    setter: (arr: string[]) => void,
  ) => {
    setter(arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item]);
  };

  const [createWorkflow, { isLoading: isCreating }] =
    useCreateWorkflowMutation();
  const [updateWorkflow, { isLoading: isUpdating }] =
    useUpdateWorkflowMutation();
  const isPending = isCreating || isUpdating;

  // Field-level validation, recomputed reactively. Rendered inline once the
  // user has clicked Save at least once (`attempted`), so the form doesn't
  // shout errors on a fresh open.
  const errors = useMemo(() => {
    const e: {
      categoryId?: string;
      requestTypeId?: string;
      escalateTo?: string;
      escalateAfterMinutes?: string;
      notifyBeforeMinutes?: string;
    } = {};
    if (!categoryId) e.categoryId = "Category is required";
    if (!requestTypeId) e.requestTypeId = "Ticket type is required";
    if (escalationEnabled) {
      if (!escalateTo)
        e.escalateTo = categoryPrimaries.length
          ? "Pick a primary executor to escalate to"
          : "This category has no primary executor to escalate to — add one to its roster, or turn auto-escalation off";
      if (!escalateAfterMinutes || escalateAfterMinutes < 1)
        e.escalateAfterMinutes = "Must be at least 1 minute";
      if (
        notifyBeforeEscalation &&
        (!notifyBeforeMinutes || notifyBeforeMinutes < 1)
      )
        e.notifyBeforeMinutes = "Must be at least 1 minute";
    }
    return e;
  }, [
    categoryId,
    requestTypeId,
    escalationEnabled,
    escalateTo,
    escalateAfterMinutes,
    notifyBeforeEscalation,
    notifyBeforeMinutes,
  ]);
  const hasErrors = Object.keys(errors).length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasErrors) {
      setAttempted(true);
      toast.error("Please fix the highlighted fields before saving");
      return;
    }
    // Approval routing is per-ticket: both levels come from the requester's
    // employee record (L1 manager, L2 manager). The API also takes an optional
    // L2 override at submit-for-approval time, but its candidate pool is the
    // `dev-leadership` policy, which exists nowhere — so it is never surfaced.
    // The workflow config carries no level definitions; the BE ignores
    // approval_required / approval_levels even if sent, but we omit them.
    const payload: WorkflowCreatePayload = {
      category_id: categoryId,
      request_type_id: requestTypeId,
      approval_required: true,
      approval_levels: [],
      escalation_config: {
        auto_escalate_enabled: escalationEnabled,
        escalate_after_minutes: escalateAfterMinutes,
        escalate_to_user_id: escalateTo,
        pre_notify_enabled: notifyBeforeEscalation,
        pre_notify_minutes_before: notifyBeforeMinutes,
        notification_methods: notifyMethods,
        notify_on: notifyEvents,
      },
    };
    try {
      if (isEditing) {
        await updateWorkflow({
          id: editId!,
          body: { ...payload, status },
        }).unwrap();
        toast.success("Workflow updated");
      } else {
        await createWorkflow(payload).unwrap();
        toast.success("Workflow created");
        // Clear the slider's fields right after a successful create so the panel
        // doesn't carry the just-created workflow's data into the next open.
        resetForm();
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err,
        isEditing ? "Failed to update workflow" : "Failed to create workflow",
      );
    }
  };

  const typedEmployees = employees as Array<{
    userId: string;
    firstName: string;
    lastName: string;
    empCode: string;
  }>;

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>
              {isEditing
                ? "Edit Workflow"
                : "Configure Assignment & Approval Workflow"}
            </SheetTitle>
            <SheetDescription>
              Define assignment rules, approval levels, and escalation settings.
            </SheetDescription>
          </SheetHeader>

          {isEditing && (isLoadingDetail || !populated) ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex flex-col flex-1 overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                {/* Category & Ticket Type */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-4">
                    Category & Ticket Type
                  </h3>
                  <div
                    className={`grid gap-4 items-start ${isEditing ? "grid-cols-[1fr_1fr_auto]" : "grid-cols-2"}`}
                  >
                    <div className="space-y-2">
                      <Label>
                        Category <span className="text-destructive">*</span>
                      </Label>
                      <div
                        className={
                          attempted && errors.categoryId
                            ? "rounded-md ring-1 ring-destructive"
                            : ""
                        }
                        aria-invalid={
                          attempted && errors.categoryId ? "true" : undefined
                        }
                      >
                        <SearchableSelect
                          {...categoryPicker.selectProps}
                          value={categoryId}
                          onChange={(val) => {
                            setCategoryId(val as string);
                            setRequestTypeId("");
                            setIsDirty(true);
                          }}
                          placeholder="Select Category"
                        />
                      </div>
                      {attempted && errors.categoryId && (
                        <p
                          role="alert"
                          className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                        >
                          <AlertCircle className="size-3.5 shrink-0" />
                          {errors.categoryId}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Ticket Type <span className="text-destructive">*</span>
                      </Label>
                      <div
                        className={
                          attempted && errors.requestTypeId
                            ? "rounded-md ring-1 ring-destructive"
                            : ""
                        }
                        aria-invalid={
                          attempted && errors.requestTypeId ? "true" : undefined
                        }
                      >
                        <SearchableSelect
                          {...requestTypePicker.selectProps}
                          value={requestTypeId}
                          onChange={(val) => {
                            setRequestTypeId(val as string);
                            setIsDirty(true);
                          }}
                          placeholder={
                            !effectiveCategoryId
                              ? "Select Category first"
                              : "Select Ticket Type"
                          }
                          disabled={!effectiveCategoryId}
                        />
                      </div>
                      {attempted && errors.requestTypeId && (
                        <p
                          role="alert"
                          className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                        >
                          <AlertCircle className="size-3.5 shrink-0" />
                          {errors.requestTypeId}
                        </p>
                      )}
                    </div>

                    {isEditing && (
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Status</Label>
                        <div className="flex h-9 items-center gap-2">
                          <Switch
                            checked={status === "active"}
                            onCheckedChange={(checked) => {
                              setStatus(checked ? "active" : "inactive");
                              setIsDirty(true);
                            }}
                          />
                          <Badge
                            variant={
                              status === "active" ? "default" : "secondary"
                            }
                          >
                            {status === "active" ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                      </div>
                    )}
                  </div>
                  {selectedCategory && (
                    <div className="mt-3 rounded-xl border p-3 bg-muted/30">
                      {categoryPrimaries.length === 0 ? (
                        <>
                          <p className="text-sm font-medium text-foreground">
                            No primary executor on this category
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Tickets cannot be raised against a category with no
                            primary. Add one to the category's roster before
                            using this workflow.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm">
                            <span className="text-muted-foreground">
                              Primary executors:{" "}
                            </span>
                            <span className="font-medium">
                              {categoryPrimaries
                                .map((e) => e.name || e.email || e.user_id)
                                .join(", ")}
                            </span>
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {categoryPrimaries.length > 1
                              ? "New tickets default to the first of these. "
                              : ""}
                            Primaries assign, reassign and receive escalations
                            {categorySecondaries.length > 0
                              ? `; ${categorySecondaries.length} secondar${
                                  categorySecondaries.length === 1 ? "y" : "ies"
                                } work tickets`
                              : ""}
                            . A department head holds none of this unless they
                            are on the roster too.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <Separator />

                {/* Approval Routing — derived per ticket, nothing to configure.
                    Both levels come from the REQUESTER's employee record in
                    IAM, so two tickets on this workflow can have entirely
                    different approvers. That is why there is no approver
                    picker here and no Approvers column on the workflow list.

                    L2 is stated flatly as the requester's L2 manager. The API
                    does accept an override (`trigger_l2` takes an optional
                    `level_2_approver_user_id`), but it gates candidates on
                    `iam.list_leadership_users`, which filters employees on a
                    policy named `dev-leadership` that exists in no environment
                    we have — the pool is always empty, so the picker offers
                    nothing and the override cannot be exercised. Documenting a
                    control nobody can reach only sends admins looking for it;
                    if that policy is ever created, restore the sentence here.

                    The failure mode worth knowing is the other one: a requester
                    with no L2 on their employee record cannot be sent to L2 at
                    all (NO_L2_MANAGER), and the fix is in IAM, not here. */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">
                    Approval Routing
                  </h3>
                  <div className="rounded-xl border bg-muted/30 p-4 flex gap-3">
                    <Info className="size-4 shrink-0 text-muted-foreground mt-0.5" />
                    <div className="space-y-1 text-sm">
                      <p className="text-foreground">
                        Approvals are routed automatically per ticket, from the
                        requester&apos;s reporting hierarchy.
                      </p>
                      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                        <li>
                          <span className="font-medium text-foreground">
                            Level 1
                          </span>{" "}
                          — the requester&apos;s L1 manager.
                        </li>
                        <li>
                          <span className="font-medium text-foreground">
                            Level 2
                          </span>{" "}
                          — the requester&apos;s L2 manager.
                        </li>
                      </ul>
                      <p className="text-xs text-muted-foreground pt-1">
                        Both are read from the requester&apos;s employee record,
                        so approvers differ per ticket. Someone with no L2
                        manager set cannot be sent for L2 approval until their
                        record is updated.
                      </p>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Escalation Rules */}
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-foreground">
                      Escalation Rules
                    </h3>
                    <Switch
                      checked={escalationEnabled}
                      onCheckedChange={(v) => {
                        setEscalationEnabled(v);
                        setIsDirty(true);
                      }}
                    />
                  </div>
                  {escalationEnabled && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>
                            Escalate After (minutes){" "}
                            <span className="text-destructive">*</span>
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            className={`h-9 ${attempted && errors.escalateAfterMinutes ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            aria-invalid={
                              attempted && errors.escalateAfterMinutes
                                ? "true"
                                : undefined
                            }
                            value={escalateAfterMinutes}
                            onChange={(e) => {
                              setEscalateAfterMinutes(Number(e.target.value));
                              setIsDirty(true);
                            }}
                          />
                          {attempted && errors.escalateAfterMinutes && (
                            <p
                              role="alert"
                              className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                            >
                              <AlertCircle className="size-3.5 shrink-0" />
                              {errors.escalateAfterMinutes}
                            </p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label>
                            Escalate To{" "}
                            <span className="text-destructive">*</span>
                          </Label>
                          <div
                            className={
                              attempted && errors.escalateTo
                                ? "rounded-md ring-1 ring-destructive"
                                : ""
                            }
                            aria-invalid={
                              attempted && errors.escalateTo
                                ? "true"
                                : undefined
                            }
                          >
                            <SearchableSelect
                              options={escalateToOptions}
                              value={escalateTo}
                              onChange={(val) => {
                                setEscalateTo(val as string);
                                setIsDirty(true);
                              }}
                              placeholder={
                                categoryPrimaries.length === 0
                                  ? "No primary executor on this category"
                                  : "Select a primary executor"
                              }
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {categoryPrimaries.length === 0
                              ? "Add a primary to the category's roster first — auto-escalation has nobody to hand the ticket to."
                              : "Only the category's primary executors can receive an escalated ticket, so this list matches the roster."}
                          </p>
                          {attempted && errors.escalateTo && (
                            <p
                              role="alert"
                              className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                            >
                              <AlertCircle className="size-3.5 shrink-0" />
                              {errors.escalateTo}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between rounded-xl border p-3">
                        <div>
                          <Label>Notify before escalation</Label>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Alert the assignee before escalation triggers
                          </p>
                        </div>
                        <Switch
                          checked={notifyBeforeEscalation}
                          onCheckedChange={setNotifyBeforeEscalation}
                        />
                      </div>
                      {notifyBeforeEscalation && (
                        <div className="space-y-2">
                          <Label>
                            Lead time (minutes before escalation){" "}
                            <span className="text-destructive">*</span>
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            className={`h-9 max-w-[150px] ${attempted && errors.notifyBeforeMinutes ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            aria-invalid={
                              attempted && errors.notifyBeforeMinutes
                                ? "true"
                                : undefined
                            }
                            value={notifyBeforeMinutes}
                            onChange={(e) =>
                              setNotifyBeforeMinutes(Number(e.target.value))
                            }
                          />
                          {attempted && errors.notifyBeforeMinutes && (
                            <p
                              role="alert"
                              className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                            >
                              <AlertCircle className="size-3.5 shrink-0" />
                              {errors.notifyBeforeMinutes}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <Separator />

                {/* Notification Settings */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-4">
                    Notification Settings
                  </h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Notification Methods</Label>
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 cursor-not-allowed">
                              <Checkbox checked disabled />
                              <span className="text-sm text-muted-foreground">
                                Email Notification
                              </span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="max-w-[280px] text-xs"
                          >
                            Email is the only supported channel today and is
                            always on for every workflow. In-app/system
                            notifications aren't wired yet, so this can't be
                            turned off.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <div className="space-y-2">
                      <Label>Notify for Events</Label>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { value: "assignment", label: "Executor Assignment" },
                          { value: "approval", label: "Approval Tickets" },
                          { value: "escalation", label: "Escalation Alerts" },
                          { value: "sla_breach", label: "SLA Breach Warnings" },
                        ].map((event) => (
                          <label
                            key={event.value}
                            className="flex items-center gap-2 cursor-pointer"
                          >
                            <Checkbox
                              checked={notifyEvents.includes(event.value)}
                              onCheckedChange={() =>
                                toggleArrayItem(
                                  notifyEvents,
                                  event.value,
                                  setNotifyEvents,
                                )
                              }
                            />
                            <span className="text-sm">{event.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t px-6 py-4 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="soft" disabled={isPending}>
                  {isPending && <Loader2 className="animate-spin" />}
                  {isEditing ? "Update" : "Save"}
                </Button>
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
