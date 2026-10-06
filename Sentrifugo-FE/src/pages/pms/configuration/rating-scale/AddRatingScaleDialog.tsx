import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { useCreatePmsRatingScaleMutation } from "@/store/api/pmsApi";
import type { PmsRatingScaleUpdate } from "@/types/pms-config";

type Row = { label: string; definition: string; min: string; max: string };

const LEVEL_OPTIONS = [3, 4, 5, 6, 7];
const FIVE_POINT_LABELS = ["Outstanding", "Exceeds Expectations", "Meets Expectations", "Needs Improvement", "Unsatisfactory"];

/** Blank rows for n levels; the five-point scale starts from the standard labels and ranges. */
const blankRows = (n: number): Row[] => {
  if (n === 5) {
    const std = [
      ["4.50", "5.00"], ["3.50", "4.49"], ["2.50", "3.49"], ["1.50", "2.49"], ["1.00", "1.49"],
    ];
    return FIVE_POINT_LABELS.map((label, i) => ({ label, definition: "", min: std[i][0], max: std[i][1] }));
  }
  return Array.from({ length: n }, (_, i) => ({ label: `Level ${n - i}`, definition: "", min: "", max: "" }));
};

const COLOURS = ["#16A34A", "#2563EB", "#6366F1", "#D97706", "#DC2626", "#0891B2", "#7C3AED"];

/** Screen 2.13 "Add Rating Scale". Creates one scale; the API checks ranges do not overlap. */
const AddRatingScaleDialog = ({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) => {
  const [createScale, { isLoading: saving }] = useCreatePmsRatingScaleMutation();
  const [name, setName] = useState("");
  const [count, setCount] = useState(5);
  const [rows, setRows] = useState<Row[]>(() => blankRows(5));
  const [isDefault, setIsDefault] = useState(false);
  const [showDefinitions, setShowDefinitions] = useState(true);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setCount(5);
      setRows(blankRows(5));
      setIsDefault(false);
      setShowDefinitions(true);
    }
  }, [open]);

  const changeCount = (n: number) => {
    setCount(n);
    setRows(blankRows(n));
  };

  const updateRow = (i: number, field: keyof Row, value: string) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Give the rating scale a name");
      return;
    }
    const invalid = rows.some((r) => {
      const min = Number(r.min);
      const max = Number(r.max);
      return !r.label.trim() || r.min === "" || r.max === "" || !Number.isFinite(min) || !Number.isFinite(max) || min > max;
    });
    if (invalid) {
      toast.error("Enter a label and a score range for every level, with the maximum not below the minimum");
      return;
    }
    const body: PmsRatingScaleUpdate = {
      is_default: isDefault,
      show_definitions_to_employees: showDefinitions,
      levels: rows.map((r, i) => ({
        rating: count - i,
        label: r.label.trim(),
        definition: r.definition.trim(),
        score_min: Number(r.min),
        score_max: Number(r.max),
        color: COLOURS[i % COLOURS.length],
      })),
    };
    try {
      const saved = await createScale({ name: name.trim(), body }).unwrap();
      toast.success("Rating scale created");
      onCreated(saved.id);
      onOpenChange(false);
    } catch (e) {
      toast.error(e, "Could not create the rating scale");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add Rating Scale</DialogTitle>
          <DialogDescription>Define the levels, their score ranges and what each one means.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <div className="space-y-1.5">
            <Label htmlFor="rs-name">Scale name *</Label>
            <Input id="rs-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rs-count">Number of levels *</Label>
            <select
              id="rs-count"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={count}
              onChange={(e) => changeCount(Number(e.target.value))}
            >
              {LEVEL_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-2">
          <p className="mb-2 text-sm font-medium text-foreground">Rating levels *</p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Rating</th>
                  <th className="px-3 py-2 text-left">Label</th>
                  <th className="px-3 py-2 text-left">Score from</th>
                  <th className="px-3 py-2 text-left">Score to</th>
                  <th className="px-3 py-2 text-left">Definition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2 font-medium">{count - i}</td>
                    <td className="px-3 py-2">
                      <Input value={r.label} onChange={(e) => updateRow(i, "label", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <Input inputMode="decimal" className="w-24" value={r.min} onChange={(e) => updateRow(i, "min", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <Input inputMode="decimal" className="w-24" value={r.max} onChange={(e) => updateRow(i, "max", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <Input value={r.definition} onChange={(e) => updateRow(i, "definition", e.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Score ranges must not overlap.</p>
        </div>

        <div className="mt-3 flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} aria-label="Default scale" />
            Set as default scale for new cycles
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={showDefinitions} onCheckedChange={(v) => setShowDefinitions(v === true)} aria-label="Show definitions" />
            Show definitions to employees
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save Scale"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddRatingScaleDialog;
