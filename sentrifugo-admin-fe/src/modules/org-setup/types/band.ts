export interface Band {
  id: string;
  name: string;
  // classLabel: string;
  // frequency: string;
  currency?: string;
  minAmount?: number;
  maxAmount?: number;
  effectiveFrom?: string; // ISO date
  effectiveTo?: string;   // ISO date
  notes: string;
  is_active: boolean;
}
