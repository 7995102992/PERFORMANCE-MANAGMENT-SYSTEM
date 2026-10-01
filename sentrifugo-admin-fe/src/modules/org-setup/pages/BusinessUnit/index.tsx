import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoader } from "@/components/shared/PageLoader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { Building2, Layers, Pencil, Plus, Search } from "lucide-react";
import { toast } from "@/lib/toast";
import { BusinessUnitForm, type BusinessUnitFormRef } from "./BusinessUnitForm";
import type {
  BusinessStructure,
  BusinessUnitFormValues,
  BusinessUnitEntry,
  StructureOption,
} from "@/modules/org-setup/types/business-unit";
import { useAppDispatch, useAppSelector } from "@/store";
import { setSavedOrganisation } from "@/store/slices/organisation-slice";
import { useOrganisations } from "@/hooks/queries/use-organisation";
import {
  useBusinessUnits,
  useSaveBusinessUnit,
  useDeleteBusinessUnit,
} from "@/hooks/queries/use-business-unit";
import { organisationService, businessUnitService } from "@/api/org-setup";
import type { OrganisationResponseDTO } from "@/api/org-setup/types";
import { StatusBadge } from "@/components/shared/StatusBadge";

const structureOptions: StructureOption[] = [
  {
    value: "single",
    title: "No Business Unit / Subsidiary",
    description:
      "A single line of organisation with employees working from one office.",
    Icon: Building2,
  },
  {
    value: "multiple",
    title: "Multiple Business Units / Subsidiaries",
    description:
      "Multiple lines of business serving different markets, each with its own departments.",
    Icon: Layers,
  },
];

function SelectionScreen({
  selected,
  onSelect,
}: {
  selected: BusinessStructure | null;
  onSelect: (value: BusinessStructure) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Organisation Structure
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Choose how your organisation is structured. You can change this
            later, but existing business units will be removed.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {structureOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect(opt.value)}
              className={`group relative flex cursor-pointer items-center gap-4 rounded-lg border px-5 py-4 text-left transition-all ${
                selected === opt.value
                  ? "border-foreground/25 bg-muted/50"
                  : "border-border bg-card hover:border-foreground/20 hover:bg-muted/20"
              }`}
            >
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors ${
                  selected === opt.value
                    ? "bg-icon-bg-selected text-icon"
                    : "bg-icon-bg text-icon"
                }`}
              >
                <opt.Icon className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight text-foreground">
                  {opt.title}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  {opt.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Map an org response to the BU form's initial values.
 * Used to pre-fill the Single BU screen with the org's data.
 */
function orgToBuInitialValues(
  org: OrganisationResponseDTO,
): BusinessUnitFormValues {
  const addr = org.address;
  return {
    country: addr?.country ?? "",
    businessUnitName: org.legal_name,
    empCodePrefix: "",
    empCodeStartFrom: { fullTime: "0", contract: "0", internship: "0" },
    headName: "",
    dateOfIncorporation: org.date_of_incorporation
      ? org.date_of_incorporation.substring(0, 10)
      : "",
    ein: "",
    sector: "",
    typeOfBusiness: "",
    addressLine1: addr?.address_line_1 ?? "",
    natureOfBusiness: "",
    city: addr?.city ?? "",
    addressLine2: addr?.address_line_2 ?? "",
    zipCode: addr?.zip_code ?? "",
    state: addr?.state ?? "",
    financialYear: org.financial_year ?? "financial",
    currency: org.currency ?? "",
    timeZone: org.timezone ?? "",
    timeFormat: "12",
    isSubsidiary: false,
    isActive: true,
  };
}

const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

const ENTITY_TYPE_OPTIONS = [
  { label: "All Types", value: "all" },
  { label: "Business Unit", value: "business_unit" },
  { label: "Subsidiary", value: "subsidiary" },
];

const BU_PAGE_SIZE = 10;
const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

function MultipleBusinessUnitScreen({
  organisationId,
}: {
  organisationId: string;
}) {
  const confirm = useConfirm();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [entityFilter, setEntityFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);

  // Debounce search — 400ms delay, min 2 chars
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.length >= 2 ? search : "");
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const isActiveFilter =
    statusFilter === "all" ? undefined : statusFilter === "active";
  const isSubsidiaryFilter =
    entityFilter === "all" ? undefined : entityFilter === "subsidiary";
  const { data: remoteUnits = [], isLoading } = useBusinessUnits(
    organisationId,
    {
      search: debouncedSearch,
      limit: 100,
      is_active: isActiveFilter,
      is_subsidiary: isSubsidiaryFilter,
    },
  );
  const saveBu = useSaveBusinessUnit();

  const [editingUnit, setEditingUnit] = useState<BusinessUnitEntry | null>(
    null,
  );
  const [showForm, setShowForm] = useState(false);
  const [viewingUnit, setViewingUnit] = useState<BusinessUnitEntry | null>(
    null,
  );
  const formRef = useRef<BusinessUnitFormRef>(null);

  // Pagination
  const totalPages = Math.ceil(remoteUnits.length / BU_PAGE_SIZE);
  const paginated = remoteUnits.slice(
    (currentPage - 1) * BU_PAGE_SIZE,
    currentPage * BU_PAGE_SIZE,
  );
  const startIndex = (currentPage - 1) * BU_PAGE_SIZE + 1;
  const endIndex = Math.min(currentPage * BU_PAGE_SIZE, remoteUnits.length);

  const handleAdd = () => {
    setEditingUnit(null);
    setShowForm(true);
  };

  const handleEdit = (bu: (typeof remoteUnits)[number]) => {
    setEditingUnit({
      id: bu.id,
      hasEmployees: bu.hasEmployees ?? false,
      data: {
        country: bu.address?.country ?? "",
        businessUnitName: bu.business_unit_name,
        empCodePrefix: bu.emp_code_prefix ?? "",
        empCodeStartFrom: {
          fullTime: bu.empCodeStartFrom?.F ?? "0",
          contract: bu.empCodeStartFrom?.C ?? "0",
          internship: bu.empCodeStartFrom?.I ?? "0",
        },
        headName: bu.head_employee_name
          ? bu.head_emp_code
            ? `${bu.head_employee_name} (${bu.head_emp_code})`
            : bu.head_employee_name
          : "",
        dateOfIncorporation: bu.date_of_incorporation
          ? bu.date_of_incorporation.substring(0, 10)
          : "",
        ein: bu.ein ?? "",
        sector: bu.sector?._id ?? "",
        typeOfBusiness: bu.type_of_business?._id ?? "",
        addressLine1: bu.address?.address_line_1 ?? "",
        natureOfBusiness: bu.nature_of_business?._id ?? "",
        city: bu.address?.city ?? "",
        addressLine2: bu.address?.address_line_2 ?? "",
        zipCode: bu.address?.zip_code ?? "",
        state: bu.address?.state ?? "",
        financialYear: bu.financial_year ?? "",
        currency: bu.currency ?? "",
        timeZone: bu.time_zone ?? "",
        timeFormat: bu.time_format ?? "12",
        isSubsidiary: bu.isSubsidiary ?? false,
        isActive: bu.is_active,
      },
    });
    setShowForm(true);
  };

  const handleView = (bu: (typeof remoteUnits)[number]) => {
    setViewingUnit({
      id: bu.id,
      data: {
        country: bu.address?.country ?? "",
        businessUnitName: bu.business_unit_name,
        empCodePrefix: bu.emp_code_prefix ?? "",
        empCodeStartFrom: {
          fullTime: bu.empCodeStartFrom?.F ?? "0",
          contract: bu.empCodeStartFrom?.C ?? "0",
          internship: bu.empCodeStartFrom?.I ?? "0",
        },
        headName: bu.head_employee_name
          ? bu.head_emp_code
            ? `${bu.head_employee_name} (${bu.head_emp_code})`
            : bu.head_employee_name
          : "",
        dateOfIncorporation: bu.date_of_incorporation
          ? bu.date_of_incorporation.substring(0, 10)
          : "",
        ein: bu.ein ?? "",
        sector: bu.sector?._id ?? "",
        typeOfBusiness: bu.type_of_business?._id ?? "",
        addressLine1: bu.address?.address_line_1 ?? "",
        natureOfBusiness: bu.nature_of_business?._id ?? "",
        city: bu.address?.city ?? "",
        addressLine2: bu.address?.address_line_2 ?? "",
        zipCode: bu.address?.zip_code ?? "",
        state: bu.address?.state ?? "",
        financialYear: bu.financial_year ?? "",
        currency: bu.currency ?? "",
        timeZone: bu.time_zone ?? "",
        timeFormat: bu.time_format ?? "12",
        isSubsidiary: bu.isSubsidiary ?? false,
        isActive: bu.is_active,
      },
    });
  };

  const handleFormSave = async (data: BusinessUnitFormValues) => {
    const savedBu = await saveBu.mutateAsync({
      organisationId,
      businessUnitId: editingUnit?.id,
      values: data,
    });
    await formRef.current?.saveCustomFields(savedBu.id);
    setShowForm(false);
    setEditingUnit(null);
  };

  const handleFormCancel = () => {
    if (formRef.current?.isDirty()) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to leave?",
        confirmText: "Discard",
        onConfirm: async () => {
          setShowForm(false);
          setEditingUnit(null);
        },
      });
    } else {
      setShowForm(false);
      setEditingUnit(null);
    }
  };

  // Collect existing names (exclude the one being edited)
  const existingNames = remoteUnits
    .filter((bu) => bu.is_active && bu.id !== editingUnit?.id)
    .map((bu) => bu.business_unit_name);

  // Collect existing employee-code prefixes (exclude the one being edited)
  const existingPrefixes = remoteUnits
    .filter((bu) => bu.is_active && bu.id !== editingUnit?.id)
    .map((bu) => bu.emp_code_prefix ?? "")
    .filter(Boolean);

  if (viewingUnit) {
    return (
      <BusinessUnitForm
        mode="multiple"
        entityId={viewingUnit.id}
        initialData={viewingUnit.data}
        onSave={() => {}}
        onCancel={() => setViewingUnit(null)}
        onEdit={() => {
          const bu = remoteUnits.find((u) => u.id === viewingUnit.id);
          setViewingUnit(null);
          if (bu) handleEdit(bu);
        }}
        readOnly
      />
    );
  }

  if (showForm) {
    return (
      <BusinessUnitForm
        ref={formRef}
        mode="multiple"
        entityId={editingUnit?.id}
        initialData={editingUnit?.data}
        hasSavedBU={!!editingUnit?.id}
        hasEmployees={editingUnit?.hasEmployees ?? false}
        onSave={handleFormSave}
        onCancel={handleFormCancel}
        existingNames={existingNames}
        existingPrefixes={existingPrefixes}
        isSaving={saveBu.isPending}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold">Manage Business Units</h3>
              <p className="text-sm text-muted-foreground">
                Manage your business units and their details.
              </p>
            </div>
            <Button variant="success" onClick={handleAdd}>
              <Plus />
              Add Business Unit
            </Button>
          </div>

          {/* Search + Status filter */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-icon" />
              <Input
                placeholder="Search business units..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="w-48">
              <SearchableSelect
                options={ENTITY_TYPE_OPTIONS}
                value={entityFilter}
                onChange={(v) => {
                  setEntityFilter(v);
                  setCurrentPage(1);
                }}
                placeholder="Entity Type"
                searchable={false}
              />
            </div>
            <div className="w-48">
              <SearchableSelect
                options={STATUS_OPTIONS}
                value={statusFilter}
                onChange={(v) => {
                  setStatusFilter(v);
                  setCurrentPage(1);
                }}
                placeholder="Status"
                searchable={false}
              />
            </div>
          </div>

          {/* Table */}
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Business Unit</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10">
                      <PageLoader message="Loading business units..." />
                    </TableCell>
                  </TableRow>
                ) : paginated.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No business units found.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((bu) => (
                    <TableRow
                      key={bu.id}
                      className="cursor-pointer"
                      onClick={() => handleView(bu)}
                    >
                      <TableCell className="font-medium">
                        {bu.business_unit_name}
                      </TableCell>
                      <TableCell>{bu.currency ?? "—"}</TableCell>
                      <TableCell>{bu.address?.city ?? "—"}</TableCell>
                      <TableCell>
                        {bu.is_active ? (
                          <StatusBadge status="active" />
                        ) : (
                          <StatusBadge status="inactive" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEdit(bu);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {/* <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => handleDelete(bu.id)}>
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button> */}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {remoteUnits.length > 0 ? startIndex : 0}-{endIndex} of{" "}
              {remoteUnits.length} business units
            </p>
            {totalPages > 1 && (
              <Pagination className="mx-0 w-auto justify-end">
                <PaginationContent>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                    (page) => (
                      <PaginationItem key={page}>
                        <PaginationLink
                          href="#"
                          isActive={page === currentPage}
                          onClick={(e) => {
                            e.preventDefault();
                            setCurrentPage(page);
                          }}
                        >
                          {page}
                        </PaginationLink>
                      </PaginationItem>
                    ),
                  )}
                </PaginationContent>
              </Pagination>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SingleBusinessUnitScreen({
  organisationId,
  initialValues,
}: {
  organisationId: string;
  initialValues: BusinessUnitFormValues;
}) {
  const confirm = useConfirm();
  const saveBu = useSaveBusinessUnit();
  const deleteBu = useDeleteBusinessUnit();
  const { data: remoteUnits = [] } = useBusinessUnits(organisationId);
  const existingBu = remoteUnits.find((bu) => bu.is_active);
  const formRef = useRef<BusinessUnitFormRef>(null);

  // If BU exists, map its data to form values for editing
  const formData = existingBu
    ? {
        country: existingBu.address?.country ?? "",
        businessUnitName: existingBu.business_unit_name,
        empCodePrefix: existingBu.emp_code_prefix ?? "",
        empCodeStartFrom: {
          fullTime: existingBu.empCodeStartFrom?.F ?? "0",
          contract: existingBu.empCodeStartFrom?.C ?? "0",
          internship: existingBu.empCodeStartFrom?.I ?? "0",
        },
        headName: existingBu.head_employee_name
          ? existingBu.head_emp_code
            ? `${existingBu.head_employee_name} (${existingBu.head_emp_code})`
            : existingBu.head_employee_name
          : "",
        dateOfIncorporation: existingBu.date_of_incorporation
          ? existingBu.date_of_incorporation.substring(0, 10)
          : "",
        ein: existingBu.ein ?? "",
        sector: existingBu.sector?._id ?? "",
        typeOfBusiness: existingBu.type_of_business?._id ?? "",
        addressLine1: existingBu.address?.address_line_1 ?? "",
        natureOfBusiness: existingBu.nature_of_business?._id ?? "",
        city: existingBu.address?.city ?? "",
        addressLine2: existingBu.address?.address_line_2 ?? "",
        zipCode: existingBu.address?.zip_code ?? "",
        state: existingBu.address?.state ?? "",
        financialYear: existingBu.financial_year ?? "",
        currency: existingBu.currency ?? "",
        timeZone: existingBu.time_zone ?? "",
        timeFormat: existingBu.time_format ?? "12",
        isSubsidiary: existingBu.isSubsidiary ?? false,
        isActive: existingBu.is_active,
      }
    : initialValues;

  const handleSave = async (data: BusinessUnitFormValues) => {
    const savedBu = await saveBu.mutateAsync({
      organisationId,
      businessUnitId: existingBu?.id,
      values: data,
    });
    await formRef.current?.saveCustomFields(savedBu.id);
  };

  const handleDelete = () => {
    if (!existingBu) return;
    confirm({
      title: "Delete Business Unit?",
      description: `Are you sure you want to delete "${existingBu.business_unit_name}"? This action cannot be undone.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        await deleteBu.mutateAsync(existingBu.id);
      },
    });
  };

  return (
    <BusinessUnitForm
      ref={formRef}
      key={existingBu?.id ?? "new"}
      mode="single"
      entityId={existingBu?.id}
      initialData={formData}
      onSave={handleSave}
      onDelete={handleDelete}
      hasSavedBU={!!existingBu}
      hasEmployees={existingBu?.hasEmployees ?? false}
      isSaving={saveBu.isPending}
    />
  );
}

export function BusinessUnit() {
  const confirm = useConfirm();
  const dispatch = useAppDispatch();
  const savedOrganisation = useAppSelector(
    (s) => s.organisation.savedOrganisation,
  );
  const { data: organisations } = useOrganisations();

  // Hydrate Redux from API if empty
  useEffect(() => {
    if (!savedOrganisation && organisations?.[0]) {
      dispatch(setSavedOrganisation(organisations[0]));
    }
  }, [savedOrganisation, organisations, dispatch]);

  const org = savedOrganisation ?? organisations?.[0];

  const [structure, setStructure] = useState<BusinessStructure | null>(
    org?.is_multiple_business_units === true
      ? "multiple"
      : org?.is_multiple_business_units === false
        ? "single"
        : null,
  );

  const { data: currentBUs = [] } = useBusinessUnits(org?.id);

  const handleSelectStructure = async (value: BusinessStructure) => {
    if (!org) return;

    // Same selection — no change needed
    const isCurrentlyMultiple = org.is_multiple_business_units;
    if ((value === "multiple") === isCurrentlyMultiple && structure !== null) {
      setStructure(value);
      return;
    }

    const activeBUs = currentBUs.filter((bu) => bu.is_active);
    const currentLabel = isCurrentlyMultiple
      ? "Multiple Business Units"
      : "Single Organisation";
    const newLabel =
      value === "multiple" ? "Multiple Business Units" : "Single Organisation";

    // ── Switching Multiple → Single ──────────────────────────────────────
    if (value === "single" && isCurrentlyMultiple) {
      confirm({
        title: `Switch from ${currentLabel} to ${newLabel}?`,
        description:
          activeBUs.length > 0
            ? `You have ${activeBUs.length} active business unit${activeBUs.length > 1 ? "s" : ""}. All business units will be deleted. This action cannot be undone. Are you sure?`
            : "You are switching from Multiple Business Units to Single Organisation. Are you sure?",
        confirmText: "Yes, Delete All & Switch",
        variant: "destructive",
        onConfirm: async () => {
          try {
            // Delete all active BUs
            if (activeBUs.length > 0) {
              await businessUnitService.bulkDelete(
                activeBUs.map((bu) => bu.id),
              );
            }
            const updated = await organisationService.update(org.id, {
              is_multiple_business_units: false,
            });
            dispatch(setSavedOrganisation(updated));
            setStructure("single");
            toast.success("Switched to Single Organisation");
          } catch (err) {
            toast.error(err, "Failed to switch to single organisation");
          }
        },
      });
      return;
    }

    // ── Switching Single → Multiple ──────────────────────────────────────
    if (value === "multiple" && !isCurrentlyMultiple) {
      confirm({
        title: `Switch from ${currentLabel} to ${newLabel}?`,
        description:
          activeBUs.length > 0
            ? `You have ${activeBUs.length} business unit${activeBUs.length > 1 ? "s" : ""}. All existing business units will be deleted. Are you sure?`
            : "You are switching to Multiple Business Units. Are you sure?",
        confirmText:
          activeBUs.length > 0 ? "Yes, Delete All & Switch" : "Yes, Switch",
        variant: activeBUs.length > 0 ? "destructive" : "default",
        onConfirm: async () => {
          try {
            // Delete all existing BUs
            if (activeBUs.length > 0) {
              await businessUnitService.bulkDelete(
                activeBUs.map((bu) => bu.id),
              );
            }
            const updated = await organisationService.update(org.id, {
              is_multiple_business_units: true,
            });
            dispatch(setSavedOrganisation(updated));
            setStructure("multiple");
            toast.success("Switched to Multiple Business Units");
          } catch (err) {
            toast.error(err, "Failed to switch to multiple business units");
          }
        },
      });
      return;
    }

    // ── First time selection or 0 BUs ────────────────────────────────────
    confirm({
      title: `Switch to ${newLabel}?`,
      description: `You are switching to ${newLabel}. Are you sure you want to continue?`,
      confirmText: "Yes, Continue",
      onConfirm: async () => {
        try {
          const updated = await organisationService.update(org.id, {
            is_multiple_business_units: value === "multiple",
          });
          dispatch(setSavedOrganisation(updated));
          setStructure(value);
          toast.success(`Switched to ${newLabel}`);
        } catch (err) {
          toast.error(err, "Failed to update organisation structure");
        }
      },
    });
  };

  if (!org) {
    return (
      <div className="space-y-6 p-6">
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Please create an organisation first before setting up business
            units.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <SelectionScreen selected={structure} onSelect={handleSelectStructure} />

      {structure === "single" && (
        <SingleBusinessUnitScreen
          organisationId={org.id}
          initialValues={orgToBuInitialValues(org)}
        />
      )}
      {structure === "multiple" && (
        <MultipleBusinessUnitScreen organisationId={org.id} />
      )}
    </div>
  );
}
