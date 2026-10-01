import { useState, useEffect } from "react";
import { Eye, EyeOff, Save, KeyRound, User, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAppSelector, useAppDispatch } from "@/store";
import {
  useGetMeQuery,
  useGetMasterDataQuery,
  useGetDirectoryQuery,
  useGetEmployeeByUserIdQuery,
  useUpdateEmployeeMutation,
  useUpdateMeMutation,
  useChangePasswordMutation,
  useMpinRegisterMutation,
  iamApi,
} from "@/store/api/iamApi";
import type { MasterDataOption } from "@/types/iam";
import { useRegeneratePayslipPinMutation } from "@/store/api/payrollApi";
import { useAuth } from "@/hooks/use-auth";
import { setMpinDeviceToken, setMpinAccount } from "@/lib/mpin";
import { toast } from "@/lib/toast";

/** True when an RTK error is a 401 INCORRECT_PASSWORD. */
function isIncorrectPassword(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; data?: { code?: string } };
  return e.status === 401 && e.data?.code === "INCORRECT_PASSWORD";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

function toDateInputValue(iso: string | null | undefined) {
  if (!iso) return "";
  return iso.split("T")[0];
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        })
        .replace(/ /g, "-");
}

/**
 * Label of an employment master-data reference. The IAM employee record sends
 * these as `MasterDataCompact` objects; /directory sends the resolved string.
 */
function compactLabel(
  ref: { value?: string | null } | string | null | undefined,
): string {
  if (!ref) return "";
  return typeof ref === "string" ? ref : (ref.value ?? "");
}

/**
 * Value of an identity row, matched on its label — the backend stores these as
 * free-text `{ label, value }` pairs, so "Aadhaar" / "Aadhar" / "PAN Number"
 * all have to resolve.
 */
function identityValue(
  fields: { label: string; value: string }[] | undefined,
  ...needles: string[]
): string {
  const match = fields?.find((f) =>
    needles.some((n) => f.label?.toLowerCase().replace(/\s/g, "").includes(n)),
  );
  return match?.value ?? "";
}

/** A master-data reference: a bare ObjectId, or an object with the label embedded. */
type MasterRef =
  | string
  | { id?: string; _id?: string; key?: string; value?: string }
  | null
  | undefined;

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** The id of a master-data reference, whether it arrived bare or as an object. */
function masterRefId(ref: MasterRef): string {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object") return ref.id ?? ref._id ?? "";
  return "";
}

/**
 * Display label for a master-data reference. Prefers the matching option, then
 * a label embedded in the reference itself, then the raw value when it isn't an
 * opaque ObjectId — so a missing /master-data row degrades to something
 * readable instead of a silently blank field.
 */
function masterLabel(ref: MasterRef, options: MasterDataOption[]): string {
  const id = masterRefId(ref);
  if (!id) return "";
  const matched = options.find((o) => o.id === id || o.key === id);
  if (matched) return matched.value;
  if (ref && typeof ref === "object") return ref.value ?? ref.key ?? "";
  return OBJECT_ID_RE.test(id) ? "" : id;
}

/**
 * Master-data options for a category, resolvable for every user.
 *
 * Seeded categories (GENDERS, MARITAL_STATUSES) live at `organisation_id: null`,
 * so an org-scoped request can come back without the row a profile points at.
 * When the wanted id is missing from the scoped list, retry unscoped so the
 * label still resolves.
 */
function useMasterDataOptions(
  category: string,
  orgId: string | undefined,
  wantedId: string,
): MasterDataOption[] {
  const scoped = useGetMasterDataQuery({
    category,
    ...(orgId ? { organisation_id: orgId } : {}),
  });
  const scopedOptions = scoped.data ?? [];
  const resolved = scopedOptions.some(
    (o) => o.id === wantedId || o.key === wantedId,
  );
  const needsFallback =
    !!orgId && !!wantedId && !scoped.isLoading && !resolved;
  const unscoped = useGetMasterDataQuery({ category }, { skip: !needsFallback });
  if (!needsFallback) return scopedOptions;
  return unscoped.data ?? scopedOptions;
}

function getApiError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "object" && "data" in (error as object)) {
    const err = error as { data?: { detail?: string | { msg: string }[] } };
    if (typeof err.data?.detail === "string") return err.data.detail;
    if (Array.isArray(err.data?.detail))
      return err.data.detail.map((d) => d.msg).join(", ");
  }
  return "Something went wrong. Please try again.";
}

// ─── Profile Details Tab ──────────────────────────────────────────────────────

// Phone: digits only, optional leading +
const PHONE_REGEX = /^\+?[0-9]{10,15}$/;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Kept for when name editing is re-enabled.
// // Name: letters, hyphen, and spaces only (no digits or other special chars)
// const NAME_REGEX = /^[A-Za-z][A-Za-z\s-]*$/;
//
// function sanitizeNameInput(value: string) {
//   return value.replace(/[^A-Za-z\s-]/g, "");
// }

function sanitizePhoneInput(value: string) {
  const hasLeadingPlus = value.startsWith("+");
  const digits = value.replace(/[^0-9]/g, "");
  return hasLeadingPlus ? `+${digits}` : digits;
}

/** Read-only text field, matching the disabled inputs on this form. */
function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        value={value}
        placeholder="—"
        readOnly
        disabled
        className="disabled:opacity-60"
      />
    </div>
  );
}

function ProfileDetailsTab() {
  // Always pull the freshest /auth/me so the form reflects saved values even if
  // the cached session user is stale.
  useGetMeQuery();
  const user = useAppSelector((s) => s.auth.user);
  // Phone lives on the user record; personal email and emergency contact live
  // on the employee record, so saving the form can touch two endpoints.
  const [updateMe, { isLoading: savingUser }] = useUpdateMeMutation();
  const [updateEmployee, { isLoading: savingEmployee }] =
    useUpdateEmployeeMutation();
  const isLoading = savingUser || savingEmployee;
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  // /auth/me returns gender and marital_status as master-data ObjectIds, so the
  // labels have to be resolved from the GENDERS / MARITAL_STATUSES categories.
  const orgId = user?.organisation_id ?? undefined;
  const genderId = masterRefId(user?.gender);
  const maritalStatusId = masterRefId(user?.marital_status);
  const genders = useMasterDataOptions("GENDERS", orgId, genderId);
  const maritalStatuses = useMasterDataOptions(
    "MARITAL_STATUSES",
    orgId,
    maritalStatusId,
  );
  const genderLabel = masterLabel(user?.gender, genders);
  const maritalStatusLabel = masterLabel(user?.marital_status, maritalStatuses);

  // L1 / L2 manager aren't on /auth/me — they live on the IAM employee record,
  // so the caller's own row is read by user id.
  const { data: employee, isError: employeeError } = useGetEmployeeByUserIdQuery(
    user?.id ?? "",
    { skip: !user?.id },
  );

  // GET /employees/{userId} is HR-scoped, so a plain employee reading their own
  // profile can come back 403. GET /directory is the colleague-facing view any
  // authenticated user may read and carries the same resolved manager names —
  // fall back to it only when the employee record didn't yield them. Search
  // there also hits names and codes, so the row is matched on userId, not email.
  const needsDirectoryFallback =
    !!user?.email &&
    (employeeError || (!!employee && !employee.l1ManagerName && !employee.l2ManagerName));
  const { data: directory } = useGetDirectoryQuery(
    { search: user?.email ?? "", limit: 20, includeInactive: true },
    { skip: !needsDirectoryFallback },
  );
  const directoryRecord = directory?.items.find((e) => e.userId === user?.id);

  const l1ManagerName =
    employee?.l1ManagerName ?? directoryRecord?.l1Manager ?? "";
  const l2ManagerName =
    employee?.l2ManagerName ?? directoryRecord?.l2Manager ?? "";

  // Employment attributes: the HR record first, then the colleague-facing
  // /directory row, which carries the same fields already resolved to labels.
  const empCode = employee?.empCode ?? directoryRecord?.empCode ?? "";
  const department =
    employee?.departmentName ?? directoryRecord?.department ?? "";
  const dateOfJoining = formatDate(
    employee?.dateOfJoining ?? directoryRecord?.dateOfJoining,
  );
  const employmentType =
    compactLabel(employee?.employmentType) ||
    (directoryRecord?.employmentType ?? "");
  const employmentStatus =
    compactLabel(employee?.employmentStatus) ||
    (directoryRecord?.employmentStatus ?? "");

  // Personal contact, identity and emergency details exist only on the HR
  // record — /employees/{userId} is core_hr-scoped, so they stay blank for a
  // user without that permission. Nothing to fall back to: /directory
  // deliberately excludes them.
  const aadhaar = identityValue(employee?.identityFields, "aadhaar", "aadhar");
  const pan = identityValue(employee?.identityFields, "pan");

  // Personal email and emergency contact save through PUT /employees/{userId},
  // the same core_hr-scoped route this record was read from. When that read
  // failed there is nothing to write back to either, so the fields stay
  // read-only rather than offering an edit that would 403 on save.
  const canEditEmployeeFields = !!employee && !employeeError;

  const [form, setForm] = useState({
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    middle_name: user?.middle_name ?? "",
    phone: user?.phone ?? "",
    dob: toDateInputValue(user?.dob),
    gender: genderId,
    marital_status: maritalStatusId,
  });

  const [phoneError, setPhoneError] = useState<string | undefined>(undefined);

  // Employee-record fields, kept in their own state because they load from a
  // different query than `user` and save through a different endpoint.
  const [empForm, setEmpForm] = useState({
    personalEmail: "",
    contactName: "",
    contactNumber: "",
    relationship: "",
  });
  const [empErrors, setEmpErrors] = useState<{
    personalEmail?: string;
    contactName?: string;
    contactNumber?: string;
    relationship?: string;
  }>({});

  useEffect(() => {
    if (!employee) return;
    const emergency = employee.emergencyContacts?.[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmpForm({
      personalEmail: employee.personalEmail ?? "",
      contactName: emergency?.contactName ?? "",
      contactNumber: emergency?.contactNumber ?? "",
      relationship: emergency?.relationship ?? "",
    });
  }, [employee]);

  const setEmpField =
    (field: keyof typeof empForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        field === "contactNumber"
          ? sanitizePhoneInput(e.target.value)
          : e.target.value;
      setEmpForm((prev) => ({ ...prev, [field]: value }));
      setEmpErrors((prev) => ({ ...prev, [field]: undefined }));
      setSaved(false);
    };

  /**
   * Emergency contact is all-or-nothing: an entry with a name but no number is
   * worse than no entry at all, so a started row must be completed.
   */
  const validateEmployeeFields = () => {
    const next: typeof empErrors = {};
    const personalEmail = empForm.personalEmail.trim();
    if (personalEmail) {
      if (!EMAIL_REGEX.test(personalEmail))
        next.personalEmail = "Enter a valid email address.";
      else if (personalEmail.toLowerCase() === (user?.email ?? "").toLowerCase())
        next.personalEmail =
          "Personal email must be different from your work email.";
    }

    const name = empForm.contactName.trim();
    const number = empForm.contactNumber.trim();
    const relationship = empForm.relationship.trim();
    if (name || number || relationship) {
      if (!name) next.contactName = "Contact name is required.";
      if (!number) next.contactNumber = "Contact number is required.";
      else if (!PHONE_REGEX.test(number))
        next.contactNumber =
          "Enter a valid phone number (10–15 digits, optional leading +).";
      if (!relationship) next.relationship = "Relationship is required.";
    }
    return next;
  };

  const handleEmpBlur = () => setEmpErrors(validateEmployeeFields());

  // const [fieldErrors, setFieldErrors] = useState<{
  //   first_name?: string;
  //   last_name?: string;
  //   middle_name?: string;
  //   phone?: string;
  // }>({});

  useEffect(() => {
    if (user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        first_name: user.first_name,
        last_name: user.last_name,
        middle_name: user.middle_name ?? "",
        phone: user.phone ?? "",
        dob: toDateInputValue(user.dob),
        gender: masterRefId(user.gender),
        marital_status: masterRefId(user.marital_status),
      });
    }
  }, [user]);

  const setPhone = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = sanitizePhoneInput(e.target.value);
    setForm((prev) => ({ ...prev, phone: sanitized }));
    setPhoneError(undefined);
    setSaved(false);
  };

  const validatePhone = () => {
    const value = form.phone.trim();
    if (!value) return undefined;
    if (!PHONE_REGEX.test(value))
      return "Enter a valid phone number (10–15 digits, optional leading +).";
    return undefined;
  };

  const handlePhoneBlur = () => setPhoneError(validatePhone());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const err = validatePhone();
    setPhoneError(err);
    const empErrs = canEditEmployeeFields ? validateEmployeeFields() : {};
    setEmpErrors(empErrs);
    if (err || Object.values(empErrs).some(Boolean)) return;

    setSaveError("");
    setSaved(false);

    const phone = form.phone.trim();
    const personalEmail = empForm.personalEmail.trim();
    const contactName = empForm.contactName.trim();
    const contactNumber = empForm.contactNumber.trim();
    const relationship = empForm.relationship.trim();

    const savedEmergency = employee?.emergencyContacts?.[0];
    const employeeChanged =
      canEditEmployeeFields &&
      (personalEmail !== (employee?.personalEmail ?? "") ||
        contactName !== (savedEmergency?.contactName ?? "") ||
        contactNumber !== (savedEmergency?.contactNumber ?? "") ||
        relationship !== (savedEmergency?.relationship ?? ""));

    try {
      if (phone !== (user.phone ?? "")) {
        await updateMe({ phone: phone || null }).unwrap();
      }
      if (employeeChanged) {
        // The profile edits only the first contact; any others the HR record
        // holds are carried through untouched rather than dropped.
        const rest = (employee?.emergencyContacts ?? []).slice(1);
        const first =
          contactName || contactNumber || relationship
            ? [{ contactName, contactNumber, relationship }]
            : [];
        await updateEmployee({
          id: user.id,
          body: {
            personalEmail: personalEmail || null,
            emergencyContacts: [...first, ...rest],
          },
        }).unwrap();
      }
      setSaved(true);
    } catch (apiError) {
      setSaveError(getApiError(apiError));
    }
  };

  // ── Edit handlers / validation for the read-only fields ──
  // const setName =
  //   (field: "first_name" | "last_name" | "middle_name") =>
  //   (e: React.ChangeEvent<HTMLInputElement>) => {
  //     const sanitized = sanitizeNameInput(e.target.value);
  //     setForm((prev) => ({ ...prev, [field]: sanitized }));
  //     setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  //   };
  //
  // const set = (field: "dob") => (e: React.ChangeEvent<HTMLInputElement>) =>
  //   setForm((prev) => ({ ...prev, [field]: e.target.value }));
  //
  // const setSelect = (field: keyof typeof form) => (value: string) =>
  //   setForm((prev) => ({ ...prev, [field]: value }));
  //
  // const validateNameField = (
  //   field: "first_name" | "last_name" | "middle_name",
  //   label: string,
  //   required: boolean,
  // ) => {
  //   const value = form[field].trim();
  //   if (!value) {
  //     return required ? `${label} is required.` : undefined;
  //   }
  //   if (value.length < 2) return `${label} must be at least 2 characters.`;
  //   if (value.length > 50) return `${label} must be at most 50 characters.`;
  //   if (!NAME_REGEX.test(value))
  //     return `${label} can contain only letters, spaces, and hyphens.`;
  //   return undefined;
  // };
  //
  // const handleBlur =
  //   (field: "first_name" | "last_name" | "middle_name" | "phone") => () => {
  //     const next: typeof fieldErrors = { ...fieldErrors };
  //     if (field === "first_name")
  //       next.first_name = validateNameField("first_name", "First name", true);
  //     if (field === "last_name")
  //       next.last_name = validateNameField("last_name", "Last name", true);
  //     if (field === "middle_name")
  //       next.middle_name = validateNameField(
  //         "middle_name",
  //         "Middle name",
  //         false,
  //       );
  //     if (field === "phone") next.phone = validatePhone();
  //     setFieldErrors(next);
  //   };
  //
  // const handleSubmit = async (e: React.FormEvent) => {
  //   e.preventDefault();
  //   if (!user) return;
  //   const errors: typeof fieldErrors = {
  //     first_name: validateNameField("first_name", "First name", true),
  //     last_name: validateNameField("last_name", "Last name", true),
  //     middle_name: validateNameField("middle_name", "Middle name", false),
  //     phone: validatePhone(),
  //   };
  //   setFieldErrors(errors);
  //   if (Object.values(errors).some(Boolean)) return;
  //
  //   await updateMe({
  //     first_name: form.first_name.trim() || null,
  //     last_name: form.last_name.trim() || null,
  //     middle_name: form.middle_name.trim() || null,
  //     phone: form.phone.trim() || null,
  //     dob: form.dob ? `${form.dob}T00:00:00Z` : null,
  //     gender: form.gender || null,
  //     marital_status: form.marital_status || null,
  //   });
  // };

  return (
    <form onSubmit={handleSubmit}>
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b">
          <h2 className="text-sm font-medium">Profile Information</h2>
        </div>
        <CardContent className="p-5 space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <ReadOnlyField label="Employee ID" value={empCode} />
            <div className="space-y-2">
              <Label>First Name</Label>
              <Input
                value={form.first_name}
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>Last Name</Label>
              <Input
                value={form.last_name}
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>Middle Name</Label>
              <Input
                value={form.middle_name}
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input
                value={form.phone}
                onChange={setPhone}
                onBlur={handlePhoneBlur}
                type="tel"
                inputMode="tel"
                maxLength={16}
                placeholder="Enter phone number"
                disabled={isLoading}
                aria-invalid={!!phoneError}
                
              />
              {phoneError && (
                <p className="text-xs text-destructive">{phoneError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Date of Birth</Label>
              <Input
                value={form.dob}
                type="date"
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            {/* Read-only text, not a disabled <Select> — a Select renders blank
                whenever the id has no matching option, hiding data that exists. */}
            <div className="space-y-2">
              <Label>Gender</Label>
              <Input
                value={genderLabel}
                placeholder="—"
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>Marital Status</Label>
              <Input
                value={maritalStatusLabel}
                placeholder="—"
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                value={user?.email ?? ""}
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>L1 Manager</Label>
              <Input
                value={l1ManagerName}
                placeholder="—"
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <div className="space-y-2">
              <Label>L2 Manager</Label>
              <Input
                value={l2ManagerName}
                placeholder="—"
                readOnly
                disabled
                className="disabled:opacity-60"
              />
            </div>
            <ReadOnlyField label="Department" value={department} />
            <ReadOnlyField label="Date of Joining" value={dateOfJoining} />
            <ReadOnlyField label="Employment Type" value={employmentType} />
            <ReadOnlyField label="Employment Status" value={employmentStatus} />
            {canEditEmployeeFields ? (
              <div className="space-y-2">
                <Label>Personal Email</Label>
                <Input
                  value={empForm.personalEmail}
                  onChange={setEmpField("personalEmail")}
                  onBlur={handleEmpBlur}
                  type="email"
                  inputMode="email"
                  maxLength={100}
                  placeholder="Enter personal email"
                  disabled={isLoading}
                  aria-invalid={!!empErrors.personalEmail}
                />
                {empErrors.personalEmail && (
                  <p className="text-xs text-destructive">
                    {empErrors.personalEmail}
                  </p>
                )}
              </div>
            ) : (
              <ReadOnlyField label="Personal Email" value="" />
            )}
          </div>

          <div className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-medium">Identity Information</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ReadOnlyField label="Aadhaar Number" value={aadhaar} />
              <ReadOnlyField label="PAN Number" value={pan} />
            </div>
          </div>

          <div className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-medium">Emergency Contact</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {canEditEmployeeFields ? (
                <>
                  <div className="space-y-2">
                    <Label>Contact Name</Label>
                    <Input
                      value={empForm.contactName}
                      onChange={setEmpField("contactName")}
                      onBlur={handleEmpBlur}
                      maxLength={100}
                      placeholder="Enter contact name"
                      disabled={isLoading}
                      aria-invalid={!!empErrors.contactName}
                    />
                    {empErrors.contactName && (
                      <p className="text-xs text-destructive">
                        {empErrors.contactName}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Contact Number</Label>
                    <Input
                      value={empForm.contactNumber}
                      onChange={setEmpField("contactNumber")}
                      onBlur={handleEmpBlur}
                      type="tel"
                      inputMode="tel"
                      maxLength={16}
                      placeholder="Enter contact number"
                      disabled={isLoading}
                      aria-invalid={!!empErrors.contactNumber}
                    />
                    {empErrors.contactNumber && (
                      <p className="text-xs text-destructive">
                        {empErrors.contactNumber}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Relationship</Label>
                    <Input
                      value={empForm.relationship}
                      onChange={setEmpField("relationship")}
                      onBlur={handleEmpBlur}
                      maxLength={50}
                      placeholder="e.g. Spouse"
                      disabled={isLoading}
                      aria-invalid={!!empErrors.relationship}
                    />
                    {empErrors.relationship && (
                      <p className="text-xs text-destructive">
                        {empErrors.relationship}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <ReadOnlyField label="Contact Name" value="" />
                  <ReadOnlyField label="Contact Number" value="" />
                  <ReadOnlyField label="Relationship" value="" />
                </>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {canEditEmployeeFields
              ? "You can edit your phone number, personal email, and emergency contact. Contact your administrator to change any other detail."
              : "Only your phone number can be edited. Contact your administrator to change any other detail."}
          </p>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {saved && <p className="text-sm text-success">Profile updated.</p>}
        </CardContent>
        <div className="px-5 py-3.5 border-t">
          <Button type="submit" variant="default" disabled={isLoading}>
            <Save />
            {isLoading ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </Card>
    </form>
  );
}

// ─── Security Tab ─────────────────────────────────────────────────────────────

function SecurityTab() {
  const [changePassword, { isLoading, error, isSuccess }] =
    useChangePasswordMutation();
  const [regeneratePin, { isLoading: regenLoading }] =
    useRegeneratePayslipPinMutation();
  const [registerDevice, { isLoading: enabling }] = useMpinRegisterMutation();
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const isPinExists = user?.is_pin_exists ?? false;
  // SSO users have no password, so they can't confirm PIN/mPIN actions — hide them.
  const isLocalAuth = (user?.auth_method ?? "local") === "local";
  const { permissions, isOrgAdmin } = useAuth();
  // The PIN endpoints require core_hr.my_payroll (admins bypass on the backend).
  const canManagePin =
    (isOrgAdmin || (permissions.core_hr?.includes("my_payroll") ?? false)) &&
    isLocalAuth;

  // Password-confirmation dialog shared by regenerate + enable-mPIN.
  const [pwDialog, setPwDialog] = useState<null | "regenerate" | "enable">(null);
  const [pwValue, setPwValue] = useState("");
  const [pwError, setPwError] = useState("");
  const pwBusy = regenLoading || enabling;

  const openPw = (intent: "regenerate" | "enable") => {
    setPwDialog(intent);
    setPwValue("");
    setPwError("");
  };

  const submitPw = async () => {
    if (!pwValue || pwBusy) return;
    setPwError("");
    try {
      if (pwDialog === "regenerate") {
        await regeneratePin({ password: pwValue }).unwrap();
        toast.success(
          isPinExists ? "PIN regenerated" : "PIN generated",
          "Your PIN has been sent to your email.",
        );
        // Backend flips is_pin_exists on the session; refresh /me to reflect it.
        dispatch(iamApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }));
      } else {
        const { device_token } = await registerDevice({ password: pwValue }).unwrap();
        setMpinDeviceToken(device_token);
        if (user)
          setMpinAccount({
            name: `${user.first_name} ${user.last_name}`.trim(),
            email: user.email,
          });
        toast.success("Quick login enabled", "Use your Secure PIN to sign in on this device.");
      }
      setPwDialog(null);
      setPwValue("");
    } catch (err) {
      setPwError(
        isIncorrectPassword(err)
          ? "Incorrect password. Please try again."
          : "Something went wrong. Please try again.",
      );
    }
  };

  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [show, setShow] = useState({
    current: false,
    next: false,
    confirm: false,
  });
  const [clientError, setClientError] = useState("");

  const toggle = (field: keyof typeof show) => () =>
    setShow((prev) => ({ ...prev, [field]: !prev[field] }));

  const set =
    (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setClientError("");
    if (form.next.length < 8) {
      setClientError("New password must be at least 8 characters.");
      return;
    }
    if (form.next !== form.confirm) {
      setClientError("New passwords do not match.");
      return;
    }
    try {
      await changePassword({
        current_password: form.current,
        new_password: form.next,
      }).unwrap();
      setForm({ current: "", next: "", confirm: "" });
      // eslint-disable-next-line no-empty
    } catch {}
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit}>
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b">
          <h2 className="text-sm font-medium">Change Password</h2>
        </div>
        <CardContent className="p-5 space-y-5 max-w-lg">
          <div className="space-y-2">
            <Label>
              Current Password <span className="text-destructive">*</span>
            </Label>
            <PasswordInput
              value={form.current}
              onChange={set("current")}
              show={show.current}
              onToggle={toggle("current")}
              disabled={isLoading}
            />
          </div>
          <div className="space-y-2">
            <Label>
              New Password <span className="text-destructive">*</span>
            </Label>
            <PasswordInput
              value={form.next}
              onChange={set("next")}
              show={show.next}
              onToggle={toggle("next")}
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Minimum 8 characters
            </p>
          </div>
          <div className="space-y-2">
            <Label>
              Confirm New Password <span className="text-destructive">*</span>
            </Label>
            <PasswordInput
              value={form.confirm}
              onChange={set("confirm")}
              show={show.confirm}
              onToggle={toggle("confirm")}
              disabled={isLoading}
            />
          </div>
          {(clientError || error) && (
            <p className="text-sm text-destructive">
              {clientError || getApiError(error)}
            </p>
          )}
          {isSuccess && (
            <p className="text-sm text-success">
              Password changed successfully.
            </p>
          )}
        </CardContent>
        <div className="px-5 py-3.5 border-t">
          <Button type="submit" variant="default" disabled={isLoading}>
            <KeyRound />
            {isLoading ? "Updating…" : "Update Password"}
          </Button>
        </div>
      </Card>
      </form>

      {canManagePin && (
        <Card className="gap-0 py-0">
          <div className="px-5 py-3.5 border-b">
            <h2 className="text-sm font-medium">Secure PIN</h2>
          </div>
          <CardContent className="p-5 max-w-lg">
            <p className="text-sm text-muted-foreground">
              {isPinExists
                ? "Your payslip PDFs are protected with a PIN. If you've forgotten it, regenerate it — a new PIN will be emailed to you. The PIN is never shown on screen."
                : "Generate a PIN to protect your payslip PDFs. It will be emailed to you and is never shown on screen."}
            </p>
            {isPinExists && (
              <p className="mt-2 text-sm text-muted-foreground">
                Enable quick login to sign in on this device with your PIN instead of your
                password.
              </p>
            )}
          </CardContent>
          <div className="px-5 py-3.5 border-t flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => openPw("regenerate")}
            >
              <KeyRound />
              {isPinExists ? "Regenerate PIN" : "Generate PIN"}
            </Button>
            {isPinExists && (
              <Button
                type="button"
                variant="outline"
                onClick={() => openPw("enable")}
              >
                <KeyRound />
                Enable mPIN login
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Password confirmation for PIN regenerate / mPIN enrolment */}
      <Dialog
        open={!!pwDialog}
        onOpenChange={(o) => {
          if (!o) {
            setPwDialog(null);
            setPwValue("");
            setPwError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {pwDialog === "enable" ? "Enable PIN login" : "Confirm your password"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              {pwDialog === "enable"
                ? "Enter your password to enable PIN login on this device."
                : "Enter your password to continue."}
            </p>
            <div className="space-y-2">
              <Label htmlFor="pin-confirm-password">Confirm your password</Label>
              <Input
                id="pin-confirm-password"
                type="password"
                autoFocus
                value={pwValue}
                onChange={(e) => {
                  setPwValue(e.target.value);
                  if (pwError) setPwError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitPw();
                  }
                }}
                aria-invalid={!!pwError}
              />
              {pwError && <p className="text-xs text-destructive">{pwError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPwDialog(null)}
              disabled={pwBusy}
            >
              Cancel
            </Button>
            <Button onClick={() => void submitPw()} disabled={!pwValue || pwBusy}>
              {pwBusy
                ? "Please wait…"
                : pwDialog === "enable"
                  ? "Enable"
                  : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Small shared components ──────────────────────────────────────────────────

function PasswordInput({
  value,
  onChange,
  show,
  onToggle,
  disabled,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  show: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        required
        disabled={disabled}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onToggle}
        tabIndex={-1}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 h-full w-10 rounded-none text-muted-foreground hover:text-foreground hover:bg-transparent"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Profile() {
  const user = useAppSelector((s) => s.auth.user);

  const fullName = user ? `${user.first_name} ${user.last_name}` : "—";
  const initials = user ? getInitials(user.first_name, user.last_name) : "?";
  const role = user?.is_super_admin
    ? "Super Admin"
    : user?.is_org_admin
      ? "Org Admin"
      : "User";

  return (
    <div className="space-y-6">
      {/* Identity row */}
      <div className="flex items-center gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-lg font-bold ring-2 ring-primary/20">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="text-base font-semibold leading-tight">{fullName}</p>
          <p className="text-sm text-muted-foreground truncate">
            {user?.email}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Badge variant="secondary" className="text-xs">
              {role}
            </Badge>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile" className="gap-2">
            <User className="size-4" />
            Profile Details
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-2">
            <ShieldCheck className="size-4" />
            Security
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-4">
          <ProfileDetailsTab />
        </TabsContent>
        <TabsContent value="security" className="mt-4">
          <SecurityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
