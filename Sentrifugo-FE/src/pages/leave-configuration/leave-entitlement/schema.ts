import { z } from 'zod'

// ─── Sub-schemas ───────────────────────────────────────────────

const stepAccrualRuleSchema = z.object({
  from_day: z.number().int().min(1).max(31),
  to_day: z.number().int().min(1).max(31),
  allocation: z.number().min(0),
  unit: z.string(),
})

const bandRuleSchema = z.object({
  from_month: z.number().int().min(0),
  to_month: z.number().int().min(0),
  credit_amount: z.number().min(0),
  unit: z.string(),
})

const midYearSlabRuleSchema = z.object({
  from_date: z.string(),
  to_date: z.string(),
  // Nullable so the field can be empty until entered (it is mandatory, but 0
  // is a valid value the user types explicitly — see MidYearJoinersSection).
  allocation: z.number().min(0).nullable(),
  unit: z.string(),
})

const dateRangeCreditRuleSchema = z.object({
  from_day: z.number().int().min(1).max(31),
  to_day: z.number().int().min(1).max(31),
  credit_day: z.number().int().min(1).max(31),
  allocation_days: z.number().min(0),
})

// ─── 16 Section schemas ────────────────────────────────────────

const postingCycleRuleSchema = z.object({
  leave_type_id: z.string(),
  value: z.number().min(0),
  unit: z.string(),
  // Per-leave-type accrual frequency (replaces the plan-level one).
  accrual_frequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']).nullable().optional(),
  // Whether this leave type carries forward at year-end.
  carry_forward: z.boolean().optional(),
})

const distributionSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['all_at_once', 'step_by_step']),
  accrual_frequency: z.enum(['monthly', 'quarterly', 'half_yearly']).nullable().optional(),
  posting_cycles: z.array(postingCycleRuleSchema).optional(),
  policy_cycle_start_day: z.number().int().min(1).max(31).nullable().optional(),
  step_rules: z.array(stepAccrualRuleSchema).optional(),
})

const midYearJoiningSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['pro_rate', 'credit_joining_month']).nullable().optional(),
  slab_rules: z.array(midYearSlabRuleSchema).optional(),
})

const probationSchema = z.object({
  enabled: z.boolean(),
  credit_mode: z.enum(['same_for_all', 'tiered_by_duration']).nullable().optional(),
  credit_start: z.enum(['start_date', 'confirmation_date']).nullable().optional(),
  probation_duration_months: z.number().int().min(0).max(100, 'Cannot exceed 100 months').nullable().optional(),
  // Superseded by the plural field; kept optional so a config saved before
  // multi-select still parses. The backend folds it into the list.
  probation_leave_type_id: z.string().nullable().optional(),
  probation_leave_type_ids: z.array(z.string()).optional(),
  band_rules: z.array(bandRuleSchema).optional(),
}).superRefine((data, ctx) => {
  if (data.credit_mode !== 'tiered_by_duration') return
  // Tiered credit must say where it starts, and start-date mode needs a duration.
  if (!data.credit_start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Select where leave credit starts',
      path: ['credit_start'],
    })
  }
  if (data.credit_start === 'start_date') {
    // Start-date mode: leave type, duration, and bands are all mandatory.
    if (!data.probation_leave_type_ids?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Select at least one probation leave type',
        path: ['probation_leave_type_ids'],
      })
    }
    if (data.probation_duration_months == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Probation duration (months) is required',
        path: ['probation_duration_months'],
      })
    }
    if (!data.band_rules || data.band_rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Add at least one band',
        path: ['band_rules'],
      })
    }
  }
  const max = data.probation_duration_months
  if (max == null) return
  data.band_rules?.forEach((rule, i) => {
    if (rule.to_month > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot exceed the probation duration of ${max} months`,
        path: ['band_rules', i, 'to_month'],
      })
    }
    if (rule.from_month > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot exceed the probation duration of ${max} months`,
        path: ['band_rules', i, 'from_month'],
      })
    }
  })
})

const futureRequestSchema = z.object({
  allow_future_requests: z.boolean(),
  allow_based_on_projected_balance: z.boolean(),
})

const negativeBalanceSchema = z.object({
  allow_negative_balance: z.boolean(),
  max_negative_balance: z.number().min(0).nullable().optional(),
  approval_required: z.boolean(),
  approval_mode: z.enum(['auto_deduct', 'require_approval']).nullable().optional(),
})

const fractionalBalanceSchema = z.object({
  mode: z.enum(['exact', 'nearest_half', 'nearest_one', 'round_up', 'round_down']),
})

const creditExpirySchema = z.object({
  expiry_enabled: z.boolean(),
  expiry_period_value: z.number().int().min(1).nullable().optional(),
  expiry_period_unit: z.enum(['Days', 'Months']).nullable().optional(),
  expiry_at_cycle_end: z.boolean(),
})

const creditTimingSchema = z.object({
  mode: z.enum(['before_month_start', 'no_change', 'do_not_credit_notice', 'last_month_prorated']).nullable().optional(),
  date_rules: z.array(dateRangeCreditRuleSchema).optional(),
})

const uploadRequirementSchema = z.object({
  mandatory: z.boolean(),
  required_after_days: z.number().int().min(0).nullable().optional(),
})

const commentRequirementSchema = z.object({
  mode: z.enum(['not_required', 'optional', 'mandatory']),
})

const requestLimitsSchema = z.object({
  max_requests_allowed: z.number().int().min(0).nullable().optional(),
  period: z.string().nullable().optional(),
  enforce_gap: z.boolean(),
  gap_days: z.number().int().min(0).nullable().optional(),
})

const clubbingSchema = z.object({
  enabled: z.boolean(),
  restricted_leave_type_ids: z.array(z.string()).optional(),
})

const continuousLimitSchema = z.object({
  enabled: z.boolean(),
  max_consecutive_days: z.number().int().min(0).nullable().optional(),
  include_weekends: z.boolean(),
  include_holidays: z.boolean(),
}).superRefine((data, ctx) => {
  if (data.enabled && (data.max_consecutive_days == null || data.max_consecutive_days < 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Max consecutive days is required',
      path: ['max_consecutive_days'],
    })
  }
})

const monthlyLimitSchema = z.object({
  enabled: z.boolean(),
  max_days_per_month: z.number().min(0).max(31, 'Cannot exceed 31 days').nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.enabled && (data.max_days_per_month == null || data.max_days_per_month <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Max days per month is required',
      path: ['max_days_per_month'],
    })
  }
})

const noticePeriodLeaveSchema = z.object({
  mode: z.enum(['block', 'allow_with_extension']).nullable().optional(),
  extend_notice_by_leave_days: z.boolean(),
})

const backdatedLeaveSchema = z.object({
  enabled: z.boolean(),
  max_days: z.number().int('Must be a whole number').min(1, 'Must be at least 1').nullable().optional(),
})

const requestValidationSchema = z.object({
  upload_requirement: uploadRequirementSchema,
  comment_requirement: commentRequirementSchema,
  request_limits: requestLimitsSchema,
  allow_past_dates: z.boolean(),
  allow_future_dates: z.boolean(),
})

// ─── Merged from the (removed) Grant Configuration step ────────

const joiningRuleSchema = z.object({
  enabled: z.boolean(),
  first_month_restriction: z.object({
    enabled: z.boolean(),
    cutoff_day: z.number().int().min(0).max(31).nullable().optional(),
    rule: z.enum(['NO_CREDIT_IF_JOIN_AFTER']).optional(),
  }),
}).superRefine((data, ctx) => {
  if (data.enabled && data.first_month_restriction.enabled) {
    const c = data.first_month_restriction.cutoff_day
    if (c == null || c < 1 || c > 31) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Select a cutoff day between 1 and 31',
        path: ['first_month_restriction', 'cutoff_day'],
      })
    }
  }
})

const extraLeaveSchema = z.object({
  status: z.enum(['ALLOWED', 'NOT_ALLOWED']),
  max_days: z.number().int('Must be a whole number').min(0).max(365, 'Cannot exceed 365 days').nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.status === 'ALLOWED' && (data.max_days == null || data.max_days < 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Maximum extra days is required',
      path: ['max_days'],
    })
  }
})

// ─── Root entitlement schema ───────────────────────────────────

export const entitlementSchema = z.object({
  distribution: distributionSchema,
  mid_year_joining: midYearJoiningSchema,
  probation: probationSchema,
  future_request: futureRequestSchema,
  negative_balance: negativeBalanceSchema,
  fractional_balance: fractionalBalanceSchema,
  credit_expiry: creditExpirySchema,
  credit_timing: creditTimingSchema,
  upload_requirement: uploadRequirementSchema,
  comment_requirement: commentRequirementSchema,
  request_limits: requestLimitsSchema,
  clubbing: clubbingSchema,
  continuous_limit: continuousLimitSchema,
  monthly_limit: monthlyLimitSchema,
  notice_period_leave: noticePeriodLeaveSchema,
  backdated_leave: backdatedLeaveSchema,
  request_validation: requestValidationSchema,
  joining_rule: joiningRuleSchema,
  extra_leave: extraLeaveSchema,
})

export type EntitlementFormValues = z.infer<typeof entitlementSchema>

// ─── Default values ────────────────────────────────────────────

export const defaultEntitlementValues: EntitlementFormValues = {
  distribution: { enabled: true, mode: 'all_at_once' },
  mid_year_joining: { enabled: true, mode: 'pro_rate' },
  probation: { enabled: true, credit_mode: 'same_for_all' },
  future_request: { allow_future_requests: false, allow_based_on_projected_balance: false },
  negative_balance: { allow_negative_balance: false, approval_required: false },
  fractional_balance: { mode: 'exact' },
  credit_expiry: { expiry_enabled: false, expiry_at_cycle_end: false },
  credit_timing: {},
  upload_requirement: { mandatory: false },
  comment_requirement: { mode: 'not_required' },
  request_limits: { max_requests_allowed: 5, period: 'monthly', enforce_gap: false },
  clubbing: { enabled: false },
  continuous_limit: { enabled: false, include_weekends: false, include_holidays: false },
  monthly_limit: { enabled: false },
  notice_period_leave: { mode: 'block', extend_notice_by_leave_days: false },
  backdated_leave: { enabled: false },
  joining_rule: { enabled: false, first_month_restriction: { enabled: false, cutoff_day: 0 } },
  extra_leave: { status: 'NOT_ALLOWED', max_days: 0 },
  request_validation: {
    upload_requirement: { mandatory: false },
    comment_requirement: { mode: 'not_required' },
    request_limits: { max_requests_allowed: 5, period: 'monthly', enforce_gap: false },
    allow_past_dates: true,
    allow_future_dates: true,
  },
}
