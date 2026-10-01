import { useEffect, useMemo, useState } from "react";
import {
  Search,
  Users,
  Loader2,
  AlertCircle,
  Mail,
  Building2,
  BadgeCheck,
  Sparkles,
  GraduationCap,
  Briefcase,
  Phone,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  useGetDepartmentsQuery,
} from "@/store/api/iamApi";
import { useDirectoryPool } from "@/hooks/use-directory-pool";
import type { DirectoryEmployee } from "@/types/iam";

type StatusFilter = "active" | "inactive" | "all";

/** Every field but `userId` is nullable, so display always goes through this. */
function displayName(e: DirectoryEmployee): string {
  return (
    e.fullName?.trim() ||
    [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() ||
    e.empCode ||
    "—"
  );
}

function initials(e: DirectoryEmployee): string {
  const first = e.firstName?.[0] ?? e.fullName?.[0] ?? "";
  const last = e.lastName?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        })
        .replace(/ /g, "-");
}

/** Work phone with its extension appended, when both are present. */
function phoneWithExtension(e: DirectoryEmployee): string {
  if (!e.workPhone) return "—";
  return e.workPhoneExtension
    ? `${e.workPhone} ext. ${e.workPhoneExtension}`
    : e.workPhone;
}

function Avatar({
  employee,
  className,
  textClassName,
}: {
  employee: DirectoryEmployee;
  className: string;
  textClassName: string;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-primary font-bold ring-2 ring-primary/20 ${className}`}
    >
      {employee.avatarUrl ? (
        <img
          src={employee.avatarUrl}
          alt=""
          className="size-full object-cover"
        />
      ) : (
        <span className={textClassName}>{initials(employee)}</span>
      )}
    </div>
  );
}

/** One `Label | Value` row of the detail table. */
function InfoRow({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="grid grid-cols-[132px_1fr] border-b border-table-border last:border-b-0">
      <div className="bg-table-header px-3 py-2.5 text-xs text-muted-foreground">
        {label}
      </div>
      <div className="px-3 py-2.5 text-sm text-foreground break-words">
        {value || "—"}
      </div>
    </div>
  );
}

/** `Label : Value` line in the identity header, dotted-underlined like the
 *  employee profile screens. */
function HeaderRow({
  label,
  value,
  isEmail,
}: {
  label: string;
  value?: string | null;
  isEmail?: boolean;
}) {
  return (
    <div className="grid grid-cols-[128px_10px_1fr] items-baseline border-b border-dashed border-border py-1.5 last:border-b-0">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">:</span>
      {isEmail && value ? (
        <a
          href={`mailto:${value}`}
          className="truncate text-sm text-primary hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="truncate text-sm text-foreground">{value || "—"}</span>
      )}
    </div>
  );
}

export default function EmployeeDirectory() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [selected, setSelected] = useState<DirectoryEmployee | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: departments = [] } = useGetDepartmentsQuery({
    is_active: true,
  });

  const poolFilters = {
    search: debouncedSearch || undefined,
    // The API takes a comma-separated list; a single id is a valid list of one.
    ...(departmentId ? { departmentIds: departmentId } : {}),
  };
  const isActiveOnly = status === "active";

  // GET /directory is the colleague-facing view: any authenticated user may
  // read it, it's org-scoped server-side, and it returns no sensitive data —
  // so unlike GET /employees/ there is nothing here to withhold client-side.
  //
  // The list is unpaginated, so the whole filtered set is held here. Search and
  // department still filter server-side, so only the filtered set is drawn
  // down, never the entire directory.
  const pool = useDirectoryPool(poolFilters);

  const employees = useMemo(() => {
    if (status === "active") return pool.active;
    if (status === "inactive") return pool.inactive;
    // "All": active first, inactive after — each half keeps the server's
    // alphabetical order.
    return [...pool.active, ...pool.inactive];
  }, [status, pool.active, pool.inactive]);

  const isLoading = pool.isLoading;
  const isFetching = pool.isLoading;
  const isError = pool.isError;
  const total = employees.length;

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Employee Directory"
        subtitle="Everyone in your organisation"
      />

      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative min-w-0 max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by name, code or email..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              className="pl-9 h-9"
            />
          </div>

          <div className="w-56 shrink-0">
            <SearchableSelect
              // An explicit "All Departments" entry is how the filter is
              // cleared — the select has no separate clear affordance.
              options={[
                { label: "All Departments", value: "" },
                ...departments.map((d) => ({
                  label: d.departmentName,
                  value: d.id,
                })),
              ]}
              value={departmentId}
              onChange={(v) => {
                setDepartmentId(v as string);
              }}
              placeholder="All Departments"
              className="h-9 min-h-0"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Label
              htmlFor="directory-status"
              className="text-sm font-normal text-muted-foreground"
            >
              Status
            </Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as StatusFilter);
              }}
            >
              <SelectTrigger id="directory-status" className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isFetching && !isLoading && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && isError && (
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load the directory"
            description="Please try again."
          />
        )}

        {!isLoading && !isError && employees.length === 0 && (
          <EmptyState
            icon={Users}
            title="No employees found"
            description={
              debouncedSearch
                ? "No one matches your search."
                : status === "inactive"
                  ? "There are no inactive employees to show."
                  : "There are no employees to show yet."
            }
          />
        )}

        {!isLoading && !isError && employees.length > 0 && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
              {employees.map((e, i) => (
                <button
                  // Employee record id, not userId — a rehire shares one user
                  // across several employee rows, so userId is not unique here
                  // and duplicate keys leave stale cards behind on re-render.
                  // empCode/index only carry the load on an API too old to send
                  // `id`; they keep the keys unique rather than identifying a row.
                  key={e.id ?? `${e.userId}:${e.empCode ?? i}`}
                  type="button"
                  onClick={() => setSelected(e)}
                  className="rounded-xl border bg-card p-4 text-left hover:shadow-md hover:border-primary/30 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <Avatar
                      employee={e}
                      className="size-11"
                      textClassName="text-sm"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {displayName(e)}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {e.designation ?? "—"}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Building2 className="size-3.5 shrink-0" />
                      <span className="truncate">{e.department ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Mail className="size-3.5 shrink-0" />
                      <span className="truncate">{e.email ?? "—"}</span>
                    </div>
                    {/* Only once inactive rows can appear — otherwise every card
                        would carry a redundant "Active" line. */}
                    {!isActiveOnly && e.employmentStatus && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <BadgeCheck className="size-3.5 shrink-0" />
                        <span className="truncate">{e.employmentStatus}</span>
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* Unpaginated — the count stands in for the pager, so the list
                still says how much of the directory is on screen. */}
            <div className="border-t px-4 py-3 text-sm text-muted-foreground">
              {total} {total === 1 ? "employee" : "employees"}
            </div>
          </>
        )}
      </div>

      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          {selected && (
            <>
              {/* Identity header — avatar beside the key "Label : Value"
                  lines, mirroring the employee profile screens. */}
              <SheetHeader className="px-6 py-5 border-b">
                <SheetTitle className="sr-only">
                  {displayName(selected)}
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Employee directory details for {displayName(selected)}
                </SheetDescription>
                <div className="flex items-start gap-4">
                  <Avatar
                    employee={selected}
                    className="size-20 rounded-md ring-1 ring-border"
                    textClassName="text-xl"
                  />
                  <div className="min-w-0 flex-1 text-left">
                    <HeaderRow
                      label="Employee Name"
                      value={displayName(selected)}
                    />
                    <HeaderRow label="Employee Id" value={selected.empCode} />
                    <HeaderRow label="Email Id" value={selected.email} isEmail />
                    <HeaderRow
                      label="Contact Number"
                      value={phoneWithExtension(selected)}
                    />
                  </div>
                </div>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5">
                {/* Tab key includes the row id so switching employees resets
                    back to Official rather than keeping the previous tab. */}
                <Tabs
                  key={selected.id ?? selected.userId}
                  defaultValue="official"
                >
                  <TabsList>
                    <TabsTrigger value="official">Official</TabsTrigger>
                    <TabsTrigger value="professional">Professional</TabsTrigger>
                    <TabsTrigger value="contact">Contact</TabsTrigger>
                    <TabsTrigger value="skills">Skills</TabsTrigger>
                    <TabsTrigger value="training">
                      Training &amp; Certification
                    </TabsTrigger>
                  </TabsList>

                  {/* Two side-by-side field blocks — the panel is wide enough
                      that a single column leaves the value side stranded. */}
                  <TabsContent
                    value="official"
                    className="grid grid-cols-2 items-start gap-4 pt-4"
                  >
                    <div className="overflow-hidden rounded-xl border border-table-border">
                      <InfoRow label="Employee Id" value={selected.empCode} />
                      <InfoRow label="First Name" value={selected.firstName} />
                      <InfoRow label="Middle Name" value={selected.middleName} />
                      <InfoRow label="Last Name" value={selected.lastName} />
                      <InfoRow
                        label="Designation"
                        value={selected.designation}
                      />
                      <InfoRow
                        label="Business Unit"
                        value={selected.businessUnit}
                      />
                      <InfoRow label="Department" value={selected.department} />
                      <InfoRow label="L1 Manager" value={selected.l1Manager} />
                    </div>
                    <div className="overflow-hidden rounded-xl border border-table-border">
                      <InfoRow label="L2 Manager" value={selected.l2Manager} />
                      <InfoRow
                        label="Employment Type"
                        value={selected.employmentType}
                      />
                      <InfoRow
                        label="Employment Status"
                        value={selected.employmentStatus}
                      />
                      <InfoRow
                        label="Date of Joining"
                        value={formatDate(selected.dateOfJoining)}
                      />
                      <InfoRow
                        label="Work Telephone"
                        value={selected.workPhone}
                      />
                      <InfoRow
                        label="Extension"
                        value={selected.workPhoneExtension}
                      />
                      <InfoRow
                        label="Seat Location"
                        value={selected.seatLocation}
                      />
                    </div>
                  </TabsContent>

                  {/* GET /directory carries only the Official fields — the
                      remaining tabs stay empty until it returns their data. */}
                  <TabsContent value="professional" className="pt-4">
                    <div className="rounded-xl border border-table-border">
                      <EmptyState
                        icon={Briefcase}
                        title="No professional details"
                        description="This employee has no professional details recorded yet."
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="contact" className="pt-4">
                    <div className="rounded-xl border border-table-border">
                      <EmptyState
                        icon={Phone}
                        title="No contact details"
                        description="This employee has no additional contact details recorded yet."
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="skills" className="pt-4">
                    <div className="rounded-xl border border-table-border">
                      <EmptyState
                        icon={Sparkles}
                        title="No skills listed"
                        description="This employee has no skills recorded yet."
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="training" className="pt-4">
                    <div className="rounded-xl border border-table-border">
                      <EmptyState
                        icon={GraduationCap}
                        title="No training or certifications"
                        description="This employee has no training or certification records yet."
                      />
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
