import type { PmsTargetType, PmsCompetencyCategory } from "@/types/pms-config";

/**
 * Form-side shape of a goal template. The API only stores what was *selected*;
 * the form holds every master KRA / KPI / competency so the user can tick them,
 * and `template.utils.ts` converts between the two.
 */
export interface TemplateKpiRow {
  kpi_id: string;
  name: string;
  unit: string;
  selected: boolean;
  weight: number;
  target_type: PmsTargetType;
  expected_outcome: string;
  evidence_required: string;
}

export interface TemplateKraRow {
  kra_id: string;
  name: string;
  selected: boolean;
  kpis: TemplateKpiRow[];
}

export interface TemplateCompetencyRow {
  competency_id: string;
  name: string;
  category: PmsCompetencyCategory;
  selected: boolean;
  weight: number;
}

export interface TemplateFormValues {
  basic: {
    financial_year: number;
    name: string;
    description: string;
    department_id: string;
    designation_id: string;
    effective_from: string;
    status: "active" | "inactive";
  };
  kras: TemplateKraRow[];
  competencies: TemplateCompetencyRow[];
}
