import { toast as sonner } from "sonner";
import type { AxiosError } from "axios";
import { store } from "@/store";

function formatLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractAxiosDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (first && typeof first === "object" && "msg" in first) {
      return String((first as { msg: unknown }).msg);
    }
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    return (detail as { message: string }).message;
  }
  return null;
}

/**
 * Backend errors are uniformly `{ detail, code }`. Branch on `code`, never on the
 * message text — `detail` is a human string and may be reworded at any time.
 */
export function extractErrorCode(error: unknown): string | null {
  const data =
    (error as { data?: { code?: unknown } })?.data ??
    (error as AxiosError<{ code?: unknown }>)?.response?.data;
  const code = (data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** True when the error carries any of the given backend codes. */
export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  const code = extractErrorCode(error);
  return code !== null && codes.includes(code);
}

interface DependencyInfo {
  message: string;
  dependencies: { type: string; count: number }[];
}

function extractDependencyError(error: unknown): DependencyInfo | null {
  const axiosErr = error as AxiosError<{ detail?: unknown }>;
  const detail =
    axiosErr?.response?.data?.detail ??
    (error as { data?: { detail?: unknown } })?.data?.detail;
  if (
    detail &&
    typeof detail === "object" &&
    !Array.isArray(detail) &&
    "dependencies" in detail
  ) {
    const obj = detail as DependencyInfo;
    if (obj.dependencies?.length) return obj;
  }
  return null;
}

export function extractErrorMessage(
  error: unknown,
  fallback = "Something went wrong",
): string {
  if (!error) return fallback;

  const rtkErr = error as {
    data?: { detail?: unknown; message?: string };
    status?: number;
  };
  if (rtkErr?.data) {
    const detail = extractAxiosDetail(rtkErr.data.detail);
    if (detail) return detail;
    if (typeof rtkErr.data.message === "string") return rtkErr.data.message;
  }

  const axiosErr = error as AxiosError<{ detail?: unknown; message?: string }>;
  if (axiosErr.response) {
    const data = axiosErr.response.data;
    if (data) {
      const detail = extractAxiosDetail(data.detail);
      if (detail) return detail;
      if (typeof data.message === "string") return data.message;
    }
    const status = axiosErr.response.status;
    if (status === 401) return "Session expired — please log in again";
    if (status === 403) return "You do not have permission to do that";
    if (status === 404) return "Resource not found";
    if (status === 409)
      return "A conflict occurred — this record may already exist";
    if (status === 422) return "Invalid data submitted";
    if (status >= 500) return "Server error — please try again later";
  }

  if (axiosErr.message === "Network Error")
    return "Network error — check your connection";
  if (axiosErr.code === "ECONNABORTED") return "Request timed out";

  if (error instanceof Error && error.message) return error.message;

  return fallback;
}

export const toast = {
  success: (message: string, description?: string) =>
    sonner.success(message, { id: message, description }),

  error: (error: unknown, fallback?: string) => {
    if (store.getState().auth.sessionExpired) return;
    if (typeof error === "string") {
      return sonner.error(error, { id: error });
    }
    const dep = extractDependencyError(error);
    if (dep) {
      const desc = dep.dependencies
        .map((d) => `${formatLabel(d.type)} (${d.count})`)
        .join(", ");
      return sonner.error(dep.message, {
        id: dep.message,
        description: `Active linked records: ${desc}`,
        duration: 6000,
      });
    }
    const message = extractErrorMessage(error, fallback);
    return sonner.error(message, { id: message });
  },

  info: (message: string) => sonner.info(message, { id: message }),

  loading: (message: string) => sonner.loading(message),

  dismiss: (id?: string | number) => sonner.dismiss(id),

  promise: sonner.promise.bind(sonner),
};
