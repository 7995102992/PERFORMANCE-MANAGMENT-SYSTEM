import { cn } from '@/lib/utils';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  useComboboxAnchor,
} from '@/components/ui/combobox';

export interface Option {
  label: string;
  value: string;
  /** Optional muted sub-line rendered under the label (e.g. the parent BU of a department). */
  description?: string;
}

interface BaseProps {
  options: Option[];
  onSearchChange?: (search: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
}

interface SingleSelectProps extends BaseProps {
  multi?: false;
  value?: string;
  onChange: (value: string) => void;
}

interface MultiSelectProps extends BaseProps {
  multi: true;
  value?: string[];
  onChange: (value: string[]) => void;
}

export type SearchableSelectProps = SingleSelectProps | MultiSelectProps;

// ─── Single-select ────────────────────────────────────────────────────────────

function SingleSelect({
  options,
  value,
  onChange,
  onSearchChange,
  placeholder = 'Select an option...',
  emptyMessage = 'No options found.',
  searchable = true,
  disabled = false,
  className,
}: SingleSelectProps) {
  const singleValue = value ?? '';
  const getLabel = (val: string) => options.find((o) => o.value === val)?.label ?? val;

  return (
    <Combobox
      value={singleValue}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={disabled}
      items={options}
      itemToStringLabel={getLabel}
      {...(!searchable ? { filter: null } : {})}
    >
      <ComboboxInput
        placeholder={placeholder}
        showClear={!!singleValue}
        disabled={disabled}
        readOnly={!searchable}
        className={cn('w-full', className)}
        {...(onSearchChange ? { onInput: (e: React.FormEvent<HTMLInputElement>) => onSearchChange((e.target as HTMLInputElement).value) } : {})}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(item: Option) => (
            <ComboboxItem key={item.value} value={item.value}>
              {item.description ? (
                <span className="flex flex-col">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.description}</span>
                </span>
              ) : (
                item.label
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// ─── Multi-select ─────────────────────────────────────────────────────────────

function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select options...',
  emptyMessage = 'No options found.',
  searchable = true,
  disabled = false,
  className,
}: MultiSelectProps) {
  const selectedValues = value ?? [];
  const getLabel = (val: string) => options.find((o) => o.value === val)?.label ?? val;
  const anchor = useComboboxAnchor();

  return (
    <Combobox
      value={selectedValues}
      onValueChange={(vals) => onChange(vals ?? [])}
      disabled={disabled}
      multiple
      items={options}
      {...(!searchable ? { filter: null } : {})}
    >
      <ComboboxChips ref={anchor} className={cn('w-full', className)}>
        {selectedValues.map((v) => (
          <ComboboxChip key={v}>
            {getLabel(v)}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          placeholder={selectedValues.length === 0 ? placeholder : ''}
          readOnly={!searchable}
          disabled={disabled}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(item: Option) => (
            <ComboboxItem key={item.value} value={item.value}>
              {item.description ? (
                <span className="flex flex-col">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.description}</span>
                </span>
              ) : (
                item.label
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function SearchableSelect(props: SearchableSelectProps) {
  return props.multi ? <MultiSelect {...props} /> : <SingleSelect {...props} />;
}
