import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
