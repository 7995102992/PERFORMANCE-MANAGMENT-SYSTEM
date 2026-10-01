import { z } from "zod";
import { POSTAL_CODE_REGEX, POSTAL_CODE_MESSAGE } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Organisation Form Schema — single source of truth for all validation rules
// ---------------------------------------------------------------------------

export const organisationFormSchema = z.object({
  legalName: z
    .string()
    .min(1, "Legal name is required")
    .max(100, "Legal name must be 100 characters or less")
    .transform((v) => v.trim()),

  logoFile: z.union([z.instanceof(File), z.string(), z.null()]).optional(),

  country: z.string().min(1, "Country is required"),

  state: z.string().min(1, "State is required"),

  addressLine1: z
    .string()
    .min(1, "Address line 1 is required")
    .max(550, "Address line 1 must be 550 characters or less")
    .transform((v) => v.trim()),

  addressLine2: z
    .string()
    .max(550, "Address line 2 must be 550 characters or less")
    .transform((v) => v.trim())
    .optional(),

  city: z
    .string()
    .min(1, "City is required")
    .max(100, "City must be 100 characters or less")
    .transform((v) => v.trim()),

  zipCode: z
    .string()
    .min(1, "Zip code is required")
    .max(10, "Zip code must be 10 characters or less")
    .regex(POSTAL_CODE_REGEX, POSTAL_CODE_MESSAGE)
    .transform((v) => v.trim()),

  dateOfIncorporation: z.string().min(1, "Date of incorporation is required"),

  financialYear: z.string().min(1, "Fiscal year is required"),

  currency: z.string().min(1, "Currency is required"),

  timezone: z.string().min(1, "Timezone is required"),
});

/**
 * TypeScript type auto-derived from the schema above.
 * No need to write the type separately — schema is the single source of truth.
 */
export type OrganisationFormValues = z.infer<typeof organisationFormSchema>;

// ---------------------------------------------------------------------------
// Organisation Entity — shape returned by the backend GET API
// ---------------------------------------------------------------------------

export interface Organisation {
  id: string;
  legalName: string;
  logoUrl?: string;
  country: string;
  state?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  zipCode: string;
  dateOfIncorporation?: string; // ISO 8601: "YYYY-MM-DD"
  financialYear?: string;
  currency: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Master Data types — from API dropdown endpoints
// ---------------------------------------------------------------------------

export interface Country {
  code: string;  // e.g. "US"
  name: string;  // e.g. "United States"
}

export interface State {
  code: string;        // e.g. "CA"
  name: string;        // e.g. "California"
  countryCode: string; // FK -> Country.code
}

export interface Currency {
  code: string;   // e.g. "USD"
  name: string;   // e.g. "US Dollar"
  symbol: string; // e.g. "$"
}

export interface Timezone {
  value: string; // e.g. "America/New_York"
  label: string; // e.g. "(UTC-05:00) Eastern Time"
}
