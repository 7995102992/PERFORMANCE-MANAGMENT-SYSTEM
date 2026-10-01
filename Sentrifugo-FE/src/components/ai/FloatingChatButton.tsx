import { useEffect, useRef, useState } from "react";
import { BotMessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatDrawer } from "./ChatDrawer";
import { useAppDispatch, useAppSelector } from "@/store";
import {
  setChatButtonCorner,
  type ChatButtonCorner,
} from "@/store/slices/uiSlice";

const BUTTON_SIZE = 56; // size-14
const MARGIN = 32;

function cornerToPos(corner: ChatButtonCorner): { x: number; y: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  switch (corner) {
    case "top-left":
      return { x: MARGIN, y: MARGIN };
    case "top-right":
      return { x: w - BUTTON_SIZE - MARGIN, y: MARGIN };
    case "bottom-left":
      return { x: MARGIN, y: h - BUTTON_SIZE - MARGIN };
    case "bottom-right":
      return { x: w - BUTTON_SIZE - MARGIN, y: h - BUTTON_SIZE - MARGIN };
  }
}

function nearestCorner(x: number, y: number): ChatButtonCorner {
  const cx = x + BUTTON_SIZE / 2;
  const cy = y + BUTTON_SIZE / 2;
  const onRight = cx > window.innerWidth / 2;
  const onBottom = cy > window.innerHeight / 2;
  if (onRight && onBottom) return "bottom-right";
  if (!onRight && onBottom) return "bottom-left";
  if (onRight && !onBottom) return "top-right";
  return "top-left";
}

// Tooltip callout side per corner so it doesn't go off-screen
function tooltipClass(corner: ChatButtonCorner): string {
  switch (corner) {
    case "bottom-right":
      return "bottom-full right-0 mb-3";
    case "bottom-left":
      return "bottom-full left-0 mb-3";
    case "top-right":
      return "top-full right-0 mt-3";
    case "top-left":
      return "top-full left-0 mt-3";
  }
}

function arrowClass(corner: ChatButtonCorner): string {
  // Arrow sits on the edge closest to the button
  const isBottom = corner.startsWith("bottom");
  const isRight = corner.endsWith("right");
  if (isBottom)
    return cn(
      "top-full border-t-foreground/90",
      isRight ? "right-4" : "left-4",
    );
  return cn(
    "bottom-full border-b-foreground/90",
    isRight ? "right-4" : "left-4",
  );
}

export function FloatingChatButton() {
  const dispatch = useAppDispatch();
  const savedCorner = useAppSelector((s) => s.ui.chatButtonCorner);

  const [open, setOpen] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [showTooltip, setShowTooltip] = useState(true);
  const [pos, setPos] = useState(() => cornerToPos(savedCorner));

  // Recompute pixel pos if corner changes (e.g. on mount with a saved corner)
  useEffect(() => {
    setPos(cornerToPos(savedCorner));
  }, [savedCorner]);

  // Auto-dismiss tooltip after 6 s
  useEffect(() => {
    const t = setTimeout(() => setShowTooltip(false), 6000);
    return () => clearTimeout(t);
  }, []);

  // Recalculate corner position on window resize
  useEffect(() => {
    const handler = () => setPos(cornerToPos(savedCorner));
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [savedCorner]);

  const dragging = useRef(false);
  const moved = useRef(false);
  const startPointer = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    dragging.current = true;
    moved.current = false;
    startPointer.current = { x: e.clientX, y: e.clientY };
    startPos.current = { ...pos };
    setSnapping(false);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - startPointer.current.x;
    const dy = e.clientY - startPointer.current.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved.current = true;
    setPos({
      x: Math.min(
        Math.max(startPos.current.x + dx, 0),
        window.innerWidth - BUTTON_SIZE,
      ),
      y: Math.min(
        Math.max(startPos.current.y + dy, 0),
        window.innerHeight - BUTTON_SIZE,
      ),
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);

    if (!moved.current) {
      // Tap — open drawer
      setOpen(true);
      setShowTooltip(false);
      return;
    }

    // Snap to nearest corner
    const corner = nearestCorner(pos.x, pos.y);
    setSnapping(true);
    setPos(cornerToPos(corner));
    dispatch(setChatButtonCorner(corner));
  };

  const isBottom = savedCorner.startsWith("bottom");

  return (
    <>
      <div
        className="fixed z-50 touch-none select-none"
        style={{
          left: pos.x,
          top: pos.y,
          width: BUTTON_SIZE,
          height: BUTTON_SIZE,
        }}
      >
        {/* Tooltip */}
        {showTooltip && !open && (
          <div
            className={cn(
              "absolute w-56 pointer-events-none",
              tooltipClass(savedCorner),
            )}
          >
            <div className="rounded-xl bg-foreground/90 px-3 py-2.5 text-xs text-background leading-relaxed shadow-lg">
              Hello from FugoAI — click me for AI Superpowers. Drag me anywhere
              across the screen.
            </div>
            {/* Arrow */}
            <span
              className={cn(
                "absolute size-0 block border-x-4 border-x-transparent",
                isBottom
                  ? "border-t-4 border-t-foreground/90 top-full"
                  : "border-b-4 border-b-foreground/90 bottom-full",
                arrowClass(savedCorner),
              )}
            />
          </div>
        )}

        <button
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className={cn(
            "size-full rounded-full shadow-lg",
            "bg-primary text-primary-foreground",
            "flex items-center justify-center",
            snapping && "transition-all duration-300 ease-out",
            "hover:scale-105 active:scale-95",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            open && "hidden",
          )}
          aria-label="Open Leave Assistant"
        >
          <BotMessageSquareIcon className="size-6" />
          <span className="absolute top-1 right-1 size-2.5 rounded-full bg-success border-2 border-background" />
        </button>
      </div>

      <ChatDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
