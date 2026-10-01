import { z } from 'zod'

const slabRuleSchema = z.object({
  min_balance: z.number({ error: 'Required' }).min(0, 'Must be ≥ 0'),
  payout_value: z.number({ error: 'Required' }).min(0, 'Must be ≥ 0'),
  carry_forward_value: z.number({ error: 'Required' }).min(0, 'Must be ≥ 0'),
})

const roundingConfigSchema = z.object({
  enabled: z.boolean(),
  rounding_type: z.enum(['NEAREST', 'UP', 'DOWN']).optional(),
  rounding_unit: z.enum(['HALF_DAY', 'FULL_DAY']).optional(),
})

const payoutCarryConfigSchema = z.object({
  calculation_mode: z.enum(['FIXED_DAYS', 'PERCENTAGE']),
  minimum_eligible_balance: z.number({ error: 'Required' }).min(0, 'Must be ≥ 0').optional(),
  slab_rules: z.array(slabRuleSchema).optional(),
  percentage_config: z.object({
    payout_percentage: z.number().min(0).max(100),
    carry_percentage: z.number().min(0).max(100),
  }).optional().nullable(),
  max_payout_limit: z.number().min(0).optional().nullable(),
  max_carry_limit: z.number().min(0).optional().nullable(),
  rounding: roundingConfigSchema.optional().nullable(),
})

export const yearEndProcessingSchema = z.object({
  processing_type: z.enum([
    'EXPIRE_RESET',
    'PAYOUT_ALL',
    'CARRY_FORWARD_ALL',
    'PAYOUT_THEN_CARRY',
    'CARRY_THEN_PAYOUT',
  ]),
  payout_carry_config: payoutCarryConfigSchema.optional(),
  negative_balance_rule: z.enum([
    'DEDUCT_FROM_PAYROLL',
    'RESET_TO_ZERO',
    'CARRY_FORWARD_DEFICIT',
  ]),
})

export type YearEndFormValues = z.infer<typeof yearEndProcessingSchema>

export const defaultYearEndValues: YearEndFormValues = {
  processing_type: 'EXPIRE_RESET',
  payout_carry_config: {
    calculation_mode: 'FIXED_DAYS',
    minimum_eligible_balance: 0,
    slab_rules: [],
    percentage_config: {
      payout_percentage: 50,
      carry_percentage: 50,
    },
    rounding: {
      enabled: false,
    },
  },
  negative_balance_rule: 'RESET_TO_ZERO',
}
