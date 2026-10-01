// Every timestamp this app displays comes from a backend as a UTC instant.
// Rendering it with `.getHours()`/`.toLocaleString()` etc. converts to
// whatever timezone the VIEWER'S BROWSER/OS happens to be set to — usually
// IST, but not guaranteed (a traveling laptop, a UTC-configured QA machine).
// These helpers force Asia/Kolkata explicitly, so the displayed time is
// always IST regardless of the browser's local timezone.

const IST_TIME_ZONE = "Asia/Kolkata";

// Some backends in this system serialize a UTC instant without a timezone
// marker (e.g. "2026-08-25T10:30:00" instead of "...T10:30:00Z"). Per the
// ECMAScript Date spec, a date-TIME string with no offset is parsed as LOCAL
// time, not UTC — so without this, the instant itself would already be wrong
// before we even get to formatting it, and forcing IST on the output
// wouldn't fix that. Only date-time strings are affected; a bare date-only
// string ("2026-08-25") is already spec'd as UTC midnight, so it's left alone.
const HAS_TIME_COMPONENT = /T\d{2}:\d{2}/;
const HAS_TIMEZONE_MARKER = /(?:Z|[+-]\d{2}:?\d{2})$/;

function toDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (
    typeof value === "string" &&
    HAS_TIME_COMPONENT.test(value) &&
    !HAS_TIMEZONE_MARKER.test(value)
  ) {
    return new Date(`${value}Z`);
  }
  return new Date(value);
}

/** "25-Aug-2026" */
export function formatDateIST(value: string | number | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: IST_TIME_ZONE,
  })
    .format(toDate(value))
    .replace(/ /g, "-");
}

/** "4:00 PM" */
export function formatTimeIST(value: string | number | Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: IST_TIME_ZONE,
  }).format(toDate(value));
}

/** "25-Aug-2026, 4:00 PM" */
export function formatDateTimeIST(value: string | number | Date): string {
  return `${formatDateIST(value)}, ${formatTimeIST(value)}`;
}

/** "25-Aug-2026, 4:00 PM IST" — explicit zone suffix for anywhere the reader
 * might otherwise assume their own local time (e.g. cross-timezone audit logs). */
export function formatDateTimeISTWithZone(value: string | number | Date): string {
  return `${formatDateTimeIST(value)} IST`;
}
