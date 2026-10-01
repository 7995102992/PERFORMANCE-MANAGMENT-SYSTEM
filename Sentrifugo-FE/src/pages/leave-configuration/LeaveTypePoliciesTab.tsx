import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
} from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  entitlementSchema,
  defaultEntitlementValues,
  type EntitlementFormValues,
} from './leave-entitlement/schema'
// Mid-year section hidden — always pro_rate for now (schema default).
// import { MidYearJoinersSection } from './leave-entitlement/sections/MidYearJoinersSection'
import { ProbationSection } from './leave-entitlement/sections/ProbationSection'
// Negative balance disabled product-wide — section hidden.
// import { NegativeBalanceSection } from './leave-entitlement/sections/NegativeBalanceSection'
import { FractionalBalanceSection } from './leave-entitlement/sections/FractionalBalanceSection'
import { RequestLimitsSection } from './leave-entitlement/sections/RequestLimitsSection'
import { LeaveLimitsSection } from './leave-entitlement/sections/LeaveLimitsSection'
import { NoticePeriodSection } from './leave-entitlement/sections/NoticePeriodSection'
import { BackdatedLeaveSection } from './leave-entitlement/sections/BackdatedLeaveSection'
import type { LeaveTypePolicies } from '@/types/leave'

// The leave-type policies are the entitlement config minus the distribution
// (accrual lives on the leave type's Accrual tab now). These are the keys we
// persist back as `policies`.
const POLICY_KEYS = [
  'mid_year_joining',
  'probation',
  'future_request',
  'negative_balance',
  'fractional_balance',
  'credit_expiry',
  'credit_timing',
  'upload_requirement',
  'comment_requirement',
  'request_limits',
  'clubbing',
  'continuous_limit',
  'monthly_limit',
  'notice_period_leave',
  'backdated_leave',
] as const

export interface LeaveTypePoliciesHandle {
  /** Validate; returns the policies object when valid, otherwise null. */
  collect: () => Promise<LeaveTypePolicies | null>
}

interface LeaveTypePoliciesTabProps {
  initialPolicies?: LeaveTypePolicies | null
  readOnly?: boolean
  onDirtyChange?: (dirty: boolean) => void
}

export const LeaveTypePoliciesTab = forwardRef<
  LeaveTypePoliciesHandle,
  LeaveTypePoliciesTabProps
>(function LeaveTypePoliciesTab({ initialPolicies, readOnly, onDirtyChange }, ref) {
  const methods = useForm<EntitlementFormValues>({
    resolver: zodResolver(entitlementSchema),
    defaultValues: {
      ...defaultEntitlementValues,
      ...(initialPolicies as Partial<EntitlementFormValues> | undefined),
    },
    mode: 'onBlur',
  })

  // Cap checks from the plan-coupled sections. On a leave type there's no plan
  // grant to validate against, so these stay false (no-op).
  const [, setMidYearCap] = useState(false)
  const [, setContinuousCap] = useState(false)
  const handleMidYearCap = useCallback((c: boolean) => setMidYearCap(c), [])
  const handleContinuousCap = useCallback((c: boolean) => setContinuousCap(c), [])

  const { isDirty } = methods.formState
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Re-seed when an existing leave type's policies arrive.
  useEffect(() => {
    if (!initialPolicies) return
    methods.reset({
      ...defaultEntitlementValues,
      ...(initialPolicies as Partial<EntitlementFormValues>),
    } as EntitlementFormValues)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPolicies])

  useImperativeHandle(ref, () => ({
    collect: () =>
      new Promise<LeaveTypePolicies | null>((resolve) => {
        methods.handleSubmit(
          (values) => {
            const policies: Record<string, unknown> = {}
            for (const key of POLICY_KEYS) {
              policies[key] = (values as Record<string, unknown>)[key]
            }
            resolve(policies as LeaveTypePolicies)
          },
          () => resolve(null),
        )()
      }),
  }))

  return (
    <FormProvider {...methods}>
      <fieldset
        disabled={readOnly}
        data-leave-type-policies
        className="w-full space-y-6 border-0 p-0 m-0 disabled:opacity-75"
      >
        {/* Mid-year joiners hidden — always pro_rate for now. */}
        {/* <MidYearJoinersSection onCapChange={handleMidYearCap} /> */}
        <ProbationSection />
        {/* Negative balance disabled product-wide — balance is always capped at the current balance. */}
        {/* <NegativeBalanceSection /> */}
        <FractionalBalanceSection />
        <RequestLimitsSection />
        <LeaveLimitsSection onContinuousCapChange={handleContinuousCap} />
        <NoticePeriodSection />
        <BackdatedLeaveSection />
      </fieldset>
    </FormProvider>
  )
})
