import React from "react"
import ReactDOM from "react-dom/client"
import { QueryClient, QueryClientProvider, MutationCache, QueryCache } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { Provider as ReduxProvider } from "react-redux"
import { Toaster } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ConfirmDialogProvider } from "@/providers/confirm-dialog-provider"
import { store } from "@/store"
import { router } from "./router"
import { toast, extractErrorMessage } from "@/lib/toast"
import { queryKeys } from "@/api/query-keys"
import "./index.css"

interface MutationMeta {
  affectsSetupSteps?: boolean
}

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      // Any mutation flagged with `meta: { affectsSetupSteps: true }` triggers
      // one org refetch so setup_steps stay fresh. Declarative, opt-in.
      const meta = mutation.options.meta as MutationMeta | undefined
      if (meta?.affectsSetupSteps) {
        queryClient.invalidateQueries({ queryKey: queryKeys.organisation.all })
      }
    },
    onError: (error, _variables, _context, mutation) => {
      if (!mutation.options.onError) {
        toast.error(error)
      }
    },
  }),
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (error instanceof Error && error.name === 'CanceledError') return
      if (query.state.data === undefined) {
        const message = extractErrorMessage(error)
        toast.error(message)
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof Error && error.name === 'CanceledError') return false
        return failureCount < 1
      },
      staleTime: 30 * 1000,
    },
  },
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReduxProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ConfirmDialogProvider>
            <RouterProvider router={router} />
            <Toaster
              position="top-right"
              richColors
              closeButton
              duration={4000}
              visibleToasts={5}
              toastOptions={{
                style: { fontFamily: "inherit" },
              }}
            />
          </ConfirmDialogProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ReduxProvider>
  </React.StrictMode>
)
