import { useCallback, useRef, useState } from "react";
import { differenceInMonths, parseISO } from "date-fns";
import { useLazyGetEmployeesQuery } from "@/store/api/iamApi";
import type { EmployeeResponse } from "@/types/iam";
import type {
  PmsCycleApplicability,
  PmsEligibilityPreview,
  PmsEligibleEmployee,
  PmsEmploymentType,
} from "@/types/pms";

/** Employees per IAM page (the API allows up to 1000) and the most pages read. */
const PAGE = 1000;
const MAX_PAGES = 20;
/** The preview lists this many people; the totals count everyone. */
const MAX_ITEMS = 200;

/**
 * The PMS employment type of an employee. IAM keeps two things: the employment status (Permanent, Probation,
 * ... ) and the employment type (Full-time, Contract, Internship). Probation and Permanent come from the status,
 * Contract and Trainee from the type; a full-time employee with no clearer status counts as Permanent.
 */
function pmsType(e: EmployeeResponse): PmsEmploymentType | null {
  const status = `${e.employmentStatus?.key ?? ""} ${e.employmentStatus?.value ?? ""}`.toLowerCase();
  const type = `${e.employmentType?.key ?? ""} ${e.employmentType?.value ?? ""}`.toLowerCase();
  if (status.includes("probation") || type.includes("probation")) return "probationary";
  if (type.includes("contract") || status.includes("contract")) return "contract";
  if (type.includes("intern") || type.includes("trainee") || status.includes("trainee")) return "trainee";
  if (status.includes("permanent") || type.includes("permanent") || type.includes("full")) return "permanent";
  return null;
}

/** True when the employment status says the person is serving notice or has resigned. */
function isOnNotice(e: EmployeeResponse): boolean {
  const t = `${e.employmentStatus?.key ?? ""} ${e.employmentStatus?.value ?? ""}`.toLowerCase();
  return ["notice", "resign", "exit", "separat"].some((w) => t.includes(w));
}

/** Whole months of service from joining to the cut-off date; 0 when the joining date is unknown. */
function serviceMonths(joined: string | null | undefined, asOn: Date): number {
  if (!joined) return 0;
  const from = parseISO(joined.slice(0, 10));
  if (Number.isNaN(from.getTime())) return 0;
  return Math.max(0, differenceInMonths(asOn, from));
}

/**
 * Who a cycle would cover under the rules of the form. The employees come from IAM (`GET /employees/`, filtered
 * by the chosen plants and departments, active only); the employment type, notice period and service rules are
 * applied here because the API filters on one employment type at a time and has no service filter.
 */
export function useEligibilityPreview() {
  const [fetchEmployees] = useLazyGetEmployeesQuery();
  const [data, setData] = useState<PmsEligibilityPreview | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [isError, setError] = useState(false);
  // A newer run supersedes an older one that is still loading.
  const runId = useRef(0);

  const run = useCallback(
    async (rules: PmsCycleApplicability) => {
      const id = ++runId.current;
      setLoading(true);
      setError(false);
      try {
        const everyone: EmployeeResponse[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const rows = await fetchEmployees({
            business_unit_ids: rules.plant_ids.length > 0 ? rules.plant_ids : undefined,
            department_ids:
              !rules.all_departments && rules.department_ids.length > 0 ? rules.department_ids : undefined,
            is_active: true,
            skip: page * PAGE,
            limit: PAGE,
          }).unwrap();
          everyone.push(...rows);
          if (rows.length < PAGE) break;
        }

        const asOn = rules.appraisal.service_as_on ? parseISO(rules.appraisal.service_as_on) : new Date();
        let excludedNotice = 0;
        let excludedService = 0;
        let rated = 0;
        const items: PmsEligibleEmployee[] = [];
        for (const e of everyone) {
          const type = pmsType(e);
          if (!type || !rules.goal_setting.employment_types.includes(type)) continue;
          if (rules.exclude_notice_period && isOnNotice(e)) {
            excludedNotice++;
            continue;
          }
          const months = serviceMonths(e.dateOfJoining, asOn);
          if (months < rules.goal_setting.min_service_months) {
            excludedService++;
            continue;
          }
          const isRated =
            rules.appraisal.employment_types.includes(type) && months >= rules.appraisal.min_service_months;
          if (isRated) rated++;
          items.push({
            employee_id: e.userId ?? e.user_id ?? e.id,
            employee_code: e.empCode,
            name: `${e.firstName} ${e.lastName}`.trim(),
            department: e.departmentName ?? e.department_name,
            department_id: e.departmentId,
            plant: e.businessUnitName,
            plant_id: e.businessUnitId,
            employment_type: type,
            service_months: months,
            is_rated: isRated,
          });
        }
        items.sort((a, b) => a.employee_code.localeCompare(b.employee_code));
        if (id !== runId.current) return;
        setData({
          total_eligible: items.length,
          total_rated: rated,
          excluded_notice_period: excludedNotice,
          excluded_min_service: excludedService,
          items: items.slice(0, MAX_ITEMS),
        });
      } catch {
        if (id === runId.current) setError(true);
      } finally {
        if (id === runId.current) setLoading(false);
      }
    },
    [fetchEmployees],
  );

  /** Clears the result when the dialog closes. */
  const reset = useCallback(() => {
    runId.current++;
    setData(null);
    setError(false);
    setLoading(false);
  }, []);

  return { run, reset, data, isLoading, isError };
}
