import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface DatePickerProps {
  value?: Date;
  onChange?: (date?: Date) => void;
  minDate?: Date;
  maxDate?: Date;
  placeholder?: string;
  className?: string;
  showYearDropdown?: boolean;
  disabled?: boolean;
}

export function DatePicker({
  value,
  onChange,
  // Reasonable defaults spanning 100+ years
  minDate = new Date(1900, 0, 1),
  maxDate = new Date(2100, 0, 1),
  placeholder = "Pick a date",
  className,
  showYearDropdown = true,
  disabled = false,
}: DatePickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={"outline"}
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="text-icon" />
          {value ? format(value, "dd-MMM-yyyy") : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          disabled={(date) => date < minDate || date > maxDate}
          captionLayout={showYearDropdown ? "dropdown" : undefined}
          startMonth={new Date(minDate.getFullYear(), 0)}
          endMonth={new Date(maxDate.getFullYear(), 11)}
        />
      </PopoverContent>
    </Popover>
  );
}
