import { useState } from 'react'
import { ExpenseListView } from '@/components/expense/ExpenseListView'
import { ExpenseFormSheet } from '@/components/expense/ExpenseFormSheet'

export function MyExpenses() {
  const [formOpen, setFormOpen] = useState(false)

  return (
    <>
      <ExpenseListView
        scope="my"
        title="Expenses"
        subtitle="View your expenses"
        onCreate={() => setFormOpen(true)}
      />
      <ExpenseFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        expenseId={null}
      />
    </>
  )
}

export default MyExpenses
