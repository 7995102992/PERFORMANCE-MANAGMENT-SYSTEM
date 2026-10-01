import { AdvanceListView } from '@/components/expense/AdvanceListView'

/**
 * The employee's own advances — requested by them, or allocated to them by a
 * manager. Both origins produce the same document; `origin` records which path
 * it took (§9.2).
 */
export function MyAdvances() {
  return (
    <AdvanceListView
      scope="mine"
      title="My Advances"
      subtitle="Money made available to you before the spend"
    />
  )
}

export default MyAdvances
