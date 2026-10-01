import type {
  PmsCompetency,
  PmsGoalTemplate,
  PmsGoalTemplateUpsert,
  PmsKpi,
  PmsKra,
  PmsTemplateStatus,
} from "@/types/pms-config";
import { dateToIso } from "../../shared/pms.utils";
import { currentFinancialYear } from "../config.constants";
import type { TemplateFormValues } from "./template.types";

export const WEIGHT_EPSILON = 0.01;

export const sumWeights = (rows: { selected: boolean; weight: number }[]) =>
  rows.filter((r) => r.selected).reduce((total, r) => total + (Number(r.weight) || 0), 0);

/** Whole-number split of 100 across `n` rows, remainder to the first rows (8,8,7,7…). */
export function distributeEqually(n: number): number[] {
  if (n === 0) return [];
  const base = Math.floor(100 / n);
  const extra = 100 - base * n;
  return Array.from({ length: n }, (_, i) => (i < extra ? base + 1 : base));
}

/** Merge the masters with a saved template (or nothing, for a new one) into form values. */
export function buildFormValues(
  masters: { kras: PmsKra[]; kpis: PmsKpi[]; competencies: PmsCompetency[] },
  template?: PmsGoalTemplate,
): TemplateFormValues {
  const savedKra = new Map(template?.kras.map((k) => [k.kra_id, k]));
  const savedKpi = new Map(template?.kras.flatMap((k) => k.kpis).map((p) => [p.kpi_id, p]));
  const savedComp = new Map(template?.competencies.map((c) => [c.competency_id, c]));

  const active = masters.competencies.filter((c) => c.is_active || savedComp.has(c.id));
  // New templates start with every competency ticked and the weights split evenly.
  const defaults = distributeEqually(active.length);

  return {
    basic: {
      financial_year: template?.basic.financial_year ?? currentFinancialYear(),
      name: template?.basic.name ?? "",
      description: template?.basic.description ?? "",
      department_id: template?.basic.department_id ?? "",
      designation_id: template?.basic.designation_id ?? "",
      effective_from: template?.basic.effective_from ?? dateToIso(new Date(currentFinancialYear(), 3, 1)),
      status: template?.basic.status === "inactive" ? "inactive" : "active",
    },
    kras: masters.kras.map((kra) => ({
      kra_id: kra.id,
      name: kra.name,
      selected: savedKra.has(kra.id),
      kpis: masters.kpis
        .filter((k) => k.kra_id === kra.id)
        .map((k) => {
          const saved = savedKpi.get(k.id);
          return {
            kpi_id: k.id,
            name: k.name,
            unit: k.unit,
            selected: !!saved,
            weight: saved?.weight ?? 0,
            target_type: saved?.target_type ?? k.target_type,
            expected_outcome: saved?.expected_outcome ?? k.expected_outcome,
            evidence_required: saved?.evidence_required ?? k.evidence_required,
          };
        }),
    })),
    competencies: active.map((c, i) => {
      const saved = savedComp.get(c.id);
      return {
        competency_id: c.id,
        name: c.name,
        category: c.category,
        selected: template ? !!saved : true,
        weight: saved?.weight ?? (template ? 0 : defaults[i]),
      };
    }),
  };
}

/** Form values → API body, keeping only what the user selected. */
export function toApiBody(values: TemplateFormValues, status: PmsTemplateStatus): PmsGoalTemplateUpsert {
  return {
    basic: { ...values.basic, status },
    kras: values.kras
      .filter((k) => k.selected)
      .map((k) => ({
        kra_id: k.kra_id,
        kpis: k.kpis
          .filter((p) => p.selected)
          .map(({ kpi_id, weight, target_type, expected_outcome, evidence_required }) => ({
            kpi_id,
            weight: Number(weight) || 0,
            target_type,
            expected_outcome,
            evidence_required,
          })),
      })),
    competencies: values.competencies
      .filter((c) => c.selected)
      .map((c) => ({ competency_id: c.competency_id, weight: Number(c.weight) || 0 })),
  };
}
