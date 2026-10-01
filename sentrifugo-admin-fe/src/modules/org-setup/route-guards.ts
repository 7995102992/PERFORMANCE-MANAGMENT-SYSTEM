import { redirect } from '@tanstack/react-router'
import { store } from '@/store'
import { toast } from '@/lib/toast'

const PREREQ_PATHS = {
  organisation: '/settings/organisation',
  business_units: '/settings/business-units',
  departments: '/settings/departments',
} as const

type PrereqKey = keyof typeof PREREQ_PATHS

export function requireSetupPrereq(prereq: PrereqKey) {
  return () => {
    const state = store.getState()
    if (state.auth.user?.is_super_admin) return

    const org = state.organisation.savedOrganisation
    if (!org?.setup_progress) return

    if (org.setup_progress[prereq] === 'completed') return

    toast.info('Complete the previous step first')
    throw redirect({ to: PREREQ_PATHS[prereq] })
  }
}
