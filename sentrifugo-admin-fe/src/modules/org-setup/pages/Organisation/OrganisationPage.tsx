import * as React from "react";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { ImageUploader } from "@/components/shared/ImageUploader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { DatePicker } from "@/components/shared/DatePicker";
import { TanStackFieldWrapper } from "@/components/shared/TanStackFieldWrapper";
import {
  SectionCustomFields,
  type SectionCustomFieldsRef,
} from "@/modules/org-setup/pages/Employees/SectionCustomFields";
import { organisationFormSchema } from "@/modules/org-setup/types/organisation";
import type { OrganisationFormValues } from "@/modules/org-setup/types/organisation";
import {
  Search,
  Loader2,
  Sparkles,
  Globe,
  MapPin,
  Building2,
  Pencil,
  Package,
  ShieldCheck,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModuleManagementPage } from "@/modules/org-setup/pages/ModuleManagement";
import { OrgAdminsPage } from "@/modules/org-setup/pages/OrgAdmins";
import { useRegisterWizardTabs } from "@/modules/org-setup/wizard-tab-context";
import { PageLoader } from "@/components/shared/PageLoader";
import {
  getLogoProxyUrl as getClearbitLogoUrl,
  urlToFile,
} from "@/api/external/google-places";
import { useCompanySearch } from "@/hooks/queries/use-company-search";
import { useFetchCompanyDetails } from "@/hooks/queries/use-company-details";
import {
  useOrganisations,
  useSaveOrganisation,
} from "@/hooks/queries/use-organisation";
import { organisationToFormValues } from "@/api/org-setup";
import { useAppDispatch, useAppSelector } from "@/store";
import { setSavedOrganisation } from "@/store/slices/organisation-slice";
import { toast } from "@/lib/toast";
import {
  useCountries,
  useStates,
  useCities,
  useCurrencies,
  useTimezones,
} from "@/hooks/queries/use-master-data";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import type { CompanySuggestion, CompanyData } from "@/types/company";

const FINANCIAL_YEARS = [
  { label: "Calendar Year (Jan - Dec)", value: "calendar" },
  { label: "Financial Year (Apr - Mar)", value: "financial" },
];

function validate<T>(schema: z.ZodType<T>) {
  const fn = ({ value }: { value: unknown }) => {
    const normalized = typeof value === "string" ? value.trim() : value;
    const result = schema.safeParse(normalized);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
  return { onChange: fn, onSubmit: fn };
}

function OrganisationDetailsContent() {
  const confirm = useConfirm();
  const dispatch = useAppDispatch();
  const scrollToError = useScrollToError();
  const saveOrgMutation = useSaveOrganisation();
  const { data: organisations, isLoading: orgLoading } = useOrganisations();
  const savedOrganisation = useAppSelector(
    (s) => s.organisation.savedOrganisation,
  );
  const existingOrg = savedOrganisation ?? organisations?.[0];
  const [currentOrgId, setCurrentOrgId] = React.useState<string | undefined>(
    undefined,
  );
  const [isEditing, setIsEditing] = React.useState(false);
  const customFieldsRef = React.useRef<SectionCustomFieldsRef>(null);
  const [cfDirty, setCfDirty] = React.useState(false);
  const [hasCFs, setHasCFs] = React.useState(false);
  const hasPrefilled = React.useRef(false);

  // Master data — countries, states, cities from API
  const { data: countryOptions = [] } = useCountries();
  const [selectedCountry, setSelectedCountry] = React.useState("");
  const [selectedState, setSelectedState] = React.useState("");
  const { data: stateOptions = [] } = useStates(selectedCountry);
  const { data: cityOptions = [] } = useCities(selectedCountry, selectedState);
  const { data: currencyOptions = [] } = useCurrencies(selectedCountry);
  const { data: timezoneOptions = [] } = useTimezones(selectedCountry);

  // Auto-fill currency and timezone when only one option exists for the selected country
  React.useEffect(() => {
    if (currencyOptions.length === 1 && !form.getFieldValue("currency")) {
      form.setFieldValue("currency", currencyOptions[0].value);
    }
  }, [currencyOptions]);

  React.useEffect(() => {
    if (timezoneOptions.length === 1 && !form.getFieldValue("timezone")) {
      form.setFieldValue("timezone", timezoneOptions[0].value);
    }
  }, [timezoneOptions]);

  // India follows the Apr–Mar fiscal year — auto-fill it when India is selected
  React.useEffect(() => {
    if (
      selectedCountry.trim().toLowerCase() === "india" &&
      !form.getFieldValue("financialYear")
    ) {
      form.setFieldValue("financialYear", "financial");
    }
  }, [selectedCountry]);

  // Tracks the last reset values after save so that TanStack Form's internal
  // update() cycle doesn't overwrite them with stale defaultValues.
  const [savedDefaults, setSavedDefaults] =
    React.useState<OrganisationFormValues | null>(null);

  const initialValues = React.useMemo<OrganisationFormValues>(() => {
    if (savedDefaults) return savedDefaults;
    if (!existingOrg) {
      return {
        logoFile: null,
        country: "",
        legalName: "",
        dateOfIncorporation: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        zipCode: "",
        state: "",
        financialYear: "",
        currency: "",
        timezone: "",
      };
    }
    const vals = organisationToFormValues(existingOrg);
    if (existingOrg.logo_url) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vals.logoFile = existingOrg.logo_url as any;
    }
    return vals;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingOrg?.id, savedDefaults]);

  const form = useForm({
    defaultValues: initialValues,
    // Fires when a submit is attempted but field-level validation fails.
    // Without this, onSubmit (where the other scrollToError lives) never runs
    // on invalid forms, so the page wouldn't scroll to the first error.
    onSubmitInvalid: () => scrollToError(),
    onSubmit: async ({ value }) => {
      // Pre-trim all string values and validate before proceeding
      const trimmedValue = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          typeof v === "string" ? v.trim() : v,
        ]),
      );
      const result = organisationFormSchema.safeParse(trimmedValue);
      if (!result.success) {
        toast.error(
          null,
          "Please fill all mandatory fields before submitting.",
        );
        requestAnimationFrame(() => scrollToError());
        return;
      }
      // Required custom fields must be filled before we save anything
      const cfValid = customFieldsRef.current?.validate() ?? true;
      if (!cfValid) {
        toast.error(
          null,
          "Please fill all mandatory custom fields before submitting.",
        );
        requestAnimationFrame(() => scrollToError());
        return;
      }
      confirm({
        title: currentOrgId
          ? "Update Organisation Details"
          : "Save Organisation Details",
        description: currentOrgId
          ? "Are you sure you want to update these foundational settings?"
          : "Are you sure you want to save these organisation details?",
        confirmText: currentOrgId ? "Update" : "Save",
        onConfirm: async () => {
          try {
            const saved = await saveOrgMutation.mutateAsync({
              organisationId: currentOrgId,
              values: result.data,
              existingLogoAssetId: existingOrg?.logo_asset_id,
            });
            setCurrentOrgId(saved.id);

            // Save custom field values
            await customFieldsRef.current?.saveValues(saved.id);
            setCfDirty(false);

            // PUT may not return nested address — fill it from submitted values
            const completeOrg = {
              ...saved,
              address: saved.address ?? {
                id: saved.address_id,
                country: result.data.country,
                state: result.data.state,
                city: result.data.city,
                zip_code: result.data.zipCode,
                address_line_1: result.data.addressLine1,
                address_line_2: result.data.addressLine2 || null,
              },
            };
            dispatch(setSavedOrganisation(completeOrg));

            // Reset dirty state with the new logo URL so the preview stays correct
            const resetValues = { ...value };
            if (saved.logo_url) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              resetValues.logoFile = saved.logo_url as any;
            }
            setSavedDefaults(resetValues);
            form.reset(resetValues);
            setIsEditing(false);
          } catch (err) {
            toast.error(err, "Failed to save organisation");
          }
        },
      });
    },
  });

  const formDirty = useStore(form.store, (s) => s.isDirty);
  useNavigationGuard(formDirty || cfDirty);

  // ── Sync state when existing org loads ──────────────────────────────────────
  React.useEffect(() => {
    if (!existingOrg || hasPrefilled.current) return;
    hasPrefilled.current = true;
    setCurrentOrgId(existingOrg.id);
    dispatch(setSavedOrganisation(existingOrg));

    // Sync dropdowns so states/cities load
    if (existingOrg.address?.country)
      setSelectedCountry(existingOrg.address.country);
    if (existingOrg.address?.state) setSelectedState(existingOrg.address.state);
  }, [existingOrg, dispatch]);

  // ── Company lookup state ────────────────────────────────────────────────────
  const fetchCompanyDetails = useFetchCompanyDetails();

  const [companySearch, setCompanySearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [isFetching, setIsFetching] = React.useState(false);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [fetchedCompany, setFetchedCompany] =
    React.useState<CompanyData | null>(null);
  const searchRef = React.useRef<HTMLDivElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounce search input
  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => setDebouncedSearch(companySearch),
      400,
    );
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [companySearch]);

  const { data: suggestions = [], isFetching: isSearching } =
    useCompanySearch(debouncedSearch);

  // Close suggestions on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleCompanySearchChange(value: string) {
    setCompanySearch(value);
    setFetchedCompany(null);
    setShowSuggestions(value.length >= 2);
  }

  async function handleSelectCompany(suggestion: CompanySuggestion) {
    setShowSuggestions(false);
    setCompanySearch(suggestion.label);

    if (suggestion.source === "manual") {
      setIsEditing(true);
      form.setFieldValue("legalName", suggestion.label);
      setFetchedCompany(null);
      return;
    }

    setIsFetching(true);
    const data = await fetchCompanyDetails(suggestion.id, suggestion.source);
    setIsFetching(false);
    if (!data) {
      setIsEditing(true);
      form.setFieldValue("legalName", suggestion.label);
      return;
    }

    setFetchedCompany(data);

    const doPopulate = async () => {
      setIsEditing(true);
      form.setFieldValue("legalName", data.name);

      // Map Places API country (full name OR iso2/iso3 code) to our
      // master-data country list — Google may return either form.
      const incoming = (data.country ?? "").trim().toLowerCase();
      const matchedCountry = countryOptions.find(
        (c) =>
          c.label.toLowerCase() === incoming ||
          c.iso2?.toLowerCase() === incoming ||
          c.iso3?.toLowerCase() === incoming,
      );
      const countryValue = matchedCountry?.value ?? "";

      if (countryValue) {
        form.setFieldValue("country", countryValue);
        setSelectedCountry(countryValue);
        form.setFieldValue("state", "");
        setSelectedState("");
      }

      // State / city — Places returns full names, same format our master data uses
      if (data.state) {
        form.setFieldValue("state", data.state);
        setSelectedState(data.state);
      }
      if (data.city) form.setFieldValue("city", data.city);
      if (data.address) form.setFieldValue("addressLine1", data.address);
      if (data.addressLine2)
        form.setFieldValue("addressLine2", data.addressLine2);
      if (data.postalCode) form.setFieldValue("zipCode", data.postalCode);

      const logoSrc =
        data.logoUrl || (data.website ? getClearbitLogoUrl(data.website) : "");
      if (logoSrc) {
        const file = await urlToFile(
          logoSrc,
          `${data.name.replace(/\s+/g, "_")}_logo.png`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (file) form.setFieldValue("logoFile", file as any);
      }
    };

    if (form.state.isDirty || currentOrgId) {
      confirm({
        title: "Replace current details?",
        description:
          "Selecting this company will overwrite the details you have already entered. Do you want to continue?",
        confirmText: "Yes, overwrite",
        onConfirm: doPopulate,
      });
    } else {
      await doPopulate();
    }
  }

  const handleSubmitClick = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    form.handleSubmit();
  };

  const readOnly = !!currentOrgId && !isEditing;

  function handleCancelEdit() {
    confirm({
      title: "Discard Changes?",
      description:
        "Any unsaved changes will be lost. Are you sure you want to cancel?",
      confirmText: "Discard",
      onConfirm: async () => {
        form.reset();
        customFieldsRef.current?.discardChanges();
        setCfDirty(false);
        setIsEditing(false);
      },
    });
  }

  if (orgLoading && !savedOrganisation)
    return <PageLoader message="Loading organisation..." />;

  return (
    <div className="space-y-6 p-6">
      {/* ── Company Lookup ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 overflow-visible">
        <div ref={searchRef} className="relative">
          <label className="text-sm font-medium mb-2 flex items-center gap-1.5 text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            Quick Setup — search your company to auto-fill details
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-icon pointer-events-none" />
            <Input
              placeholder="Type your company name to auto-fill details..."
              value={companySearch}
              onChange={(e) => handleCompanySearchChange(e.target.value)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              className="pl-9 pr-10"
            />
            {(isSearching || isFetching) && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Suggestions dropdown */}
          {showSuggestions && (
            <div className="absolute z-50 mt-1 w-full rounded-lg border bg-popover shadow-lg overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleSelectCompany(s)}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-accent transition-colors border-b last:border-b-0"
                >
                  <Building2 className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {s.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Fetched company info card */}
          {fetchedCompany && (
            <div className="mt-3 flex items-start gap-4 rounded-lg border bg-muted/50 p-4">
              {fetchedCompany.logoUrl && (
                <img
                  src={fetchedCompany.logoUrl}
                  alt={fetchedCompany.name}
                  className="h-12 w-12 rounded-lg object-contain bg-white border p-1 shrink-0"
                  onError={(e) => {
                    // Fallback to Clearbit logo
                    const target = e.target as HTMLImageElement;
                    if (fetchedCompany.website && !target.dataset.fallback) {
                      target.dataset.fallback = "1";
                      target.src = getClearbitLogoUrl(fetchedCompany.website);
                    } else {
                      target.style.display = "none";
                    }
                  }}
                />
              )}
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-semibold">{fetchedCompany.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {fetchedCompany.description}
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {fetchedCompany.country && (
                    <Badge variant="secondary" className="gap-1 text-[11px]">
                      <MapPin className="h-2.5 w-2.5" />
                      {fetchedCompany.city
                        ? `${fetchedCompany.city}, ${fetchedCompany.country}`
                        : fetchedCompany.country}
                    </Badge>
                  )}
                  {fetchedCompany.website && (
                    <Badge variant="secondary" className="gap-1 text-[11px]">
                      <Globe className="h-2.5 w-2.5" />
                      {fetchedCompany.website
                        .replace(/^https?:\/\//, "")
                        .replace(/\/$/, "")}
                    </Badge>
                  )}
                  {fetchedCompany.industry && (
                    <Badge variant="secondary" className="text-[11px]">
                      {fetchedCompany.industry}
                    </Badge>
                  )}
                  {fetchedCompany.foundedYear && (
                    <Badge variant="secondary" className="text-[11px]">
                      Est. {fetchedCompany.foundedYear}
                    </Badge>
                  )}
                </div>
                {fetchedCompany.address && (
                  <p className="text-xs text-muted-foreground pt-0.5">
                    {fetchedCompany.address}
                  </p>
                )}
                <p className="text-[11px] text-success font-medium pt-1">
                  ✓ Details auto-filled — name, location, address, currency,
                  timezone, logo
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Organisation Details Form ─────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Organisation Details</CardTitle>
            <CardDescription>
              Manage your organisation's foundational details.
            </CardDescription>
          </div>
          {readOnly && (
            <Button
              type="button"
              variant="soft"
              onClick={() => setIsEditing(true)}
            >
              <Pencil />
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitClick}>
            <fieldset disabled={readOnly} className="space-y-6">
              {/* Logo + identity fields */}
              <div className="flex gap-6 items-start">
                <form.Field
                  name="logoFile"
                  validators={{
                    onChange: ({ value }) =>
                      !value ? "Organisation Logo is required" : undefined,
                    onSubmit: ({ value }) =>
                      !value ? "Organisation Logo is required" : undefined,
                  }}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          Organisation Logo{" "}
                          <span className="text-destructive">*</span>
                        </>
                      }
                      className="shrink-0 w-[320px]"
                    >
                      <ImageUploader
                        value={field.state.value}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onChange={(val) => field.handleChange(val as any)}
                        maxSizeMB={2}
                        allowedTypes={["image/jpeg", "image/png", "image/jpg"]}
                        cropWidth={600}
                        cropHeight={350}
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <div className="flex-1 grid grid-cols-2 gap-4">
                  <form.Field
                    name="legalName"
                    validators={validate(
                      organisationFormSchema.shape.legalName,
                    )}
                    children={(field) => (
                      <TanStackFieldWrapper
                        field={field}
                        className="col-span-2"
                        label={
                          <>
                            Organisation Legal Name{" "}
                            <span className="text-destructive">*</span>
                          </>
                        }
                      >
                        <Input
                          placeholder="Enter legal name"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                        />
                      </TanStackFieldWrapper>
                    )}
                  />

                  <form.Field
                    name="country"
                    validators={validate(organisationFormSchema.shape.country)}
                    children={(field) => (
                      <TanStackFieldWrapper
                        field={field}
                        label={
                          <>
                            Country <span className="text-destructive">*</span>
                          </>
                        }
                      >
                        <SearchableSelect
                          options={countryOptions}
                          value={field.state.value}
                          onChange={(val) => {
                            field.handleChange(val);
                            setSelectedCountry(val);
                            setSelectedState("");
                            form.setFieldValue("state", "");
                            form.setFieldValue("city", "");
                          }}
                          placeholder="Select country"
                        />
                      </TanStackFieldWrapper>
                    )}
                  />

                  <form.Field
                    name="dateOfIncorporation"
                    validators={validate(
                      organisationFormSchema.shape.dateOfIncorporation,
                    )}
                    children={(field) => (
                      <TanStackFieldWrapper
                        field={field}
                        label={
                          <>
                            Date of Incorporation{" "}
                            <span className="text-destructive">*</span>
                          </>
                        }
                      >
                        <DatePicker
                          value={
                            field.state.value
                              ? (() => {
                                  const [y, m, d] = field.state.value
                                    .split("-")
                                    .map(Number);
                                  return new Date(y, m - 1, d);
                                })()
                              : undefined
                          }
                          onChange={(val) =>
                            field.handleChange(
                              val
                                ? `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, "0")}-${String(val.getDate()).padStart(2, "0")}`
                                : "",
                            )
                          }
                          maxDate={new Date()}
                          placeholder="Select an incorporation date"
                        />
                      </TanStackFieldWrapper>
                    )}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="col-span-full border-t pt-4">
                  <h3 className="text-xs font-semibold text-label uppercase tracking-wide">
                    Address
                  </h3>
                </div>

                <form.Field
                  name="addressLine1"
                  validators={validate(
                    organisationFormSchema.shape.addressLine1,
                  )}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      className="md:col-span-2 lg:col-span-3"
                      label={
                        <>
                          Address Line 1{" "}
                          <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <Input
                        placeholder="Street address, P.O. box, c/o"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <form.Field
                  name="addressLine2"
                  validators={validate(
                    organisationFormSchema.shape.addressLine2,
                  )}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      className="md:col-span-2 lg:col-span-3"
                      label={
                        <>
                          Address Line 2{" "}
                          <span className="text-muted-foreground font-normal whitespace-nowrap">
                            (Optional)
                          </span>
                        </>
                      }
                    >
                      <Input
                        placeholder="Apartment, suite, unit, building, floor, etc."
                        value={field.state.value || ""}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <form.Field
                  name="state"
                  validators={validate(organisationFormSchema.shape.state)}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          State / Province{" "}
                          <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <SearchableSelect
                        options={stateOptions}
                        value={field.state.value}
                        onChange={(val) => {
                          field.handleChange(val);
                          setSelectedState(val);
                          form.setFieldValue("city", "");
                        }}
                        placeholder="Select state"
                        disabled={!selectedCountry}
                        emptyMessage={
                          selectedCountry
                            ? "No states found."
                            : "Please select a country first."
                        }
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <form.Field
                  name="city"
                  validators={validate(organisationFormSchema.shape.city)}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          City <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <SearchableSelect
                        options={cityOptions}
                        value={field.state.value}
                        onChange={(val) => field.handleChange(val)}
                        placeholder="Select city"
                        disabled={!selectedState}
                        emptyMessage={
                          selectedState
                            ? "No cities found."
                            : "Please select a state first."
                        }
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <form.Field
                  name="zipCode"
                  validators={validate(organisationFormSchema.shape.zipCode)}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          Zip Code <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <Input
                        placeholder="Enter zip code"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <div className="col-span-full border-t pt-4">
                  <h3 className="text-xs font-semibold text-label uppercase tracking-wide">
                    Settings
                  </h3>
                </div>

                <form.Field
                  name="financialYear"
                  validators={validate(
                    organisationFormSchema.shape.financialYear,
                  )}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          Fiscal Year{" "}
                          <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <SearchableSelect
                        options={FINANCIAL_YEARS}
                        value={field.state.value || ""}
                        onChange={(val) => field.handleChange(val)}
                        placeholder="Select financial year type"
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <form.Field
                  name="currency"
                  validators={validate(organisationFormSchema.shape.currency)}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          Currency <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <SearchableSelect
                        options={currencyOptions}
                        value={field.state.value}
                        onChange={(val) => field.handleChange(val)}
                        placeholder={
                          selectedCountry
                            ? "Select currency"
                            : "Select country first"
                        }
                        emptyMessage={
                          selectedCountry
                            ? "No currencies found."
                            : "Please select a country first."
                        }
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                <form.Field
                  name="timezone"
                  validators={validate(organisationFormSchema.shape.timezone)}
                  children={(field) => (
                    <TanStackFieldWrapper
                      field={field}
                      label={
                        <>
                          Time Zone <span className="text-destructive">*</span>
                        </>
                      }
                    >
                      <SearchableSelect
                        options={timezoneOptions}
                        value={field.state.value}
                        onChange={(val) => field.handleChange(val)}
                        placeholder={
                          selectedCountry
                            ? "Select timezone"
                            : "Select country first"
                        }
                        emptyMessage={
                          selectedCountry
                            ? "No timezones found."
                            : "Please select a country first."
                        }
                      />
                    </TanStackFieldWrapper>
                  )}
                />

                {/* Organisation Head — read-only, managed via Assign Heads */}
                <div className="space-y-3">
                  <Label className="text-sm font-medium">
                    Organisation Head
                  </Label>
                  <Input
                    value={
                      existingOrg?.head_employee_name?.trim() || "Not assigned"
                    }
                    disabled
                    className="disabled:opacity-60"
                  />
                  <p className="text-xs text-muted-foreground">
                    Managed via Assign Heads
                  </p>
                </div>

                <div
                  className={`col-span-full ${hasCFs ? "border-t pt-6 mt-2" : ""}`}
                >
                  {hasCFs && (
                    <h3 className="text-sm font-semibold text-label uppercase tracking-wide mb-4">
                      Additional Information
                    </h3>
                  )}
                  <SectionCustomFields
                    ref={customFieldsRef}
                    entityType="organisation"
                    section="default"
                    entityId={currentOrgId}
                    onDirtyChange={setCfDirty}
                    onHasDefinitionsChange={setHasCFs}
                    readOnly={readOnly}
                  />
                </div>
              </div>
            </fieldset>

            {!readOnly && (
              <div className="flex justify-end gap-3 pt-4 border-t mt-6">
                {currentOrgId && isEditing && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancelEdit}
                  >
                    Cancel
                  </Button>
                )}
                <form.Subscribe
                  selector={(state) => [state.isSubmitting, state.isDirty]}
                  children={([isSubmitting, isDirty]) => (
                    <Button
                      type="submit"
                      variant="soft"
                      disabled={
                        saveOrgMutation.isPending ||
                        (!!currentOrgId && !isDirty && !cfDirty)
                      }
                    >
                      {isSubmitting || saveOrgMutation.isPending
                        ? currentOrgId
                          ? "Updating..."
                          : "Saving..."
                        : currentOrgId
                          ? "Update"
                          : "Save"}
                    </Button>
                  )}
                />
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tab layout ───────────────────────────────────────────────────────────────

const TABS = ["details", "modules", "org-admins"];

export function OrganisationPage() {
  const { activeTab, setActiveTab } = useRegisterWizardTabs(TABS);

  return (
    <div className="p-6">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="details" className="gap-2">
            <Building2 className="size-4" />
            Organisation Details
          </TabsTrigger>
          <TabsTrigger value="modules" className="gap-2">
            <Package className="size-4" />
            Module Management
          </TabsTrigger>
          <TabsTrigger value="org-admins" className="gap-2">
            <ShieldCheck className="size-4" />
            Organisation Admins
          </TabsTrigger>
        </TabsList>

        {/* keepMounted: preserve each tab's form/dirty state across tab switches
            so unsaved edits aren't silently discarded when switching tabs. */}
        <TabsContent value="details" keepMounted className="-mx-6 -mt-2">
          <OrganisationDetailsContent />
        </TabsContent>

        <TabsContent value="modules" keepMounted className="-mx-6 -mt-2">
          <ModuleManagementPage />
        </TabsContent>

        <TabsContent value="org-admins" keepMounted className="-mx-6 -mt-2">
          <OrgAdminsPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}
