import * as React from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Download, Loader2, Pencil, Upload } from "lucide-react";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";

import { BasicDetails } from "./sections/BasicDetails";
import { WorkInfo } from "./sections/WorkInfo";
import { PersonalDetails } from "./sections/PersonalDetails";
import { IdentityInfo } from "./sections/IdentityInfo";
import { BankDetails } from "./sections/BankDetails";
import { ContactAddress } from "./sections/ContactAddress";
import { EmergencyContacts } from "./sections/EmergencyContacts";
import { WorkExperience } from "./sections/WorkExperience";
import { DependentDetails } from "./sections/DependentDetails";
import { EducationDetails } from "./sections/EducationDetails";
import {
  SectionCustomFields,
  type SectionCustomFieldsRef,
} from "@/components/shared/SectionCustomFields";
import { BulkUploadDialog } from "./BulkUploadDialog";

import { EMPTY_EMPLOYEE_FORM } from "@/types/employee";
import type { EmployeeFormValues } from "@/types/employee";
import {
  useGetBusinessUnitsQuery,
  useGetEmployeeByUserIdQuery,
  useCreateEmployeeMutation,
  useUpdateEmployeeMutation,
  useDownloadEmployeeTemplateMutation,
} from "@/store/api/iamApi";
import type { EmployeeCreateDTO, EmployeeUpdateDTO } from "@/types/iam";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { isValidPostalCode, POSTAL_CODE_MESSAGE } from "@/lib/utils";
import { useEmployeeAccess } from "@/hooks/use-employee-access";

// ─── Section keys ─────────────────────────────────────────────────────────────

type SectionKey =
  | "basic"
  | "work"
  | "personal"
  | "identity"
  | "contact"
  | "emergency"
  | "experience"
  | "dependents"
  | "education";

// ─── Validation ───────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?\d{10,15}$/;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function stripPhone(s: string): string {
  return s.replace(/[\s\-()]/g, "");
}

const INDIA_MATCHERS = ["india", "in", "ind"];

function isIndiaCountry(country: string | undefined | null): boolean {
  if (!country) return false;
  return INDIA_MATCHERS.includes(country.trim().toLowerCase());
}

const AADHAAR_LABEL = "Aadhaar Number";
const PAN_LABEL = "PAN Number";

// Current Experience (years) is derived from Date of Joining, counted up to
// Date of Exit when the employee has left, otherwise to today. Returns '' when
// there's no joining date. Rounded to 1 decimal place.
function deriveCurrentExp(dateOfJoining: string, dateOfExit: string): string {
  if (!dateOfJoining) return "";
  const start = new Date(dateOfJoining);
  if (isNaN(start.getTime())) return "";
  const end = dateOfExit ? new Date(dateOfExit) : new Date();
  if (isNaN(end.getTime())) return "";
  const years =
    (end.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return "0";
  return (Math.round(years * 10) / 10).toString();
}

function validate(
  values: EmployeeFormValues,
  buCountry: string | null,
): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};

  // Basic Details (emp_code is server-generated)
  if (!values.workEmail.trim()) errors.workEmail = "Work email is required";
  else if (!EMAIL_REGEX.test(values.workEmail.trim()))
    errors.workEmail = "Enter a valid email address";
  if (!values.firstName.trim()) errors.firstName = "First name is required";
  if (!values.lastName.trim()) errors.lastName = "Last name is required";

  // Work Info
  if (!values.businessUnit) errors.businessUnit = "Business unit is required";
  if (!values.department) errors.department = "Department is required";
  if (!values.designation) errors.designation = "Designation is required";
  if (values.currentExp.trim()) {
    if (isNaN(Number(values.currentExp)) || Number(values.currentExp) < 0)
      errors.currentExp = "Must be a non-negative number";
    else if (Number(values.currentExp) > 70)
      errors.currentExp = "Current experience seems too high";
  }
  if (values.totalExp.trim()) {
    if (isNaN(Number(values.totalExp)) || Number(values.totalExp) < 0)
      errors.totalExp = "Must be a non-negative number";
    else if (Number(values.totalExp) > 70)
      errors.totalExp = "Total experience seems too high";
  }
  if (
    values.currentExp.trim() &&
    values.totalExp.trim() &&
    !isNaN(Number(values.currentExp)) &&
    !isNaN(Number(values.totalExp)) &&
    Number(values.currentExp) > Number(values.totalExp)
  ) {
    errors.totalExp = "Total experience cannot be less than current experience";
  }
  if (!values.role) errors.role = "Role is required";
  if (!values.employmentType)
    errors.employmentType = "Employment type is required";
  if (!values.employmentStatus)
    errors.employmentStatus = "Employment status is required";
  if (!values.workType) errors.workType = "Work type is required";
  if (!values.projectStatus)
    errors.projectStatus = "Project status is required";
  // Compensation — ctc & currency are paired: if one is provided, the other becomes required
  if (values.ctc.trim()) {
    if (isNaN(Number(values.ctc)) || Number(values.ctc) < 0)
      errors.ctc = "CTC must be a non-negative number";
    if (!values.currency)
      errors.currency = "Currency is required when CTC is provided";
  }
  if (values.currency && !values.ctc.trim())
    errors.ctc = "CTC is required when currency is selected";
  if (values.dateOfJoining && values.dateOfJoining > todayISO())
    errors.dateOfJoining = "Date of joining cannot be in the future";
  if (values.dateOfExit) {
    if (values.dateOfJoining && values.dateOfExit < values.dateOfJoining) {
      errors.dateOfExit = "Date of exit cannot be before date of joining";
    } else if (values.dateOfExit > todayISO()) {
      errors.dateOfExit = "Date of exit cannot be in the future";
    }
  }

  // L1 / L2 managers are fully optional now — the user can pick a manager or
  // the explicit "Not Applicable" option. No hierarchy-driven requirement.

  // Emergency contacts — optional, but a started row must be completed.
  values.emergencyContacts.forEach((c, i) => {
    const hasAny =
      c.contactName.trim() || c.contactNumber.trim() || c.relationship.trim();
    if (!hasAny) return;
    if (!c.contactName.trim())
      errors[`emergencyContacts.${i}.contactName`] = "Name is required";
    if (!c.contactNumber.trim())
      errors[`emergencyContacts.${i}.contactNumber`] = "Number is required";
    if (!c.relationship.trim())
      errors[`emergencyContacts.${i}.relationship`] =
        "Relationship is required";
  });

  // Personal — DOB optional, but validate when provided.
  if (values.dob) {
    if (values.dob >= todayISO())
      errors.dob = "Date of birth must be in the past";
    else {
      const [by, bm, bd] = values.dob.split("-").map(Number);
      const birth = new Date(by, bm - 1, bd);
      const today = new Date();
      let age = today.getFullYear() - birth.getFullYear();
      const mDiff = today.getMonth() - birth.getMonth();
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < birth.getDate()))
        age--;
      if (age < 18) errors.dob = "Employee must be at least 18 years old";
      if (values.dateOfJoining && values.dob >= values.dateOfJoining) {
        errors.dob = "Date of birth must be before date of joining";
      }
    }
  }
  if (!values.gender) errors.gender = "Gender is required";
  if (!values.maritalStatus)
    errors.maritalStatus = "Marital status is required";

  // Identity — optional; validate format only when a value is provided.
  if (values.businessUnit && isIndiaCountry(buCountry)) {
    const aadhaar = values.identityFields
      .find((f) => f.label === AADHAAR_LABEL)
      ?.value?.trim();
    const pan = values.identityFields
      .find((f) => f.label === PAN_LABEL)
      ?.value?.trim();
    if (aadhaar && !/^\d{12}$/.test(aadhaar))
      errors.aadhaar = "Aadhaar must be 12 digits";
    if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan))
      errors.pan = "PAN must be in format ABCDE1234F";
  }

  // Contact — optional; validate format only when provided.
  if (
    values.personalPhone.trim() &&
    !PHONE_REGEX.test(stripPhone(values.personalPhone.trim()))
  ) {
    errors.personalPhone = "Phone must be 10–15 digits";
  }
  if (
    values.workPhone.trim() &&
    !PHONE_REGEX.test(stripPhone(values.workPhone.trim()))
  ) {
    errors.workPhone = "Work phone must be 10–15 digits";
  }
  if (values.personalEmail.trim()) {
    if (!EMAIL_REGEX.test(values.personalEmail.trim()))
      errors.personalEmail = "Enter a valid email address";
    else if (
      values.workEmail.trim() &&
      values.workEmail.trim().toLowerCase() ===
        values.personalEmail.trim().toLowerCase()
    ) {
      errors.personalEmail = "Personal email must be different from work email";
    }
  }

  // Addresses — optional; if a block is started, its core fields are required.
  for (const addrKey of ["permanentAddress", "presentAddress"] as const) {
    if (addrKey === "presentAddress" && values.sameAsPermanent) continue;
    const a = values[addrKey];
    const started =
      a.addressLine1.trim() ||
      a.country.trim() ||
      a.state.trim() ||
      a.city.trim() ||
      a.postalCode.trim();
    if (!started) continue;
    if (!a.addressLine1.trim())
      errors[`${addrKey}.addressLine1`] = "Address line 1 is required";
    if (!a.country.trim()) errors[`${addrKey}.country`] = "Country is required";
    if (!a.state.trim()) errors[`${addrKey}.state`] = "State is required";
    if (!a.city.trim()) errors[`${addrKey}.city`] = "City is required";
    if (!a.postalCode.trim())
      errors[`${addrKey}.postalCode`] = "Postal code is required";
    else if (!isValidPostalCode(a.postalCode))
      errors[`${addrKey}.postalCode`] = POSTAL_CODE_MESSAGE;
  }

  // Bank Details — optional; account & IFSC are paired (holder/bank name alone
  // don't force them). If either identifier is entered, both are required.
  const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  const ACCOUNT_NO_REGEX = /^\d{9,18}$/;
  const acct = values.bankDetails.accountNumber.trim();
  const ifsc = values.bankDetails.ifscCode.trim();
  if (acct || ifsc) {
    if (!acct) errors.bankAccountNumber = "Account number is required";
    else if (!ACCOUNT_NO_REGEX.test(acct))
      errors.bankAccountNumber = "Account number must be 9–18 digits";
    if (!ifsc) errors.bankIfscCode = "IFSC code is required";
    else if (!IFSC_REGEX.test(ifsc))
      errors.bankIfscCode =
        "IFSC code must be in format ABCD0123456 (e.g. SBIN0001234)";
  }

  // Work Experience — if any field filled, all fields required
  values.workExperience.forEach((row, i) => {
    const hasAny =
      row.companyName.trim() ||
      row.jobTitle.trim() ||
      row.fromDate ||
      row.toDate ||
      row.jobDescription.trim() ||
      row.relevant;
    if (!hasAny) return;
    if (!row.companyName.trim())
      errors[`workExperience.${i}.companyName`] = "Company name is required";
    if (!row.jobTitle.trim())
      errors[`workExperience.${i}.jobTitle`] = "Job title is required";
    if (!row.fromDate)
      errors[`workExperience.${i}.fromDate`] = "From date is required";
    if (!row.toDate)
      errors[`workExperience.${i}.toDate`] = "To date is required";
    else if (row.toDate > todayISO())
      errors[`workExperience.${i}.toDate`] = "To date cannot be in the future";
    if (row.fromDate && row.toDate && row.fromDate >= row.toDate) {
      errors[`workExperience.${i}.fromDate`] =
        "From date must be before to date";
    }
    if (
      row.fromDate &&
      values.dateOfJoining &&
      row.toDate > values.dateOfJoining
    ) {
      errors[`workExperience.${i}.toDate`] =
        "Previous experience end date must be before date of joining";
    }
    if (!row.jobDescription.trim())
      errors[`workExperience.${i}.jobDescription`] =
        "Job description is required";
    if (!row.relevant)
      errors[`workExperience.${i}.relevant`] = "Relevant is required";
  });

  // Dependents — if any field filled, all fields required
  values.dependents.forEach((row, i) => {
    const hasAny = row.name.trim() || row.relationship || row.dateOfBirth;
    if (!hasAny) return;
    if (!row.name.trim()) errors[`dependents.${i}.name`] = "Name is required";
    if (!row.relationship)
      errors[`dependents.${i}.relationship`] = "Relationship is required";
    if (!row.dateOfBirth)
      errors[`dependents.${i}.dateOfBirth`] = "Date of birth is required";
    else if (row.dateOfBirth > todayISO())
      errors[`dependents.${i}.dateOfBirth`] =
        "Date of birth cannot be in the future";
  });

  // Education — if any field filled, all fields required
  values.education.forEach((row, i) => {
    const hasAny =
      row.instituteName.trim() ||
      row.degree.trim() ||
      row.specialization.trim() ||
      row.dateOfCompletion;
    if (!hasAny) return;
    if (!row.instituteName.trim())
      errors[`education.${i}.instituteName`] = "Institute name is required";
    if (!row.degree.trim())
      errors[`education.${i}.degree`] = "Degree is required";
    if (!row.specialization.trim())
      errors[`education.${i}.specialization`] = "Specialization is required";
    if (!row.dateOfCompletion)
      errors[`education.${i}.dateOfCompletion`] =
        "Date of completion is required";
    else if (row.dateOfCompletion > todayISO())
      errors[`education.${i}.dateOfCompletion`] =
        "Date of completion cannot be in the future";
  });

  return errors;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmployeeForm() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const scrollToError = useScrollToError();
  const [createEmp, createState] = useCreateEmployeeMutation();
  const [updateEmp, updateState] = useUpdateEmployeeMutation();
  const [downloadTemplate, downloadState] =
    useDownloadEmployeeTemplateMutation();
  const { data: remoteBUs = [] } = useGetBusinessUnitsQuery(undefined);

  // ── Edit mode: read ?id=... from URL ─────────────────────────────────────
  const search = useSearch({ strict: false }) as {
    id?: string;
    view?: boolean;
  };
  const editId = search?.id ?? null;
  const isEdit = !!editId;
  // Viewers are pinned to read-only regardless of the URL — `?view` is just a
  // search param, so without this anyone holding core_hr:resource_management at
  // viewer level could hand-edit it away and get an editable form. The writes
  // would 403, but only after they had filled the whole thing in.
  // The level comes from `GET /employees/resources`, i.e. the server reading
  // its own guards, so this form unlocks on exactly the condition the PUT
  // accepts.
  const { canEdit } = useEmployeeAccess();
  const isViewMode = !!search?.view || !canEdit;
  const { data: existingEmp, isLoading: isEmpLoading } =
    useGetEmployeeByUserIdQuery(editId ?? "", { skip: !editId });

  const [values, setValues] = React.useState<EmployeeFormValues>({
    ...EMPTY_EMPLOYEE_FORM,
  });
  const [errors, setErrors] = React.useState<Partial<Record<string, string>>>(
    {},
  );
  const [submitted, setSubmitted] = React.useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = React.useState(false);
  const [isFormDirty, setIsFormDirty] = React.useState(false);
  const [cfDirty, setCfDirty] = React.useState(false);
  useNavigationGuard(isFormDirty || cfDirty);
  const cfDirtySet = React.useRef<Set<string>>(new Set());
  const [sectionHasCFs, setSectionHasCFs] = React.useState<
    Record<string, boolean>
  >({});
  const hasPrefilled = React.useRef(false);
  const sectionCFRefs = React.useRef<Map<string, SectionCustomFieldsRef>>(
    new Map(),
  );

  // Pre-fill when existing employee data loads
  React.useEffect(() => {
    if (!existingEmp || hasPrefilled.current) return;
    hasPrefilled.current = true;

    // Master-data references arrive as either the compact object or a bare id.
    const refId = (ref: unknown): string =>
      ref && typeof ref === "object"
        ? ((ref as { _id?: string })._id ?? "")
        : ((ref as string | null | undefined) ?? "");

    setValues({
      workEmail: existingEmp.workEmail,
      firstName: existingEmp.firstName,
      middleName: existingEmp.middleName ?? "",
      lastName: existingEmp.lastName,
      businessUnit: existingEmp.businessUnitId,
      department: existingEmp.departmentId,
      designation: existingEmp.designationId,
      role: existingEmp.policies?.[0]?.id ?? "",
      sourceOfHire: refId(existingEmp.sourceOfHire),
      l1Manager: existingEmp.l1ManagerId ?? "",
      l2Manager: existingEmp.l2ManagerId ?? "",
      currentExp:
        existingEmp.currentExp != null ? String(existingEmp.currentExp) : "",
      totalExp:
        existingEmp.totalExp != null ? String(existingEmp.totalExp) : "",
      employmentType: refId(existingEmp.employmentType),
      employmentStatus: refId(existingEmp.employmentStatus),
      workType: existingEmp.workType ?? "",
      projectStatus: refId(existingEmp.projectStatus),
      dateOfJoining: existingEmp.dateOfJoining ?? "",
      dateOfExit: existingEmp.dateOfExit ?? "",
      ctc: existingEmp.ctc != null ? String(existingEmp.ctc) : "",
      currency: existingEmp.currency ?? "",
      dob: existingEmp.dob ?? "",
      gender: refId(existingEmp.gender),
      maritalStatus: refId(existingEmp.maritalStatus),
      aboutMe: existingEmp.aboutMe ?? "",
      identityFields: existingEmp.identityFields ?? [],
      workPhoneExtension: existingEmp.workPhoneExtension ?? "",
      workPhone: existingEmp.workPhone ?? "",
      personalPhone: existingEmp.personalPhone ?? "",
      personalEmail: existingEmp.personalEmail ?? "",
      seatLocation: existingEmp.seatLocation ?? "",
      permanentAddress: {
        addressLine1: existingEmp.permanentAddress?.address_line_1 ?? "",
        addressLine2: existingEmp.permanentAddress?.address_line_2 ?? "",
        city: existingEmp.permanentAddress?.city ?? "",
        country: existingEmp.permanentAddress?.country ?? "",
        state: existingEmp.permanentAddress?.state ?? "",
        postalCode: existingEmp.permanentAddress?.zip_code ?? "",
      },
      presentAddress: {
        addressLine1: existingEmp.presentAddress?.address_line_1 ?? "",
        addressLine2: existingEmp.presentAddress?.address_line_2 ?? "",
        city: existingEmp.presentAddress?.city ?? "",
        country: existingEmp.presentAddress?.country ?? "",
        state: existingEmp.presentAddress?.state ?? "",
        postalCode: existingEmp.presentAddress?.zip_code ?? "",
      },
      sameAsPermanent: existingEmp.sameAsPermanent ?? false,
      emergencyContacts:
        (existingEmp.emergencyContacts ?? []).length > 0
          ? existingEmp.emergencyContacts!.map((c) => ({
              contactName: c.contactName,
              contactNumber: c.contactNumber,
              relationship: c.relationship,
            }))
          : [{ contactName: "", contactNumber: "", relationship: "" }],
      workExperience: (existingEmp.workExperience ?? []).map((w) => ({
        companyName: w.companyName,
        jobTitle: w.jobTitle,
        fromDate: w.fromDate ?? "",
        toDate: w.toDate ?? "",
        jobDescription: w.jobDescription ?? "",
        relevant: w.relevant ?? "",
      })),
      dependents: (existingEmp.dependents ?? []).map((d) => ({
        name: d.name,
        relationship: d.relationship,
        dateOfBirth: d.dateOfBirth ?? "",
      })),
      education: (existingEmp.education ?? []).map((e) => ({
        instituteName: e.instituteName,
        degree: e.degree,
        specialization: e.specialization ?? "",
        dateOfCompletion: e.dateOfCompletion ?? "",
      })),
      bankDetails: {
        accountHolderName: existingEmp.bankDetails?.accountHolderName ?? "",
        accountNumber: existingEmp.bankDetails?.accountNumber ?? "",
        ifscCode: existingEmp.bankDetails?.ifscCode ?? "",
        bankName: existingEmp.bankDetails?.bankName ?? "",
      },
    });
  }, [existingEmp]);

  // ── Form field change ──────────────────────────────────────────────────────

  function handleChange<K extends keyof EmployeeFormValues>(
    key: K,
    value: EmployeeFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setIsFormDirty(true);
    if (submitted) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  // Current Experience is read-only and auto-derived from Date of Joining
  // (up to Date of Exit when the employee has left, otherwise today).
  React.useEffect(() => {
    const derived = deriveCurrentExp(values.dateOfJoining, values.dateOfExit);
    setValues((prev) =>
      prev.currentExp === derived ? prev : { ...prev, currentExp: derived },
    );
  }, [values.dateOfJoining, values.dateOfExit]);

  function handleCfDirtyChange(section: string, dirty: boolean) {
    if (dirty) cfDirtySet.current.add(section);
    else cfDirtySet.current.delete(section);
    setCfDirty(cfDirtySet.current.size > 0);
  }

  async function handleDownloadTemplate() {
    try {
      const blob = await downloadTemplate().unwrap();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "employee-bulk-template.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Template downloaded");
    } catch (err) {
      toast.error(err);
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    setSubmitted(true);

    const selectedBU = remoteBUs.find((bu) => bu.id === values.businessUnit);
    const buCountry = selectedBU?.address?.country ?? null;
    const validationErrors = validate(values, buCountry);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      scrollToError();
      return;
    }

    // Required custom fields across every section must pass before we hit the API
    const cfRefs = Array.from(sectionCFRefs.current.values());
    const cfAllValid = cfRefs.map((r) => r.validate()).every(Boolean);
    if (!cfAllValid) {
      scrollToError();
      return;
    }

    confirm({
      title: isEdit ? "Update Employee" : "Add Employee",
      description: isEdit
        ? "Save changes to this employee record?"
        : "Are you sure you want to save this employee record?",
      confirmText: isEdit ? "Update" : "Save Employee",
      onConfirm: async () => {
        const payload: EmployeeCreateDTO = {
          workEmail: values.workEmail,
          firstName: values.firstName,
          middleName: values.middleName || null,
          lastName: values.lastName,
          businessUnitId: values.businessUnit,
          departmentId: values.department,
          designationId: values.designation,
          roleIds: values.role ? [values.role] : [],
          sourceOfHire: values.sourceOfHire || null,
          // "not-applicable" is the explicit no-manager choice → persist as null.
          l1ManagerId:
            values.l1Manager && values.l1Manager !== "not-applicable"
              ? values.l1Manager
              : null,
          l2ManagerId:
            values.l2Manager && values.l2Manager !== "not-applicable"
              ? values.l2Manager
              : null,
          currentExp: values.currentExp.trim()
            ? Number(values.currentExp)
            : null,
          totalExp: values.totalExp.trim() ? Number(values.totalExp) : null,
          employmentType: values.employmentType,
          employmentStatus: values.employmentStatus,
          workType: values.workType || null,
          projectStatus: values.projectStatus,
          dateOfJoining: values.dateOfJoining,
          dateOfExit: values.dateOfExit || null,
          ctc: values.ctc.trim() ? Number(values.ctc) : null,
          currency: values.currency || null,
          dob: values.dob,
          gender: values.gender,
          maritalStatus: values.maritalStatus || null,
          aboutMe: values.aboutMe || null,
          bankDetails:
            values.bankDetails.accountNumber ||
            values.bankDetails.ifscCode ||
            values.bankDetails.accountHolderName ||
            values.bankDetails.bankName
              ? {
                  accountHolderName:
                    values.bankDetails.accountHolderName || null,
                  accountNumber: values.bankDetails.accountNumber || null,
                  ifscCode: values.bankDetails.ifscCode || null,
                  bankName: values.bankDetails.bankName || null,
                }
              : null,
          identityFields: values.identityFields,
          workPhoneExtension: values.workPhoneExtension || null,
          workPhone: values.workPhone || null,
          personalPhone: values.personalPhone,
          personalEmail: values.personalEmail,
          seatLocation: values.seatLocation || null,
          permanentAddress: {
            country: values.permanentAddress.country,
            state: values.permanentAddress.state,
            city: values.permanentAddress.city,
            zip_code: values.permanentAddress.postalCode || null,
            address_line_1: values.permanentAddress.addressLine1,
            address_line_2: values.permanentAddress.addressLine2 || null,
          },
          presentAddress: {
            country: values.presentAddress.country,
            state: values.presentAddress.state,
            city: values.presentAddress.city,
            zip_code: values.presentAddress.postalCode || null,
            address_line_1: values.presentAddress.addressLine1,
            address_line_2: values.presentAddress.addressLine2 || null,
          },
          sameAsPermanent: values.sameAsPermanent,
          emergencyContacts: values.emergencyContacts.filter(
            (c) =>
              c.contactName.trim() &&
              c.contactNumber.trim() &&
              c.relationship.trim(),
          ),
          // Drop fully-empty rows so blank repeatable entries aren't persisted.
          workExperience: values.workExperience.filter(
            (w) =>
              w.companyName.trim() ||
              w.jobTitle.trim() ||
              w.fromDate ||
              w.toDate ||
              w.jobDescription.trim() ||
              w.relevant,
          ),
          dependents: values.dependents.filter(
            (d) => d.name.trim() || d.relationship || d.dateOfBirth,
          ),
          education: values.education.filter(
            (e) =>
              e.instituteName.trim() ||
              e.degree.trim() ||
              e.specialization.trim() ||
              e.dateOfCompletion,
          ),
        };
        try {
          let savedId: string;
          if (isEdit && editId) {
            const updated = await updateEmp({
              id: editId,
              body: payload as EmployeeUpdateDTO,
            }).unwrap();
            savedId = updated.id;
            toast.success("Employee updated successfully");
          } else {
            const created = await createEmp(payload).unwrap();
            savedId = created.id;
            toast.success("Employee created successfully");
          }
          await Promise.all(
            Array.from(sectionCFRefs.current.values()).map((r) =>
              r.saveValues(savedId),
            ),
          );
          setIsFormDirty(false);
          setCfDirty(false);
          navigate({ to: "/hr/employees/list" });
        } catch (err: unknown) {
          const detail = (err as { data?: { detail?: unknown } })?.data?.detail;
          setErrors((prev) => ({
            ...prev,
            _form:
              typeof detail === "string" ? detail : "Failed to save employee",
          }));
        }
      },
    });
  }

  function renderCustomFields(section: SectionKey) {
    const hasDefs = sectionHasCFs[section];
    return (
      <div
        className={hasDefs ? "border-t border-dashed pt-4 mt-4" : "mt-3 pb-2"}
      >
        {hasDefs && (
          <h4 className="text-xs font-semibold text-label uppercase tracking-wide mb-3">
            Additional Information
          </h4>
        )}
        <SectionCustomFields
          ref={(el) => {
            if (el) sectionCFRefs.current.set(section, el);
            else sectionCFRefs.current.delete(section);
          }}
          entityType="employee"
          section={section}
          entityId={editId ?? undefined}
          readOnly={isViewMode}
          onDirtyChange={(dirty) => handleCfDirtyChange(section, dirty)}
          onHasDefinitionsChange={(has) =>
            setSectionHasCFs((prev) =>
              prev[section] === has ? prev : { ...prev, [section]: has },
            )
          }
        />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Edit/view mode: hold the form back until the employee record arrives —
  // rendering the empty form first reads as "no data" for a few seconds.
  if (isEdit && isEmpLoading) {
    return <FullScreenLoader message="Loading employee details..." />;
  }

  const isSaving = createState.isLoading || updateState.isLoading;

  return (
    <>
      {downloadState.isLoading && (
        <FullScreenLoader message="Generating template..." />
      )}
      <div className="w-full mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl">
              {isViewMode
                ? "View Employee"
                : isEdit
                  ? "Edit Employee"
                  : "Add Employee"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isEdit
                ? "Update the details of this employee record."
                : "Fill in the details to create a new employee record."}
            </p>
          </div>
          {!isEdit && canEdit && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleDownloadTemplate}
                disabled={downloadState.isLoading}
              >
                {downloadState.isLoading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                {downloadState.isLoading
                  ? "Generating template..."
                  : "Download Template"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBulkUploadOpen(true)}
              >
                <Upload />
                Import Employees
              </Button>
            </div>
          )}
          {isViewMode && canEdit && (
            <Button
              type="button"
              variant="soft"
              onClick={() =>
                navigate({
                  to: "/hr/employees/create",
                  search: { id: editId ?? undefined, view: undefined },
                })
              }
            >
              <Pencil />
              Edit
            </Button>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <fieldset disabled={isViewMode} className="min-w-0 space-y-4">
            <Card>
              <CardContent>
                <BasicDetails
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                  isEdit={isEdit}
                />
                {renderCustomFields("basic")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <WorkInfo
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                  editingEmployeeId={editId}
                  ctcHistory={existingEmp?.ctcHistory}
                />
                {renderCustomFields("work")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <PersonalDetails
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("personal")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <IdentityInfo
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("identity")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <BankDetails
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <ContactAddress
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("contact")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <EmergencyContacts
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("emergency")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <WorkExperience
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("experience")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <DependentDetails
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("dependents")}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <EducationDetails
                  values={values}
                  onChange={handleChange}
                  errors={errors}
                />
                {renderCustomFields("education")}
              </CardContent>
            </Card>
          </fieldset>

          {/* Form-level error */}
          {errors._form && (
            <p className="text-sm text-destructive mt-4 text-right">
              {errors._form}
            </p>
          )}

          {/* Footer buttons */}
          <div className="flex items-center justify-end gap-3 mt-6">
            {isViewMode ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate({ to: "/hr/employees/list" })}
              >
                Back
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (isFormDirty || cfDirty) {
                      confirm({
                        title: "Discard changes?",
                        description:
                          "You have unsaved changes. Are you sure you want to leave?",
                        confirmText: "Discard",
                        onConfirm: async () => {
                          setIsFormDirty(false);
                          setCfDirty(false);
                          navigate({ to: "/hr/employees/list" });
                        },
                      });
                    } else {
                      navigate({ to: "/hr/employees/list" });
                    }
                  }}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="soft"
                  disabled={isSaving || (isEdit && !isFormDirty && !cfDirty)}
                >
                  {isSaving
                    ? isEdit
                      ? "Updating..."
                      : "Saving..."
                    : isEdit
                      ? "Update Employee"
                      : "Save Employee"}
                </Button>
              </>
            )}
          </div>
        </form>

        <BulkUploadDialog
          open={bulkUploadOpen}
          onOpenChange={setBulkUploadOpen}
        />
      </div>
    </>
  );
}
