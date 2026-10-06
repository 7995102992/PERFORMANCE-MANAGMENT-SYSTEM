import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import {
  useCreatePmsRatingScaleMutation,
  useCreatePmsStandardRatingLevelMutation,
  useGetPmsStandardRatingLevelsQuery,
} from "@/store/api/pmsApi";
import type { PmsRatingScaleUpdate, PmsStandardRatingLevel } from "@/types/pms-config";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../../shared/PmsTableCard";

const RATING_SCALE_PATH = "/pms/configuration/rating-scale";

/** Score range typed for a selected standard; kept as text while the user types. */
type Range = { min: string; max: string };

/** Screen 2.10 - create a rating scale from the standard levels. */
const CreateRatingScale = () => {
  const navigate = useNavigate();
  const { data: standards = [], isLoading } = useGetPmsStandardRatingLevelsQuery();
  const [createScale, { isLoading: saving }] = useCreatePmsRatingScaleMutation();
  const [createStandard, { isLoading: adding }] = useCreatePmsStandardRatingLevelMutation();

  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Record<string, Range>>({});
  const [draft, setDraft] = useState({ label: "", definition: "", color: "#16A34A" });

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { min: "", max: "" };
      return next;
    });

  const setRange = (id: string, field: keyof Range, value: string) =>
    setPicked((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));

  const addStandard = async () => {
    if (!draft.label.trim()) {
      toast.error("Give the standard a label");
      return;
    }
    try {
      await createStandard(draft).unwrap();
      setDraft({ label: "", definition: "", color: "#16A34A" });
      toast.success("Standard added");
    } catch (e) {
      toast.error(e, "Could not add the standard");
    }
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error("Give the rating scale a name");
      return;
    }
    const chosen = standards
      .filter((s) => picked[s.id])
      .map((s: PmsStandardRatingLevel) => ({
        standard: s,
        min: Number(picked[s.id].min),
        max: Number(picked[s.id].max),
        raw: picked[s.id],
      }));
    if (chosen.length === 0) {
      toast.error("Select at least one standard");
      return;
    }
    const missing = chosen.find((c) => c.raw.min === "" || c.raw.max === "" || !Number.isFinite(c.min) || !Number.isFinite(c.max));
    if (missing) {
      toast.error(`Enter a score range for ${missing.standard.label}`);
      return;
    }
    const inverted = chosen.find((c) => c.min > c.max);
    if (inverted) {
      toast.error(`The maximum for ${inverted.standard.label} is below its minimum`);
      return;
    }

    // Highest score range becomes the highest rating.
    const ordered = [...chosen].sort((a, b) => b.min - a.min);
    const body: PmsRatingScaleUpdate = {
      is_default: false,
      show_definitions_to_employees: true,
      levels: ordered.map((c, i) => ({
        rating: ordered.length - i,
        label: c.standard.label,
        definition: c.standard.definition,
        score_min: c.min,
        score_max: c.max,
        color: c.standard.color,
      })),
    };
    try {
      await createScale({ name: name.trim(), body }).unwrap();
      toast.success("Rating scale created");
      navigate({ to: RATING_SCALE_PATH });
    } catch (e) {
      toast.error(e, "Could not create the rating scale");
    }
  };

  if (isLoading) return <PageLoader message="Loading standards…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Create Rating Scale"
        subtitle="Pick the standard levels this scale uses and set each score range"
        action={
          <Button type="button" variant="outline" onClick={() => navigate({ to: RATING_SCALE_PATH })}>
            Cancel
          </Button>
        }
      />

      <PmsTableCard>
        <div className="mb-4 max-w-md space-y-1.5">
          <Label htmlFor="scale-name">Scale name</Label>
          <Input
            id="scale-name"
            value={name}
            placeholder="e.g. Standard 5-Point Scale"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <h2 className="mb-3 text-base font-semibold text-foreground">Standards</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh className="w-12">Select</PmsTh>
              <PmsTh>Label</PmsTh>
              <PmsTh>Definition</PmsTh>
              <PmsTh className="w-24">Colour</PmsTh>
              <PmsTh className="w-64">Score range</PmsTh>
            </tr>
          </thead>
          <tbody>
            {standards.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No standards yet. Add one below.
                </td>
              </tr>
            )}
            {standards.map((s) => {
              const on = !!picked[s.id];
              return (
                <tr key={s.id} className="border-t">
                  <td className="px-4 py-3">
                    <Checkbox checked={on} onCheckedChange={() => togglePick(s.id)} aria-label={`Select ${s.label}`} />
                  </td>
                  <td className="px-4 py-3 font-medium text-foreground">{s.label}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.definition || "—"}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block size-5 rounded" style={{ backgroundColor: s.color }} />
                  </td>
                  <td className="px-4 py-3">
                    {on && (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          step="0.01"
                          aria-label={`${s.label} minimum score`}
                          className="w-24"
                          value={picked[s.id].min}
                          onChange={(e) => setRange(s.id, "min", e.target.value)}
                        />
                        <span className="text-muted-foreground">–</span>
                        <Input
                          type="number"
                          step="0.01"
                          aria-label={`${s.label} maximum score`}
                          className="w-24"
                          value={picked[s.id].max}
                          onChange={(e) => setRange(s.id, "max", e.target.value)}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-6 grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_2fr_auto_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="std-label">New standard</Label>
            <Input
              id="std-label"
              placeholder="Label"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="std-definition">Definition</Label>
            <Input
              id="std-definition"
              placeholder="What this level means"
              value={draft.definition}
              onChange={(e) => setDraft({ ...draft, definition: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="std-colour">Colour</Label>
            <Input
              id="std-colour"
              type="color"
              className="h-9 w-16 p-1"
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            />
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" onClick={addStandard} disabled={adding}>
              {adding ? "Adding…" : "Add standard"}
            </Button>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3 border-t pt-4">
          <Button type="button" variant="outline" onClick={() => navigate({ to: RATING_SCALE_PATH })} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Creating…" : "Create Scale"}
          </Button>
        </div>
      </PmsTableCard>
    </div>
  );
};

export default CreateRatingScale;
