import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'

const LMS_BASE_URL = import.meta.env.VITE_LMS_BASE_URL as string

export interface PunchEntry {
  time: string
  type: 'in' | 'out'
  terminal_name?: string | null
  // Card number/ID recorded when the punch was made with an access card.
  // Empty/null means the punch was a face-ID scan instead.
  card?: string | null
}

export interface EmployeeDayAttendance {
  employee_user_id?: string | null
  terminal_user_id: string
  user_name: string
  group_name?: string | null
  // HR department, resolved server-side. Not the same as `group_name`, which is
  // the biometric terminal's group. Only the team roster populates this.
  department_name?: string | null
  punch_date: string
  first_in?: string | null
  last_out?: string | null
  total_hours?: string | null
  work_hours?: string | null
  punches: PunchEntry[]
  status: string
  // Set when status === 'leave': the leave type charged that day (e.g.
  // "Earned Leave", "Work From Home"), so the calendar can label it precisely.
  leave_type_name?: string | null
}

export const attendanceApi = createApi({
  reducerPath: 'attendanceApi',
  baseQuery: createBaseQuery(LMS_BASE_URL),
  tagTypes: ['Attendance'],
  endpoints: (builder) => ({
    getDailyAttendance: builder.query<EmployeeDayAttendance[], { punch_date: string }>({
      query: ({ punch_date }) => ({
        url: '/attendance/daily',
        params: { punch_date },
      }),
      providesTags: ['Attendance'],
    }),

    getEmployeeAttendance: builder.query<EmployeeDayAttendance, { terminal_user_id: string; punch_date: string }>({
      query: ({ terminal_user_id, punch_date }) => ({
        url: `/attendance/employee/${terminal_user_id}`,
        params: { punch_date },
      }),
      providesTags: ['Attendance'],
    }),

    getEmployeeMonthAttendance: builder.query<EmployeeDayAttendance[], { terminal_user_id: string; year: number; month: number }>({
      query: ({ terminal_user_id, year, month }) => ({
        url: `/attendance/employee/${terminal_user_id}/month`,
        params: { year, month },
      }),
      providesTags: ['Attendance'],
    }),

    getTeamDailyAttendance: builder.query<EmployeeDayAttendance[], { punch_date: string }>({
      query: ({ punch_date }) => ({
        url: '/attendance/team/daily',
        params: { punch_date },
      }),
      providesTags: ['Attendance'],
    }),

    getMyDailyAttendance: builder.query<EmployeeDayAttendance, { punch_date: string }>({
      query: ({ punch_date }) => ({
        url: '/attendance/my/daily',
        params: { punch_date },
      }),
      providesTags: ['Attendance'],
    }),

    getMyMonthAttendance: builder.query<EmployeeDayAttendance[], { year: number; month: number }>({
      query: ({ year, month }) => ({
        url: '/attendance/my/month',
        params: { year, month },
      }),
      providesTags: ['Attendance'],
    }),
  }),
})

export const {
  useGetDailyAttendanceQuery,
  useGetTeamDailyAttendanceQuery,
  useGetEmployeeAttendanceQuery,
  useGetEmployeeMonthAttendanceQuery,
  useGetMyDailyAttendanceQuery,
  useGetMyMonthAttendanceQuery,
} = attendanceApi
