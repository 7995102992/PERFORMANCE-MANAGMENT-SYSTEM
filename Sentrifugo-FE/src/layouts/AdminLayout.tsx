import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { Topbar } from "./Topbar";
import { SessionExpiredModal } from "@/components/shared/SessionExpiredModal";
// DEPRECATED (hidden for now): FugoAI agent chat button. Logic kept intact —
// re-enable by uncommenting this import and the <FloatingChatButton /> render below.
// import { FloatingChatButton } from "@/components/ai/FloatingChatButton";
import { useAppSelector } from "@/store";
import { useGetMeQuery } from "@/store/api/iamApi";

const SIDEBAR_KEY = "sidebar_open";

export function AdminLayout() {
  const { accessToken, user } = useAppSelector((s) => s.auth);
  const defaultOpen = localStorage.getItem(SIDEBAR_KEY) !== "false";
  const navigate = useNavigate();

  const { isLoading } = useGetMeQuery(undefined, {
    skip: !accessToken || !!user,
  });

  const isAuthorised = !user?.is_super_admin || !user?.is_org_admin;

  useEffect(() => {
    if (user && !isAuthorised) {
      navigate({ to: "/login" });
    }
  }, [user, isAuthorised, navigate]);

  if (isLoading || (accessToken && !user)) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <Loader2 className="size-6 animate-spin text-primary" />
        <span className="text-muted-foreground text-sm">Loading…</span>
      </div>
    );
  }

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      onOpenChange={(open) => localStorage.setItem(SIDEBAR_KEY, String(open))}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      >
        Skip to main content
      </a>
      <AppSidebar />
      <SidebarInset>
        <Topbar />
        <div
          className="flex-1 min-w-0 overflow-y-auto bg-muted/30 dark:bg-background p-6"
          id="main-content"
        >
          <Outlet />
        </div>
      </SidebarInset>
      <SessionExpiredModal />
      {/* DEPRECATED (hidden for now): FugoAI agent chat button. Do not remove —
          re-enable by uncommenting this and its import above. */}
      {/* <FloatingChatButton /> */}
    </SidebarProvider>
  );
}
