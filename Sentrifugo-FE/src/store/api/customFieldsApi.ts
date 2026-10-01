import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'
import type {
  CustomFieldDefinition,
  CustomFieldOption,
  EntityValuesResponse,
  EntityType,
  SectionType,
  DefinitionCreateDTO,
  DefinitionUpdateDTO,
  OptionCreateDTO,
  OptionUpdateDTO,
  ValueUpsertDTO,
  ReorderItemDTO,
} from '@/types/custom-fields'

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

export const customFieldsApi = createApi({
  reducerPath: 'customFieldsApi',
  baseQuery: createBaseQuery(IAM_BASE_URL),
  tagTypes: ['CustomFieldDefinitions', 'CustomFieldOptions', 'CustomFieldValues'],
  endpoints: (builder) => ({

    // --- Definitions ---

    getDefinitions: builder.query<
      CustomFieldDefinition[],
      { entity_type?: EntityType; section?: SectionType; is_active?: boolean }
    >({
      query: (params) => ({ url: '/custom-fields/definitions', params }),
      providesTags: ['CustomFieldDefinitions'],
    }),

    createDefinition: builder.mutation<CustomFieldDefinition, DefinitionCreateDTO>({
      query: (body) => ({ url: '/custom-fields/definitions', method: 'POST', body }),
      invalidatesTags: ['CustomFieldDefinitions'],
    }),

    updateDefinition: builder.mutation<CustomFieldDefinition, { id: string; body: DefinitionUpdateDTO }>({
      query: ({ id, body }) => ({ url: `/custom-fields/definitions/${id}`, method: 'PUT', body }),
      invalidatesTags: ['CustomFieldDefinitions'],
    }),

    deleteDefinition: builder.mutation<void, string>({
      query: (id) => ({ url: `/custom-fields/definitions/${id}`, method: 'DELETE' }),
      invalidatesTags: ['CustomFieldDefinitions', 'CustomFieldValues'],
    }),

    reorderDefinitions: builder.mutation<void, ReorderItemDTO[]>({
      query: (body) => ({ url: '/custom-fields/definitions/reorder', method: 'PUT', body }),
      invalidatesTags: ['CustomFieldDefinitions'],
    }),

    // --- Options ---

    getOptions: builder.query<CustomFieldOption[], string>({
      query: (definitionId) => `/custom-fields/definitions/${definitionId}/options`,
      providesTags: (_result, _error, definitionId) => [
        { type: 'CustomFieldOptions', id: definitionId },
      ],
    }),

    createOption: builder.mutation<CustomFieldOption, { definitionId: string; body: OptionCreateDTO }>({
      query: ({ definitionId, body }) => ({
        url: `/custom-fields/definitions/${definitionId}/options`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_result, _error, { definitionId }) => [
        { type: 'CustomFieldOptions', id: definitionId },
      ],
    }),

    updateOption: builder.mutation<CustomFieldOption, { id: string; body: OptionUpdateDTO }>({
      query: ({ id, body }) => ({ url: `/custom-fields/options/${id}`, method: 'PUT', body }),
      invalidatesTags: ['CustomFieldOptions'],
    }),

    deleteOption: builder.mutation<void, string>({
      query: (id) => ({ url: `/custom-fields/options/${id}`, method: 'DELETE' }),
      invalidatesTags: ['CustomFieldOptions'],
    }),

    // --- Values ---

    getEntityValues: builder.query<EntityValuesResponse, { entityType: EntityType; entityId: string }>({
      query: ({ entityType, entityId }) => `/custom-fields/values/${entityType}/${entityId}`,
      providesTags: (_result, _error, { entityType, entityId }) => [
        { type: 'CustomFieldValues', id: `${entityType}-${entityId}` },
      ],
    }),

    upsertEntityValues: builder.mutation<
      EntityValuesResponse,
      { entityType: EntityType; entityId: string; body: ValueUpsertDTO[] }
    >({
      query: ({ entityType, entityId, body }) => ({
        url: `/custom-fields/values/${entityType}/${entityId}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { entityType, entityId }) => [
        { type: 'CustomFieldValues', id: `${entityType}-${entityId}` },
      ],
    }),

  }),
})

export const {
  useGetDefinitionsQuery,
  useCreateDefinitionMutation,
  useUpdateDefinitionMutation,
  useDeleteDefinitionMutation,
  useReorderDefinitionsMutation,
  useGetOptionsQuery,
  useLazyGetOptionsQuery,
  useCreateOptionMutation,
  useUpdateOptionMutation,
  useDeleteOptionMutation,
  useGetEntityValuesQuery,
  useUpsertEntityValuesMutation,
} = customFieldsApi
