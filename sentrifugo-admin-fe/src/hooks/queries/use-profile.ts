import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authService, type UpdateProfileRequest, type ChangePasswordRequest } from '@/api/auth'
import { queryKeys } from '@/api/query-keys'
import { toast } from '@/lib/toast'
import { store } from '@/store'
import { setUser } from '@/store/slices/auth-slice'

export function useUpdateProfile() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: UpdateProfileRequest) => authService.updateProfile(payload),
    onSuccess: (data) => {
      store.dispatch(setUser(data))
      queryClient.invalidateQueries({ queryKey: queryKeys.profile.me })
      toast.success('Profile updated successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (payload: ChangePasswordRequest) => authService.changePassword(payload),
    onSuccess: () => {
      toast.success('Password changed successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}
