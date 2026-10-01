import { useEffect, useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  useGetCategoryByIdQuery,
  useGetEmployeesQuery,
  useGetWorkflowsQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
} from "@/store/api/srmApi";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
} from "@/store/api/iamApi";
import type { CategoryFormData, Employee } from "@/types/service-request";
import { deptLabel } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";

const NAME_MAX = 100;
const NAME_MIN = 3;
const DESCRIPTION_MAX = 500;
// Mirrors MAX_EXECUTORS in the backend's category schema.
const MAX_EXECUTORS = 200;
// IAM caps a page of employees at 100, so the list below is a page, not the
// whole department — search is what reaches anyone past it.
const EMPLOYEE_PAGE_SIZE = 100;

function useDebounce<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

const categorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Category name is required")
      .min(NAME_MIN, `Category name must be at least ${NAME_MIN} characters`)
      .max(NAME_MAX, `Category name must be ${NAME_MAX} characters or fewer`),
    description: z
      .string()
      .max(DESCRIPTION_MAX, `Description must be ${DESCRIPTION_MAX} characters or fewer`)
      .optional(),
    businessUnitId: z.string().min(1, "Business unit is required"),
    // A category is scoped to one business unit and a list of departments —
    // their employees are the pool the roster is picked from.
    departmentIds: z
      .array(z.string())
      .min(1, "At least one department is required"),
    restrictedVisibility: z.boolean(),
    // Additional teams beyond the home business unit + department, which
    // always have visibility. Optional — restricting to just the home team
    // (both lists empty) is valid.
    visibilityBusinessUnitIds: z.array(z.string()),
    visibilityDepartmentIds: z.array(z.string()),
    // Tagged executor roster. Empty is valid and means legacy behaviour —
    // the department head holds the powers, the whole department executes.
    executors: z
      .array(
        z.object({
          user_id: z.string(),
          role: z.enum(["primary", "secondary"]),
        }),
      )
      .max(MAX_EXECUTORS, `At most ${MAX_EXECUTORS} executors can be assigned`)
      // Mirrors `_validate_executors` in the backend's category schema: empty
      // stays valid, but once anyone is named at least one of them must be a
      // primary. Checked here too so the admin sees it against the roster
      // instead of as a 422 after submitting.
      //
      // The message no longer offers "clear the roster" as the way out. That
      // was true when an empty roster fell back to the department (D4) — it
      // isn't now: `service_create.py` rejects a ticket raised into a category
      // with no primary (`CategoryRosterNotConfigured`), so emptying the roster
      // does not relax the requirement, it produces a category nobody can raise
      // a ticket in.
      .refine(
        (list) => list.length === 0 || list.some((e) => e.role === "primary"),
        {
          message:
            "Mark at least one person as Primary — primaries assign, reassign and receive escalations. Without a primary, tickets cannot be raised in this category.",
        },
      ),
    // `rosterIsExclusive` was here. It is no longer form state at all: the
    // submit handler derives `roster_is_exclusive` from whether a roster exists,
    // so there is nothing for the user to set and nothing to validate.
    status: z.enum(["active", "inactive"]),
  });

const EMPTY_FORM: CategoryFormValues = {
  name: "",
  description: "",
  businessUnitId: "",
  departmentIds: [],
  restrictedVisibility: false,
  visibilityBusinessUnitIds: [],
  visibilityDepartmentIds: [],
  executors: [],
  status: "active",
};

type CategoryFormValues = z.infer<typeof categorySchema>;

type ExecutorRole = "primary" | "secondary";

/** Display metadata for one roster member, kept beside the form value. */
type RosterMeta = {
  name: string;
  empCode: string;
  departmentId: string;
  departmentName: string;
};

/** Primary/Secondary pair for one roster row — live only once the row is ticked. */
const RoleChoice = ({
  userId,
  role,
  onChange,
}: {
  userId: string;
  role?: ExecutorRole;
  onChange: (userId: string, role: ExecutorRole) => void;
}) => (
  <RadioGroup
    value={role ?? ""}
    onValueChange={(v) => onChange(userId, v as ExecutorRole)}
    disabled={!role}
    className="flex w-auto shrink-0 items-center gap-3"
  >
    {(["primary", "secondary"] as const).map((option) => (
      <div key={option} className="flex items-center gap-1.5">
        <RadioGroupItem value={option} id={`${userId}-${option}`} />
        <Label
          htmlFor={`${userId}-${option}`}
          className={`text-xs font-normal ${
            role ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          {option === "primary" ? "Primary" : "Secondary"}
        </Label>
      </div>
    ))}
  </RadioGroup>
);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId?: string | null;
}

export const CategoryForm = ({ open, onOpenChange, editId }: Props) => {
  const isEditing = !!editId;

  const { data: category, isLoading } = useGetCategoryByIdQuery(editId!, {
    skip: !editId,
  });
  // Workflows on this category, so removing a primary can warn about the one
  // thing removal genuinely breaks: an auto-escalation target.
  //
  // The default assignee needs no warning — tickets derive it live from the
  // roster now, so removing someone silently and correctly moves it to the next
  // primary. The escalation target is different: it is an explicit choice
  // naming one person, it cannot be silently repointed without overriding what
  // an admin decided, and the API refuses to save a target who is not a primary
  // (WORKFLOW_ESCALATION_TARGET_NOT_PRIMARY). Left unattended it becomes a
  // workflow that auto-escalates to someone with no rights over the ticket.
  //
  // A warning, never a block: the person may have left the company, and making
  // the roster hostage to a workflow deadlocks — a workflow with open tickets
  // cannot be deleted, so there would be no way out.
  const { data: categoryWorkflows } = useGetWorkflowsQuery(
    { category_id: editId ?? "", page_size: 100 },
    { skip: !editId },
  );
  // user_id -> the workflows that auto-escalate to them.
  const escalationTargetWorkflows = (categoryWorkflows?.items ?? []).reduce<
    Record<string, string[]>
  >((acc, wf) => {
    const target = wf.escalate_to_user_id;
    if (!target) return acc;
    const label = wf.request_type_name || wf.category_name || "a workflow";
    acc[target] = [...(acc[target] ?? []), label];
    return acc;
  }, {});
  const {
    data: businessUnits = [],
    isLoading: businessUnitsLoading,
    isError: businessUnitsError,
  } = useGetBusinessUnitsQuery({ is_active: true });
  const {
    data: departments = [],
    isLoading: departmentsLoading,
    isError: departmentsError,
  } = useGetDepartmentsQuery({ is_active: true });

  const businessUnitOptions = businessUnits
    .map((bu) => ({ label: bu.business_unit_name, value: bu.id }))
    .filter((o) => o.label && o.value);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<CategoryFormValues>({
    resolver: zodResolver(categorySchema),
    defaultValues: EMPTY_FORM,
  });

  const [populated, setPopulated] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState("");
  // Names/codes/department for roster members, keyed by user id. The form field
  // holds only {user_id, role} (what the API takes); this is what lets a
  // selected person keep rendering once the search moves them off the loaded
  // page, and what the department prune below reads.
  const [rosterMeta, setRosterMeta] = useState<Record<string, RosterMeta>>({});

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && isDirty) {
      setDiscardOpen(true);
    } else {
      onOpenChange(open);
    }
  }, [isDirty, onOpenChange]);

  // Always start from a blank form whenever the sheet opens/closes or the
  // target record changes — edit mode then re-populates in the effect below.
  useEffect(() => {
    reset(EMPTY_FORM);
    setPopulated(false);
    setRosterMeta({});
    setEmployeeSearch("");
  }, [open, editId, reset]);

  useEffect(() => {
    if (
      populated ||
      !open ||
      !editId ||
      !category ||
      // Ignore a cached result belonging to a previously opened category.
      category.id !== editId ||
      departmentsLoading ||
      businessUnitsLoading
    )
      return;
    // Tolerate a document saved before the list existed — the API still emits
    // the deprecated scalar for exactly this reason.
    const savedDepartmentIds = category.department_ids?.length
      ? category.department_ids
      : category.department_id
        ? [category.department_id]
        : [];
    reset({
      name: category.name,
      description: category.description,
      businessUnitId: category.business_unit_id ?? "",
      departmentIds: savedDepartmentIds,
      restrictedVisibility: category.restricted_visibility ?? false,
      // Home BU/depts are always-included implicitly, so keep only the extras.
      visibilityBusinessUnitIds: (category.visibility_business_unit_ids ?? []).filter(
        (id) => id !== category.business_unit_id,
      ),
      visibilityDepartmentIds: (category.visibility_department_ids ?? []).filter(
        (id) => !savedDepartmentIds.includes(id),
      ),
      // Every stored row loads, heads included — the roster is exactly what was
      // picked last time, so nothing is filtered out on the way in and nothing
      // is synthesised on the way out.
      executors: (category.executors ?? []).map((e) => ({
        user_id: e.user_id,
        role: e.role,
      })),
      status: category.status,
    });
    // Seed display metadata from the saved snapshot so roster members who are
    // not on the loaded employee page still render with a name.
    setRosterMeta(
      Object.fromEntries(
        (category.executors ?? []).map((e) => [
          e.user_id,
          {
            name: e.name,
            empCode: e.emp_code || "",
            departmentId: e.department_id ?? "",
            departmentName: e.department_name || "",
          },
        ]),
      ),
    );
    setPopulated(true);
  }, [category, departmentsLoading, businessUnitsLoading, populated, reset, open, editId]);

  const [createCategory, { isLoading: isCreating }] =
    useCreateCategoryMutation();
  const [updateCategory, { isLoading: isUpdating }] =
    useUpdateCategoryMutation();
  const isPending = isCreating || isUpdating;

  // ── Cascade: only departments that belong to the selected business unit ──
  const selectedBusinessUnitId = watch("businessUnitId");
  const departmentOptions = (
    selectedBusinessUnitId
      ? departments.filter((d) => d.businessUnits?.includes(selectedBusinessUnitId))
      : []
  )
    .map((d) => ({ label: deptLabel(d), value: d.id }))
    .filter((o) => o.label && o.value);

  // ── Selected departments — the employee pool for the roster ──────────────
  const selectedDepartmentIds = watch("departmentIds");
  const selectedDepartments = departments.filter((d) =>
    selectedDepartmentIds.includes(d.id),
  );
  const departmentNameById = new Map(
    departments.map((d) => [d.id, d.departmentName]),
  );
  // Short form for the compact identity pair on each row (ENG · EMP0142) — the
  // employee record itself carries only the department name.
  const departmentCodeById = new Map(
    departments.map((d) => [d.id, d.departmentCode]),
  );
  // Heads of the selected departments. They hold no special status in the
  // picker — this exists only so the list is complete: a head whose own
  // employee record sits in another department never comes back from the
  // employee sweep, and would otherwise be impossible to pick. Used to append
  // the missing ones (`offPageHeads`) and to label the row.
  const headUserIds = new Set(
    selectedDepartments.map((d) => d.departmentHead).filter(Boolean) as string[],
  );
  const headNameById = new Map(
    selectedDepartments
      .filter((d) => d.departmentHead)
      .map((d) => [d.departmentHead as string, d.departmentHeadName || ""]),
  );

  // ── Visibility scope (multi-select) ──────────────────────────────────────
  // The home business unit + department always have visibility, so they are
  // excluded from the pickers below — these only add *other* teams.
  const restrictedVisibility = watch("restrictedVisibility");
  const visibilityBuIds = watch("visibilityBusinessUnitIds");
  const homeBusinessUnitName =
    businessUnits.find((b) => b.id === selectedBusinessUnitId)?.business_unit_name ?? "";
  // Plain department names (no BU prefix) — the BU is shown as its own tag.
  const homeDepartmentNames = selectedDepartments.map((d) => d.departmentName);

  // Other business units (home one is implicit and always visible).
  const visibilityBusinessUnitOptions = businessUnitOptions.filter(
    (o) => o.value !== selectedBusinessUnitId,
  );

  // Departments offered are those belonging to *every* selected visibility BU
  // (the intersection), minus the home department which is already included.
  const visibilityDepartmentOptions = (
    visibilityBuIds.length
      ? departments.filter((d) =>
          visibilityBuIds.every((bu) => d.businessUnits?.includes(bu)),
        )
      : []
  )
    .map((d) => ({ label: deptLabel(d), value: d.id }))
    .filter(
      (o) => o.label && o.value && !selectedDepartmentIds.includes(o.value),
    );

  // Keep only departments still valid for the current set of visibility BUs.
  const pruneVisibilityDepartments = (buIds: string[]) =>
    watch("visibilityDepartmentIds").filter((id) => {
      const d = departments.find((x) => x.id === id);
      return !!d && buIds.every((bu) => d.businessUnits?.includes(bu));
    });

  // ── Employee list — one merged page across every selected department ─────
  const debouncedEmployeeSearch = useDebounce(employeeSearch.trim(), 300);

  // `currentData`, not `data`: RTK Query keeps `data` from the previous args
  // until the new request resolves, so switching or clearing departments would
  // keep rendering the old department's employees for a beat. `currentData` is
  // undefined the moment the args change, which hands the render to the
  // "Loading employees…" branch below instead of showing a stale list.
  const {
    currentData: employees,
    isFetching: employeesFetching,
    isError: employeesError,
  } = useGetEmployeesQuery(
    selectedDepartmentIds.length
      ? {
          department_ids: selectedDepartmentIds,
          limit: EMPLOYEE_PAGE_SIZE,
          search: debouncedEmployeeSearch || undefined,
        }
      : undefined,
    { skip: selectedDepartmentIds.length === 0 },
  );

  const fetchedEmployees: Employee[] = Array.isArray(employees)
    ? (employees as Employee[])
    : [];

  const formatEmployeeName = (e: Employee) => {
    const parts = [e.firstName, e.middleName, e.lastName].filter(Boolean);
    return parts.join(" ").trim() || e.workEmail || e.empCode || "—";
  };

  // ── Executor roster ───────────────────────────────────────────────────────
  // `executors` is the whole truth: every person the admin ticked, with the
  // role they were given. Nobody is added implicitly and nobody is filtered
  // out, so what the list shows is exactly what is stored and exactly what the
  // counts elsewhere in the app read back.
  const executors = watch("executors");
  const executorRoles = new Map(executors.map((e) => [e.user_id, e.role]));
  const primaryCount = executors.filter((e) => e.role === "primary").length;
  const secondaryCount = executors.filter((e) => e.role === "secondary").length;

  // Primaries at the top, then secondaries, then everyone still unpicked —
  // otherwise the people who hold the powers sit wherever IAM's paging happened
  // to put them. Ranked purely on what has been picked; a head who has not been
  // selected is just another unpicked employee.
  // sort() is stable, so IAM's ordering still shows through within a group.
  const executorRank = (userId: string) => {
    const role = executorRoles.get(userId);
    if (role === "primary") return 0;
    return role === "secondary" ? 1 : 2;
  };
  const employeeList = [...fetchedEmployees].sort(
    (a, b) => executorRank(a.userId) - executorRank(b.userId),
  );

  const setExecutors = (next: CategoryFormValues["executors"]) =>
    setValue("executors", next, { shouldValidate: true, shouldDirty: true });

  const rememberEmployee = (emp: Employee) =>
    setRosterMeta((prev) => ({
      ...prev,
      [emp.userId]: {
        name: formatEmployeeName(emp),
        empCode: emp.empCode || "",
        departmentId: emp.departmentId || "",
        departmentName: emp.departmentName || "",
      },
    }));

  // Tell the admin when the person they just removed is a workflow's
  // auto-escalation target. Fires on removal rather than on save so it lands
  // next to the action that caused it, while the roster is still in front of
  // them and the change is still undoable.
  const warnIfEscalationTarget = (userId: string) => {
    const affected = escalationTargetWorkflows[userId];
    if (!affected?.length) return;
    const name = rosterMeta[userId]?.name || "That person";
    toast.error(
      `${name} is the auto-escalation target on ${affected.length} workflow` +
        `${affected.length === 1 ? "" : "s"} (${affected.join(", ")}). ` +
        "Update the escalation target there, or those workflows will escalate " +
        "to someone with no rights over the ticket.",
    );
  };

  const toggleExecutor = (emp: Employee, checked: boolean) => {
    if (checked) {
      if (executors.length >= MAX_EXECUTORS) {
        toast.error(`At most ${MAX_EXECUTORS} executors can be assigned`);
        return;
      }
      rememberEmployee(emp);
      // Default to Secondary — being added to the roster shouldn't silently
      // hand someone the department head's powers.
      setExecutors([...executors, { user_id: emp.userId, role: "secondary" }]);
    } else {
      warnIfEscalationTarget(emp.userId);
      setExecutors(executors.filter((e) => e.user_id !== emp.userId));
    }
  };

  // A head listed from the department document rather than the employee sweep
  // (see `offPageHeads`): the same add as above, but all we hold is an id and a
  // name — the employee record that carries emp code and department is in
  // another department, or does not exist.
  const addHeadExecutor = (head: { userId: string; name: string }) => {
    if (executors.length >= MAX_EXECUTORS) {
      toast.error(`At most ${MAX_EXECUTORS} executors can be assigned`);
      return;
    }
    setRosterMeta((prev) => ({
      ...prev,
      [head.userId]: {
        name: head.name,
        empCode: "",
        departmentId: "",
        departmentName: "",
      },
    }));
    setExecutors([...executors, { user_id: head.userId, role: "secondary" }]);
  };

  const setExecutorRole = (userId: string, role: "primary" | "secondary") =>
    setExecutors(
      executors.map((e) => (e.user_id === userId ? { ...e, role } : e)),
    );

  // Selected people who are not in the current (searched) page, so a selection
  // never disappears just because the admin typed something.
  const offPageExecutors = executors.filter(
    (e) => !employeeList.some((emp) => emp.userId === e.user_id),
  );

  // Heads missing from the loaded page — either filtered out by the search, or
  // because their own employee record points at a different department. IAM
  // allows that: `Department.department_head` points into `users` and is never
  // checked against `Employee.department_id`, and one person can head two
  // departments while belonging to only one. Without this they would simply be
  // absent from the picker and could not be selected at all.
  //
  // Already-selected heads are excluded — they render under `offPageExecutors`
  // above, and listing them twice would let the two rows disagree.
  const offPageHeads = [...headUserIds]
    .filter(
      (id) =>
        !employeeList.some((emp) => emp.userId === id) &&
        !executors.some((e) => e.user_id === id),
    )
    .map((id) => ({ userId: id, name: headNameById.get(id) || id }));

  const clearRoster = () => {
    // Clearing removes everyone at once, so warn once for the whole set rather
    // than firing a separate toast per person.
    const affected = executors
      .map((e) => e.user_id)
      .filter((id) => escalationTargetWorkflows[id]?.length);
    if (affected.length) {
      const names = affected
        .map((id) => rosterMeta[id]?.name || id)
        .join(", ");
      toast.error(
        `${names} ${affected.length === 1 ? "is" : "are"} the auto-escalation ` +
          "target on workflows using this category. Update those workflows, or " +
          "they will escalate to someone with no rights over the ticket.",
      );
    }
    setExecutors([]);
    setRosterMeta({});
  };

  /**
   * Drop the roster members the removed departments contributed.
   *
   * Membership comes from `rosterMeta`, which records the department each
   * person was listed under. Someone who belongs to two of the selected
   * departments carries only one of them, so removing that one drops them even
   * though they would still be valid — deliberately the cautious direction:
   * the alternative is a save that fails validation on the server. The admin
   * is told how many went so it never looks like a glitch.
   */
  const pruneRosterForDepartments = (nextDepartmentIds: string[]) => {
    const kept = executors.filter((e) => {
      const deptId = rosterMeta[e.user_id]?.departmentId;
      // Unknown department (metadata lost across a reload) — keep them and let
      // the server have the final word.
      return !deptId || nextDepartmentIds.includes(deptId);
    });
    if (kept.length !== executors.length) {
      toast.info(
        `Removed ${executors.length - kept.length} executor${
          executors.length - kept.length === 1 ? "" : "s"
        } from the department you removed`,
      );
    }
    setExecutors(kept);
  };

  const handleDepartmentsChange = (next: string[]) => {
    setValue("departmentIds", next, {
      shouldValidate: true,
      shouldDirty: true,
    });
    setEmployeeSearch("");
    // Departments no longer offered as an *extra* visibility scope now that
    // they are part of the category's own set.
    setValue(
      "visibilityDepartmentIds",
      watch("visibilityDepartmentIds").filter((id) => !next.includes(id)),
      { shouldDirty: true, shouldValidate: true },
    );
    if (executors.length) pruneRosterForDepartments(next);
  };

  const toPayload = (data: CategoryFormValues): CategoryFormData => ({
    name: data.name,
    description: data.description ?? "",
    business_unit_id: data.businessUnitId,
    department_ids: data.departmentIds,
    restricted_visibility: data.restrictedVisibility,
    visibility_business_unit_ids: data.restrictedVisibility
      ? data.visibilityBusinessUnitIds
      : [],
    visibility_department_ids: data.restrictedVisibility
      ? data.visibilityDepartmentIds
      : [],
    executors: data.executors,
    // Meaningless without a roster, and the server drops it too — don't send a
    // lockdown that a later re-roster would silently inherit.
    // Always true when a roster exists: the roster is the whole pool now, and
    // the toggle that used to say otherwise is gone. Still sent so an older
    // backend (or a category re-saved from an older client) can't leave a
    // stored `false` widening the pool behind our back.
    roster_is_exclusive: data.executors.length > 0,
    status: data.status,
  });

  const onSubmit = async (data: CategoryFormValues) => {
    try {
      if (isEditing) {
        await updateCategory({ id: editId!, body: toPayload(data) }).unwrap();
        toast.success("Category updated");
      } else {
        await createCategory(toPayload(data)).unwrap();
        toast.success("Category created");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err, isEditing ? "Failed to update category" : "Failed to create category");
    }
  };

  const showLoadingState = isEditing && (isLoading || !populated);

  return (
    <>
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[520px] flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 py-5 border-b">
          <SheetTitle>
            {isEditing ? "Edit Category" : "Create Category"}
          </SheetTitle>
          <SheetDescription>
            {isEditing
              ? "Update the service ticket category details."
              : "Define a new service ticket category."}
          </SheetDescription>
        </SheetHeader>

        {showLoadingState ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="flex flex-1 flex-col overflow-hidden"
          >
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <div className="flex items-start gap-4">
                <div className="flex-1 space-y-2">
                  <Label htmlFor="name">
                    Category Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="name"
                    placeholder="e.g., IT Support"
                    maxLength={NAME_MAX}
                    className={`h-9 ${errors.name ? "border-destructive focus-visible:ring-destructive" : ""}`}
                    aria-invalid={errors.name ? "true" : undefined}
                    aria-describedby={errors.name ? "name-error" : "name-count"}
                    {...register("name")}
                  />
                  <div className="flex items-start justify-between gap-2">
                    {errors.name ? (
                      <p
                        id="name-error"
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
                      id="name-count"
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

                {isEditing && (
                  <div className="space-y-2">
                    <Label htmlFor="status-toggle">Status</Label>
                    <div className="flex h-9 items-center gap-2">
                      <Switch
                        id="status-toggle"
                        checked={watch("status") === "active"}
                        onCheckedChange={(checked) =>
                          setValue("status", checked ? "active" : "inactive", {
                            shouldDirty: true,
                          })
                        }
                        aria-label="Category status"
                      />
                      <Badge
                        variant={
                          watch("status") === "active" ? "default" : "secondary"
                        }
                      >
                        {watch("status") === "active" ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                  </div>
                )}
              </div>

              {/* Business Unit — cascade parent of Department */}
              <div className="space-y-2">
                <Label>
                  Business Unit <span className="text-destructive">*</span>
                </Label>
                <div
                  className={
                    errors.businessUnitId
                      ? "rounded-md ring-1 ring-destructive"
                      : ""
                  }
                  aria-invalid={errors.businessUnitId ? "true" : undefined}
                  aria-describedby={
                    errors.businessUnitId ? "businessUnitId-error" : undefined
                  }
                >
                  <SearchableSelect
                    options={businessUnitOptions}
                    value={watch("businessUnitId")}
                    onChange={(val) => {
                      setValue("businessUnitId", val as string, {
                        shouldValidate: true,
                        shouldDirty: true,
                      });
                      // Departments belong to the BU, so both they and the
                      // roster built from them go with it.
                      handleDepartmentsChange([]);
                      clearRoster();
                    }}
                    placeholder={
                      businessUnitsLoading
                        ? "Loading..."
                        : businessUnitsError
                        ? "Failed to load business units"
                        : businessUnitOptions.length === 0
                        ? "No business units available"
                        : "Select Business Unit"
                    }
                    disabled={
                      businessUnitsLoading ||
                      businessUnitsError ||
                      businessUnitOptions.length === 0
                    }
                  />
                </div>
                {errors.businessUnitId && (
                  <p
                    id="businessUnitId-error"
                    role="alert"
                    className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                  >
                    <AlertCircle className="size-3.5 shrink-0" />
                    {errors.businessUnitId.message}
                  </p>
                )}
                {businessUnitsError && (
                  <p className="text-sm text-destructive">
                    Couldn't load business units. Please try again.
                  </p>
                )}
              </div>

              {/* Executors. The department filter lives inside this box: it
                  scopes the employee list directly below it, and is also what
                  gets saved as the category's departments. */}
              <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Executors
                      {executors.length > 0 && (
                        <span className="ml-1 tabular-nums">
                          ({primaryCount} primary · {secondaryCount} secondary)
                        </span>
                      )}
                    </p>
                    {executors.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={clearRoster}
                      >
                        Clear all
                      </Button>
                    )}
                  </div>
                  {errors.executors && (
                    <p
                      id="executors-error"
                      role="alert"
                      className="flex items-start gap-1.5 text-sm font-medium text-destructive"
                    >
                      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                      {errors.executors.message}
                    </p>
                  )}
                  {/* Was "Leave empty to keep the department heads in charge",
                      which described the removed D3 behaviour: heads no longer
                      hold category powers implicitly, and an empty roster now
                      blocks ticket creation outright rather than falling back
                      to anyone. */}
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Primaries assign, reassign and receive escalations;
                    secondaries work tickets. At least one primary is required —
                    a category with none cannot accept tickets. To give a
                    department head these powers, select them here like anyone
                    else.
                  </p>

                  <div className="space-y-1.5 pt-1">
                    <Label>
                      Filter Department{" "}
                      <span className="text-destructive">*</span>
                    </Label>
                    <div
                      className={
                        errors.departmentIds
                          ? "rounded-md ring-1 ring-destructive"
                          : ""
                      }
                      aria-invalid={errors.departmentIds ? "true" : undefined}
                      aria-describedby={
                        errors.departmentIds ? "departmentIds-error" : undefined
                      }
                    >
                      <SearchableSelect
                        multi
                        options={departmentOptions}
                        value={selectedDepartmentIds}
                        onChange={(val) =>
                          handleDepartmentsChange(val as string[])
                        }
                        placeholder={
                          !selectedBusinessUnitId
                            ? "Select a business unit first"
                            : departmentsLoading
                            ? "Loading..."
                            : departmentsError
                            ? "Failed to load departments"
                            : departmentOptions.length === 0
                            ? "No departments in this business unit"
                            : "Select Departments"
                        }
                        disabled={
                          !selectedBusinessUnitId ||
                          departmentsLoading ||
                          departmentsError ||
                          departmentOptions.length === 0
                        }
                      />
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Scopes the employee list below, and is saved as the
                      departments this category is staffed from.
                    </p>
                    {errors.departmentIds && (
                      <p
                        id="departmentIds-error"
                        role="alert"
                        className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                      >
                        <AlertCircle className="size-3.5 shrink-0" />
                        {errors.departmentIds.message}
                      </p>
                    )}
                  </div>

                    {selectedDepartmentIds.length > 0 && (
                      <Input
                        value={employeeSearch}
                        onChange={(e) => setEmployeeSearch(e.target.value)}
                        placeholder="Search employees…"
                        className="h-9"
                        aria-label="Search employees"
                      />
                    )}

                    <div className="max-h-64 overflow-y-auto rounded-md border bg-background">
                      {offPageHeads.length > 0 && (
                        <ul className="divide-y border-b">
                          {offPageHeads.map((head) => (
                            <li
                              key={head.userId}
                              className="flex items-center gap-3 px-3 py-2"
                            >
                              <Checkbox
                                checked={false}
                                onCheckedChange={(v) =>
                                  v === true && addHeadExecutor(head)
                                }
                                aria-label={`Select ${head.name}`}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-foreground">
                                  {head.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Department head
                                </p>
                              </div>
                              <RoleChoice
                                userId={head.userId}
                                role={undefined}
                                onChange={setExecutorRole}
                              />
                            </li>
                          ))}
                        </ul>
                      )}

                      {offPageExecutors.length > 0 && (
                        <div className="border-b bg-muted/40">
                          <p className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            Selected ({offPageExecutors.length} not shown below)
                          </p>
                          <ul className="divide-y">
                            {offPageExecutors.map((sel) => {
                              const meta = rosterMeta[sel.user_id];
                              return (
                                <li
                                  key={sel.user_id}
                                  className="flex items-center gap-3 px-3 py-2"
                                >
                                  <Checkbox
                                    checked
                                    onCheckedChange={() =>
                                      setExecutors(
                                        executors.filter(
                                          (e) => e.user_id !== sel.user_id,
                                        ),
                                      )
                                    }
                                    aria-label={`Remove ${meta?.name || sel.user_id}`}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-foreground">
                                      {meta?.name || sel.user_id}
                                    </p>
                                    {(meta?.empCode ||
                                      meta?.departmentName) && (
                                      <p className="truncate text-xs text-muted-foreground">
                                        {[
                                          meta?.departmentName ||
                                            departmentNameById.get(
                                              meta?.departmentId ?? "",
                                            ),
                                          meta?.empCode,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </p>
                                    )}
                                  </div>
                                  <RoleChoice
                                    userId={sel.user_id}
                                    role={sel.role}
                                    onChange={setExecutorRole}
                                  />
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}

                      {employeesFetching ? (
                        <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                          <Loader2 className="animate-spin" />
                          Loading employees…
                        </div>
                      ) : employeesError ? (
                        <p className="px-3 py-2 text-xs text-destructive">
                          Couldn't load employees for these departments.
                        </p>
                      ) : employeeList.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          {selectedDepartmentIds.length === 0
                            ? "Pick a department above to list its employees."
                            : debouncedEmployeeSearch
                            ? "No employees match this search."
                            : "No employees in these departments."}
                        </p>
                      ) : (
                        <ul className="divide-y">
                          {employeeList.map((emp) => {
                            // The department head is an ordinary row: whoever
                            // the admin ticks is who gets stored, heads
                            // included. `isHead` survives only as a label, so a
                            // list merged across departments still says who
                            // leads which one.
                            const isHead = headUserIds.has(emp.userId);
                            const role = executorRoles.get(emp.userId);
                            const checked = role !== undefined;
                            return (
                              <li
                                key={emp.id}
                                className="flex items-center gap-3 px-3 py-2"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(v) =>
                                    toggleExecutor(emp, v === true)
                                  }
                                  aria-label={`Select ${formatEmployeeName(emp)}`}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                      <span className="truncate text-sm font-medium text-foreground">
                                        {formatEmployeeName(emp)}
                                      </span>
                                    </span>
                                    {/* Department code + employee code — the
                                        compact pair that identifies someone in
                                        a list merged across departments. */}
                                    {(emp.empCode ||
                                      departmentCodeById.get(
                                        emp.departmentId,
                                      )) && (
                                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                        {[
                                          departmentCodeById.get(
                                            emp.departmentId,
                                          ),
                                          emp.empCode,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </span>
                                    )}
                                  </div>
                                  {/* Department first — with several of them
                                      merged into one list it is what tells two
                                      similarly-named people apart. */}
                                  <div className="truncate text-xs text-muted-foreground">
                                    {[
                                      emp.departmentName ||
                                        departmentNameById.get(emp.departmentId),
                                      isHead ? "Department head" : null,
                                      emp.designationName,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </div>
                                </div>
                                <RoleChoice
                                  userId={emp.userId}
                                  role={role}
                                  onChange={setExecutorRole}
                                />
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                    {employeeList.length >= EMPLOYEE_PAGE_SIZE && (
                      <p className="text-xs text-muted-foreground">
                        Showing the first {EMPLOYEE_PAGE_SIZE} across the
                        selected departments. Use search to find others.
                      </p>
                    )}
                    {/* The executors error is rendered once, at the top of the
                        roster section (`id="executors-error"`). It was repeated
                        here at the foot of the employee picker, so a category
                        saved with no primary showed the same sentence twice. */}
                  </div>


                  {/* The "Only the roster may work this category" toggle used
                      to live here, defaulting to Off — which meant anyone in the
                      selected departments could pick up a ticket alongside the
                      roster. The roster is the authoritative answer to who works
                      a category now, so a switch whose default silently widened
                      the pool past the people an admin picked contradicted the
                      rest of the model. Removed; the API still accepts the field
                      for back-compat but no longer reads it. */}
                  {executors.length > 0 && (
                    <p className="border-t pt-3 text-xs text-muted-foreground leading-relaxed">
                      Only the people selected above can work this category's
                      tickets. Select a new joiner here to let them pick one up.
                    </p>
                  )}
                </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="restrict-toggle">
                      Restrict visibility
                    </Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Limits this category to the selected business units and
                      departments below. Only people in those teams can see it
                      or raise tickets for it.
                    </p>
                    {restrictedVisibility &&
                      homeBusinessUnitName &&
                      homeDepartmentNames.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            This category is always visible to its own business
                            unit and departments (below). Use the lists to add
                            any other teams that should also have access.
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary" className="gap-1.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                BU
                              </span>
                              {homeBusinessUnitName}
                            </Badge>
                            {homeDepartmentNames.map((name) => (
                              <Badge
                                key={name}
                                variant="secondary"
                                className="gap-1.5"
                              >
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  Dept
                                </span>
                                {name}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                  <Switch
                    id="restrict-toggle"
                    checked={restrictedVisibility}
                    onCheckedChange={(checked) =>
                      setValue("restrictedVisibility", checked, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    aria-label="Restrict category visibility"
                  />
                </div>

                {restrictedVisibility && (
                  <div className="space-y-4 rounded-xl border bg-muted/30 p-3">
                    {/* Also visible to — other Business Units (multi) */}
                    <div className="space-y-2">
                      <Label>Also visible to Business Units</Label>
                      <SearchableSelect
                        multi
                        options={visibilityBusinessUnitOptions}
                        value={visibilityBuIds}
                        onChange={(val) => {
                          const next = val as string[];
                          setValue("visibilityBusinessUnitIds", next, {
                            shouldDirty: true,
                            shouldValidate: true,
                          });
                          // Drop departments no longer common to all BUs.
                          setValue(
                            "visibilityDepartmentIds",
                            pruneVisibilityDepartments(next),
                            { shouldDirty: true, shouldValidate: true },
                          );
                        }}
                        placeholder={
                          businessUnitsLoading
                            ? "Loading..."
                            : businessUnitsError
                            ? "Failed to load business units"
                            : visibilityBusinessUnitOptions.length === 0
                            ? "No other business units"
                            : "Add business units"
                        }
                        disabled={
                          businessUnitsLoading ||
                          businessUnitsError ||
                          visibilityBusinessUnitOptions.length === 0
                        }
                      />
                    </div>

                    {/* Also visible to — other Departments (multi, filtered by BUs) */}
                    <div className="space-y-2">
                      <Label>Also visible to Departments</Label>
                      <SearchableSelect
                        multi
                        options={visibilityDepartmentOptions}
                        value={watch("visibilityDepartmentIds")}
                        onChange={(val) =>
                          setValue(
                            "visibilityDepartmentIds",
                            val as string[],
                            { shouldDirty: true, shouldValidate: true },
                          )
                        }
                        placeholder={
                          visibilityBuIds.length === 0
                            ? "Add other business units first"
                            : departmentsLoading
                            ? "Loading..."
                            : departmentsError
                            ? "Failed to load departments"
                            : visibilityDepartmentOptions.length === 0
                            ? "No other departments common to the selected business units"
                            : "Add departments"
                        }
                        disabled={
                          visibilityBuIds.length === 0 ||
                          departmentsLoading ||
                          departmentsError ||
                          visibilityDepartmentOptions.length === 0
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Brief description of this category..."
                  maxLength={DESCRIPTION_MAX}
                  className={`resize-none min-h-[80px] ${
                    errors.description
                      ? "border-destructive focus-visible:ring-destructive"
                      : ""
                  }`}
                  aria-invalid={errors.description ? "true" : undefined}
                  aria-describedby={
                    errors.description ? "description-error" : "description-count"
                  }
                  {...register("description")}
                />
                <div className="flex items-start justify-between gap-2">
                  {errors.description ? (
                    <p
                      id="description-error"
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
                    id="description-count"
                    className={`shrink-0 text-xs tabular-nums ${
                      (watch("description")?.length ?? 0) > DESCRIPTION_MAX
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {watch("description")?.length ?? 0}/{DESCRIPTION_MAX}
                  </span>
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
              <Button
                type="submit"
                variant="soft"
                disabled={isPending || (!isDirty && isEditing)}
              >
                {isPending && (
                  <Loader2 className="animate-spin" />
                )}
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
