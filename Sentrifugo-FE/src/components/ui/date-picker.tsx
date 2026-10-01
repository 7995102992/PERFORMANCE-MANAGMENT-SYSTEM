"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import { format, parse, isValid } from "date-fns";

import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DatePickerProps {
  value?: string;
  onChange?: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

function parseYMD(str: string | undefined): Date | undefined {
  if (!str) return undefined;
  const d = parse(str, "yyyy-MM-dd", new Date());
  return isValid(d) ? d : undefined;
}

function toYMD(date: Date | undefined): string {
  if (!date) return "";
  return format(date, "yyyy-MM-dd");
}

function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "Pick a date",
  className,
  disabled,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseYMD(value);
  const minDate = parseYMD(min);
  const maxDate = parseYMD(max);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            "justify-start text-left font-normal h-9 focus-visible:ring-0 focus-visible:border-muted-foreground/40",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="shrink-0" />
          {selected ? format(selected, "dd-MMM-yyyy") : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            onChange?.(toYMD(date));
            setOpen(false);
          }}
          disabled={(date) => {
            if (minDate && date < minDate) return true;
            if (maxDate && date > maxDate) return true;
            return false;
          }}
          defaultMonth={selected || minDate}
        />
      </PopoverContent>
    </Popover>
  );
}

export { DatePicker };
