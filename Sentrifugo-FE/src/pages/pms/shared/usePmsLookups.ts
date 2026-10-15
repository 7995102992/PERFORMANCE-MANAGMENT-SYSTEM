import { useMemo } from "react";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useGetDesignationsQuery,
} from "@/store/api/iamApi";
import {
  departmentFromIam,
  designationFromIam,
  LOOKUP_PAGE_SIZE,
  plantFromIam,
} from "@/store/api/pmsLookups";

/** Plants for the PMS screens: IAM business units, as `{ id, name }`. */
export function usePmsPlants() {
  const { data, isLoading, isFetching } = useGetBusinessUnitsQuery({ is_active: true, limit: LOOKUP_PAGE_SIZE });
  // Memoised so the select options keep the same identity between renders.
  const plants = useMemo(() => (data ?? []).map(plantFromIam), [data]);
  return { data: plants, isLoading, isFetching };
}

/** Departments for the PMS screens, as `{ id, name }`. */
export function usePmsDepartments() {
  const { data, isLoading, isFetching } = useGetDepartmentsQuery({ is_active: true, limit: LOOKUP_PAGE_SIZE });
  const departments = useMemo(() => (data ?? []).map(departmentFromIam), [data]);
  return { data: departments, isLoading, isFetching };
}

/**
 * Designations of one department, as `{ id, name, department_id }`.
 * Nothing is requested until a department is chosen.
 */
export function usePmsDesignations(departmentId?: string) {
  const { data, isLoading, isFetching } = useGetDesignationsQuery(
    { department_id: departmentId, limit: LOOKUP_PAGE_SIZE },
    { skip: !departmentId },
  );
  const designations = useMemo(
    () => (data ?? []).filter((d) => d.is_active !== false).map(designationFromIam),
    [data],
  );
  return { data: designations, isLoading, isFetching };
}
