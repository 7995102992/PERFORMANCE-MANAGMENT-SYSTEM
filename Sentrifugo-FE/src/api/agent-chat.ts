import { apiClient } from '@/lib/axios'
import type { ChatRequest, ChatResponse, ConfirmRequest } from '@/types/agent-chat'

export const sendAgentChat = async (payload: ChatRequest): Promise<ChatResponse> => {
  const { data } = await apiClient.post<ChatResponse>('/api/v1/agent/chat', payload)
  return data
}

export const confirmWorkflow = async (
  workflowId: string,
  payload: ConfirmRequest,
): Promise<Record<string, unknown>> => {
  const { data } = await apiClient.post<Record<string, unknown>>(
    `/api/v1/workflows/${workflowId}/confirm`,
    payload,
  )
  return data
}

export const resumeWorkflow = async (
  workflowId: string,
  payload: ChatRequest,
): Promise<ChatResponse> => {
  const { data } = await apiClient.post<ChatResponse>(
    `/api/v1/workflows/${workflowId}/resume`,
    payload,
  )
  return data
}
