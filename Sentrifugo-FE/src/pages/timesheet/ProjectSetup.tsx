import { useState, useEffect, Fragment, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Plus,
  Check,
  ChevronDown,
  X,
  CalendarIcon,
  Search,
  AlertTriangle,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { format, parseISO } from "date-fns";
import { useNavigate, useParams } from "@tanstack/react-router";
import ClientSheet from "./ClientSheet";
import {
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useGetProjectQuery,
  useGetClientsQuery,
  useGetClientQuery,
  useGetProjectHeadsQuery,
  useLazyGenerateProjectCodeQuery,
} from "@/store/api/timesheetApi";
import {
  useGetCurrenciesQuery,
  useGetEmployeesQuery,
} from "@/store/api/iamApi";
import type {
  ProjectCreate,
  ProjectType,
  ProjectUpdate,
  BillableRateType,
  BillableOn,
} from "@/types/timesheet";
import { toast } from "@/lib/toast";
import { ProjectStepper } from "@/components/shared/ProjectStepper";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { useAppDispatch, useAppSelector } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";

type RateType = BillableRateType;

const PROJECT_TYPES: { value: ProjectType; title: string; subtitle: string }[] =
  [
    {
      value: "time_and_materials",
      title: "Time & Material",
      subtitle: "Bill by the hour, with billable rates",
    },
    {
      value: "fixed_fee",
      title: "Fixed Fee",
      subtitle: "Bill a set price, regardless of time tracked",
    },
    {
      value: "non_billable",
      title: "Non - Billable",
      subtitle: "Track time without billing",
    },
  ];

const ProjectSetup = () => {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string };
  const isEdit = !!params.projectId;
  const editingId = params.projectId;
  const [clientSheetOpen, setClientSheetOpen] = useState(false);
  const { data: clientsData } = useGetClientsQuery({
    page: 1,
    page_size: 100,
    status: "active",
  });
  const { data: existingProject, error: existingProjectError } =
    useGetProjectQuery(editingId ?? "", {
      skip: !isEdit,
    });
  // Projects are scoped to the caller — a 404 means deleted or not yours
  const projectNotFound =
    (existingProjectError as { status?: number } | undefined)?.status === 404;

  // Topbar breadcrumb leaf: Timesheet › Projects › <this>
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch(
      setBreadcrumbDetail(
        isEdit ? (existingProject?.name ?? "Edit Project") : "New Project",
      ),
    );
    return () => {
      dispatch(setBreadcrumbDetail(null));
    };
  }, [dispatch, isEdit, existingProject?.name]);

  const [createProject, { isLoading: isCreating }] = useCreateProjectMutation();
  const [updateProject, { isLoading: isUpdating }] = useUpdateProjectMutation();
  const [triggerGenerateCode] = useLazyGenerateProjectCodeQuery();
  const codeDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(codeDebounceRef.current), []);
  const isLoading = isCreating || isUpdating;

  const { data: currencyData = [] } = useGetCurrenciesQuery();
  const currencies = currencyData.map((c) => ({
    code: c.currency,
    name: c.currency_name ?? c.currency,
  }));

  const [form, setForm] = useState<ProjectCreate>({
    client_id: "",
    name: "",
    code: "",
    description: "",
    project_type: "time_and_materials",
    start_date: "",
    end_date: "",
    budget_hours: null,
    budget_cost: null,
    billable_rate: null,
    currency: "INR",
  });

  const [rateType, setRateType] = useState<RateType>("per_day");
  const [billableOn, setBillableOn] = useState<"project" | "resource">(
    "project",
  );
  const [emailAlert, setEmailAlert] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState<number>(80);
  const [projectStatus, setProjectStatus] = useState<string>("active");
  const [clientApprovalRequired, setClientApprovalRequired] = useState(false);
  const [isInternalProject, setIsInternalProject] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const [projectHeadIds, setProjectHeadIds] = useState<string[]>([]);
  const [headsPopoverOpen, setHeadsPopoverOpen] = useState(false);
  const [headSearch, setHeadSearch] = useState("");
  const [debouncedHeadSearch, setDebouncedHeadSearch] = useState("");
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [currencyOpen2, setCurrencyOpen2] = useState(false);
  const [currencyOpen3, setCurrencyOpen3] = useState(false);
  const [currencySearch, setCurrencySearch] = useState("");
  const [currencySearch2, setCurrencySearch2] = useState("");
  const [currencySearch3, setCurrencySearch3] = useState("");
  const [budgetType, setBudgetType] = useState<
    "total_project_hours" | "total_project_cost"
  >("total_project_hours");

  const clients = clientsData?.items ?? [];
  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));

  // Debounce the project-head / employee search (same pattern as the Resources tab)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedHeadSearch(headSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [headSearch]);

  const { data: projectHeadsData } = useGetProjectHeadsQuery(
    {
      client_id: form.client_id,
      page: 1,
      page_size: 25,
      search: debouncedHeadSearch || undefined,
    },
    { skip: !form.client_id || isInternalProject },
  );
  const projectHeads = projectHeadsData?.items ?? [];

  // For internal projects, project heads come from the eligible employees —
  // the same list shown in the Resources tab (scoped by the client's BU/dept).
  const orgUser = useAppSelector((s) => s.auth.user);
  const orgId = orgUser?.organisation_id || "";
  const { data: headClient } = useGetClientQuery(form.client_id, {
    skip: !form.client_id || !isInternalProject,
  });
  const belongsToFilter = useMemo<{
    department_ids?: string[];
    business_unit_ids?: string[];
  }>(() => {
    const filter: { department_ids?: string[]; business_unit_ids?: string[] } =
      {};
    if (headClient?.business_unit_ids?.length)
      filter.business_unit_ids = headClient.business_unit_ids;
    if (headClient?.department_ids?.length)
      filter.department_ids = headClient.department_ids;
    return filter;
  }, [headClient]);
  const { data: eligibleEmployees = [] } = useGetEmployeesQuery(
    {
      limit: 100,
      search: debouncedHeadSearch || undefined,
      ...(orgId ? { organisation_id: orgId } : {}),
      ...belongsToFilter,
    },
    { skip: !isInternalProject || !form.client_id },
  );

  // Unified option shape for the "Assign Project Head" picker
  const headOptions = useMemo(
    () =>
      isInternalProject
        ? // project_head_ids are IAM user IDs everywhere — use the employee's
          // user_id (not the employee document _id) as the option value.
          eligibleEmployees
            .filter((e) => e.userId ?? e.user_id)
            .map((e) => ({
              id: (e.userId ?? e.user_id) as string,
              first_name: e.firstName ?? e.first_name ?? "",
              last_name: e.lastName ?? e.last_name ?? "",
              email: e.workEmail ?? e.work_email ?? "",
            }))
        : projectHeads.map((h) => ({
            id: h.id,
            first_name: h.first_name,
            last_name: h.last_name,
            email: h.email,
          })),
    [isInternalProject, eligibleEmployees, projectHeads],
  );

  useEffect(() => {
    if (existingProject) {
      const isoToInput = (d?: string | null) => (d ? d.slice(0, 10) : "");
      setForm({
        client_id: existingProject.client_id,
        name: existingProject.name,
        code: existingProject.code ?? "",
        description: existingProject.description ?? "",
        project_type: existingProject.project_type,
        start_date: isoToInput(existingProject.start_date),
        end_date: isoToInput(existingProject.end_date),
        budget_hours: existingProject.budget_hours ?? null,
        budget_cost: existingProject.budget_cost ?? null,
        billable_rate: existingProject.billable_rate ?? null,
        currency: existingProject.currency ?? "INR",
      });
      if (existingProject.budget_cost != null) {
        setBudgetType("total_project_cost");
      } else {
        setBudgetType("total_project_hours");
      }
      setProjectStatus(existingProject.project_status ?? "active");
      setClientApprovalRequired(
        existingProject.client_approval_required ?? false,
      );
      setIsInternalProject(existingProject.is_internal ?? false);
      setProjectHeadIds(existingProject.project_head_ids ?? []);
      setEmailAlert(existingProject.send_alerts != null);
      if (existingProject.send_alerts != null)
        setAlertThreshold(existingProject.send_alerts);
      if (existingProject.billable_rate_type)
        setRateType(existingProject.billable_rate_type);
      if (existingProject.billable_on)
        setBillableOn(existingProject.billable_on);
    }
  }, [existingProject]);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!form.client_id) errs.client_id = "Client is required";
    if (!form.name?.trim()) errs.name = "Project Name is required";
    if (!form.code?.trim()) errs.code = "Project Code is required";
    if (!form.start_date) errs.start_date = "Start Date is required";
    if (!form.end_date) errs.end_date = "End Date is required";
    if (form.start_date && form.end_date && form.start_date > form.end_date)
      errs.end_date = "End Date must be after Start Date";
    if (!projectStatus) errs.project_status = "Status is required";
    if (!form.currency) errs.currency = "Currency is required";
    if (!form.project_type) errs.project_type = "Project Type is required";
    if (
      form.project_type !== "non_billable" &&
      (form.billable_rate == null || form.billable_rate <= 0)
    )
      errs.billable_rate = "Billable Rate is required";
    if (budgetType === "total_project_hours") {
      if (form.budget_hours == null || form.budget_hours <= 0)
        errs.budget_hours = "Budget Hours is required";
    } else {
      if (form.budget_cost == null || form.budget_cost <= 0)
        errs.budget_hours = "Budget Cost is required";
      else if (
        form.billable_rate != null &&
        form.billable_rate > 0 &&
        form.budget_cost <= form.billable_rate
      )
        errs.budget_hours = `Total Project Cost must be greater than the Billable Rate ${form.currency} ${form.billable_rate}`;
    }
    if (emailAlert && (alertThreshold < 0 || alertThreshold > 100))
      errs.alertThreshold = "Must be between 0 and 100";
    return errs;
  };

  const persist = async (): Promise<string | null> => {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      scrollToFirstError();
      toast.error("Please fill in all required fields");
      return null;
    }
    try {
      const basePayload = {
        ...form,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        budget_hours:
          budgetType === "total_project_hours" ? form.budget_hours : null,
        budget_cost:
          budgetType === "total_project_cost" ? form.budget_cost : null,
        project_head_ids: projectHeadIds,
        send_alerts: emailAlert ? alertThreshold : null,
        client_approval_required: clientApprovalRequired,
        is_internal: isInternalProject,
        billable_rate:
          form.project_type === "non_billable" ? null : form.billable_rate,
        billable_rate_type:
          form.project_type === "non_billable" ? null : rateType,
        billable_on: form.project_type === "non_billable" ? null : billableOn,
      };
      if (isEdit && editingId) {
        const { client_id: _client_id, ...updateBody } = basePayload;
        await updateProject({
          id: editingId,
          body: {
            ...updateBody,
            project_status: projectStatus,
          } as ProjectUpdate,
        }).unwrap();
        toast.success("Project updated");
        setIsDirty(false);
        return editingId;
      } else {
        const created = (await createProject(
          basePayload,
        ).unwrap()) as unknown as { id?: string; _id?: string };
        toast.success("Project created");
        setIsDirty(false);
        return created.id ?? created._id ?? null;
      }
    } catch (err: unknown) {
      toast.error(err, "Failed to save project");
      return null;
    }
  };

  const handleSave = async () => {
    const id = await persist();
    if (id) navigate({ to: "/timesheet/projects" });
  };

  const handleSaveAndNext = async () => {
    const id = await persist();
    if (id)
      navigate({
        to: "/timesheet/projects/$projectId/tasks",
        params: { projectId: id },
      });
  };

  const goToStep = (stepNum: number) => {
    if (!editingId) return;
    if (stepNum === 2)
      navigate({
        to: "/timesheet/projects/$projectId/tasks",
        params: { projectId: editingId },
      });
    else if (stepNum === 3)
      navigate({
        to: "/timesheet/projects/$projectId/resources",
        params: { projectId: editingId },
      });
  };

  const updateField = <K extends keyof ProjectCreate>(
    key: K,
    value: ProjectCreate[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  // Auto-derive the project code from the name:
  // 1 word → first 3 letters · 2 words → 1 + 2 letters · 3+ words → 1 letter each
  const deriveProjectCode = (name: string): string => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
    if (words.length === 2)
      return (words[0].slice(0, 1) + words[1].slice(0, 2)).toUpperCase();
    return words
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  };

  const handleNameChange = (name: string) => {
    setFieldErrors((prev) => {
      const { name: _n, ...rest } = prev;
      return rest;
    });

    // Edit mode: keep the project's existing code, only update the name
    if (isEdit) {
      setForm((prev) => ({ ...prev, name }));
      setIsDirty(true);
      return;
    }

    // Create mode: optimistic local preview, then overwrite with the backend's unique code
    setForm((prev) => ({ ...prev, name, code: deriveProjectCode(name) }));
    setIsDirty(true);

    clearTimeout(codeDebounceRef.current);
    const trimmed = name.trim();
    if (!trimmed) {
      setForm((prev) => ({ ...prev, code: "" }));
      return;
    }
    codeDebounceRef.current = setTimeout(async () => {
      try {
        const res = await triggerGenerateCode(trimmed).unwrap();
        // Only apply if the name hasn't changed since this request started
        setForm((prev) =>
          prev.name.trim() === trimmed ? { ...prev, code: res.code } : prev,
        );
      } catch {
        // Keep the optimistic local code on failure
      }
    }, 400);
  };

  const handleNavAway = () => {
    if (isDirty) {
      setDiscardOpen(true);
    } else {
      navigate({ to: "/timesheet/projects" });
    }
  };

  const scrollToFirstError = () => {
    requestAnimationFrame(() => {
      formRef.current
        ?.querySelector('[aria-invalid="true"]')
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const alertHint: string | null = (() => {
    if (!emailAlert || alertThreshold < 0 || alertThreshold > 100) return null;
    if (
      budgetType === "total_project_hours" &&
      form.budget_hours != null &&
      form.budget_hours > 0
    ) {
      const bh = form.budget_hours;
      const raw = (alertThreshold / 100) * bh;
      const usedStr = Number.isInteger(raw) ? raw.toString() : raw.toFixed(1);
      const totalStr = Number.isInteger(bh) ? bh.toString() : bh.toFixed(1);
      return `Email alert will be sent upon completion of ${usedStr} hrs of allocated ${totalStr} hrs`;
    }
    if (
      budgetType === "total_project_cost" &&
      form.budget_cost != null &&
      form.budget_cost > 0
    ) {
      const bc = form.budget_cost;
      const used = ((alertThreshold / 100) * bc).toFixed(2);
      return `Email alert will be sent upon completion of ${form.currency} ${used} of allocated ${form.currency} ${bc.toFixed(2)}`;
    }
    return null;
  })();

  if (projectNotFound) {
    return (
      <RecordNotFound
        entity="project"
        backLabel="Back to Projects"
        onBack={() => navigate({ to: "/timesheet/projects" })}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Stepper */}
      <ProjectStepper currentStep={1} projectId={editingId} />

      {/* Form Card */}
      <div ref={formRef} className="rounded-xl border bg-card p-8 space-y-8">
        <h2 className="text-lg font-semibold text-foreground">
          {isEdit ? "Edit Project" : "New Project"}
        </h2>

        {/* Project Details */}
        <div className="grid grid-cols-[180px_1fr] gap-8 pb-6 border-b">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Project Details
            </h3>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Client Name <span className="text-destructive">*</span>
              </label>
              <div className="flex items-center gap-3">
                <div
                  className={`flex-1 ${fieldErrors.client_id ? "rounded-md ring-1 ring-destructive" : ""}`}
                  aria-invalid={fieldErrors.client_id ? "true" : undefined}
                >
                  <SearchableSelect
                    options={clientOptions}
                    value={form.client_id}
                    onChange={(v) => {
                      updateField("client_id", v as string);
                      setProjectHeadIds([]);
                      setFieldErrors((prev) => {
                        const { client_id: _, ...rest } = prev;
                        return rest;
                      });
                    }}
                    placeholder="Enter Client Name"
                    emptyMessage="No clients found"
                  />
                </div>
                <span className="text-sm text-muted-foreground">or</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setClientSheetOpen(true)}
                >
                  <Plus />
                  New Client
                </Button>
              </div>
              {fieldErrors.client_id && (
                <p className="text-xs text-destructive mt-1">
                  {fieldErrors.client_id}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Project Name <span className="text-destructive">*</span>
                </label>
                <Input
                  value={form.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Enter Project Name"
                  aria-invalid={fieldErrors.name ? "true" : undefined}
                  className={fieldErrors.name ? "border-destructive" : ""}
                />
                {fieldErrors.name && (
                  <p className="text-xs text-destructive mt-1">
                    {fieldErrors.name}
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block flex items-center justify-between">
                  <span>
                    Project Code <span className="text-destructive">*</span>
                  </span>
                  <span className="text-muted-foreground">
                    Last Project Code : TC
                  </span>
                </label>
                <Input
                  value={form.code ?? ""}
                  disabled
                  readOnly
                  placeholder="Auto-generated from name"
                  className={fieldErrors.code ? "border-destructive" : ""}
                />
                {fieldErrors.code && (
                  <p className="text-xs text-destructive mt-1">
                    {fieldErrors.code}
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Project Status <span className="text-destructive">*</span>
                </label>
                <Select
                  value={projectStatus}
                  onValueChange={(v) => {
                    setProjectStatus(v);
                    setFieldErrors((prev) => {
                      const { project_status: _, ...rest } = prev;
                      return rest;
                    });
                  }}
                >
                  <SelectTrigger
                    className={
                      fieldErrors.project_status ? "border-destructive" : ""
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
                {fieldErrors.project_status && (
                  <p className="text-xs text-destructive mt-1">
                    {fieldErrors.project_status}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between mt-[4%]">
                <p className="text-sm text-foreground">
                  Client approval needed after manager approval?{" "}
                  <span className="text-destructive">*</span>
                </p>
                <Switch
                  checked={clientApprovalRequired}
                  onCheckedChange={setClientApprovalRequired}
                />
              </div>
              <div className="flex items-center justify-between mt-[4%]">
                <p className="text-sm text-foreground">
                  Is this internal project?
                </p>
                <Switch
                  checked={isInternalProject}
                  onCheckedChange={(v) => {
                    setIsInternalProject(v);
                    // The head source changes (employees vs project heads) — reset selection
                    setProjectHeadIds([]);
                  }}
                />
              </div>
            </div>

            {/* Assign Project Head */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Assign Project Head{" "}
                <span className="text-muted-foreground">(Optional)</span>
              </label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Popover
                    open={headsPopoverOpen}
                    onOpenChange={(open) => {
                      setHeadsPopoverOpen(open);
                      if (!open) setHeadSearch("");
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-between font-normal"
                        disabled={!form.client_id}
                      >
                        <span className="truncate text-left">
                          {projectHeadIds.length === 0
                            ? form.client_id
                              ? isInternalProject
                                ? "Select employees"
                                : "Select project heads"
                              : "Select a client first"
                            : headOptions
                                .filter((h) => projectHeadIds.includes(h.id))
                                .map((h) => `${h.first_name} ${h.last_name}`)
                                .join(", ")}
                        </span>
                        <ChevronDown className="w-4 h-4 opacity-50 shrink-0 ml-2" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 p-2" align="start">
                      <div className="relative mb-2">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                        <Input
                          autoFocus
                          placeholder={
                            isInternalProject
                              ? "Search employees..."
                              : "Search project heads..."
                          }
                          value={headSearch}
                          onChange={(e) => setHeadSearch(e.target.value)}
                          className="pl-8 h-8 text-sm"
                        />
                      </div>
                      {headOptions.length === 0 ? (
                        <p className="px-2 py-3 text-sm text-muted-foreground text-center">
                          {debouncedHeadSearch
                            ? "No matches found"
                            : isInternalProject
                              ? "No eligible employees for this client"
                              : "No project heads for this client"}
                        </p>
                      ) : (
                        <div className="max-h-52 overflow-y-auto space-y-0.5">
                          {headOptions.map((h) => {
                            const selected = projectHeadIds.includes(h.id);
                            return (
                              <button
                                key={h.id}
                                type="button"
                                onClick={() =>
                                  setProjectHeadIds((prev) =>
                                    selected
                                      ? prev.filter((id) => id !== h.id)
                                      : [...prev, h.id],
                                  )
                                }
                                className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-muted"
                              >
                                <div className="text-left">
                                  <div className="font-medium">
                                    {h.first_name} {h.last_name}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {h.email}
                                  </div>
                                </div>
                                {selected && (
                                  <Check className="w-4 h-4 text-primary shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
                {!isInternalProject && (
                  <>
                    <span className="text-sm text-muted-foreground">or</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate({
                          to: "/timesheet/project-heads",
                          search: { new: "true" },
                        })
                      }
                    >
                      <Plus />
                      New Project Head
                    </Button>
                  </>
                )}
              </div>
              {projectHeadIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {headOptions
                    .filter((h) => projectHeadIds.includes(h.id))
                    .map((h) => (
                      <span
                        key={h.id}
                        className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 rounded-full"
                      >
                        {h.first_name} {h.last_name}
                        <button
                          type="button"
                          onClick={() =>
                            setProjectHeadIds((prev) =>
                              prev.filter((id) => id !== h.id),
                            )
                          }
                          className="hover:text-primary/70"
                        >
                          <X />
                        </button>
                      </span>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Scheduling */}
        <div className="grid grid-cols-[180px_1fr] gap-8 pb-6 border-b">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Scheduling
            </h3>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground block">
              Dates <span className="text-destructive">*</span>
            </label>
            <div className="flex items-center gap-3">
              <div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={`w-44 justify-start font-normal ${fieldErrors.start_date ? "border-destructive" : ""}`}
                    >
                      <CalendarIcon className="size-4 text-muted-foreground" />
                      {form.start_date ? (
                        format(parseISO(form.start_date), "dd-MMM-yyyy")
                      ) : (
                        <span className="text-muted-foreground">
                          Start date
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={
                        form.start_date ? parseISO(form.start_date) : undefined
                      }
                      defaultMonth={
                        form.start_date ? parseISO(form.start_date) : undefined
                      }
                      captionLayout="dropdown"
                      endMonth={new Date(new Date().getFullYear() + 5, 11)}
                      onSelect={(date) => {
                        const newStart = date ? format(date, "yyyy-MM-dd") : "";
                        updateField("start_date", newStart);
                        if (
                          form.end_date &&
                          newStart &&
                          newStart > form.end_date
                        ) {
                          updateField("end_date", "");
                        }
                        setFieldErrors((prev) => {
                          const { start_date: _, end_date: __, ...rest } = prev;
                          return rest;
                        });
                      }}
                    />
                  </PopoverContent>
                </Popover>
                {fieldErrors.start_date && (
                  <p className="text-xs text-destructive mt-1">
                    {fieldErrors.start_date}
                  </p>
                )}
              </div>
              <span className="text-sm text-muted-foreground">to</span>
              <div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      disabled={!form.start_date}
                      className={`w-44 justify-start font-normal ${fieldErrors.end_date ? "border-destructive" : ""}`}
                    >
                      <CalendarIcon className="size-4 text-muted-foreground" />
                      {form.end_date ? (
                        format(parseISO(form.end_date), "dd-MMM-yyyy")
                      ) : (
                        <span className="text-muted-foreground">End date</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={
                        form.end_date ? parseISO(form.end_date) : undefined
                      }
                      defaultMonth={
                        form.end_date
                          ? parseISO(form.end_date)
                          : form.start_date
                            ? parseISO(form.start_date)
                            : undefined
                      }
                      captionLayout="dropdown"
                      disabled={(date) =>
                        form.start_date
                          ? date < parseISO(form.start_date)
                          : false
                      }
                      fromDate={
                        form.start_date ? parseISO(form.start_date) : undefined
                      }
                      endMonth={new Date(new Date().getFullYear() + 5, 11)}
                      onSelect={(date) => {
                        updateField(
                          "end_date",
                          date ? format(date, "yyyy-MM-dd") : "",
                        );
                        setFieldErrors((prev) => {
                          const { end_date: _, ...rest } = prev;
                          return rest;
                        });
                      }}
                    />
                  </PopoverContent>
                </Popover>
                {fieldErrors.end_date && (
                  <p className="text-xs text-destructive mt-1">
                    {fieldErrors.end_date}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              (You can track time outside of this date range.)
            </p>
          </div>
        </div>

        {/* Notes */}
        <div className="grid grid-cols-[180px_1fr] gap-8 pb-6 border-b">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Notes</h3>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Add Notes{" "}
                <span className="text-muted-foreground">(Optional)</span>
              </label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => updateField("description", e.target.value)}
                placeholder="Add notes about the project"
                rows={3}
              />
            </div>
          </div>
        </div>

        {/* Project Type */}
        <div className="space-y-4 pb-6 border-b">
          <h3 className="text-sm font-semibold text-foreground">
            Project Type <span className="text-destructive">*</span>
          </h3>
          {fieldErrors.project_type && (
            <p className="text-xs text-destructive">
              {fieldErrors.project_type}
            </p>
          )}
          <div className="grid grid-cols-3 gap-4">
            {PROJECT_TYPES.map((pt) => {
              const selected = form.project_type === pt.value;
              return (
                <button
                  key={pt.value}
                  type="button"
                  onClick={() => updateField("project_type", pt.value)}
                  className={`relative text-left rounded-xl border-2 p-5 transition-all ${
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-muted-foreground/40"
                  }`}
                >
                  {selected && (
                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}
                  <h4 className="font-semibold text-foreground text-center mb-1">
                    {pt.title}
                  </h4>
                  <p className="text-xs text-muted-foreground text-center">
                    {pt.subtitle}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Billable Rates */}
        {form.project_type !== "non_billable" && (
          <div className="grid grid-cols-[180px_1fr] gap-8 pb-6 border-b">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Billable rates <span className="text-destructive">*</span>
              </h3>
            </div>
            <div className="space-y-3">
              <label className="text-xs text-muted-foreground block">
                Rate Type
              </label>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rateType"
                    checked={rateType === "per_hour"}
                    onChange={() => setRateType("per_hour")}
                    className="text-primary"
                  />
                  <span className="text-sm text-foreground">Per Hour</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rateType"
                    checked={rateType === "per_day"}
                    onChange={() => setRateType("per_day")}
                    className="text-primary"
                  />
                  <span className="text-sm text-foreground">Per Day</span>
                </label>
              </div>

              <div className="grid grid-cols-[1fr_120px_1fr_auto] gap-3 items-center">
                <Select
                  value={billableOn}
                  onValueChange={(v) => setBillableOn(v as BillableOn)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">
                      Project billable rate
                    </SelectItem>
                    <SelectItem value="resource">
                      Resource billable rate
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Popover open={currencyOpen2} onOpenChange={setCurrencyOpen2}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between font-normal"
                    >
                      {form.currency || "Currency"}
                      <ChevronDown className="size-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-2" align="start">
                    <input
                      placeholder="Search currency..."
                      value={currencySearch2}
                      onChange={(e) => setCurrencySearch2(e.target.value)}
                      className="w-full mb-2 px-3 py-1.5 text-sm border rounded-md outline-none bg-background"
                    />
                    <div className="max-h-52 overflow-y-auto space-y-0.5">
                      {currencies
                        .filter(
                          (c) =>
                            c.code
                              .toLowerCase()
                              .includes(currencySearch2.toLowerCase()) ||
                            c.name
                              .toLowerCase()
                              .includes(currencySearch2.toLowerCase()),
                        )
                        .map((c) => (
                          <button
                            key={c.code}
                            type="button"
                            onClick={() => {
                              updateField("currency", c.code);
                              setCurrencyOpen2(false);
                              setCurrencySearch2("");
                            }}
                            className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-muted text-left"
                          >
                            <span className="font-medium w-12 shrink-0">
                              {c.code}
                            </span>
                            <span className="flex-1 text-muted-foreground truncate">
                              {c.name}
                            </span>
                            {form.currency === c.code && (
                              <Check className="size-3.5 text-primary shrink-0" />
                            )}
                          </button>
                        ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.billable_rate ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                    updateField("billable_rate", raw ? Number(raw) : null);
                    setFieldErrors((prev) => {
                      const { billable_rate: _, ...rest } = prev;
                      return rest;
                    });
                  }}
                  placeholder="120.00"
                  className={
                    fieldErrors.billable_rate ? "border-destructive" : ""
                  }
                />
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  per {rateType === "per_hour" ? "hour" : "day"}
                </span>
              </div>
              {fieldErrors.billable_rate && (
                <p className="text-xs text-destructive">
                  {fieldErrors.billable_rate}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                We need billable rates to track your project's billable amount.
              </p>
            </div>
          </div>
        )}

        {/* Budget */}
        <div className="grid grid-cols-[180px_1fr] gap-8">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Budget <span className="text-destructive">*</span>
            </h3>
          </div>
          <div className="space-y-3">
            <label className="text-xs text-muted-foreground block">
              Track Progress
            </label>
            <div className="flex items-center gap-3">
              <Select
                value={budgetType}
                onValueChange={(v) =>
                  setBudgetType(
                    v as "total_project_hours" | "total_project_cost",
                  )
                }
              >
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="total_project_hours">
                    Total Project Hours
                  </SelectItem>
                  <SelectItem value="total_project_cost">
                    Total Project Cost
                  </SelectItem>
                </SelectContent>
              </Select>
              {budgetType === "total_project_cost" && (
                <Input
                  value={form.currency || ""}
                  disabled
                  className="w-32"
                  placeholder="Currency"
                />
              )}
              <Input
                type="number"
                step="0.01"
                min="0"
                value={
                  (budgetType === "total_project_hours"
                    ? form.budget_hours
                    : form.budget_cost) ?? ""
                }
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw && !/^\d*\.?\d{0,2}$/.test(raw)) return;
                  const val = raw ? Number(raw) : null;
                  if (budgetType === "total_project_hours") {
                    updateField("budget_hours", val);
                    setFieldErrors((prev) => {
                      const { budget_hours: _, ...rest } = prev;
                      return rest;
                    });
                  } else {
                    updateField("budget_cost", val);
                    if (
                      val &&
                      val > 0 &&
                      (form.billable_rate == null || val > form.billable_rate)
                    ) {
                      setFieldErrors((prev) => {
                        const { budget_hours: _, ...rest } = prev;
                        return rest;
                      });
                    }
                  }
                }}
                placeholder={
                  budgetType === "total_project_hours" ? "120" : "0.00"
                }
                className={`flex-1 ${fieldErrors.budget_hours ? "border-destructive" : ""}`}
              />
            </div>
            {fieldErrors.budget_hours && (
              <p className="text-xs text-destructive">
                {fieldErrors.budget_hours}
              </p>
            )}

            <div className="flex items-center gap-3 pt-2">
              <Checkbox
                checked={emailAlert}
                onCheckedChange={(c) => setEmailAlert(!!c)}
              />
              <span className="text-sm text-foreground">
                Send email alerts if project exceeds
              </span>
              <Input
                type="number"
                step="any"
                min="0"
                max="100"
                value={alertThreshold}
                onKeyDown={(e) => {
                  if (e.key === "0") {
                    const input = e.currentTarget;
                    const selStart = input.selectionStart ?? 0;
                    const selEnd = input.selectionEnd ?? 0;
                    const remaining =
                      input.value.slice(0, selStart) +
                      input.value.slice(selEnd);
                    if (selStart === 0 && remaining.length > 0)
                      e.preventDefault();
                  }
                }}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  const clamped = isNaN(v) ? 0 : v;
                  setAlertThreshold(clamped);
                  if (clamped < 0 || clamped > 100)
                    setFieldErrors((prev) => ({
                      ...prev,
                      alertThreshold: "Must be between 0 and 100",
                    }));
                  else
                    setFieldErrors((prev) => {
                      const { alertThreshold: _, ...rest } = prev;
                      return rest;
                    });
                }}
                disabled={!emailAlert}
                className={`w-24 ${fieldErrors.alertThreshold ? "border-destructive" : ""}`}
              />
              <span className="text-sm text-muted-foreground">
                % of {budgetType === "total_project_cost" ? "budget" : "hours"}
              </span>
            </div>
            {fieldErrors.alertThreshold && (
              <p className="text-xs text-destructive">
                {fieldErrors.alertThreshold}
              </p>
            )}
            {!emailAlert ? (
              <p className="text-xs text-muted-foreground">
                No emails will be triggered.
              </p>
            ) : (
              alertHint && (
                <p className="text-xs text-muted-foreground">{alertHint}</p>
              )
            )}
            <p className="text-xs text-muted-foreground">
              Set a budget to track progress.
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={handleNavAway}>
          Cancel
        </Button>
        <Button variant="soft" onClick={handleSave} disabled={isLoading}>
          {isLoading && <Loader2 className="animate-spin" />}
          Save
        </Button>
        <Button variant="soft" onClick={handleSaveAndNext} disabled={isLoading}>
          {isLoading && <Loader2 className="animate-spin" />}
          Save &amp; Next
        </Button>
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-5 text-warning" />
              <DialogTitle>Discard changes?</DialogTitle>
            </div>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You have unsaved changes. Are you sure you want to leave? Your
            changes will be lost.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() => setDiscardOpen(false)}
            >
              Stay
            </Button>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => {
                setDiscardOpen(false);
                navigate({ to: "/timesheet/projects" });
              }}
            >
              Leave without saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ClientSheet open={clientSheetOpen} onOpenChange={setClientSheetOpen} />
    </div>
  );
};

export default ProjectSetup;
