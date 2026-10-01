import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { entitlementSchema, defaultEntitlementValues } from './schema'
import type { EntitlementFormValues } from './schema'
import {
  useGetPlanEntitlementQuery,
  useCreatePlanEntitlementMutation,
  useUpdatePlanEntitlementMutation,
} from '@/store/api/lmsApi'
import { useScrollToError } from '@/hooks/use-scroll-to-error'
import { toast } from '@/lib/toast'

// Mid-year section hidden — always pro_rate for now (schema default).
// import { MidYearJoinersSection } from './sections/MidYearJoinersSection'
import { ProbationSection } from './sections/ProbationSection'
// Negative balance disabled product-wide — section hidden.
// import { NegativeBalanceSection } from './sections/NegativeBalanceSection'
import { FractionalBalanceSection } from './sections/FractionalBalanceSection'
import { RequestLimitsSection } from './sections/RequestLimitsSection'
// import { ClubbingSection } from './sections/ClubbingSection'
// import { ContinuousLeaveLimitSection } from './sections/ContinuousLeaveLimitSection'
// import { MonthlyLimitSection } from './sections/MonthlyLimitSection'
import { LeaveLimitsSection } from './sections/LeaveLimitsSection'
import { NoticePeriodSection } from './sections/NoticePeriodSection'
import { BackdatedLeaveSection } from './sections/BackdatedLeaveSection'
import { JoiningRuleSection } from './sections/JoiningRuleSection'
import { ExtraLeaveSection } from './sections/ExtraLeaveSection'

export interface LeaveEntitlementFormHandle {
  triggerSubmit: () => Promise<boolean>
  scrollToFirstError: () => void
}

interface LeaveEntitlementFormProps {
  planId?: string
  initialValues?: Partial<EntitlementFormValues>
  onValidityChange?: (isValid: boolean) => void
  onDirtyChange?: (isDirty: boolean) => void
}

const LeaveEntitlementForm = forwardRef<LeaveEntitlementFormHandle, LeaveEntitlementFormProps>(
  function LeaveEntitlementForm({ planId, initialValues, onDirtyChange }, ref) {
    const { data: planEntitlement, isLoading } = useGetPlanEntitlementQuery(planId!, {
      skip: !planId,
    })
    const [createPlanEntitlement] = useCreatePlanEntitlementMutation()
    const [updatePlanEntitlement] = useUpdatePlanEntitlementMutation()

    const methods = useForm<EntitlementFormValues>({
      resolver: zodResolver(entitlementSchema),
      defaultValues: { ...defaultEntitlementValues, ...initialValues },
      mode: 'onBlur',
    })

    const scrollToError = useScrollToError('[data-entitlement-form]')

    // Cap checks (mid-year overlaps/coverage, etc.) live in their sections and
    // report up here via refs — read only at submit time in triggerSubmit.
    const continuousCapRef = useRef(false)
    const midYearCapRef = useRef(false)

    const handleContinuousCapChange = useCallback((cap: boolean) => {
      continuousCapRef.current = cap
    }, [])

    const handleMidYearCapChange = useCallback((cap: boolean) => {
      midYearCapRef.current = cap
    }, [])

    const { isDirty } = methods.formState
    useEffect(() => {
      onDirtyChange?.(isDirty)
    }, [isDirty, onDirtyChange])

    useEffect(() => {
      if (!planEntitlement?.entitlement) return
      // joining_rule + extra_leave were merged in from the old Grant step; the
      // generated response type predates that, so widen it here.
      const incoming = planEntitlement.entitlement as typeof planEntitlement.entitlement & {
        joining_rule?: EntitlementFormValues['joining_rule']
        extra_leave?: EntitlementFormValues['extra_leave']
      }
      methods.reset({
        ...defaultEntitlementValues,
        ...incoming,
        mid_year_joining: {
          ...defaultEntitlementValues.mid_year_joining,
          ...incoming.mid_year_joining,
          enabled: incoming.mid_year_joining?.enabled ?? defaultEntitlementValues.mid_year_joining.enabled,
          mode: incoming.mid_year_joining?.mode ?? defaultEntitlementValues.mid_year_joining.mode,
        },
        request_limits: {
          ...defaultEntitlementValues.request_limits,
          ...(incoming.request_validation?.request_limits ?? incoming.request_limits),
          max_requests_allowed: incoming.request_validation?.request_limits?.max_requests_allowed ?? incoming.request_limits?.max_requests_allowed ?? defaultEntitlementValues.request_limits.max_requests_allowed,
          period: incoming.request_validation?.request_limits?.period ?? incoming.request_limits?.period ?? defaultEntitlementValues.request_limits.period,
        },
        upload_requirement: {
          ...defaultEntitlementValues.upload_requirement,
          ...(incoming.request_validation?.upload_requirement ?? incoming.upload_requirement),
        },
        comment_requirement: {
          ...defaultEntitlementValues.comment_requirement,
          ...(incoming.request_validation?.comment_requirement ?? incoming.comment_requirement),
        },
        notice_period_leave: {
          ...defaultEntitlementValues.notice_period_leave,
          ...incoming.notice_period_leave,
          mode: incoming.notice_period_leave?.mode ?? defaultEntitlementValues.notice_period_leave.mode,
          extend_notice_by_leave_days: incoming.notice_period_leave?.extend_notice_by_leave_days ?? defaultEntitlementValues.notice_period_leave.extend_notice_by_leave_days,
        },
        // Merged from the (removed) Grant Configuration step.
        joining_rule: {
          ...defaultEntitlementValues.joining_rule,
          ...incoming.joining_rule,
          first_month_restriction: {
            ...defaultEntitlementValues.joining_rule.first_month_restriction,
            ...incoming.joining_rule?.first_month_restriction,
          },
        },
        extra_leave: {
          ...defaultEntitlementValues.extra_leave,
          ...incoming.extra_leave,
        },
      } as EntitlementFormValues)
    }, [planEntitlement])

    useImperativeHandle(ref, () => ({
      scrollToFirstError: scrollToError,
      triggerSubmit: async (): Promise<boolean> => {
        // Validate EVERY field (not just blurred ones) so all errors render,
        // then combine with the component-level cap checks (mid-year, etc.).
        const zodValid = await methods.trigger()
        const capInvalid = continuousCapRef.current || midYearCapRef.current
        if (!zodValid || capInvalid) {
          // Defer one frame so the just-rendered error elements are in the DOM,
          // then scroll to the first error of any kind (zod or cap).
          requestAnimationFrame(() => scrollToError())
          toast.error('Please fix the highlighted fields before continuing.')
          return false
        }

        if (!planId) return false
        const values = methods.getValues()
        const payload = {
          ...values,
          mid_year_joining: {
            ...values.mid_year_joining,
            // Slab allocation is nullable while editing (empty field); it's
            // guaranteed filled at a valid submit, so coerce to a number.
            slab_rules: (values.mid_year_joining.slab_rules ?? []).map((s) => ({
              ...s,
              allocation: s.allocation ?? 0,
            })),
          },
          request_validation: {
            upload_requirement: values.upload_requirement,
            comment_requirement: values.comment_requirement,
            request_limits: values.request_limits,
            allow_past_dates: values.backdated_leave?.enabled ?? true,
            allow_future_dates: values.future_request?.allow_future_requests ?? true,
          },
        }
        try {
          if (planEntitlement) {
            await updatePlanEntitlement({ planId, entitlement: payload }).unwrap()
          } else {
            await createPlanEntitlement({ leave_plan_id: planId, entitlement: payload }).unwrap()
          }
          methods.reset(values, { keepValues: true })
          return true
        } catch (err) {
          toast.error(err, 'Failed to save entitlement configuration')
          return false
        }
      },
    }))

    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
          Loading entitlement configuration...
        </div>
      )
    }

    return (
      <FormProvider {...methods}>
        <form data-entitlement-form className="w-full space-y-6">
          <JoiningRuleSection />
          {/* Mid-year joiners hidden — always pro_rate for now. */}
          {/* <MidYearJoinersSection planId={planId} onCapChange={handleMidYearCapChange} /> */}
          <ProbationSection planId={planId} />
          {/* Negative balance disabled product-wide — balance is always capped at the current balance. */}
          {/* <NegativeBalanceSection /> */}
          <FractionalBalanceSection />
          <RequestLimitsSection />
          {/* <ClubbingSection /> */}
          <LeaveLimitsSection planId={planId} onContinuousCapChange={handleContinuousCapChange} />
          <NoticePeriodSection />
          <BackdatedLeaveSection />
          <ExtraLeaveSection />
        </form>
      </FormProvider>
    )
  },
)

export default LeaveEntitlementForm
