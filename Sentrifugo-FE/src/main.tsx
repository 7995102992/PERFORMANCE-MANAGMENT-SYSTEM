import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import {
  QueryClient,
  QueryClientProvider,
  MutationCache,
  QueryCache,
} from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/providers/confirm-dialog-provider";
import { store } from "./store";
import { router } from "./router";
import { Toaster } from "sonner";
import { toast, extractErrorMessage } from "@/lib/toast";
import "./index.css";

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (!mutation.options.onError) {
        toast.error(error);
      }
    },
  }),
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.state.data === undefined) {
        const message = extractErrorMessage(error);
        toast.error(message);
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30 * 1000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <ConfirmDialogProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
            <Toaster
              position="top-right"
              closeButton
              duration={4000}
              visibleToasts={3}
              gap={8}
              toastOptions={{
                style: { fontFamily: "inherit" },
              }}
            />
          </TooltipProvider>
        </ConfirmDialogProvider>
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>,
);
