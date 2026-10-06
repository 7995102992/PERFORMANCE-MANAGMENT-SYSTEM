import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Controller, FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ColorPicker } from "@/components/shared/ColorPicker";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import {
  useCreatePmsRatingScaleMutation,
  useGetPmsRatingScaleConfigsQuery,
  useUpdatePmsRatingScaleMutation,
} from "@/store/api/pmsApi";
import type { PmsRatingScaleUpdate } from "@/types/pms-config";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../../shared/PmsTableCard";

const score = (message: string) =>
  z.number({ error: message }).min(0, "Cannot be negative").max(100, "Too large");

const schema = z.object({
  levels: z
    .array(
      z.object({
        rating: z.number(),
        label: z.string().trim().min(1, "Label is required").max(40, "Max 40 characters"),
        definition: z.string().trim().max(200, "Max 200 characters"),
        score_min: score("Enter a number"),
        score_max: score("Enter a number"),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour"),
      }),
    )
    .superRefine((levels, ctx) => {
      const sorted = levels
        .map((l, index) => ({ ...l, index }))
        .sort((a, b) => a.rating - b.rating);
      sorted.forEach((l, i) => {
        if (l.score_min > l.score_max) {
          ctx.addIssue({ code: "custom", path: [l.index, "score_max"], message: "Max must be ≥ min" });
        }
        const prev = sorted[i - 1];
        if (prev && l.score_min <= prev.score_max) {
          ctx.addIssue({
            code: "custom",
            path: [l.index, "score_min"],
            message: `Overlaps rating ${prev.rating}`,
          });
        }
      });
    }),
  is_default: z.boolean(),
  show_definitions_to_employees: z.boolean(),
});

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "");

/** Starting levels for a new scale: the standard five-point design. */
const STANDARD_LEVELS: PmsRatingScaleUpdate["levels"] = [
  { rating: 5, label: "Outstanding", definition: "Exceptional performance, consistently exceeds expectations", score_min: 4.5, score_max: 5, color: "#16A34A" },
  { rating: 4, label: "Exceeds Expectations", definition: "Consistently above expectations", score_min: 3.5, score_max: 4.49, color: "#2563EB" },
  { rating: 3, label: "Meets Expectations", definition: "Fully meets expectations", score_min: 2.5, score_max: 3.49, color: "#6366F1" },
  { rating: 2, label: "Needs Improvement", definition: "Partially meets expectations", score_min: 1.5, score_max: 2.49, color: "#D97706" },
  { rating: 1, label: "Unsatisfactory", definition: "Does not meet expectations", score_min: 1, score_max: 1.49, color: "#DC2626" },
];

/** Screen 2.10 — Rating Scale. */
const RatingScale = () => {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: scales = [], isLoading } = useGetPmsRatingScaleConfigsQuery();
  const [update, { isLoading: saving }] = useUpdatePmsRatingScaleMutation();
  const [createScale, { isLoading: creatingNow }] = useCreatePmsRatingScaleMutation();
  const [pickedId, setPickedId] = useState<string>("");
  // Create mode: a blank scale with a name, using the standard levels as a start.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const busy = saving || creatingNow;

  // The default scale opens first; the user can switch below.
  const scale = scales.find((s) => s.id === pickedId) ?? scales.find((s) => s.is_default) ?? scales[0];

  const form = useForm<PmsRatingScaleUpdate>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { levels: [], is_default: false, show_definitions_to_employees: true },
  });
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = form;

  const releaseGuard = useNavigationGuard(isDirty);

  useEffect(() => {
    if (scale && !creating) {
      reset({
        levels: scale.levels,
        is_default: scale.is_default,
        show_definitions_to_employees: scale.show_definitions_to_employees,
      });
    }
  }, [scale, reset, creating]);

  // Creating a scale has its own screen: pick the standards, then set the score ranges.
  const startCreate = () => navigate({ to: "/pms/configuration/rating-scale/new" });

  const onSubmit = async (body: PmsRatingScaleUpdate) => {
    if (creating) {
      if (!newName.trim()) {
        toast.error("Give the rating scale a name");
        return;
      }
      try {
        const saved = await createScale({ name: newName.trim(), body }).unwrap();
        releaseGuard();
        setCreating(false);
        setPickedId(saved.id);
        toast.success("Rating scale created");
      } catch (e) {
        toast.error(e, "Could not create the rating scale");
      }
      return;
    }
    if (!scale) return;
    try {
      const saved = await update({ id: scale.id, body }).unwrap();
      releaseGuard();
      reset({
        levels: saved.levels,
        is_default: saved.is_default,
        show_definitions_to_employees: saved.show_definitions_to_employees,
      });
      toast.success("Rating scale saved");
    } catch (e) {
      toast.error(e, "Could not save the rating scale");
    }
  };

  if (isLoading) return <PageLoader message="Loading rating scale…" />;

  // No scales yet: offer the first one instead of loading forever.
  if (!scale && !creating) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader
          title="Rating Scale"
          subtitle="Define rating levels, labels and score ranges used in appraisals"
          action={
            <Button type="button" onClick={startCreate}>
              <Plus className="mr-2 size-4" />
              Create Rating Scale
            </Button>
          }
        />
        <p className="text-sm text-muted-foreground">
          No rating scale exists for this organisation yet. Create one before publishing an appraisal cycle.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Rating Scale"
        subtitle="Define rating levels, labels and score ranges used in appraisals"
        action={
          !creating ? (
            <Button type="button" onClick={startCreate}>
              <Plus className="mr-2 size-4" />
              Create Rating Scale
            </Button>
          ) : undefined
        }
      />

      <PmsTableCard>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FormProvider {...form}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">
                {creating ? "New rating scale" : scale?.name} – Rating Levels
              </h2>
              {creating && (
                <Input
                  aria-label="Scale name"
                  className="w-64"
                  placeholder="e.g. Engineering 4-Point Scale"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              )}
              {scales.length > 1 && !creating && (
                <Select
                  value={scale?.id ?? ""}
                  onValueChange={(v) =>
                    isDirty
                      ? confirm({
                          title: "Discard changes?",
                          description: "Your edits to this scale haven't been saved.",
                          confirmText: "Discard",
                          variant: "destructive",
                          onConfirm: () => setPickedId(v),
                        })
                      : setPickedId(v)
                  }
                >
                  <SelectTrigger className="w-56" aria-label="Choose rating scale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scales.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                        {s.is_default ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <Table>
              <TableHeader>
                <TableRow className={PMS_HEADER_ROW}>
                  <PmsTh className="w-24">Rating</PmsTh>
                  <PmsTh className="w-[18rem]">Label</PmsTh>
                  <PmsTh>Definition</PmsTh>
                  <PmsTh className="w-[16rem]">Score Range</PmsTh>
                  <PmsTh className="w-20">Colour</PmsTh>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scale.levels.map((level, i) => {
                  const e = errors.levels?.[i];
                  return (
                    <TableRow key={`${scale.id}-${level.rating}`} className="hover:bg-transparent">
                      <TableCell className="align-top pt-5 font-semibold text-foreground">
                        {level.rating}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          aria-label={`Label for rating ${level.rating}`}
                          aria-invalid={!!e?.label}
                          {...register(`levels.${i}.label`)}
                        />
                        {e?.label && <p className="mt-1 text-xs text-destructive">{e.label.message}</p>}
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          aria-label={`Definition for rating ${level.rating}`}
                          aria-invalid={!!e?.definition}
                          {...register(`levels.${i}.definition`)}
                        />
                        {e?.definition && (
                          <p className="mt-1 text-xs text-destructive">{e.definition.message}</p>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex items-center gap-2">
                          <Controller
                            control={control}
                            name={`levels.${i}.score_min`}
                            render={({ field }) => (
                              <ScoreInput
                                label={`Minimum score for rating ${level.rating}`}
                                value={field.value}
                                onChange={field.onChange}
                                invalid={!!e?.score_min}
                              />
                            )}
                          />
                          <span className="text-muted-foreground">–</span>
                          <Controller
                            control={control}
                            name={`levels.${i}.score_max`}
                            render={({ field }) => (
                              <ScoreInput
                                label={`Maximum score for rating ${level.rating}`}
                                value={field.value}
                                onChange={field.onChange}
                                invalid={!!e?.score_max}
                              />
                            )}
                          />
                        </div>
                        {(e?.score_min || e?.score_max) && (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {e.score_min?.message ?? e.score_max?.message}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Controller
                          control={control}
                          name={`levels.${i}.color`}
                          render={({ field }) => (
                            <ColorPicker value={field.value} onChange={field.onChange} />
                          )}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <div className="mt-2 flex flex-wrap items-center gap-6 border-t pt-4">
              <Controller
                control={control}
                name="is_default"
                render={({ field }) => (
                  <Label className="flex cursor-pointer items-center gap-2 font-normal">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(c) => field.onChange(c === true)}
                    />
                    Set as default scale for new cycles
                  </Label>
                )}
              />
              <Controller
                control={control}
                name="show_definitions_to_employees"
                render={({ field }) => (
                  <Label className="flex cursor-pointer items-center gap-2 font-normal">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(c) => field.onChange(c === true)}
                    />
                    Show definitions to employees
                  </Label>
                )}
              />
            </div>

            <div className="mt-4 flex items-center justify-between border-t pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={(!creating && !isDirty) || busy}
                onClick={() => {
                  if (creating) {
                    setCreating(false);
                  } else if (scale) {
                    reset({
                      levels: scale.levels,
                      is_default: scale.is_default,
                      show_definitions_to_employees: scale.show_definitions_to_employees,
                    });
                  }
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : creating ? "Create Scale" : "Save Scale"}
              </Button>
            </div>
          </FormProvider>
        </form>
      </PmsTableCard>
    </div>
  );
};

/** Decimal input that shows two places once the user leaves the field. */
function ScoreInput({
  value,
  onChange,
  label,
  invalid,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  invalid: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      inputMode="decimal"
      className="w-24 text-center"
      aria-label={label}
      aria-invalid={invalid}
      value={draft ?? fmt(value)}
      onFocus={(e) => {
        // Start the draft from what is on screen so focusing never rewrites the text.
        setDraft(fmt(value));
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value === "" ? NaN : Number(e.target.value));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export default RatingScale;
