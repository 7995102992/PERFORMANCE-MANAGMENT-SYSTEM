// Payslip tabs wrapped in the PIN gate. Route-level wrapping means the underlying
// page only mounts (and only fetches) once the unlock is verified. The unlock
// window lives in the store (payrollLockSlice), so switching between payroll tabs
// within the 5-min window does NOT re-prompt — the gate only re-asks once the
// window lapses (or a page refresh clears the in-memory store).
import NewPayroll from './NewPayroll'
import BulkPayslipUpload from './BulkPayslipUpload'
import EmployeePayroll from './EmployeePayroll'
import MyPayroll from './MyPayroll'
import { PayrollPinGate } from './PayrollPinGate'

export const GatedNewPayroll = () => (
  <PayrollPinGate>
    <NewPayroll />
  </PayrollPinGate>
)

export const GatedBulkPayslipUpload = () => (
  <PayrollPinGate>
    <BulkPayslipUpload />
  </PayrollPinGate>
)

export const GatedEmployeePayroll = () => (
  <PayrollPinGate>
    <EmployeePayroll />
  </PayrollPinGate>
)

export const GatedMyPayroll = () => (
  <PayrollPinGate>
    <MyPayroll />
  </PayrollPinGate>
)
