import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useCopyPmsTemplatesMutation, useGetPmsCopyPreviewQuery } from "@/store/api/pmsApi";
import { currentFinancialYear } from "../config.constants";

/** The form inside the dialog; it mounts each time the dialog opens, so the years start at their defaults. */
const CopyTemplateForm = ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => {
  // Target and source financial-year start years chosen in the dialog.
  const [targetStart, setTargetStart] = useState(currentFinancialYear());
  const [previousStart, setPreviousStart] = useState(currentFinancialYear() - 1);
  const [copy, { isLoading: copying }] = useCopyPmsTemplatesMutation();

  // API form of the two years ("2026-27") and the selectable years.
  const previousYear = fyToApi(previousStart);
  const targetYear = fyToApi(targetStart);
  const years = [currentFinancialYear() - 2, currentFinancialYear() - 1, currentFinancialYear(), currentFinancialYear() + 1];

  // How many templates would be copied vs skipped; not requested while both years are the same.
  const { data: preview, isFetching } = useGetPmsCopyPreviewQuery(
    { previousYear, targetYear },
    { skip: previousStart === targetStart },
  );

  /** Runs the copy and reports how many templates were copied and skipped. */
  const submit = async () => {
    if (previousStart === targetStart) {
      toast.error("Choose a different target year");
      return;
    }
    try {
      const res = await copy({ previous_year: previousYear, target_year: targetYear }).unwrap();
      toast.success(`Copied ${res.copied} templates${res.skipped ? `, ${res.skipped} skipped (already in ${targetYear})` : ""}`);
      onOpenChange(false);
    } catch (e) {
      toast.error(e, "Could not copy the templates");
    }
  };

  /** Small financial-year dropdown used for both the source and the target year. */
  const yearSelect = (id: string, value: number, onChange: (n: number) => void) => (
    <select
      id={id}
      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {years.map((y) => (
        <option key={y} value={y}>FY {fyToApi(y)}</option>
      ))}
    </select>
  );

  return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy Template</DialogTitle>
          <DialogDescription>
            Copy every goal template from a previous year into the target year, so they need not be created again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="copy-prev">Previous Year *</Label>
            {yearSelect("copy-prev", previousStart, setPreviousStart)}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="copy-target">Target Year *</Label>
            {yearSelect("copy-target", targetStart, setTargetStart)}
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {previousStart === targetStart
            ? "Pick two different years."
            : isFetching
              ? "Counting templates…"
              : preview
                ? `${preview.found} templates found in FY ${previousYear}. ${preview.already_in_target} roles already have a template in FY ${targetYear} and will be skipped. Copies are created as Draft and can be edited before use.`
                : ""}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={copying}>Cancel</Button>
          <Button onClick={submit} disabled={copying || previousStart === targetStart || preview?.found === 0}>
            {copying ? "Copying…" : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
  );
};

/** Screen 2.2 "Copy Template": copies every template of a previous year into the target year as drafts. */
const CopyTemplateDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {open && <CopyTemplateForm onOpenChange={onOpenChange} />}
  </Dialog>
);

export default CopyTemplateDialog;
