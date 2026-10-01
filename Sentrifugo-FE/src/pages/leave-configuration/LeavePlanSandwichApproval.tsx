import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  sandwichApprovalSchema,
  defaultSandwichApprovalValues,
  type SandwichApprovalFormValues,
} from './sandwich-approval/schema'
import { SandwichPolicySection } from './sandwich-approval/sections/SandwichPolicySection'
import { ApprovalWorkflowSection } from './sandwich-approval/sections/ApprovalWorkflowSection'
import {
  useGetSandwichPolicyQuery,
  useUpsertSandwichPolicyMutation,
  useGetApprovalPolicyQuery,
  useUpsertApprovalPolicyMutation,
} from '@/store/api/lmsApi'
import { useScrollToError } from '@/hooks/use-scroll-to-error'
import { toast } from '@/lib/toast'

export interface LeavePlanSandwichApprovalHandle {
  triggerSubmit: () => Promise<boolean>
  scrollToFirstError: () => void
}

interface Props {
  planId?: string
  onDirtyChange?: (dirty: boolean) => void
}

const LeavePlanSandwichApproval = forwardRef<LeavePlanSandwichApprovalHandle, Props>(
  function LeavePlanSandwichApproval({ planId, onDirtyChange }, ref) {
    const { data: sandwichData } = useGetSandwichPolicyQuery(planId!, { skip: !planId })
    const { data: approvalData } = useGetApprovalPolicyQuery(planId!, { skip: !planId })

    const [upsertSandwich] = useUpsertSandwichPolicyMutation()
    const [upsertApproval] = useUpsertApprovalPolicyMutation()

    const methods = useForm<SandwichApprovalFormValues>({
      resolver: zodResolver(sandwichApprovalSchema),
      defaultValues: defaultSandwichApprovalValues,
    })

    const scrollToError = useScrollToError('[data-sandwich-approval-form]')

    const { isDirty } = methods.formState
    useEffect(() => {
      onDirtyChange?.(isDirty)
    }, [isDirty, onDirtyChange])

    useEffect(() => {
      if (!sandwichData && !approvalData) return
      methods.reset({
        sandwich: sandwichData
          ? {
              enabled: sandwichData.enabled,
              apply_rule_when: sandwichData.apply_rule_when,
              minimum_consecutive_value: sandwichData.minimum_consecutive_value,
              minimum_consecutive_unit: sandwichData.minimum_consecutive_unit,
              ignore_half_day_leaves: sandwichData.ignore_half_day_leaves,
            }
          : defaultSandwichApprovalValues.sandwich,
        approval: approvalData
          ? {
              approval_required: approvalData.approval_required,
              levels_operator: approvalData.levels_operator ?? null,
              approval_levels: approvalData.approval_levels.map((l) => ({
                level: l.level,
              })),
              allow_hr_to_act: approvalData.allow_hr_to_act ?? false,
              allow_hr_to_view: approvalData.allow_hr_to_view ?? false,
            }
          : defaultSandwichApprovalValues.approval,
      })
    }, [sandwichData, approvalData])

    useImperativeHandle(ref, () => ({
      scrollToFirstError: scrollToError,
      triggerSubmit: () =>
        new Promise<boolean>((resolve) => {
          methods.handleSubmit(
            async (values) => {
              if (!planId) { resolve(false); return }
              try {
                await Promise.all([
                  upsertSandwich({ planId, body: values.sandwich }).unwrap(),
                  upsertApproval({
                    planId,
                    body: {
                      approval_required: values.approval.approval_required,
                      levels_operator:
                        values.approval.approval_levels.length === 2
                          ? (values.approval.levels_operator ?? null)
                          : null,
                      approval_levels: values.approval.approval_levels.map((_, i) => ({
                        level: i + 1,
                      })),
                      allow_hr_to_act: values.approval.allow_hr_to_act,
                      allow_hr_to_view: values.approval.allow_hr_to_view,
                    },
                  }).unwrap(),
                ])
                methods.reset(values, { keepValues: true })
                resolve(true)
              } catch (err) {
                toast.error(err, 'Failed to save sandwich & approval configuration')
                resolve(false)
              }
            },
            () => {
              scrollToError()
              toast.error('Please fix the highlighted fields.')
              resolve(false)
            },
          )()
        }),
    }))

    return (
      <FormProvider {...methods}>
        <form data-sandwich-approval-form className="w-full space-y-6">
          <SandwichPolicySection />
          <ApprovalWorkflowSection />
        </form>
      </FormProvider>
    )
  },
)

export default LeavePlanSandwichApproval
