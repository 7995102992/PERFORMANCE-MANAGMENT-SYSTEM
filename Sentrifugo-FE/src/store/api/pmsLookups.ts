import type { BaseQueryApi } from '@reduxjs/toolkit/query'
import type { BusinessUnitResponse, DepartmentResponse, DesignationResponse } from '@/types/iam'
import type { PmsLookupOption } from '@/types/pms'
import type { PmsDesignationOption } from '@/types/pms-config'
import { iamApi } from './iamApi'
import type { PmsLookups } from './pmsMappers'

/*
 * Plants, departments and designations are IAM org data: a PMS "plant" is an IAM
 * business unit. The PMS API stores their ids only, so the screens read the names
 * from IAM and map them onto the option shapes the PMS module already uses.
 */

/** Matches the page size the other modules ask IAM for. */
export const LOOKUP_PAGE_SIZE = 100

/** IAM business unit to a PMS plant option. */
export const plantFromIam = (b: BusinessUnitResponse): PmsLookupOption => ({
  id: b.id,
  name: b.business_unit_name,
})

/** IAM department to a PMS department option. */
export const departmentFromIam = (d: DepartmentResponse): PmsLookupOption => ({
  id: d.id,
  name: d.departmentName,
})

/** IAM designation to a PMS role option (with its department). */
export const designationFromIam = (d: DesignationResponse): PmsDesignationOption => ({
  id: d.id,
  name: d.designationName,
  department_id: d.departmentId,
})

/**
 * Resolves the lookups inside a `queryFn`, using the IAM cache (kept for an hour).
 * A lookup that fails comes back empty: the PMS screen still loads, with ids where names would be.
 */
export async function fetchLookups(api: Pick<BaseQueryApi, 'dispatch'>): Promise<PmsLookups> {
  const [plants, departments, designations] = await Promise.all([
    api
      .dispatch(iamApi.endpoints.getBusinessUnits.initiate({ is_active: true, limit: LOOKUP_PAGE_SIZE }))
      .unwrap()
      .then((rows) => rows.map(plantFromIam))
      .catch(() => [] as PmsLookupOption[]),
    api
      .dispatch(iamApi.endpoints.getDepartments.initiate({ is_active: true, limit: LOOKUP_PAGE_SIZE }))
      .unwrap()
      .then((rows) => rows.map(departmentFromIam))
      .catch(() => [] as PmsLookupOption[]),
    api
      .dispatch(iamApi.endpoints.getDesignations.initiate({ limit: LOOKUP_PAGE_SIZE }))
      .unwrap()
      .then((rows) => rows.map(designationFromIam))
      .catch(() => [] as PmsDesignationOption[]),
  ])
  return { plants, departments, designations }
}
