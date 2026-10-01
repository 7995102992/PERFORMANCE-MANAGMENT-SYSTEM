import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import { Calendar as CalendarIcon, Trash2 } from "lucide-react";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
} from "@/store/api/iamApi";
import {
  useCreateHolidayMutation,
  useUpdateHolidayMutation,
  useDeleteHolidayMutation,
  useGetHolidaysQuery,
  useGetHolidayPlanQuery,
  useGetClassificationsQuery,
} from "@/store/api/lmsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import { PageLoader } from "@/components/shared/PageLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";

interface FormValues {
  name: string;
  date: Date | undefined;
  classification: string;
  businessUnitIds: string[];
  departmentIds: string[];
  description: string;
  reminderDays: string;
  notifyEmployees: boolean;
  reprocessLeaves: boolean;
}

interface ValidateContext {
  planBuIds: string[];
  planDeptIds: string[];
}

function validate(
  v: FormValues,
  ctx: ValidateContext,
): Partial<Record<keyof FormValues, string>> {
  const errs: Partial<Record<keyof FormValues, string>> = {};
  if (!v.name.trim()) errs.name = "Holiday name is required";
  else if (v.name.trim().length > 100)
    errs.name = "Holiday name must be 100 characters or less";
  if (!v.date) errs.date = "Date is required";
  if (!v.classification) errs.classification = "Classification is required";
  if (v.businessUnitIds.length === 0)
    errs.businessUnitIds = "Select at least one business unit";
  else if (ctx.planBuIds.length > 0) {
    const outOfScope = v.businessUnitIds.filter(
      (id) => !ctx.planBuIds.includes(id),
    );
    if (outOfScope.length > 0) {
      errs.businessUnitIds =
        "Some business units are not part of the holiday plan";
    }
  }
  if (v.departmentIds.length === 0)
    errs.departmentIds = "Select at least one department";
  else if (ctx.planDeptIds.length > 0) {
    const outOfScope = v.departmentIds.filter(
      (id) => !ctx.planDeptIds.includes(id),
    );
    if (outOfScope.length > 0) {
      errs.departmentIds = "Some departments are not part of the holiday plan";
    }
  }
  return errs;
}

interface Props {
  mode: "create" | "edit";
  embeddedPlanId?: string;
  embeddedHolidayId?: string;
  onClose?: () => void;
}

const HolidayForm = ({
  mode,
  embeddedPlanId,
  embeddedHolidayId,
  onClose,
}: Props) => {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const routeParams = useParams({ strict: false }) as {
    planId?: string;
    holidayId?: string;
  };
  const planId = embeddedPlanId ?? routeParams.planId!;
  const holidayId = embeddedHolidayId ?? routeParams.holidayId;
  const confirm = useConfirm();
  const scrollToError = useScrollToError();

  const [values, setValues] = useState<FormValues>({
    name: "",
    date: undefined,
    classification: "",
    businessUnitIds: [],
    departmentIds: [],
    description: "",
    reminderDays: "0",
    notifyEmployees: true,
    reprocessLeaves: true,
  });
  const [touched, setTouched] = useState<
    Partial<Record<keyof FormValues, boolean>>
  >({});
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [initialValues, setInitialValues] = useState<FormValues | null>(null);

  const { data: planData, isLoading: isLoadingPlan } = useGetHolidayPlanQuery(
    planId,
    { skip: !planId },
  );
  const { data: busData = [] } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptsData = [] } = useGetDepartmentsQuery({ is_active: true });
  const { data: holidaysData, isLoading: isLoadingHolidays } =
    useGetHolidaysQuery({ planId }, { skip: !planId });

  const [createHoliday, createResult] = useCreateHolidayMutation();
  const [updateHoliday, updateResult] = useUpdateHolidayMutation();
  const [deleteHoliday] = useDeleteHolidayMutation();
  const { data: classificationsData = [] } = useGetClassificationsQuery();

  const isSaving = createResult.isLoading || updateResult.isLoading;
  const planYear = planData?.year;

  // Holiday plans store BUs + depts as embedded arrays. Extract the IDs so we
  // can scope the holiday's applicability to whatever the plan covers — picking
  // a BU or dept outside the plan would create unreachable holidays.
  const planBuIds = useMemo<string[]>(
    () =>
      ((planData as any)?.business_units ?? []).map(
        (bu: any) => bu.id ?? bu._id ?? bu,
      ) as string[],
    [planData],
  );
  const planDeptIds = useMemo<string[]>(
    () =>
      ((planData as any)?.departments ?? []).map(
        (d: any) => d.id ?? d._id ?? d,
      ) as string[],
    [planData],
  );

  const buOptions = useMemo<Option[]>(
    () =>
      busData
        .filter((bu) => planBuIds.length === 0 || planBuIds.includes(bu.id))
        .map((bu) => ({ label: bu.business_unit_name, value: bu.id })),
    [busData, planBuIds],
  );

  const deptOptions = useMemo<Option[]>(() => {
    if (values.businessUnitIds.length === 0) return [];
    return deptsData
      .filter((d) =>
        d.businessUnits?.some((bu: string) =>
          values.businessUnitIds.includes(bu),
        ),
      )
      .filter((d) => planDeptIds.length === 0 || planDeptIds.includes(d.id))
      .map((d) => ({ label: deptLabel(d), value: d.id }));
  }, [deptsData, values.businessUnitIds, planDeptIds]);

  const classificationOptions = useMemo<Option[]>(
    () =>
      classificationsData.map((c) => ({ label: c.name, value: c.id ?? c._id })),
    [classificationsData],
  );

  useEffect(() => {
    if (mode !== "create" || values.businessUnitIds.length > 0) return;
    if (planBuIds.length > 0) {
      setValues((v) => ({
        ...v,
        businessUnitIds: planBuIds,
        departmentIds: [],
      }));
    } else if (buOptions.length === 1) {
      setValues((v) => ({
        ...v,
        businessUnitIds: [buOptions[0].value],
        departmentIds: [],
      }));
    }
  }, [mode, buOptions, planBuIds, values.businessUnitIds.length]);

  useEffect(() => {
    if (mode !== "create" || values.departmentIds.length > 0) return;
    if (planDeptIds.length > 0) {
      setValues((v) => ({ ...v, departmentIds: planDeptIds }));
    } else if (deptOptions.length === 1) {
      setValues((v) => ({ ...v, departmentIds: [deptOptions[0].value] }));
    }
  }, [mode, deptOptions, planDeptIds, values.departmentIds.length]);

  const dateFromLimit = planYear ? new Date(planYear, 0, 1) : undefined;
  const dateToLimit = planYear ? new Date(planYear, 11, 31) : undefined;

  useEffect(() => {
    if (mode === "create") {
      dispatch(setBreadcrumbDetail("Add Holiday"));
    }
  }, [mode, dispatch]);

  useEffect(
    () => () => {
      dispatch(setBreadcrumbDetail(null));
    },
    [dispatch],
  );

  useEffect(() => {
    if (mode !== "edit" || !holidayId || !holidaysData || initialized) return;
    const holiday = holidaysData.items.find((h) => h._id === holidayId);
    if (!holiday) return;
    let parsedDate: Date | undefined;
    if (holiday.date) {
      const [y, m, d] = holiday.date.split("-").map(Number);
      parsedDate = new Date(y, m - 1, d);
    }
    const buIds =
      holiday.business_unit_ids ??
      ((holiday as any).business_unit_id
        ? [(holiday as any).business_unit_id]
        : []);
    const loaded: FormValues = {
      name: holiday.name,
      date: parsedDate,
      classification: holiday.classification?.id ?? "",
      businessUnitIds: buIds,
      departmentIds: holiday.applicable_department_ids ?? [],
      description: holiday.description ?? "",
      reminderDays: String(holiday.reminder?.days_before ?? 0),
      notifyEmployees: holiday.notify_employees ?? true,
      reprocessLeaves: holiday.reprocess_leaves ?? true,
    };
    setValues(loaded);
    setInitialValues(loaded);
    setInitialized(true);
    dispatch(setBreadcrumbDetail(holiday.name));
  }, [mode, holidayId, holidaysData, initialized]);

  const isDirty =
    mode === "create"
      ? values.name.trim() !== "" ||
        values.date !== undefined ||
        values.classification !== "" ||
        values.departmentIds.length > 0
      : initialValues != null &&
        (values.name !== initialValues.name ||
          values.date?.getTime() !== initialValues.date?.getTime() ||
          values.classification !== initialValues.classification ||
          JSON.stringify(values.businessUnitIds) !==
            JSON.stringify(initialValues.businessUnitIds) ||
          JSON.stringify(values.departmentIds) !==
            JSON.stringify(initialValues.departmentIds) ||
          values.description !== initialValues.description ||
          values.reminderDays !== initialValues.reminderDays ||
          values.notifyEmployees !== initialValues.notifyEmployees ||
          values.reprocessLeaves !== initialValues.reprocessLeaves);

  const errors = validate(values, { planBuIds, planDeptIds });
  const touch = (field: keyof FormValues) =>
    setTouched((t) => ({ ...t, [field]: true }));
  const fieldError = (field: keyof FormValues) =>
    touched[field] ? errors[field] : undefined;

  const releaseNavigationGuard = useNavigationGuard(isDirty);

  const handleCancel = () => {
    if (isDirty) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to leave?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: () => {
          releaseNavigationGuard();
          onClose
            ? onClose()
            : navigate({ to: "/leave-management/holiday-calendar" });
        },
      });
    } else {
      onClose
        ? onClose()
        : navigate({ to: "/leave-management/holiday-calendar" });
    }
  };

  const handleDelete = () => {
    if (!holidayId) return;
    confirm({
      title: `Delete "${values.name}"?`,
      description:
        "Applicable employees will no longer see this holiday in their calendar. This action cannot be undone.",
      variant: "destructive",
      confirmText: "Delete",
      onConfirm: async () => {
        try {
          await deleteHoliday(holidayId).unwrap();
          toast.success("Holiday deleted");
          releaseNavigationGuard();
          onClose
            ? onClose()
            : navigate({ to: "/leave-management/holiday-calendar" });
        } catch (err) {
          toast.error(err, "Failed to delete holiday");
        }
      },
    });
  };

  const handleSave = () => {
    setTouched({
      name: true,
      date: true,
      classification: true,
      businessUnitIds: true,
      departmentIds: true,
    });
    if (Object.keys(errors).length > 0) {
      toast.error("Please fill all required fields");
      requestAnimationFrame(() => scrollToError());
      return;
    }

    const action = mode === "create" ? "Create" : "Update";
    confirm({
      title: `${action} Holiday?`,
      description: `Are you sure you want to ${action.toLowerCase()} "${values.name}"?`,
      confirmText: action,
      onConfirm: async () => {
        try {
          if (mode === "create") {
            const dateStr = values.date
              ? `${values.date.getFullYear()}-${String(values.date.getMonth() + 1).padStart(2, "0")}-${String(values.date.getDate()).padStart(2, "0")}`
              : "";
            const days = Number(values.reminderDays);
            await createHoliday({
              plan_id: planId,
              name: values.name.trim(),
              date: dateStr,
              classification_id: values.classification,
              business_unit_ids: values.businessUnitIds,
              applicable_department_ids: values.departmentIds,
              reminder: { enabled: days > 0, days_before: days },
              description: values.description.trim() || null,
              notify_employees: values.notifyEmployees,
              reprocess_leaves: values.reprocessLeaves,
            }).unwrap();
            toast.success("Holiday created successfully");
          } else {
            const days = Number(values.reminderDays);
            await updateHoliday({
              id: holidayId!,
              body: {
                name: values.name.trim(),
                classification_id: values.classification,
                business_unit_ids: values.businessUnitIds,
                applicable_department_ids: values.departmentIds,
                reminder: { enabled: days > 0, days_before: days },
                description: values.description.trim() || null,
                notify_employees: values.notifyEmployees,
                reprocess_leaves: values.reprocessLeaves,
              },
            }).unwrap();
            toast.success("Holiday updated successfully");
          }
          releaseNavigationGuard();
          onClose
            ? onClose()
            : navigate({ to: "/leave-management/holiday-calendar" });
        } catch (err) {
          toast.error(
            err,
            `Failed to ${mode === "create" ? "create" : "update"} holiday`,
          );
        }
      },
    });
  };

  if (isLoadingPlan || (mode === "edit" && isLoadingHolidays))
    return <PageLoader message="Loading…" />;

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">
          {mode === "edit" ? "Edit Holiday" : "Add Holiday"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {planData?.name && (
            <>
              For{" "}
              <span className="font-medium text-foreground">
                {planData.name}
              </span>{" "}
              ({planYear})
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-6 mb-6 items-start">
        {/* LEFT — Holiday Details */}
        <Card>
          <CardContent className="space-y-6">
            <div className="space-y-1 border-b pb-4">
              <h3 className="text-base font-semibold">Holiday Details</h3>
              <p className="text-sm text-muted-foreground">
                Basic information about the holiday.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              <Field data-invalid={!!fieldError("name")}>
                <FieldLabel>
                  Holiday Name <span className="text-destructive">*</span>
                </FieldLabel>
                <Input
                  value={values.name}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, name: e.target.value }))
                  }
                  onBlur={() => touch("name")}
                  placeholder="Enter holiday name (e.g., Diwali)"
                  aria-invalid={!!fieldError("name")}
                />
                {fieldError("name") && (
                  <FieldError errors={[{ message: fieldError("name") }]} />
                )}
              </Field>

              <Field data-invalid={!!fieldError("date")}>
                <FieldLabel>
                  Date <span className="text-destructive">*</span>
                </FieldLabel>
                <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      disabled={mode === "edit" || !planYear}
                      className="w-full justify-start text-left font-normal"
                      onClick={() => touch("date")}
                    >
                      <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                      {values.date ? (
                        values.date
                          .toLocaleDateString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })
                          .replace(/ /g, "-")
                      ) : (
                        <span className="text-muted-foreground">
                          Pick a date
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    {dateFromLimit && dateToLimit && (
                      <Calendar
                        mode="single"
                        selected={values.date}
                        onSelect={(date) => {
                          setValues((v) => ({ ...v, date }));
                          setIsCalendarOpen(false);
                          touch("date");
                        }}
                        defaultMonth={dateFromLimit}
                        fromMonth={dateFromLimit}
                        toMonth={dateToLimit}
                        fromDate={dateFromLimit}
                        toDate={dateToLimit}
                        initialFocus
                      />
                    )}
                  </PopoverContent>
                </Popover>
                {fieldError("date") && (
                  <FieldError errors={[{ message: fieldError("date") }]} />
                )}
                {!fieldError("date") && planYear && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Only dates in {planYear}
                  </p>
                )}
              </Field>

              <Field data-invalid={!!fieldError("classification")}>
                <FieldLabel>
                  Classification <span className="text-destructive">*</span>
                </FieldLabel>
                <SearchableSelect
                  options={classificationOptions}
                  value={values.classification}
                  onChange={(val) => {
                    const cls: string = val as string;
                    setValues((v) => ({ ...v, classification: cls }));
                    touch("classification");
                  }}
                  placeholder="Select classification"
                  searchable={false}
                />
                {fieldError("classification") && (
                  <FieldError
                    errors={[{ message: fieldError("classification") }]}
                  />
                )}
              </Field>

              <div className="sm:col-span-2">
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea
                    value={values.description}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, description: e.target.value }))
                    }
                    placeholder="Add any additional notes about this holiday"
                    rows={3}
                    className="resize-none"
                  />
                </Field>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* RIGHT — Applicability + Reminder stacked */}
        <div className="space-y-6">
          {/* Applicability */}
          <Card>
            <CardContent className="space-y-6">
              <div className="space-y-1 border-b pb-4">
                <h3 className="text-base font-semibold">Applicability</h3>
                <p className="text-sm text-muted-foreground">
                  Business unit and departments this holiday applies to.
                </p>
              </div>

              <Field data-invalid={!!fieldError("businessUnitIds")}>
                <FieldLabel>
                  Business Units <span className="text-destructive">*</span>
                </FieldLabel>
                <SearchableSelect
                  multi
                  options={buOptions}
                  value={values.businessUnitIds}
                  onChange={(vals) => {
                    const buIds: string[] = vals as string[];
                    setValues((v) => ({
                      ...v,
                      businessUnitIds: buIds,
                      departmentIds: [],
                    }));
                    touch("businessUnitIds");
                  }}
                  placeholder="Select business units"
                  searchable={buOptions.length > 5}
                />
                {fieldError("businessUnitIds") && (
                  <FieldError
                    errors={[{ message: fieldError("businessUnitIds") }]}
                  />
                )}
              </Field>

              <Field data-invalid={!!fieldError("departmentIds")}>
                <FieldLabel>
                  Departments <span className="text-destructive">*</span>
                </FieldLabel>
                <SearchableSelect
                  multi
                  options={deptOptions}
                  value={values.departmentIds}
                  onChange={(vals) => {
                    const deptIds: string[] = vals as string[];
                    setValues((v) => ({ ...v, departmentIds: deptIds }));
                    touch("departmentIds");
                  }}
                  placeholder={
                    values.businessUnitIds.length > 0
                      ? "Search departments…"
                      : "Select a business unit first…"
                  }
                  disabled={values.businessUnitIds.length === 0}
                  emptyMessage="No departments available."
                />
                {fieldError("departmentIds") && (
                  <FieldError
                    errors={[{ message: fieldError("departmentIds") }]}
                  />
                )}
              </Field>
            </CardContent>
          </Card>

          {/* Reminder & Notifications */}
          {
            <Card>
              <CardContent className="space-y-6">
                <div className="space-y-1 border-b pb-4">
                  <h3 className="text-base font-semibold">
                    Reminder & Notifications
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Email reminders and notification preferences.
                  </p>
                </div>

                <Field>
                  <FieldLabel>Reminder Email</FieldLabel>
                  <SearchableSelect
                    options={[
                      { label: "No reminder", value: "0" },
                      { label: "1 day before", value: "1" },
                      { label: "2 days before", value: "2" },
                      { label: "3 days before", value: "3" },
                      { label: "1 week before", value: "7" },
                    ]}
                    value={values.reminderDays}
                    onChange={(val) => {
                      const days: string = val as string;
                      setValues((v) => ({ ...v, reminderDays: days }));
                    }}
                    placeholder="Select reminder"
                    searchable={false}
                  />
                </Field>

                <div className="space-y-3">
                  <FieldLabel>Notification Options</FieldLabel>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      className="mt-0.5"
                      checked={values.notifyEmployees}
                      onCheckedChange={(checked) =>
                        setValues((v) => ({ ...v, notifyEmployees: !!checked }))
                      }
                    />
                    <span className="text-sm font-medium">
                      Notify applicable employees
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      className="mt-0.5"
                      checked={values.reprocessLeaves}
                      onCheckedChange={(checked) =>
                        setValues((v) => ({ ...v, reprocessLeaves: !!checked }))
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        Reprocess leave applications
                      </span>
                      <span className="text-xs text-muted-foreground mt-0.5">
                        Leaves already applied for this holiday will be
                        reprocessed and balance adjusted.
                      </span>
                    </div>
                  </label>
                </div>
              </CardContent>
            </Card>
          }
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
        {mode === "edit" && (
          <Button
            variant="destructive"
            className="gap-1.5"
            onClick={handleDelete}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        )}
        <Button variant="soft" onClick={handleSave} disabled={isSaving}>
          {isSaving
            ? "Saving…"
            : mode === "edit"
              ? "Update Holiday"
              : "Save Holiday"}
        </Button>
      </div>
    </div>
  );
};

export default HolidayForm;
