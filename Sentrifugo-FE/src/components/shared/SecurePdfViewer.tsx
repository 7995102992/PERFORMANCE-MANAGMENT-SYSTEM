import { useEffect, useRef, useState } from "react";
import { Loader2, FileText, Lock } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * View-only PDF renderer for documents where download is disabled.
 *
 * Renders pages to canvases via pdf.js — no browser PDF toolbar, so no
 * built-in download / print / save controls. Context menu is blocked and the
 * wrapper is hidden from printing (`print:hidden`). Pages render
 * progressively: the first page appears as soon as it's ready.
 *
 * Encrypted PDFs are supported: pdf.js signals them through the loading task's
 * `onPassword` hook, which we surface as an inline prompt. Without that hook
 * pdf.js rejects with a PasswordException and the file looks simply broken.
 */
export function SecurePdfViewer({
  url,
  httpHeaders,
}: {
  url: string;
  /** e.g. Authorization header when the URL is an authenticated API endpoint */
  httpHeaders?: Record<string, string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Set while pdf.js is waiting on a password. `wrong` is true after a
  // rejected attempt so the prompt can say so instead of silently re-asking.
  const [passwordPrompt, setPasswordPrompt] = useState<{ wrong: boolean } | null>(
    null,
  );
  const [password, setPassword] = useState("");
  // pdf.js hands us a callback to feed the password back into the open attempt.
  const submitPasswordRef = useRef<((value: string) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    setLoading(true);
    setError(false);
    setPasswordPrompt(null);
    setPassword("");

    const loadingTask = pdfjsLib.getDocument({ url, httpHeaders });

    // Fires once for an encrypted file, and again for every wrong password.
    loadingTask.onPassword = (
      updatePassword: (value: string) => void,
      reason: number,
    ) => {
      if (cancelled) return;
      submitPasswordRef.current = updatePassword;
      setPasswordPrompt({
        wrong: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD,
      });
      setPassword("");
      // Swap the spinner for the prompt — the load is paused, not in flight.
      setLoading(false);
    };

    (async () => {
      try {
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        setPasswordPrompt(null);
        setLoading(true);
        // Fit pages to the container width; render at devicePixelRatio for
        // crispness without over-rendering.
        const cssWidth = container.clientWidth || 640;
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);

        for (let p = 1; p <= pdf.numPages; p++) {
          if (cancelled) return;
          const page = await pdf.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(cssWidth / base.width, 2);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.className =
            "mx-auto mb-4 block max-w-full rounded border bg-white shadow-sm";

          await page.render({
            canvas,
            viewport,
            transform:
              outputScale !== 1
                ? [outputScale, 0, 0, outputScale, 0, 0]
                : undefined,
          }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
          // Show content as soon as the first page is on screen
          if (p === 1) setLoading(false);
        }
        if (!cancelled) setLoading(false);
      } catch {
        if (!cancelled) {
          setPasswordPrompt(null);
          setError(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      submitPasswordRef.current = null;
      // Release the worker; an abandoned task left awaiting a password would
      // otherwise keep it alive for the life of the tab.
      loadingTask.destroy().catch(() => {});
    };
  }, [url]);

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || !submitPasswordRef.current) return;
    // pdf.js resumes the same load; a wrong password re-triggers onPassword.
    setPasswordPrompt(null);
    setLoading(true);
    submitPasswordRef.current(password);
  }

  return (
    <div
      className="h-full overflow-y-auto p-4 select-none print:hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      {loading && (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading document...
        </div>
      )}
      {passwordPrompt && (
        <form
          onSubmit={handlePasswordSubmit}
          className="mx-auto flex max-w-xs flex-col items-center gap-3 py-20 text-center"
        >
          <div className="flex size-12 items-center justify-center rounded-xl bg-icon-bg text-icon">
            <Lock className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              This document is password protected
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {passwordPrompt.wrong
                ? "That password wasn't correct. Please try again."
                : "Enter the password to view it."}
            </p>
          </div>
          <Input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="text-center"
          />
          <Button type="submit" size="sm" disabled={!password}>
            Unlock
          </Button>
        </form>
      )}
      {error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-icon-bg text-icon">
            <FileText className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              Couldn't load the preview
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
              The document couldn't be displayed. Please try again later.
            </p>
          </div>
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}
