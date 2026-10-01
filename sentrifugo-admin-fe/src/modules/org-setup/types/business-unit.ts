import type React from "react"
import { z } from "zod"
import { POSTAL_CODE_REGEX, POSTAL_CODE_MESSAGE } from "@/lib/utils"

export type BusinessStructure = "single" | "multiple"

// Start-from values are digit STRINGS so leading zeros are significant and
// define the zero-pad width ("006" → codes start at 006, width 3; "1" → no
// padding). Mandatory, but the "required" rule is enforced in the form's
// per-field validator (empty === not yet entered).
const startFromField = z
    .string()
    .regex(/^\d{1,7}$/, "Enter 1–7 digits (leading zeros allowed, e.g. 006)")
    .optional()

export const empCodeStartFromSchema = z.object({
    fullTime: startFromField,
    contract: startFromField,
    internship: startFromField,
})

export const businessUnitSchema = z.object({
    country: z.string().min(1, "Country is required"),
    businessUnitName: z.string().min(1, "Business Unit Name is required"),
    empCodePrefix: z
        .string()
        .min(1, "Employee Code Prefix is required")
        .max(10, "Prefix must be 10 characters or less")
        .regex(/^[A-Za-z0-9]+$/, "Only letters and digits allowed"),
    empCodeStartFrom: empCodeStartFromSchema.default({ fullTime: "0", contract: "0", internship: "0" }),
    headName: z.string().optional().default(""),
    dateOfIncorporation: z.string().min(1, "Date of Incorporation is required"),
    ein: z
        .string()
        .regex(/^(\d{2}-\d{7})?$/, "EIN must be in ##-####### format"),
    sector: z.string(),
    typeOfBusiness: z.string(),
    addressLine1: z.string().min(1, "Address line 1 is required"),
    natureOfBusiness: z.string(),
    state: z.string().min(1, "State is required"),
    city: z.string().min(1, "City is required"),
    addressLine2: z.string().optional().default(""),
    zipCode: z
        .string()
        .min(1, "Zip code is required")
        .max(10, "Zip code must be 10 characters or less")
        .regex(POSTAL_CODE_REGEX, POSTAL_CODE_MESSAGE),
    financialYear: z.string().min(1, "Fiscal Year is required"),
    currency: z.string().min(1, "Currency is required"),
    timeZone: z.string().min(1, "Time Zone is required"),
    timeFormat: z.string().default("12"),
    isSubsidiary: z.boolean().default(false),
    isActive: z.boolean().default(true),
})

export type BusinessUnitFormValues = z.infer<typeof businessUnitSchema>
export type BusinessUnitForm = BusinessUnitFormValues

export interface BusinessUnitEntry {
    id: string
    data: BusinessUnitFormValues
    hasEmployees?: boolean
}

export interface StructureOption {
    value: BusinessStructure
    title: string
    description: string
    Icon: React.ComponentType<{ className?: string }>
}
