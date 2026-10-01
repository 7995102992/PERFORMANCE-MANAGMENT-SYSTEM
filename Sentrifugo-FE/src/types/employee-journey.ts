// ─── Employee Journey types ───────────────────────────────────────────────────

export type JourneyEventType =
  | 'onboarded'
  | 'designation_assigned'
  | 'l1_assigned'
  | 'l2_assigned'
  | 'paygrade_allocated'
  | 'band_allocated'
  | 'project_assigned'
  | 'leave_allocated'
  | 'leave_shift_assigned'
  | 'year_end_hours'
  | 'service_request'
  | 'service_request_raised'
  | 'exit'
  // backend may add more — keep the union open
  | (string & {})

export interface JourneyEvent {
  id: string
  event_type: JourneyEventType
  title: string
  description: string | null
  /** ISO 8601 datetime, or null when the event has no associated date */
  occurred_at: string | null
  /** Originating service, e.g. "iam" | "timesheet" | "leave" | "srm" */
  source_service: string
  metadata: Record<string, unknown>
}

export interface JourneyMetric {
  period: string
  worked_hours: number
  service_requests_count: number
}

export interface MyJourneyResponse {
  /** Sorted latest-first by the backend (index 0 = most recent) */
  timeline: JourneyEvent[]
  metrics: JourneyMetric[]
}

/** A team member's journey, with their identity included by the API. */
export interface TeamMemberJourney extends MyJourneyResponse {
  name: string
  emp_code: string | null
}

/** Map of user_id → that team member's journey + metrics. */
export type TeamJourneyResponse = Record<string, TeamMemberJourney>

/** Which timeline layout the My Journey page is showing. */
export type TimelineDesign = 'vertical' | 'snake'

/** A team member card's resolved display data. */
export interface TeamMember {
  userId: string
  name: string
  empCode: string | null
  designation: string | null
  eventCount: number
  latest: { title: string; date: string | null } | null
  workedHours: number | null
  serviceRequests: number | null
}
