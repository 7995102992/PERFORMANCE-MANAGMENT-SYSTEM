import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

// ─── Types (IAM BE /announcements/* DTOs) ────────────────────────────────────

export type AnnouncementStatus = 'draft' | 'published'

export interface AnnouncementAttachment {
  asset_id: string
  file_name: string
  mime_type: string
  size: number
}

export interface Announcement {
  id: string
  organisation_id: string
  business_unit_ids: string[]
  /** Resolved server-side. Empty array = every business unit. */
  business_unit_names: string[]
  department_ids: string[]
  /** Resolved server-side. Empty array = organisation-wide. */
  department_names: string[]
  title: string
  description: string
  attachments: AnnouncementAttachment[]
  status: AnnouncementStatus
  /** Stamped at publish time; null while the announcement is a draft. */
  posted_date?: string | null
  published_by?: string | null
  created_by: string
  created_on: string
  updated_on?: string | null
  is_active: boolean
}

/** Admin list envelope — `total` is the unpaged match count. */
export interface AnnouncementListResponse {
  items: Announcement[]
  total: number
}

export interface AnnouncementListParams {
  skip?: number
  limit?: number
  search?: string
  status?: AnnouncementStatus
  /** Announcements explicitly targeted at this department (org-wide excluded). */
  department_id?: string
  /** Announcements explicitly targeted at this business unit (org-wide excluded). */
  business_unit_id?: string
}

/** Audience of an announcement, as the employee page filters on it. */
export type AnnouncementScope = 'org_wide' | 'targeted'

export interface MyAnnouncementsPageParams {
  skip?: number
  limit?: number
  search?: string
  scope?: AnnouncementScope
}

export interface AnnouncementCreate {
  title: string
  description: string
  business_unit_ids: string[]
  department_ids: string[]
  attachments: AnnouncementAttachment[]
}

/** Every field is optional on update; the BE 409s once published. */
export type AnnouncementUpdate = Partial<AnnouncementCreate>

// ─── API ─────────────────────────────────────────────────────────────────────
// `organisation_id` is never sent from the client — the BE takes it from the
// session. Two cache buckets sit under the single `Announcement` tag:
//   LIST → the admin table, MY → the employee dashboard feed.
// Every write touches both, because publishing is what moves a record between
// them.

const LIST_TAG = { type: 'Announcement' as const, id: 'LIST' }
const MY_TAG = { type: 'Announcement' as const, id: 'MY' }

export const announcementsApi = createApi({
  reducerPath: 'announcementsApi',
  baseQuery: createBaseQuery(IAM_BASE_URL),
  tagTypes: ['Announcement'],
  endpoints: (builder) => ({
    // ── Admin surface (manage_announcements) ────────────────────────────────

    getAnnouncements: builder.query<
      AnnouncementListResponse,
      AnnouncementListParams | void
    >({
      query: (params) => ({
        url: '/announcements/',
        params: {
          skip: 0,
          limit: 20,
          ...(params ?? {}),
        },
      }),
      providesTags: [LIST_TAG],
    }),

    getAnnouncement: builder.query<Announcement, string>({
      query: (id) => `/announcements/${id}`,
      providesTags: (_res, _err, id) => [{ type: 'Announcement', id }],
    }),

    createAnnouncement: builder.mutation<Announcement, AnnouncementCreate>({
      query: (body) => ({ url: '/announcements/', method: 'POST', body }),
      invalidatesTags: [LIST_TAG, MY_TAG],
    }),

    updateAnnouncement: builder.mutation<
      Announcement,
      { id: string; body: AnnouncementUpdate }
    >({
      query: ({ id, body }) => ({
        url: `/announcements/${id}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: (_res, _err, { id }) => [
        LIST_TAG,
        MY_TAG,
        { type: 'Announcement', id },
      ],
    }),

    publishAnnouncement: builder.mutation<Announcement, string>({
      query: (id) => ({ url: `/announcements/${id}/publish`, method: 'PATCH' }),
      invalidatesTags: (_res, _err, id) => [
        LIST_TAG,
        MY_TAG,
        { type: 'Announcement', id },
      ],
    }),

    unpublishAnnouncement: builder.mutation<Announcement, string>({
      query: (id) => ({
        url: `/announcements/${id}/unpublish`,
        method: 'PATCH',
      }),
      invalidatesTags: (_res, _err, id) => [
        LIST_TAG,
        MY_TAG,
        { type: 'Announcement', id },
      ],
    }),

    deleteAnnouncement: builder.mutation<void, string>({
      query: (id) => ({ url: `/announcements/${id}`, method: 'DELETE' }),
      invalidatesTags: (_res, _err, id) => [
        LIST_TAG,
        MY_TAG,
        { type: 'Announcement', id },
      ],
    }),

    // ── Employee surface (view_announcements) ───────────────────────────────
    // Plain array, no envelope. Targeting is resolved server-side from the
    // caller's own department / business unit — never sent from here.

    getMyAnnouncements: builder.query<Announcement[], { limit?: number } | void>(
      {
        query: (params) => ({
          url: '/announcements/my-announcements',
          params: { limit: params?.limit ?? 5 },
        }),
        providesTags: [MY_TAG],
      },
    ),

    /** Paged feed behind the dashboard card's "View all" — same visibility
     *  rules as getMyAnnouncements, plus paging, search and an audience filter. */
    getMyAnnouncementsPage: builder.query<
      AnnouncementListResponse,
      MyAnnouncementsPageParams | void
    >({
      query: (params) => ({
        url: '/announcements/my-announcements/all',
        params: {
          skip: 0,
          limit: 20,
          ...(params ?? {}),
        },
      }),
      providesTags: [MY_TAG],
    }),

    getMyAnnouncement: builder.query<Announcement, string>({
      query: (id) => `/announcements/my-announcements/${id}`,
      providesTags: (_res, _err, id) => [{ type: 'Announcement', id }],
    }),
  }),
})

export const {
  useGetAnnouncementsQuery,
  useGetAnnouncementQuery,
  useCreateAnnouncementMutation,
  useUpdateAnnouncementMutation,
  usePublishAnnouncementMutation,
  useUnpublishAnnouncementMutation,
  useDeleteAnnouncementMutation,
  useGetMyAnnouncementsQuery,
  useGetMyAnnouncementsPageQuery,
  useGetMyAnnouncementQuery,
} = announcementsApi
