/**
 * Mark a mutation as touching the org's setup-step state.
 *
 * The global `MutationCache.onSuccess` handler in `main.tsx` watches for this
 * flag and invalidates the organisation query — so the sidebar's stepper
 * (driven by `useSetupSteps`) auto-refreshes after any create/delete that
 * could flip a step's status.
 *
 * Spread it into a mutation's options:
 *
 *   useMutation({
 *     mutationFn: ...,
 *     ...setupAffecting,
 *     onSuccess: () => { qc.invalidateQueries({ queryKey: ... }) },
 *   })
 */
export const setupAffecting = {
  meta: { affectsSetupSteps: true } as const,
}
