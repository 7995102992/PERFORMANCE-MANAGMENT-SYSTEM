import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'
import type { MyJourneyResponse, TeamJourneyResponse } from '@/types/employee-journey'

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

export const employeeJourneyApi = createApi({
  reducerPath: 'employeeJourneyApi',
  baseQuery: createBaseQuery(IAM_BASE_URL),
  tagTypes: ['MyJourney', 'TeamJourney'],
  endpoints: (builder) => ({
    // Identity is resolved from the bearer token server-side — no params needed.
    getMyJourney: builder.query<MyJourneyResponse, void>({
      query: () => '/journey/me',
      providesTags: ['MyJourney'],
    }),

    // Journeys for the logged-in user's team (reports), keyed by user_id.
    // activeOnly excludes inactive/exited reports (resolved server-side against
    // the EMPLOYMENT_STATUSES master data) and defaults to true — past
    // employees are opt-in, via the Team Journey page's toggle.
    getTeamJourney: builder.query<TeamJourneyResponse, { includeSelf?: boolean; activeOnly?: boolean } | void>({
      query: (arg) => ({
        url: '/journey/team',
        params: {
          include_self: arg?.includeSelf ?? false,
          active_only: arg?.activeOnly ?? true,
        },
      }),
      providesTags: ['TeamJourney'],
    }),

    // A single member's journey (same shape as /journey/me).
    getMemberJourney: builder.query<MyJourneyResponse, string>({
      query: (userId) => `/journey/${userId}`,
    }),
  }),
})

export const {
  useGetMyJourneyQuery,
  useGetTeamJourneyQuery,
  useGetMemberJourneyQuery,
} = employeeJourneyApi
