import { configureStore } from '@reduxjs/toolkit'
import { useDispatch, useSelector } from 'react-redux'
import authReducer from './slices/authSlice'
import uiReducer from './slices/uiSlice'
import payrollLockReducer from './slices/payrollLockSlice'
import { iamApi } from './api/iamApi'
import { lmsApi } from './api/lmsApi'
import { exitManagementApi } from './api/exitManagementApi'
import { timesheetApi } from './api/timesheetApi'
import { srmApi } from './api/srmApi'
import { customFieldsApi } from './api/customFieldsApi'
import { employeeJourneyApi } from './api/employeeJourneyApi'
import { payrollApi } from './api/payrollApi'
import { orgDocumentsApi } from './api/orgDocumentsApi'
import { attendanceApi } from './api/attendanceApi'
import { announcementsApi } from './api/announcementsApi'
import { expenseApi } from './api/expenseApi'

export const store = configureStore({
  reducer: {
    auth: authReducer,
    ui: uiReducer,
    payrollLock: payrollLockReducer,
    [iamApi.reducerPath]: iamApi.reducer,
    [lmsApi.reducerPath]: lmsApi.reducer,
    [exitManagementApi.reducerPath]: exitManagementApi.reducer,
    [timesheetApi.reducerPath]: timesheetApi.reducer,
    [srmApi.reducerPath]: srmApi.reducer,
    [customFieldsApi.reducerPath]: customFieldsApi.reducer,
    [employeeJourneyApi.reducerPath]: employeeJourneyApi.reducer,
    [payrollApi.reducerPath]: payrollApi.reducer,
    [orgDocumentsApi.reducerPath]: orgDocumentsApi.reducer,
    [attendanceApi.reducerPath]: attendanceApi.reducer,
    [announcementsApi.reducerPath]: announcementsApi.reducer,
    [expenseApi.reducerPath]: expenseApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware()
      .concat(iamApi.middleware)
      .concat(lmsApi.middleware)
      .concat(timesheetApi.middleware)
      .concat(srmApi.middleware)
      .concat(exitManagementApi.middleware)
      .concat(customFieldsApi.middleware)
      .concat(employeeJourneyApi.middleware)
      .concat(payrollApi.middleware)
      .concat(orgDocumentsApi.middleware)
      .concat(attendanceApi.middleware)
      .concat(announcementsApi.middleware)
      .concat(expenseApi.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppDispatch = () => useDispatch<AppDispatch>()
export const useAppSelector = <T>(selector: (state: RootState) => T): T =>
  useSelector(selector)

export function resetAllApiState(dispatch: AppDispatch) {
  dispatch(iamApi.util.resetApiState())
  dispatch(srmApi.util.resetApiState())
  dispatch(lmsApi.util.resetApiState())
  dispatch(timesheetApi.util.resetApiState())
  dispatch(exitManagementApi.util.resetApiState())
  dispatch(employeeJourneyApi.util.resetApiState())
  dispatch(payrollApi.util.resetApiState())
  dispatch(orgDocumentsApi.util.resetApiState())
  dispatch(attendanceApi.util.resetApiState())
  dispatch(announcementsApi.util.resetApiState())
  dispatch(expenseApi.util.resetApiState())
}
