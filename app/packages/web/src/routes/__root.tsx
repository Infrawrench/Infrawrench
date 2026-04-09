import { useState, useEffect } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { DndShell, useUIStore, type DraggableResource } from "@infrawrench/ui";
import { WebSidebar } from "@/components/WebSidebar";
import { apiGet, apiPost } from "@/lib/api";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    // Auth check — on 401 the api client auto-redirects to sign-in
    apiGet("/api/auth/me")
      .then(() => setAuthChecked(true))
      .catch(() => {
        // apiFetch already redirects on 401
      });
  }, []);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
        <div className="animate-pulse text-sm">Loading…</div>
      </div>
    );
  }

  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  async function handlePinToDashboard(resource: DraggableResource, dashboardId: string) {
    await apiPost("/api/dashboards/pin", { dashboardId, resourceId: resource.id });
    useUIStore.getState().bumpDashboardPins();
    window.dispatchEvent(new CustomEvent("iw:resources-changed"));
  }

  return (
    <DndShell onPinToDashboard={handlePinToDashboard}>
      <div className="flex h-screen bg-gray-950 text-gray-100">
        <WebSidebar />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </DndShell>
  );
}
