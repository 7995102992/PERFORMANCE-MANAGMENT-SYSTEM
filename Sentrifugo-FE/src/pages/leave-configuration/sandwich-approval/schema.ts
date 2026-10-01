import { z } from 'zod'

const sandwichApplyRuleEnum = z.enum([
  'between_two_leave_days',
  'before_a_leave_day',
  'after_a_leave_day',
  'before_or_after_leave_day',
  'between_two_holidays',
])

export const sandwichPolicySchema = z.object({
  enabled: z.boolean(),
  apply_rule_when: sandwichApplyRuleEnum,
  minimum_consecutive_value: z.number().int().min(1, 'Must be greater than 0'),
  minimum_consecutive_unit: z.enum(['days', 'hours']),
  ignore_half_day_leaves: z.boolean(),
})

const approvalLevelSchema = z.object({
  level: z.number().int().min(1).max(2),
})

export const approvalWorkflowSchema = z
  .object({
    approval_required: z.boolean(),
    levels_operator: z.enum(['AND', 'OR']).nullable().optional(),
    approval_levels: z.array(approvalLevelSchema).max(2),
    allow_hr_to_act: z.boolean(),
    allow_hr_to_view: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (!data.approval_required) return
    if (data.approval_levels.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Add at least one approval level when approval is required',
        path: ['approval_levels'],
      })
    }
    if (data.approval_levels.length === 2 && !data.levels_operator) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operator (AND / OR) is required when two levels are configured',
        path: ['levels_operator'],
      })
    }
    if (data.approval_levels.length !== 2 && data.levels_operator) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operator must be cleared when there is only one level',
        path: ['levels_operator'],
      })
    }
  })

export const sandwichApprovalSchema = z.object({
  sandwich: sandwichPolicySchema,
  approval: approvalWorkflowSchema,
})

export type SandwichApprovalFormValues = z.infer<typeof sandwichApprovalSchema>

export const defaultSandwichApprovalValues: SandwichApprovalFormValues = {
  sandwich: {
    enabled: false,
    apply_rule_when: 'between_two_leave_days',
    minimum_consecutive_value: 1,
    minimum_consecutive_unit: 'days',
    ignore_half_day_leaves: false,
  },
  approval: {
    approval_required: false,
    levels_operator: null,
    approval_levels: [],
    allow_hr_to_act: false,
    allow_hr_to_view: false,
  },
}
