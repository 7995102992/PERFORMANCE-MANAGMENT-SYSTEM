import { useEffect, useRef, useState } from "react";
import { Loader2, FileText } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * In-app PDF renderer — pages drawn to canvases via pdf.js, so there's no
 * browser PDF toolbar. Pages render progressively: the first page appears as
 * soon as it's ready.
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

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    setLoading(true);
    setError(false);

    (async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ url, httpHeaders }).promise;
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
          setError(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="h-full overflow-y-auto p-4">
      {loading && (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading document...
        </div>
      )}
      {error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-icon-bg text-icon">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">Couldn't load the preview</p>
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
