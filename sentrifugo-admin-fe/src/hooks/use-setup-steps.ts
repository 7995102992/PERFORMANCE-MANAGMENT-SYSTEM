import { useMemo } from 'react'
import { useAppSelector } from '@/store'
import { useOrganisations } from '@/hooks/queries/use-organisation'
import type { SetupProgressDTO } from '@/api/org-setup/types'

export type SetupStepId =
  | 'organisation'
  | 'business-units'
  | 'departments'
  | 'org-documents'
  | 'designations'
  | 'employees'
  | 'assign-head'

export type StepStatus = 'locked' | 'pending' | 'completed'

export interface SetupStep {
  id: SetupStepId
  label: string
  path: string
  mandatory: boolean
  dependencies: SetupStepId[]
  status: StepStatus
  complete: boolean
  unlocked: boolean
  blockingLabel: string | null
}

const STEP_META: Array<Omit<SetupStep, 'status' | 'complete' | 'unlocked' | 'blockingLabel'>> = [
  { id: 'organisation',   label: 'Organisation',     path: '/settings/organisation',  mandatory: true,  dependencies: [] },
  { id: 'business-units', label: 'Business Units',   path: '/settings/business-units', mandatory: true,  dependencies: ['organisation'] },
  { id: 'departments',    label: 'Departments',      path: '/settings/departments',   mandatory: true,  dependencies: ['business-units'] },
  { id: 'org-documents',  label: 'Org. Documents',   path: '/settings/org-documents', mandatory: false, dependencies: ['organisation'] },
  { id: 'designations',   label: 'Job Levels',       path: '/settings/designations',  mandatory: true,  dependencies: ['departments'] },
  { id: 'employees',      label: 'Employees',        path: '/employees/list',         mandatory: false, dependencies: ['departments', 'designations'] },
  { id: 'assign-head',    label: 'Assign Head',      path: '/settings/assign-heads',  mandatory: false, dependencies: ['employees'] },
]

// BE uses underscores, FE step IDs use hyphens
const BE_KEY_MAP: Record<SetupStepId, string> = {
  'organisation':   'organisation',
  'business-units': 'business_units',
  'departments':    'departments',
  'org-documents':  'org_documents',
  'designations':   'designations',
  'employees':      'employees',
  'assign-head':    'assign_head',
}

function mapProgress(progress: SetupProgressDTO | undefined, hasOrg: boolean): Record<SetupStepId, StepStatus> {
  if (!progress) {
    return {
      'organisation':   hasOrg ? 'completed' : 'pending',
      'business-units': hasOrg ? 'pending' : 'locked',
      'departments':    'locked',
      'org-documents':  'locked',
      'designations':   'locked',
      'employees':      'locked',
      'assign-head':    'locked',
    }
  }

  const result = {} as Record<SetupStepId, StepStatus>
  for (const meta of STEP_META) {
    const beKey = BE_KEY_MAP[meta.id]
    result[meta.id] = (progress[beKey] as StepStatus) ?? 'locked'
  }

  // Job Levels bundles Bands, Pay Grades, Designations and Roles (all mandatory).
  // The step is complete only when all four have data — if a designation exists
  // but bands, pay grades or roles don't yet, keep the step pending.
  // ("policies" is the BE key for roles — policies with is_role=true.)
  if (result['designations'] === 'completed') {
    const bandsStatus = (progress['bands'] as StepStatus) ?? 'locked'
    const pgStatus = (progress['pay_grades'] as StepStatus) ?? 'locked'
    const rolesStatus = (progress['policies'] as StepStatus) ?? 'locked'
    if (
      bandsStatus !== 'completed' ||
      pgStatus !== 'completed' ||
      rolesStatus !== 'completed'
    ) {
      result['designations'] = 'pending'
    }
  }

  return result
}

export function useSetupSteps() {
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation)
  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const token = useAppSelector((s) => s.auth.token)
  const { data: orgs, isLoading } = useOrganisations(!!token && !isSuperAdmin)
  const org = orgs?.[0] ?? savedOrg ?? null
  const isInitialLoading = isLoading && !savedOrg

  const statusMap = useMemo(
    () => mapProgress(org?.setup_progress, !!org),
    [org],
  )

  const steps: SetupStep[] = useMemo(() => {
    const labelById = new Map(STEP_META.map((s) => [s.id, s.label]))
    return STEP_META.map((meta) => {
      const status = statusMap[meta.id]
      const complete = status === 'completed'
      const unlocked = status !== 'locked'
      const blockingDeps = meta.dependencies.filter((dep) => statusMap[dep] === 'locked' || statusMap[dep] === 'pending')
      const blockingLabel = !unlocked && blockingDeps.length > 0
        ? labelById.get(blockingDeps[0]) ?? blockingDeps[0]
        : null
      return { ...meta, status, complete, unlocked, blockingLabel }
    })
  }, [statusMap])

  const stepById = useMemo(() => {
    const m = new Map<SetupStepId, SetupStep>()
    steps.forEach((s) => m.set(s.id, s))
    return m
  }, [steps])

  const mandatorySteps = steps.filter((s) => s.mandatory)
  const optionalSteps = steps.filter((s) => !s.mandatory)
  const mandatoryDone = mandatorySteps.every((s) => s.complete)
  const completedCount = steps.filter((s) => s.complete).length
  const mandatoryCompletedCount = mandatorySteps.filter((s) => s.complete).length

  const currentStep =
    mandatorySteps.find((s) => !s.complete)
    ?? optionalSteps.find((s) => s.unlocked && !s.complete)
    ?? null

  return {
    steps,
    stepById,
    mandatorySteps,
    optionalSteps,
    mandatoryDone,
    mandatoryCompletedCount,
    completedCount,
    totalCount: steps.length,
    currentStep,
    isInitialLoading,
  }
}
