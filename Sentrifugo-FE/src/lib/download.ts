import { store } from "@/store";

/**
 * Authenticated file download. Reads the current (rotated) bearer token from
 * the Redux store and pulls the filename from the Content-Disposition header,
 * falling back to the provided name. Avoids window.open so the rotated token
 * is always sent (see stale-token note).
 */
export async function downloadAuthed(url: string, fallbackName: string): Promise<void> {
  const token = store.getState().auth.accessToken;
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : fallbackName;
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  // The anchor must be IN the document before it is clicked: a detached
  // anchor's programmatic click is a no-op in Firefox and is unreliable in
  // Chrome while a modal (Radix Dialog sets pointer-events:none on body) is
  // open — which is exactly where the announcement attachments are offered.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a later tick. Revoking synchronously after click() can cancel the
  // save before the browser has finished reading the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/**
 * Authenticated *view*: fetches the file with the bearer token and shows it in
 * a new tab instead of saving it. A plain `window.open(url)` cannot be used —
 * the endpoint needs the Authorization header.
 *
 * The tab is opened synchronously, before the await, or the pop-up blocker
 * treats it as programmatic and kills it.
 */
export async function openAuthed(url: string): Promise<void> {
  const token = store.getState().auth.accessToken;
  if (!token) throw new Error("Not authenticated");
  const tab = window.open("", "_blank", "noopener,noreferrer");
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Preview failed (${res.status})`);
    const objectUrl = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = objectUrl;
    else window.open(objectUrl, "_blank", "noopener,noreferrer");
    // Give the tab time to load before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/** Opens a not-yet-uploaded local file in a new tab. */
export function openLocalFile(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  window.open(objectUrl, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
