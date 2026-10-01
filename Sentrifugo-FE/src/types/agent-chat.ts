export interface ChatRequest {
  message: string
  thread_id?: string | null
  channel?: string
}

export interface ChatResponse {
  thread_id: string
  reply: string
  status?: string
  missing_fields?: string[]
  recommendation?: Record<string, unknown> | null
  next_actions?: string[]
  leave_request_id?: string | null
}

export interface ConfirmRequest {
  confirmed: boolean
}

export type ChatMessageRole = 'user' | 'agent' | 'system'

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  timestamp: Date
  threadId?: string
  status?: string
  recommendation?: Record<string, unknown> | null
  nextActions?: string[]
  missingFields?: string[]
  leaveRequestId?: string | null
}
