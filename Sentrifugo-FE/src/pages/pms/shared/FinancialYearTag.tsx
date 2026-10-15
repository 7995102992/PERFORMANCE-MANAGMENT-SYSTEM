import { CalendarDays } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fyToApi } from "@/store/api/pmsMappers";
import { financialYearOptions } from "../configuration/config.constants";

/**
 * `FY 2026-27` in the header of the manager screens. A plain pill by default;
 * pass `onChange` to make it the financial-year dropdown (receives the start year, e.g. "2026").
 */
export function FinancialYearTag({ fy, onChange }: { fy: string; onChange?: (fy: string) => void }) {
  if (!onChange) {
    return (
      <span className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground">
        FY {fyToApi(Number(fy))}
      </span>
    );
  }
  return (
    <Select value={fy} onValueChange={onChange}>
      <SelectTrigger aria-label="Financial year" className="w-40 font-medium">
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {financialYearOptions().map((year) => (
          <SelectItem key={year} value={String(year)}>
            FY {fyToApi(year)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
