/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Loader2,
  ChevronDown,
  Check,
  AlertTriangle,
} from "lucide-react";
import {
  useGetClientQuery,
  useCreateClientMutation,
  useUpdateClientMutation,
} from "@/store/api/timesheetApi";
import { useGetCountriesQuery, useGetStatesQuery } from "@/store/api/iamApi";
import type { ClientCreate } from "@/types/timesheet";
import { PageLoader } from "@/components/shared/PageLoader";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { PageHeader } from "@/components/shared/PageHeader";
import { toast } from "@/lib/toast";
import {
  CountryDropdown,
  type Country,
} from "@/components/ui/country-dropdown";
import { countries as allCountries } from "country-data-list";

interface PlaceSuggestion {
  id: string;
  label: string;
  description: string;
  source: "google" | "manual";
}

interface CompanyData {
  name: string;
  address: string;
  addressLine2: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  phone: string;
}

interface GoogleAddressComponent {
  longText: string;
  types: string[];
}

const PLACES_API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY as
  string | undefined;

async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  const res = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": PLACES_API_KEY!,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.types",
      },
      body: JSON.stringify({ textQuery: query, pageSize: 6 }),
    },
  );
  const data = await res.json();
  const items: PlaceSuggestion[] = (data.places ?? []).map(
    (p: {
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
    }) => ({
      id: `google:${p.id}`,
      label: p.displayName?.text ?? "",
      description: p.formattedAddress ?? "",
      source: "google" as const,
    }),
  );
  return [
    ...items,
    {
      id: "manual",
      label: query,
      description: "Continue without autofill",
      source: "manual" as const,
    },
  ];
}

async function fetchPlaceDetails(placeId: string) {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${placeId}`,
    {
      headers: {
        "X-Goog-Api-Key": PLACES_API_KEY!,
        "X-Goog-FieldMask":
          "displayName,formattedAddress,nationalPhoneNumber,addressComponents",
      },
    },
  );
  return res.json();
}

function parsePlaceDetails(
  raw: {
    displayName?: { text: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    addressComponents?: GoogleAddressComponent[];
  },
  fallbackName: string,
): CompanyData {
  const components = raw.addressComponents ?? [];
  const get = (type: string) =>
    components.find((c) => c.types.includes(type))?.longText ?? "";

  const premise = get("premise");
  const streetNumber = get("street_number");
  const route = get("route");
  const sub3 = get("sublocality_level_3");
  const sub2 = get("sublocality_level_2");
  const sub1 = get("sublocality_level_1");
  const neighborhood = get("neighborhood");
  const locality = get("locality") || get("postal_town");
  const adminLevel2 = get("administrative_area_level_2");

  const line1Parts = [premise, streetNumber, route, sub3, sub2].filter(Boolean);
  let address = line1Parts.join(", ");
  const formatted0 = (raw.formattedAddress ?? "").split(",")[0].trim();
  if (formatted0 && !address.toLowerCase().includes(formatted0.toLowerCase())) {
    address = address ? `${formatted0}, ${address}` : formatted0;
  }

  const addressLine2 = [
    sub1,
    neighborhood && neighborhood !== sub1 ? neighborhood : "",
  ]
    .filter(Boolean)
    .join(", ");

  return {
    name: raw.displayName?.text ?? fallbackName,
    address,
    addressLine2,
    city: locality || adminLevel2,
    state: get("administrative_area_level_1"),
    country: get("country"),
    postalCode: get("postal_code"),
    phone: raw.nationalPhoneNumber ?? "",
  };
}

const findDialCountryByName = (name: string): Country | undefined =>
  (allCountries.all as Country[]).find(
    (c) =>
      c.emoji &&
      c.status !== "deleted" &&
      c.name.toLowerCase() === name.toLowerCase(),
  );

const ClientForm = () => {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { clientId?: string };
  const isEdit = !!params.clientId;

  const {
    data: existingClient,
    isLoading: isLoadingClient,
    error: clientError,
  } = useGetClientQuery(params.clientId!, { skip: !isEdit });
  const [createClient, { isLoading: isCreating }] = useCreateClientMutation();
  const [updateClient, { isLoading: isUpdating }] = useUpdateClientMutation();
  const { data: countries = [] } = useGetCountriesQuery();

  const [formData, setFormData] = useState<
    Omit<ClientCreate, "status"> & { status?: boolean }
  >({
    name: "",
    contact_person: "",
    contact_email: "",
    contact_phone: "",
    address: "",
    country: "",
    state: "",
    fax: "",
    notes: "",
    portal_access_enabled: true,
    status: true,
  });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const [countrySearch, setCountrySearch] = useState("");
  const [stateSearch, setStateSearch] = useState("");
  const [countryOpen, setCountryOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [phoneCountry, setPhoneCountry] = useState<Country | undefined>(
    undefined,
  );
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isFetchingDetails, setIsFetchingDetails] = useState(false);
  const [pendingStateName, setPendingStateName] = useState<string | null>(null);
  const [overwriteDialog, setOverwriteDialog] = useState<{
    open: boolean;
    pendingData: CompanyData | null;
  }>({ open: false, pendingData: null });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedCountry = useMemo(
    () => countries.find((c) => c.name === formData.country),
    [countries, formData.country],
  );

  const { data: states = [] } = useGetStatesQuery(
    { country_id: selectedCountry?.id ?? null, limit: 300 },
    { skip: !selectedCountry },
  );

  const filteredCountries = useMemo(
    () =>
      countries.filter((c) =>
        c.name.toLowerCase().includes(countrySearch.toLowerCase()),
      ),
    [countries, countrySearch],
  );

  const filteredStates = useMemo(
    () =>
      states.filter((s) =>
        s.name.toLowerCase().includes(stateSearch.toLowerCase()),
      ),
    [states, stateSearch],
  );

  useEffect(() => {
    if (existingClient) {
      const countryName = existingClient.country ?? "";
      let dialCountry: Country | undefined;
      if (countryName) {
        dialCountry = findDialCountryByName(countryName);
        if (dialCountry) setPhoneCountry(dialCountry);
      }
      let rawPhone = existingClient.contact_phone ?? "";
      if (dialCountry && rawPhone) {
        const prefix = dialCountry.countryCallingCodes?.[0];
        if (prefix && rawPhone.startsWith(prefix)) {
          rawPhone = rawPhone.slice(prefix.length).trim();
        }
      }
      setFormData({
        name: existingClient.name,
        contact_person: existingClient.contact_person ?? "",
        contact_email: existingClient.contact_email ?? "",
        contact_phone: rawPhone,
        address: existingClient.address ?? "",
        country: countryName,
        state: existingClient.state ?? "",
        fax: existingClient.fax ?? "",
        notes: existingClient.notes ?? "",
        portal_access_enabled: existingClient.portal_access_enabled,
        status: existingClient.status === "active",
      });
    }
  }, [existingClient]);

  useEffect(() => {
    if (!pendingStateName || states.length === 0) return;
    const matched = states.find(
      (s) => s.name.toLowerCase() === pendingStateName.toLowerCase(),
    );
    updateField("state", matched?.name ?? "");
    setPendingStateName(null);
  }, [states, pendingStateName]);

  const updateField = (field: string, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  };

  const handleNavAway = () => {
    if (isDirty) {
      setDiscardOpen(true);
    } else {
      navigate({ to: "/timesheet/clients" });
    }
  };

  const scrollToFirstError = () => {
    requestAnimationFrame(() => {
      formRef.current
        ?.querySelector('[aria-invalid="true"]')
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!formData.name?.trim()) errs.name = "Client name is required";
    if (!formData.contact_person?.trim())
      errs.contact_person = "Point of contact is required";
    if (!formData.contact_email?.trim())
      errs.contact_email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contact_email.trim()))
      errs.contact_email = "Enter a valid email";
    if (!formData.contact_phone?.trim())
      errs.contact_phone = "Phone is required";
    else if (!/^\+?[\d\s\-().]{7,20}$/.test(formData.contact_phone.trim()))
      errs.contact_phone = "Enter a valid phone number";
    if (
      formData.fax?.trim() &&
      !/^\+?[\d\s\-().]{7,20}$/.test(formData.fax.trim())
    )
      errs.fax = "Enter a valid fax number";
    if (!formData.country?.trim()) errs.country = "Country is required";
    if (!formData.state?.trim()) errs.state = "State is required";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const applyPlaceData = (data: CompanyData) => {
    const fullAddress = [
      data.address,
      data.addressLine2,
      data.city,
      data.postalCode,
    ]
      .filter(Boolean)
      .join(", ");
    const matchedCountry = countries.find(
      (c) => c.name.toLowerCase() === data.country.toLowerCase(),
    );
    setFormData((prev) => ({
      ...prev,
      name: data.name,
      address: fullAddress,
      country: matchedCountry?.name ?? prev.country,
      state: "",
      ...(data.phone ? { contact_phone: data.phone } : {}),
    }));
    if (matchedCountry) {
      setPendingStateName(data.state || null);
      const dialCountry = findDialCountryByName(matchedCountry.name);
      if (dialCountry) setPhoneCountry(dialCountry);
    }
  };

  const handleNameChange = (value: string) => {
    updateField("name", value);
    clearTimeout(debounceRef.current);
    if (!PLACES_API_KEY || value.length < 2) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchPlaces(value);
        setSuggestions(results);
        setSuggestionsOpen(true);
      } catch {
        setSuggestions([]);
      } finally {
        setIsSearching(false);
      }
    }, 400);
  };

  const handleSelectSuggestion = async (s: PlaceSuggestion) => {
    setSuggestionsOpen(false);
    updateField("name", s.label);
    if (s.source === "manual") return;
    const placeId = s.id.replace("google:", "");
    const isDirty = !!(formData.address || formData.country || formData.state);
    setIsFetchingDetails(true);
    try {
      const raw = await fetchPlaceDetails(placeId);
      const data = parsePlaceDetails(raw, s.label);
      if (isDirty) {
        setOverwriteDialog({ open: true, pendingData: data });
      } else {
        applyPlaceData(data);
      }
    } catch {
      // silently fail, user can fill manually
    } finally {
      setIsFetchingDetails(false);
    }
  };

  const handleSave = async () => {
    if (!validate()) {
      scrollToFirstError();
      toast.error("Please fill in all required fields");
      return;
    }
    try {
      const { status, ...rest } = formData;
      const statusValue = status ? "active" : "inactive";
      const dialPrefix = phoneCountry?.countryCallingCodes?.[0] ?? "";
      const fullPhone =
        rest.contact_phone && dialPrefix
          ? `${dialPrefix}${rest.contact_phone}`
          : rest.contact_phone;
      const cleaned = Object.fromEntries(
        Object.entries({ ...rest, contact_phone: fullPhone }).map(([k, v]) => [
          k,
          v === "" ? null : v,
        ]),
      ) as typeof rest;
      if (isEdit && params.clientId) {
        await updateClient({
          id: params.clientId,
          body: { ...cleaned, status: statusValue },
        }).unwrap();
        toast.success("Client updated");
      } else {
        await createClient({ ...cleaned, status: statusValue }).unwrap();
        toast.success("Client created");
      }
      setIsDirty(false);
      navigate({ to: "/timesheet/clients" });
    } catch (err: unknown) {
      toast.error(err, "Failed to save client");
    }
  };

  // Clients are scoped to the caller — a 404 means deleted or not yours
  if ((clientError as { status?: number } | undefined)?.status === 404) {
    return (
      <RecordNotFound
        entity="client"
        backLabel="Back to Clients"
        onBack={() => navigate({ to: "/timesheet/clients" })}
      />
    );
  }

  if (isEdit && isLoadingClient) {
    return <PageLoader message="Loading client…" />;
  }

  return (
    <div ref={formRef} className="space-y-6 max-w-2xl mx-auto">
      <PageHeader
        title={isEdit ? "Edit Client" : "Add New Client"}
        action={
          <Button variant="outline" size="sm" onClick={handleNavAway}>
            <ArrowLeft /> Back to Clients
          </Button>
        }
      />

      <div className="space-y-8">
        {/* Client Information */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">
            Client Information
          </h2>

          <div className="space-y-2">
            <Label>
              Client Name <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <div
                className={`flex items-center border rounded-md px-3 h-9 bg-background ${fieldErrors.name ? "border-destructive" : "border-input"}`}
              >
                <input
                  value={formData.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onFocus={() => {
                    if (suggestions.length > 0) setSuggestionsOpen(true);
                  }}
                  onBlur={() =>
                    setTimeout(() => setSuggestionsOpen(false), 150)
                  }
                  placeholder="Acme Corporation"
                  aria-invalid={fieldErrors.name ? "true" : undefined}
                  className="flex-1 text-sm bg-transparent outline-none"
                />
                {(isSearching || isFetchingDetails) && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0 ml-2" />
                )}
              </div>
              {suggestionsOpen && suggestions.length > 0 && (
                <div className="absolute z-50 w-full mt-1 border rounded-md bg-popover text-popover-foreground shadow-md">
                  <div className="max-h-56 overflow-y-auto py-1">
                    {suggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSelectSuggestion(s)}
                        className="w-full text-left px-3 py-2 hover:bg-muted"
                      >
                        <div className="text-sm font-medium text-foreground">
                          {s.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {s.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {fieldErrors.name && (
              <p className="text-xs text-destructive">{fieldErrors.name}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Address</Label>
            <Textarea
              value={formData.address ?? ""}
              onChange={(e) => updateField("address", e.target.value)}
              placeholder="123 Main St, Anytown, CA 90210"
              rows={2}
              className="resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>
                Country <span className="text-destructive">*</span>
              </Label>
              <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    aria-invalid={fieldErrors.country ? "true" : undefined}
                    className={`w-full justify-between font-normal ${fieldErrors.country ? "border-destructive" : ""}`}
                  >
                    {formData.country || "Select country"}
                    <ChevronDown className="size-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-2" align="start">
                  <Input
                    placeholder="Search countries..."
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    className="mb-2"
                  />
                  <div className="max-h-48 overflow-y-auto">
                    {filteredCountries.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          updateField("country", c.name);
                          updateField("state", "");
                          setCountryOpen(false);
                          setCountrySearch("");
                          const matched = findDialCountryByName(c.name);
                          if (matched) setPhoneCountry(matched);
                        }}
                        className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-muted"
                      >
                        {c.name}
                        {formData.country === c.name && (
                          <Check className="size-4 text-primary" />
                        )}
                      </button>
                    ))}
                    {filteredCountries.length === 0 && (
                      <p className="px-2 py-3 text-sm text-muted-foreground text-center">
                        No countries found
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
              {fieldErrors.country && (
                <p className="text-xs text-destructive">
                  {fieldErrors.country}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>
                State/Province <span className="text-destructive">*</span>
              </Label>
              <Popover open={stateOpen} onOpenChange={setStateOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    aria-invalid={fieldErrors.state ? "true" : undefined}
                    className={`w-full justify-between font-normal ${fieldErrors.state ? "border-destructive" : ""}`}
                    disabled={!formData.country}
                  >
                    {formData.state || "Select state"}
                    <ChevronDown className="size-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-2" align="start">
                  <Input
                    placeholder="Search states..."
                    value={stateSearch}
                    onChange={(e) => setStateSearch(e.target.value)}
                    className="mb-2"
                  />
                  <div className="max-h-48 overflow-y-auto">
                    {filteredStates.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          updateField("state", s.name);
                          setStateOpen(false);
                          setStateSearch("");
                        }}
                        className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-muted"
                      >
                        {s.name}
                        {formData.state === s.name && (
                          <Check className="size-4 text-primary" />
                        )}
                      </button>
                    ))}
                    {filteredStates.length === 0 && (
                      <p className="px-2 py-3 text-sm text-muted-foreground text-center">
                        {formData.country
                          ? "No states found"
                          : "Select a country first"}
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
              {fieldErrors.state && (
                <p className="text-xs text-destructive">{fieldErrors.state}</p>
              )}
            </div>
          </div>

          <div className="w-1/2 pr-2 space-y-2">
            <Label>Fax (Optional)</Label>
            <Input
              value={formData.fax ?? ""}
              onChange={(e) =>
                updateField("fax", e.target.value.replace(/[^\d+\s\-().]/g, ""))
              }
              maxLength={20}
              placeholder="+1 (555) 123-4567"
              className={fieldErrors.fax ? "border-destructive" : ""}
            />
            {fieldErrors.fax && (
              <p className="text-xs text-destructive">{fieldErrors.fax}</p>
            )}
          </div>
        </section>

        {/* Contact Information */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">
            Contact Information
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>
                Email <span className="text-destructive">*</span>
              </Label>
              <Input
                type="email"
                value={formData.contact_email ?? ""}
                onChange={(e) => updateField("contact_email", e.target.value)}
                placeholder="contact@acmecorp.com"
                aria-invalid={fieldErrors.contact_email ? "true" : undefined}
                className={
                  fieldErrors.contact_email ? "border-destructive" : ""
                }
              />
              {fieldErrors.contact_email && (
                <p className="text-xs text-destructive">
                  {fieldErrors.contact_email}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>
                Phone <span className="text-destructive">*</span>
              </Label>
              <div
                className={`flex w-full rounded-md border overflow-x-auto ${fieldErrors.contact_phone ? "border-destructive" : "border-input"}`}
              >
                <div className="shrink-0 border-r border-input">
                  <CountryDropdown
                    slim
                    showCallingCode
                    onChange={setPhoneCountry}
                    defaultValue={phoneCountry?.alpha3}
                    placeholder=""
                  />
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={formData.contact_phone ?? ""}
                  onChange={(e) =>
                    updateField(
                      "contact_phone",
                      e.target.value.replace(/[^\d\s\-().]/g, ""),
                    )
                  }
                  maxLength={15}
                  placeholder="9876543210"
                  className="flex-1 w-0 px-3 py-2 text-sm bg-background outline-none"
                />
              </div>
              {fieldErrors.contact_phone && (
                <p className="text-xs text-destructive">
                  {fieldErrors.contact_phone}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>
              Point of Contact <span className="text-destructive">*</span>
            </Label>
            <Input
              value={formData.contact_person ?? ""}
              onChange={(e) => updateField("contact_person", e.target.value)}
              placeholder="Enter Point of Contact Name"
              aria-invalid={fieldErrors.contact_person ? "true" : undefined}
              className={fieldErrors.contact_person ? "border-destructive" : ""}
            />
            {fieldErrors.contact_person && (
              <p className="text-xs text-destructive">
                {fieldErrors.contact_person}
              </p>
            )}
          </div>
        </section>

        {/* Client Status */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">
            Client Status
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-foreground">Active Status</span>
            <Checkbox
              checked={formData.status}
              onCheckedChange={(checked) => updateField("status", !!checked)}
            />
          </div>
        </section>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={handleNavAway}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!formData.name || isCreating || isUpdating}
          >
            {(isCreating || isUpdating) && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </div>

      <Dialog
        open={overwriteDialog.open}
        onOpenChange={(open) => {
          if (!open) setOverwriteDialog({ open: false, pendingData: null });
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Overwrite existing details?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Address details are already filled. Replace them with the data from
            Google Places?
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() =>
                setOverwriteDialog({ open: false, pendingData: null })
              }
            >
              Keep existing
            </Button>
            <Button
              onClick={() => {
                if (overwriteDialog.pendingData)
                  applyPlaceData(overwriteDialog.pendingData);
                setOverwriteDialog({ open: false, pendingData: null });
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                navigate({ to: "/timesheet/clients" });
              }}
            >
              Leave without saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ClientForm;
