import { useState } from "react";
import { Input } from "@/components/ui/input";

/** Props for WeightInput. `value` is a clean number; `onChange` receives the parsed number (0 when empty). */
interface WeightInputProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}

/**
 * Percent input that keeps what the user is typing ("1.", "12.5") intact while
 * the form holds a clean number — an empty field is 0, never NaN.
 */
export function WeightInput({ value, onChange, label, disabled, invalid }: WeightInputProps) {
  // What the user is typing ("1.", "12.5"), kept separate from the numeric form value.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      inputMode="decimal"
      className="w-20 text-center"
      aria-label={label}
      aria-invalid={invalid}
      disabled={disabled}
      value={draft ?? String(value ?? 0)}
      // Start the draft from the shown value and select it, so typing replaces it.
      onFocus={(e) => {
        setDraft(String(value ?? 0));
        e.currentTarget.select();
      }}
      // Accept digits with at most two decimals; an empty field counts as 0.
      onChange={(e) => {
        const text = e.target.value;
        if (!/^\d*\.?\d{0,2}$/.test(text)) return;
        setDraft(text);
        onChange(text === "" || text === "." ? 0 : Number(text));
      }}
      // Leaving the field drops the draft, so the clean number is shown again.
      onBlur={() => setDraft(null)}
    />
  );
}
