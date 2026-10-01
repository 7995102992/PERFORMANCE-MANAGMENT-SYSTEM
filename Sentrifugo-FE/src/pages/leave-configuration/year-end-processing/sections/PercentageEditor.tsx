import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { YearEndFormValues } from "../schema";

export function PercentageEditor() {
  const { control, setValue } = useFormContext<YearEndFormValues>();

  const payoutPct =
    useWatch({
      control,
      name: "payout_carry_config.percentage_config.payout_percentage",
    }) ?? 50;

  const handlePayoutChange = (val: number) => {
    const clamped = Math.min(100, Math.max(0, val));
    setValue(
      "payout_carry_config.percentage_config.payout_percentage",
      clamped,
      {
        shouldValidate: true,
      },
    );
    setValue(
      "payout_carry_config.percentage_config.carry_percentage",
      100 - clamped,
      {
        shouldValidate: true,
      },
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-semibold">Payout / Carry Split</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Adjusting the payout percentage automatically updates carry percentage
          so they always sum to 100%.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Label className="text-xs font-semibold whitespace-nowrap w-40">
            Payout Percentage
          </Label>
          <Controller
            control={control}
            name="payout_carry_config.percentage_config.payout_percentage"
            render={({ field, fieldState }) => (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={field.value}
                  onChange={(e) =>
                    handlePayoutChange(parseFloat(e.target.value) || 0)
                  }
                  className="w-20 h-9 text-sm text-right"
                  aria-label="Payout percentage"
                />
                <span className="text-sm text-muted-foreground">%</span>
                {fieldState.error && (
                  <p className="text-xs text-destructive">
                    {fieldState.error.message}
                  </p>
                )}
              </div>
            )}
          />
        </div>

        <div className="flex items-center gap-4">
          <Label className="text-xs font-semibold whitespace-nowrap w-40">
            Carry Forward %
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              readOnly
              value={100 - payoutPct}
              className="w-20 h-9 text-sm text-right bg-muted/30"
              aria-label="Carry forward percentage (auto-calculated)"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </div>

        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={payoutPct}
          onChange={(e) => handlePayoutChange(parseInt(e.target.value, 10))}
          className="w-full accent-primary cursor-pointer"
          aria-label="Payout / carry forward split slider"
        />

        <div className="flex items-center justify-between py-3 px-4 bg-muted/30 rounded-xl border border-border">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Payout</p>
            <p className="text-xl font-bold text-primary">{payoutPct}%</p>
          </div>
          <span className="text-muted-foreground text-sm">+</span>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Carry Forward</p>
            <p className="text-xl font-bold">{100 - payoutPct}%</p>
          </div>
          <span className="text-muted-foreground text-sm">=</span>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold text-success">100%</p>
          </div>
        </div>
      </div>
    </div>
  );
}
