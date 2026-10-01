import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2,
  Save,
  Plus,
  Trash2,
  AlertTriangle,
  User,
  Search,
  X,
  Clock,
  SendHorizonal,
  ShieldCheck,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  useGetTimesheetSettingsQuery,
  useUpdateHourSettingsMutation,
  useUpdateSubmissionSettingsMutation,
  useUpdateApprovalSettingsMutation,
  useGetSettingsEmploymentTypesQuery,
} from "@/store/api/timesheetApi";
import { PageHeader } from "@/components/shared/PageHeader";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { toast } from "@/lib/toast";
import { useGetEmployeesQuery } from "@/store/api/iamApi";
import type { EmployeeCompact } from "@/store/api/iamApi";
import { useAppSelector } from "@/store";
import type {
  HourSettingsUpdate,
  SubmissionSettingsUpdate,
  ApprovalLevelInput,
} from "@/types/timesheet";
import type { EmployeeReminderDays } from "@/types/timesheet";

const REMINDER_DAYS: { key: keyof EmployeeReminderDays; label: string }[] = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

/** 1 → "1st", 22 → "22nd". Keeps the cutoff hint reading like a date. */
const ordinal = (n: number): string => {
  if (!Number.isFinite(n)) return String(n);
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
};

const EMPTY_REMINDER_DAYS: EmployeeReminderDays = {
  monday: false,
  tuesday: false,
  wednesday: false,
  thursday: false,
  friday: false,
  saturday: false,
  sunday: false,
};

function EmployeeSearchField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const user = useAppSelector((s) => s.auth.user);
  const orgId = user?.organisation_id ?? "";

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: employees, isFetching } = useGetEmployeesQuery(
    {
      search: debouncedSearch,
      limit: 20,
      ...(orgId ? { organisation_id: orgId } : {}),
    },
    { skip: debouncedSearch.length < 2 },
  );

  const { data: allEmployees } = useGetEmployeesQuery({
    limit: 100,
    ...(orgId ? { organisation_id: orgId } : {}),
  });

  const empMap = new Map<string, EmployeeCompact>();
  (allEmployees ?? []).forEach((e) => {
    empMap.set(e.id, e);
    if (e.user_id) empMap.set(e.user_id, e);
  });

  const selectedEmployee = value ? (empMap.get(value) ?? null) : null;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (emp: EmployeeCompact) => {
    onChange(emp.user_id ?? emp.id);
    setSearch("");
    setOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setSearch("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="relative" ref={containerRef}>
      {selectedEmployee ? (
        <div className="flex items-center gap-3 px-3 py-2.5 border rounded-xl bg-muted">
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <span className="text-sm font-semibold text-primary">
              {selectedEmployee.first_name[0]}
              {selectedEmployee.last_name[0]}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">
              {selectedEmployee.first_name} {selectedEmployee.last_name}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {[
                selectedEmployee.designation_name,
                selectedEmployee.department_name,
              ]
                .filter(Boolean)
                .join(" · ") ||
                selectedEmployee.work_email ||
                "Employee"}
            </div>
          </div>
          <button
            onClick={handleClear}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            placeholder="Type to search employees..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(true);
            }}
            onFocus={() => debouncedSearch.length >= 2 && setOpen(true)}
            className="pl-9"
          />
          {isFetching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
          )}
        </div>
      )}

      {open && !selectedEmployee && debouncedSearch.length >= 2 && (
        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-xl shadow-xl max-h-56 overflow-y-auto">
          {isFetching && (
            <div className="px-4 py-4 text-center text-sm text-muted-foreground">
              Searching...
            </div>
          )}
          {!isFetching && (!employees || employees.length === 0) && (
            <div className="px-4 py-6 text-center">
              <User className="size-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No employees found for &ldquo;{debouncedSearch}&rdquo;
              </p>
            </div>
          )}
          {!isFetching &&
            (employees ?? []).map((emp) => (
              <button
                key={emp.id}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-primary/5 text-left transition-colors border-b border-border/50 last:border-0"
                onClick={() => handleSelect(emp)}
              >
                <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-semibold text-muted-foreground">
                    {emp.first_name[0]}
                    {emp.last_name[0]}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {emp.first_name} {emp.last_name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {[emp.designation_name, emp.department_name]
                      .filter(Boolean)
                      .join(" · ") ||
                      emp.work_email ||
                      ""}
                  </div>
                </div>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

const TimesheetSettings = () => {
  const [activeTab, setActiveTab] = useState("hours");

  const { data: settings, isLoading } = useGetTimesheetSettingsQuery();
  const [updateHours, { isLoading: isSavingHours }] =
    useUpdateHourSettingsMutation();
  const [updateSubmission, { isLoading: isSavingSubmission }] =
    useUpdateSubmissionSettingsMutation();
  const [updateApproval, { isLoading: isSavingApproval }] =
    useUpdateApprovalSettingsMutation();

  // Hour settings
  const [hourForm, setHourForm] = useState<HourSettingsUpdate>({
    daily_restrictions_enabled: true,
    min_hours_per_day: 0,
    max_hours_per_day: 24,
    deduct_leave_daily: false,
    weekly_restrictions_enabled: false,
    standard_hours_per_day: 8,
    max_hours_per_week: 40,
    deduct_leave_weekly: false,
    show_hours_type: "gross",
    shortage_penalty_enabled: false,
    penalty_percentage: 5,
  });

  // Submission settings
  const [submissionForm, setSubmissionForm] =
    useState<SubmissionSettingsUpdate>({
      daily_time_entry_enabled: false,
      allow_past_due_submission: true,
      restrict_time_off_entries: false,
      allow_attachment: true,
      submission_compliance_type: "weekly",
      submission_deadline_hours: 15,
      submission_day: "friday",
      submission_time: "18:00",
      auto_submit_enabled: false,
      client_notify_on_pending_count_enabled: false,
      client_notify_pending_count: 5,
      client_notify_on_schedule_enabled: false,
      client_notify_schedule: "weekend",
      employee_reminder_enabled: false,
      employee_reminder_time: "09:00",
      employee_reminder_days: { ...EMPTY_REMINDER_DAYS },
      /**
       * Employment types EXCLUDED from timesheet approval emails, as
       * master-data ObjectIds (not keys, not labels). Empty is the meaningful
       * default — everyone is notified, not "unset".
       *
       * Lives on submissionForm because that's the tab it's edited in; both
       * saves send it, mirroring client_notify_*.
       */
      notification_excluded_employment_types: [],
    });

  const { data: employmentTypes } = useGetSettingsEmploymentTypesQuery();

  // Approval settings
  const [approvalRequired, setApprovalRequired] = useState(true);
  // No allowFutureEntries state: the toggle is hidden and the value is always
  // sent as false. Reinstate it here along with the commented-out block below.
  const [cutoffEnabled, setCutoffEnabled] = useState(false);
  const [cutoffDay, setCutoffDay] = useState(25);
  const [approvalLevels, setApprovalLevels] = useState<ApprovalLevelInput[]>([
    { level: 1, approver_role: "manager", approver_id: null },
  ]);

  useEffect(() => {
    if (settings) {
      setHourForm({
        daily_restrictions_enabled: settings.daily_restrictions_enabled,
        min_hours_per_day: settings.min_hours_per_day,
        max_hours_per_day: settings.max_hours_per_day,
        deduct_leave_daily: settings.deduct_leave_daily,
        weekly_restrictions_enabled: settings.weekly_restrictions_enabled,
        standard_hours_per_day: settings.standard_hours_per_day,
        max_hours_per_week: settings.max_hours_per_week,
        deduct_leave_weekly: settings.deduct_leave_weekly,
        show_hours_type: settings.show_hours_type,
        shortage_penalty_enabled: settings.shortage_penalty_enabled,
        penalty_percentage: settings.penalty_percentage,
      });
      setSubmissionForm({
        daily_time_entry_enabled: settings.daily_time_entry_enabled,
        allow_past_due_submission: settings.allow_past_due_submission,
        restrict_time_off_entries: settings.restrict_time_off_entries,
        allow_attachment: settings.allow_attachment,
        submission_compliance_type: settings.submission_compliance_type,
        submission_deadline_hours: settings.submission_deadline_hours,
        submission_day: settings.submission_day,
        submission_time: settings.submission_time,
        auto_submit_enabled: settings.auto_submit_enabled,
        client_notify_on_pending_count_enabled:
          settings.client_notify_on_pending_count_enabled ?? false,
        client_notify_pending_count: settings.client_notify_pending_count ?? 5,
        client_notify_on_schedule_enabled:
          settings.client_notify_on_schedule_enabled ?? false,
        client_notify_schedule: settings.client_notify_schedule ?? "weekend",
        employee_reminder_enabled: settings.employee_reminder_enabled ?? false,
        employee_reminder_time: settings.employee_reminder_time ?? "09:00",
        employee_reminder_days: settings.employee_reminder_days ?? {
          ...EMPTY_REMINDER_DAYS,
        },
        notification_excluded_employment_types:
          settings.notification_excluded_employment_types ?? [],
      });
      setApprovalRequired(settings.approval_required);
      setCutoffEnabled(settings.past_submission_cutoff_enabled ?? false);
      setCutoffDay(settings.past_submission_cutoff_day ?? 25);
      if (settings.approval_levels?.length) {
        setApprovalLevels(
          settings.approval_levels.map((l) => ({
            level: l.level,
            approver_role: l.approver_role,
            approver_id: l.approver_id ?? null,
          })),
        );
      }
    }
  }, [settings]);

  const discardHourChanges = () => {
    if (!settings) return;
    setHourForm({
      daily_restrictions_enabled: settings.daily_restrictions_enabled,
      min_hours_per_day: settings.min_hours_per_day,
      max_hours_per_day: settings.max_hours_per_day,
      deduct_leave_daily: settings.deduct_leave_daily,
      weekly_restrictions_enabled: settings.weekly_restrictions_enabled,
      standard_hours_per_day: settings.standard_hours_per_day,
      max_hours_per_week: settings.max_hours_per_week,
      deduct_leave_weekly: settings.deduct_leave_weekly,
      show_hours_type: settings.show_hours_type,
      shortage_penalty_enabled: settings.shortage_penalty_enabled,
      penalty_percentage: settings.penalty_percentage,
    });
  };

  const discardSubmissionChanges = () => {
    if (!settings) return;
    setSubmissionForm({
      daily_time_entry_enabled: settings.daily_time_entry_enabled,
      allow_past_due_submission: settings.allow_past_due_submission,
      restrict_time_off_entries: settings.restrict_time_off_entries,
      allow_attachment: settings.allow_attachment,
      submission_compliance_type: settings.submission_compliance_type,
      submission_deadline_hours: settings.submission_deadline_hours,
      submission_day: settings.submission_day,
      submission_time: settings.submission_time,
      auto_submit_enabled: settings.auto_submit_enabled,
      client_notify_on_pending_count_enabled:
        settings.client_notify_on_pending_count_enabled ?? false,
      client_notify_pending_count: settings.client_notify_pending_count ?? 5,
      client_notify_on_schedule_enabled:
        settings.client_notify_on_schedule_enabled ?? false,
      client_notify_schedule: settings.client_notify_schedule ?? "weekend",
      employee_reminder_enabled: settings.employee_reminder_enabled ?? false,
      employee_reminder_time: settings.employee_reminder_time ?? "09:00",
      employee_reminder_days: settings.employee_reminder_days ?? {
        ...EMPTY_REMINDER_DAYS,
      },
      notification_excluded_employment_types:
        settings.notification_excluded_employment_types ?? [],
    });
  };

  const handleSaveHours = async () => {
    try {
      await updateHours(hourForm).unwrap();
      toast.success("Hour settings saved");
    } catch (err) {
      toast.error(err, "Failed to save hour settings");
    }
  };

  const handleSaveSubmission = async () => {
    try {
      // Carries notification_excluded_employment_types too — the endpoint now
      // accepts it, so this is a single write rather than a follow-up call
      // that could half-fail.
      await updateSubmission(submissionForm).unwrap();
      toast.success("Submission settings saved");
    } catch (err) {
      toast.error(err, "Failed to save submission settings");
    }
  };

  const handleSaveApproval = async () => {
    try {
      await updateApproval({
        approval_required: approvalRequired,
        // Always false while the toggle is hidden — sending the loaded value
        // would silently persist a `true` set before it was taken out
        allow_future_entries: false,
        past_submission_cutoff_enabled: cutoffEnabled,
        past_submission_cutoff_day: Math.min(31, Math.max(1, cutoffDay || 25)),
        levels: approvalLevels,
        client_notify_on_pending_count_enabled:
          submissionForm.client_notify_on_pending_count_enabled,
        client_notify_pending_count: submissionForm.client_notify_pending_count,
        client_notify_on_schedule_enabled:
          submissionForm.client_notify_on_schedule_enabled,
        client_notify_schedule: submissionForm.client_notify_schedule,
        // Whole array every time — it replaces what's stored, so an omitted
        // or partial list would quietly re-enable mail for the missing types.
        notification_excluded_employment_types:
          submissionForm.notification_excluded_employment_types,
      }).unwrap();
      toast.success("Approval settings saved");
    } catch (err) {
      toast.error(err, "Failed to save approval settings");
    }
  };

  const addApprovalLevel = () => {
    setApprovalLevels((prev) => [
      ...prev,
      { level: prev.length + 1, approver_role: "manager", approver_id: null },
    ]);
  };

  const removeApprovalLevel = (idx: number) => {
    setApprovalLevels((prev) =>
      prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, level: i + 1 })),
    );
  };

  const LEVEL_COLORS = [
    { bg: "bg-primary", text: "text-primary-foreground" },
    { bg: "bg-primary/80", text: "text-primary-foreground" },
    { bg: "bg-primary/60", text: "text-primary-foreground" },
    { bg: "bg-primary/40", text: "text-primary-foreground" },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center w-full h-full p-6">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          Loading settings...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageHeader
        title="Timesheet Settings"
        subtitle="Configure timesheet policies, submission rules, and approval workflows."
      />
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="hours" className="gap-2">
            <Clock className="size-4" />
            Hour Setting
          </TabsTrigger>
          <TabsTrigger value="submission" className="gap-2">
            <SendHorizonal className="size-4" />
            Submission Setting
          </TabsTrigger>
          <TabsTrigger value="approval" className="gap-2">
            <ShieldCheck className="size-4" />
            Approval
          </TabsTrigger>
        </TabsList>

        {/* ─── Hour Settings ─── */}
        <TabsContent value="hours" className="mt-4">
          <div className="space-y-6">
            {/* Daily Restrictions */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Daily Timesheet Restrictions
                </h3>
                <p className="text-sm text-muted-foreground">
                  Set limits for minimum and maximum hours employees can log per
                  day.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">
                  Enable daily restrictions
                </span>
                <Switch
                  checked={hourForm.daily_restrictions_enabled}
                  onCheckedChange={(v) =>
                    setHourForm((prev) => ({
                      ...prev,
                      daily_restrictions_enabled: v,
                    }))
                  }
                />
              </div>

              {hourForm.daily_restrictions_enabled && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm text-muted-foreground mb-1 block">
                        Minimum hours per day
                      </label>
                      <Input
                        type="number"
                        min={0}
                        max={24}
                        step={0.5}
                        value={hourForm.min_hours_per_day}
                        onChange={(e) =>
                          setHourForm((prev) => ({
                            ...prev,
                            min_hours_per_day: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground mb-1 block">
                        Maximum hours per day
                      </label>
                      <Input
                        type="number"
                        min={0}
                        max={24}
                        step={0.5}
                        value={hourForm.max_hours_per_day}
                        onChange={(e) =>
                          setHourForm((prev) => ({
                            ...prev,
                            max_hours_per_day: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                  </div>

                  {/* <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={hourForm.deduct_leave_daily}
                        onChange={(e) =>
                          setHourForm((prev) => ({
                            ...prev,
                            deduct_leave_daily: e.target.checked,
                          }))
                        }
                        className="rounded border-border"
                      />
                      Deduct leave hours from maximum allowable hours per day,
                      in case of partial day leave.
                    </label> */}
                </>
              )}
            </div>

            {/* Weekly Restrictions */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Weekly Timesheet Restrictions
                </h3>
                <p className="text-sm text-muted-foreground">
                  Set limits for total hours employees can log per week.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">
                  Enable weekly restrictions
                </span>
                <Switch
                  checked={hourForm.weekly_restrictions_enabled}
                  onCheckedChange={(v) =>
                    setHourForm((prev) => ({
                      ...prev,
                      weekly_restrictions_enabled: v,
                    }))
                  }
                />
              </div>

              {hourForm.weekly_restrictions_enabled && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    {/* <div>
                        <label className="text-sm text-muted-foreground mb-1 block">
                          Standard hours per day
                        </label>
                        <Input
                          type="number"
                          min={0}
                          max={24}
                          step={0.5}
                          value={hourForm.standard_hours_per_day}
                          onChange={(e) =>
                            setHourForm((prev) => ({
                              ...prev,
                              standard_hours_per_day: Number(e.target.value),
                            }))
                          }
                        />
                      </div> */}
                    <div>
                      <label className="text-sm text-muted-foreground mb-1 block">
                        Maximum hours per week
                      </label>
                      <Input
                        type="number"
                        min={0}
                        max={168}
                        step={1}
                        value={hourForm.max_hours_per_week}
                        onChange={(e) =>
                          setHourForm((prev) => ({
                            ...prev,
                            max_hours_per_week: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                  </div>

                  {/* <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={hourForm.deduct_leave_weekly}
                        onChange={(e) =>
                          setHourForm((prev) => ({
                            ...prev,
                            deduct_leave_weekly: e.target.checked,
                          }))
                        }
                        className="rounded border-border"
                      />
                      Deduct leave hours from the maximum allowable hours per
                      week, in case of leave.
                    </label> */}
                </>
              )}
            </div>

            {/* Timesheet Display Options */}
            {/* <div className="rounded-xl border bg-card p-5 space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Timesheet Display Options
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Configure how timesheet related data is presented to
                    employees.
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1 block">
                    Show Hours Type
                  </label>
                  <Select
                    value={hourForm.show_hours_type}
                    onValueChange={(v) =>
                      setHourForm((prev) => ({ ...prev, show_hours_type: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gross">Gross Hours</SelectItem>
                      <SelectItem value="net">Net Hours</SelectItem>
                      <SelectItem value="both">Both</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose how hours captured from the attendance module are
                    displayed for employee reference.
                  </p>
                </div>
            </div> */}

            {/* Shortage of Time Penalty */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Shortage of Time Penalty
                </h3>
                <p className="text-sm text-muted-foreground">
                  Configure penalties for employees who do not meet minimum hour
                  requirements.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">
                  Enable shortage penalty
                </span>
                <Switch
                  checked={hourForm.shortage_penalty_enabled}
                  onCheckedChange={(v) =>
                    setHourForm((prev) => ({
                      ...prev,
                      shortage_penalty_enabled: v,
                    }))
                  }
                />
              </div>

              {hourForm.shortage_penalty_enabled && (
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">
                    Penalty Percentage
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={hourForm.penalty_percentage}
                      onChange={(e) =>
                        setHourForm((prev) => ({
                          ...prev,
                          penalty_percentage: Number(e.target.value),
                        }))
                      }
                      className="flex-1 accent-primary"
                    />
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={hourForm.penalty_percentage}
                        onChange={(e) =>
                          setHourForm((prev) => ({
                            ...prev,
                            penalty_percentage: Number(e.target.value),
                          }))
                        }
                        className="w-16 text-center"
                      />
                      <span className="text-sm text-muted-foreground">%</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    This percentage will be applied to the calculated shortage
                    amount.
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button
                variant="outline"
                onClick={discardHourChanges}
                disabled={!settings}
              >
                Discard Changes
              </Button>
              <Button
                variant="soft"
                onClick={handleSaveHours}
                disabled={isSavingHours}
              >
                {isSavingHours && <Loader2 className="animate-spin" />}
                <Save />
                Save
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* ─── Submission Settings ─── */}
        <TabsContent value="submission">
          <div className="space-y-6 mt-4">
            {/* Client Approval Notifications */}
            <div className="rounded-xl border bg-card p-5 space-y-5">
              <h3 className="text-base font-semibold text-foreground">
                Client approval notifications
              </h3>

              {/* Pending threshold */}
              <div className="flex items-center gap-3">
                <Checkbox
                  id="notify-pending-cb"
                  checked={
                    submissionForm.client_notify_on_pending_count_enabled
                  }
                  onCheckedChange={(v) =>
                    setSubmissionForm((prev) => ({
                      ...prev,
                      client_notify_on_pending_count_enabled: !!v,
                    }))
                  }
                />
                <label
                  htmlFor="notify-pending-cb"
                  className="flex items-center gap-2 flex-wrap text-sm text-foreground cursor-pointer"
                >
                  Send email on getting
                </label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={submissionForm.client_notify_pending_count}
                  onChange={(e) => {
                    const v = Math.min(
                      20,
                      Math.max(1, Number(e.target.value) || 1),
                    );
                    setSubmissionForm((prev) => ({
                      ...prev,
                      client_notify_pending_count: v,
                    }));
                  }}
                  disabled={
                    !submissionForm.client_notify_on_pending_count_enabled
                  }
                  className="w-16 h-7 text-center px-1 text-sm"
                />
                <span className="text-sm text-foreground">
                  or more pending timesheets
                </span>
              </div>

              {/* Schedule */}
              <label className="flex items-center gap-3 cursor-pointer">
                <Checkbox
                  checked={submissionForm.client_notify_on_schedule_enabled}
                  onCheckedChange={(v) =>
                    setSubmissionForm((prev) => ({
                      ...prev,
                      client_notify_on_schedule_enabled: !!v,
                    }))
                  }
                />
                <div className="flex items-center gap-3">
                  <span className="text-sm text-foreground">
                    Send email on every
                  </span>
                  <div className="flex items-center rounded-xl border overflow-x-auto w-fit">
                    <button
                      type="button"
                      disabled={
                        !submissionForm.client_notify_on_schedule_enabled
                      }
                      onClick={() =>
                        setSubmissionForm((prev) => ({
                          ...prev,
                          client_notify_schedule: "weekend",
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium transition-colors ${submissionForm.client_notify_schedule === "weekend"
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-muted"
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      Weekend
                    </button>
                    <button
                      type="button"
                      disabled={
                        !submissionForm.client_notify_on_schedule_enabled
                      }
                      onClick={() =>
                        setSubmissionForm((prev) => ({
                          ...prev,
                          client_notify_schedule: "month_end",
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium transition-colors ${submissionForm.client_notify_schedule === "month_end"
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-muted"
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      Month end
                    </button>
                  </div>
                </div>
              </label>
            </div>

            {/* Employment types excluded from timesheet emails */}
            <div className="rounded-xl border bg-card p-5 space-y-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Don't send timesheet emails to
                </h3>
                {/* Spelled out because "excluded from notifications" is widely
                    read as "excluded from timesheets", and it is not. The
                    reminder clause is here so its arrival isn't reported as a
                    bug — it's deliberately exempt. */}
                <p className="text-xs text-muted-foreground mt-0.5">
                  These people can still fill in, submit and view their
                  timesheets, and still get the weekly reminder — they just
                  won't receive submission, approval or rejection emails.
                </p>
              </div>

              <SearchableSelect
                multi
                // Label from `value`, submitted value is the master-data `id` —
                // matching what an employee record stores in `employment_type`.
                options={(employmentTypes ?? []).map((t) => ({
                  label: t.value,
                  value: t.id,
                }))}
                value={submissionForm.notification_excluded_employment_types}
                onChange={(v) =>
                  setSubmissionForm((prev) => ({
                    ...prev,
                    notification_excluded_employment_types: v as string[],
                  }))
                }
                placeholder="Everyone receives timesheet emails"
                emptyMessage="No employment types found."
                className="max-w-md"
              />

              {/* Empty is a real, valid configuration — say what it does rather
                  than leaving a blank control that reads as unset. */}
              {submissionForm.notification_excluded_employment_types.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing selected — everyone receives timesheet emails.
                </p>
              )}
            </div>

            {/* Timesheet Reminders */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Timesheet Reminders
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Remind employees to fill and submit their timesheets.
                  </p>
                </div>
                <Switch
                  checked={submissionForm.employee_reminder_enabled}
                  onCheckedChange={(v) =>
                    setSubmissionForm((prev) => ({
                      ...prev,
                      employee_reminder_enabled: v,
                    }))
                  }
                />
              </div>

              {submissionForm.employee_reminder_enabled && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-foreground">
                      Send reminder on
                    </span>
                    <div className="flex items-center rounded-lg border overflow-hidden w-fit">
                      {REMINDER_DAYS.map((opt, i) => {
                        const active =
                          submissionForm.employee_reminder_days[opt.key];
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() =>
                              setSubmissionForm((prev) => ({
                                ...prev,
                                employee_reminder_days: {
                                  ...prev.employee_reminder_days,
                                  [opt.key]:
                                    !prev.employee_reminder_days[opt.key],
                                },
                              }))
                            }
                            className={`px-3 py-1 text-xs font-medium transition-colors ${i > 0 ? "border-l" : ""
                              } ${active
                                ? "bg-primary text-primary-foreground"
                                : "bg-background text-muted-foreground hover:bg-muted"
                              }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-foreground">at</span>
                    <Input
                      type="time"
                      value={submissionForm.employee_reminder_time}
                      onChange={(e) =>
                        setSubmissionForm((prev) => ({
                          ...prev,
                          employee_reminder_time: e.target.value,
                        }))
                      }
                      className="w-32 h-9"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Past Due Timesheets */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <h3 className="text-base font-semibold text-foreground">
                What to do with past due timesheets?
              </h3>

              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">
                  Allow submitting current timesheets even if past timesheets
                  are not submitted
                </span>
                <Switch
                  checked={submissionForm.allow_past_due_submission}
                  onCheckedChange={(v) =>
                    setSubmissionForm((prev) => ({
                      ...prev,
                      allow_past_due_submission: v,
                    }))
                  }
                />
              </div>

              <div className="space-y-3 pl-1">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={submissionForm.restrict_time_off_entries}
                    onCheckedChange={(v) =>
                      setSubmissionForm((prev) => ({
                        ...prev,
                        restrict_time_off_entries: !!v,
                      }))
                    }
                  />
                  Restrict submission of time entries on time offs
                </label>

                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={submissionForm.allow_attachment}
                    onCheckedChange={(v) =>
                      setSubmissionForm((prev) => ({
                        ...prev,
                        allow_attachment: !!v,
                      }))
                    }
                  />
                  Allow attachment while submitting a timesheet
                </label>
              </div>
            </div>

            {/* Submission Compliance */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <h3 className="text-base font-semibold text-foreground">
                Timesheet submission compliance
              </h3>

              <div className="bg-warning/10 border border-warning/30 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="size-5 text-warning mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-warning">Warning</p>
                  <p className="text-xs text-badge-pending-text">
                    Configuring penalization policies for both Attendance and
                    Timesheet for the same employee on the same day will result
                    in double penalties. Please review and ensure consistency to
                    avoid this duplication.
                  </p>
                </div>
              </div>

              {/* <div className="flex items-center gap-6">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name="compliance"
                      checked={
                        submissionForm.submission_compliance_type === "daily"
                      }
                      onChange={() =>
                        setSubmissionForm((prev) => ({
                          ...prev,
                          submission_compliance_type: "daily",
                        }))
                      }
                      className="text-primary"
                    />
                    Daily Submission
                  </label>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name="compliance"
                      checked={
                        submissionForm.submission_compliance_type === "weekly"
                      }
                      onChange={() =>
                        setSubmissionForm((prev) => ({
                          ...prev,
                          submission_compliance_type: "weekly",
                        }))
                      }
                      className="text-primary"
                    />
                    Weekly Submission
                  </label>
                </div> */}

              <div className="flex items-center gap-2 text-sm text-foreground">
                Set submission deadline to be
                <Input
                  type="number"
                  min={0}
                  max={72}
                  value={submissionForm.submission_deadline_hours}
                  onChange={(e) =>
                    setSubmissionForm((prev) => ({
                      ...prev,
                      submission_deadline_hours: Number(e.target.value),
                    }))
                  }
                  className="w-16"
                />
                hours from timesheet submission day end.
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button
                variant="outline"
                onClick={discardSubmissionChanges}
                disabled={!settings}
              >
                Discard Changes
              </Button>
              <Button
                onClick={handleSaveSubmission}
                disabled={isSavingSubmission}
              >
                {isSavingSubmission && <Loader2 className="animate-spin" />}
                <Save />
                Save
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* ─── Approval Settings ─── */}
        <TabsContent value="approval">
          <div className="space-y-6 mt-4">
            {/* Approval Toggle */}
            {/* <div className="rounded-xl border bg-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    Does this project require timesheet approval?
                  </span>
                  <Switch
                    checked={approvalRequired}
                    onCheckedChange={setApprovalRequired}
                  />
                </div>
            </div> */}

            {/* Entry Window */}
            <div className="rounded-xl border bg-card p-5 space-y-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Entry Window
                </h3>
                <p className="text-sm text-muted-foreground">
                  Control how far back employees can log time.
                </p>
              </div>

              {/* Hidden for now — future entries are always disallowed, so this
                  toggle would only ever read "off". To restore it, bring back
                  the allowFutureEntries state, its setter in the settings-load
                  effect, and swap the hardcoded false in handleSaveApproval.
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Allow future entries
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Let employees log hours for future dates.
                  </p>
                </div>
                <Switch
                  checked={allowFutureEntries}
                  onCheckedChange={setAllowFutureEntries}
                />
              </div>
              */}

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Close past periods on a cutoff day
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Freeze finished weeks each month until a project manager
                    reopens them.
                  </p>
                </div>
                <Switch
                  checked={cutoffEnabled}
                  onCheckedChange={setCutoffEnabled}
                />
              </div>

              {/* Only meaningful while the cutoff is on — render conditionally
                  rather than showing a disabled field */}
              {cutoffEnabled && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Cutoff day of the month
                  </label>
                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={cutoffDay}
                      onChange={(e) => setCutoffDay(Number(e.target.value))}
                      onBlur={() =>
                        setCutoffDay((d) =>
                          Number.isFinite(d) ? Math.min(31, Math.max(1, d)) : 25,
                        )
                      }
                      className="w-24 h-9"
                    />
                    <span className="text-sm text-muted-foreground">
                      of each month
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Weeks that end before the {ordinal(cutoffDay)} of each month
                    close for editing and submission. Months shorter than the
                    chosen day close on their last day, so 31 means month end.
                  </p>
                </div>
              )}
            </div>
            {/* 
            {approvalRequired && (
              <>
                {approvalLevels.map((level, idx) => {
                  const color = LEVEL_COLORS[idx % LEVEL_COLORS.length];
                  return (
                    <div key={idx} className="rounded-xl border overflow-x-auto bg-card">
                      <div
                        className={`${color.bg} ${color.text} px-4 py-2.5 flex items-center justify-between`}
                      >
                        <span className="font-semibold text-sm">
                          Level {level.level} Approver
                        </span>
                        {approvalLevels.length > 1 && (
                          <button
                            onClick={() => removeApprovalLevel(idx)}
                            className="hover:opacity-80"
                          >
                            <Trash2  />
                          </button>
                        )}
                      </div>
                      <div className="p-5 space-y-5">
                        <div>
                          <label className="text-sm font-medium text-foreground mb-1 block">
                            Select Role
                          </label>
                          <Select
                            value={level.approver_role}
                            onValueChange={(v) =>
                              setApprovalLevels((prev) =>
                                prev.map((l, i) =>
                                  i === idx ? { ...l, approver_role: v } : l,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="manager">Manager</SelectItem>
                              <SelectItem value="team_lead">
                                Team Lead
                              </SelectItem>
                              <SelectItem value="project_manager">
                                Project Manager
                              </SelectItem>
                              <SelectItem value="client">Client</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-sm font-medium text-foreground mb-1 block">
                            Select Employee
                          </label>
                          <EmployeeSearchField
                            value={level.approver_id ?? null}
                            onChange={(empId) =>
                              setApprovalLevels((prev) =>
                                prev.map((l, i) =>
                                  i === idx ? { ...l, approver_id: empId } : l,
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}

                <button
                  onClick={addApprovalLevel}
                  className="flex items-center gap-1 text-sm text-primary hover:text-primary mx-auto"
                >
                  <Plus  />
                  Add Another Level
                </button>
              </>
            )} */}

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline">Cancel</Button>
              <Button
                onClick={handleSaveApproval}
                disabled={isSavingApproval}
              >
                {isSavingApproval && <Loader2 className="animate-spin" />}
                Update
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default TimesheetSettings;
