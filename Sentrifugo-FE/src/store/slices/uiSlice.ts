import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type ChatButtonCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

interface UiState {
  chatButtonCorner: ChatButtonCorner
  breadcrumbDetail: string | null
}

const initialState: UiState = {
  chatButtonCorner: 'bottom-right',
  breadcrumbDetail: null,
}

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setChatButtonCorner(state, action: PayloadAction<ChatButtonCorner>) {
      state.chatButtonCorner = action.payload
    },
    setBreadcrumbDetail(state, action: PayloadAction<string | null>) {
      state.breadcrumbDetail = action.payload
    },
  },
})

export const { setChatButtonCorner, setBreadcrumbDetail } = uiSlice.actions
export default uiSlice.reducer
