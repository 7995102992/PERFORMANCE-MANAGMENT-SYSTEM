import { useEffect, useState } from "react";
import { Controller, FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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

/** Screen 2.10 — Rating Scale. */
const RatingScale = () => {
  const confirm = useConfirm();
  const { data: scales = [], isLoading } = useGetPmsRatingScaleConfigsQuery();
  const [update, { isLoading: saving }] = useUpdatePmsRatingScaleMutation();
  const [pickedId, setPickedId] = useState<string>("");

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
    if (scale) {
      reset({
        levels: scale.levels,
        is_default: scale.is_default,
        show_definitions_to_employees: scale.show_definitions_to_employees,
      });
    }
  }, [scale, reset]);

  const onSubmit = async (body: PmsRatingScaleUpdate) => {
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

  if (isLoading || !scale) return <PageLoader message="Loading rating scale…" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Rating Scale"
        subtitle="Define rating levels, labels and score ranges used in appraisals"
      />

      <PmsTableCard>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FormProvider {...form}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">
                {scale.name} – Rating Levels
              </h2>
              {scales.length > 1 && (
                <Select
                  value={scale.id}
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
                disabled={!isDirty || saving}
                onClick={() =>
                  reset({
                    levels: scale.levels,
                    is_default: scale.is_default,
                    show_definitions_to_employees: scale.show_definitions_to_employees,
                  })
                }
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save Scale"}
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
