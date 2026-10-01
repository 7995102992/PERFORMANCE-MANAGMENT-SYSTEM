import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Timestamps ───────────────────────────────────────────────────────────────

/** The organisation's timezone. Every stored timestamp renders in it. */
export const ORG_TIME_ZONE = "Asia/Kolkata"

/** True when the string already states its offset (trailing Z or ±hh:mm). */
const HAS_TZ_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/

/**
 * Parse an API timestamp as UTC.
 *
 * The services write `datetime.now(timezone.utc)`, but BSON has no timezone, so
 * what comes back over the wire is a bare `2026-08-19T05:22:00` with the offset
 * stripped. `new Date()` reads that as LOCAL time, which silently shifts every
 * timestamp by the viewer's offset — an approval at 10:52 IST rendered as 5:22.
 * A tz-less datetime is therefore forced to UTC before formatting.
 *
 * Date-only strings (`2026-07-24`) are left alone: JS already parses those as
 * UTC midnight, and appending a marker would make them unparseable.
 */
export function parseApiDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const needsUtcMarker = iso.includes("T") && !HAS_TZ_OFFSET.test(iso)
  const d = new Date(needsUtcMarker ? `${iso}Z` : iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "19-Aug-2026" in the org's timezone. */
export function formatOrgDate(iso: string | null | undefined, fallback = "-"): string {
  const d = parseApiDate(iso)
  if (!d) return fallback
  return d
    .toLocaleDateString("en-GB", {
      timeZone: ORG_TIME_ZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .replace(/ /g, "-")
}

/** "19-Aug-2026, 10:52 AM" in the org's timezone. */
export function formatOrgDateTime(iso: string | null | undefined, fallback = "-"): string {
  const d = parseApiDate(iso)
  if (!d) return fallback
  const datePart = formatOrgDate(iso)
  const timePart = d.toLocaleTimeString("en-US", {
    timeZone: ORG_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
  return `${datePart}, ${timePart}`
}

/**
 * Worldwide postal / zip code format.
 * Accepts the formats used globally — digits, letters, and internal spaces or
 * hyphens (e.g. US "12345" / "12345-6789", UK "SW1A 1AA", Canada "K1A 0B1",
 * India "110001", Netherlands "1234 AB", Brazil "12345-678").
 * Must start and end with an alphanumeric character; 3–10 characters total.
 * This rejects free-text / symbol-only input while staying country-agnostic.
 */
export const POSTAL_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/

export const POSTAL_CODE_MESSAGE = "Enter a valid postal/zip code"

/** Returns true when the value is a plausible worldwide postal/zip code. */
export function isValidPostalCode(value: string): boolean {
  return POSTAL_CODE_REGEX.test(value.trim())
}

export function deptLabel(dept: {
  departmentName: string
  businessUnitNames?: string[]
  primaryBusinessUnitData?: { businessUnitName: string } | null
}): string {
  const primaryBuName =
    dept.primaryBusinessUnitData?.businessUnitName ?? dept.businessUnitNames?.[0]
  if (!primaryBuName) return dept.departmentName
  return `${primaryBuName} - ${dept.departmentName}`
}
