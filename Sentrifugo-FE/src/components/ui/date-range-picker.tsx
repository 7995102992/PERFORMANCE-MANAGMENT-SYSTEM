"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange | undefined) => void;
  min?: Date;
  max?: Date;
  numberOfMonths?: number;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Month/year caption style. "dropdown" is worth using whenever the range
   * spans more than a year or two — paging with the arrows gets tedious fast.
   */
  captionLayout?: React.ComponentProps<typeof Calendar>["captionLayout"];
  /** Navigation bounds. Default to min/max so the reachable months match the
   *  selectable ones; a year dropdown needs these to know its options. */
  startMonth?: Date;
  endMonth?: Date;
}

function DateRangePicker({
  value,
  onChange,
  min,
  max,
  numberOfMonths = 2,
  placeholder = "Pick a date range",
  className,
  disabled,
  captionLayout,
  startMonth,
  endMonth,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<DateRange | undefined>(value);

  // Sync draft with external value whenever the popover opens
  React.useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const label =
    value?.from && value?.to
      ? `${format(value.from, "dd-MMM-yyyy")} – ${format(value.to, "dd-MMM-yyyy")}`
      : value?.from
        ? `${format(value.from, "dd-MMM-yyyy")} – …`
        : placeholder;

  const apply = () => {
    onChange?.(draft);
    setOpen(false);
  };

  const clear = () => {
    setDraft(undefined);
    onChange?.(undefined);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            "justify-start text-left font-normal h-9 focus-visible:ring-0 focus-visible:border-muted-foreground/40",
            !value?.from && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        {/* Draft preview */}
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
          <span
            className={cn(
              "rounded-md border px-2 py-1",
              draft?.from && !draft?.to
                ? "border-primary text-primary"
                : "text-foreground",
            )}
          >
            {draft?.from ? format(draft.from, "dd-MMM-yyyy") : "Start date"}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="rounded-md border px-2 py-1 text-foreground">
            {draft?.to ? format(draft.to, "dd-MMM-yyyy") : "End date"}
          </span>
        </div>
        <Calendar
          mode="range"
          selected={draft}
          onSelect={(_range, clickedDay) => {
            setDraft((cur) => {
              // No selection yet, or a complete range exists → start fresh
              if (!cur?.from || (cur.from && cur.to)) {
                return { from: clickedDay, to: undefined };
              }
              // Have a start, picking the end (swap if clicked before start)
              return clickedDay < cur.from
                ? { from: clickedDay, to: cur.from }
                : { from: cur.from, to: clickedDay };
            });
          }}
          numberOfMonths={numberOfMonths}
          defaultMonth={draft?.from ?? value?.from ?? min}
          captionLayout={captionLayout}
          startMonth={startMonth ?? min}
          endMonth={endMonth ?? max}
          disabled={(date) => {
            if (min && date < min) return true;
            if (max && date > max) return true;
            return false;
          }}
        />
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {draft?.from && !draft?.to
              ? "Now pick the end date"
              : "Click start, then end"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
            <Button size="sm" onClick={apply} disabled={!draft?.from}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { DateRangePicker };
