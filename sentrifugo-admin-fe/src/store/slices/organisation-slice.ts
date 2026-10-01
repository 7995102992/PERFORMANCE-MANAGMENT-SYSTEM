import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { OrganisationResponseDTO } from '@/api/org-setup/types'

export interface OrganisationState {
  /** The currently saved organisation (from API or after save). Null if none exists yet. */
  savedOrganisation: OrganisationResponseDTO | null
}

const initialState: OrganisationState = {
  savedOrganisation: null,
}

const organisationSlice = createSlice({
  name: 'organisation',
  initialState,
  reducers: {
    setSavedOrganisation: (state, action: PayloadAction<OrganisationResponseDTO | null>) => {
      state.savedOrganisation = action.payload
    },
    clearSavedOrganisation: (state) => {
      state.savedOrganisation = null
    },
  },
})

export const { setSavedOrganisation, clearSavedOrganisation } = organisationSlice.actions
export default organisationSlice.reducer
