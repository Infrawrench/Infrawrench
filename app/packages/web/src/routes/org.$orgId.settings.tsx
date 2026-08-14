import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useMessages } from "gt-react";
import {
  SETTINGS_SECTIONS,
  getWorkspaceTabId,
  settingsTabTarget,
  workspaceTabPanelProps,
} from "@infrawrench/ui";
import { apiPost } from "../lib/api";
import { usePermissions } from "@/auth/permissions-context";
import { WebSettingsHost } from "@/lib/settings-host";

export const Route = createFileRoute("/org/$orgId/settings")({
  component: SettingsLayout,
});

// Settings is one tab whichever section is open (getWorkspaceTabId ignores the
// section), so this is the id of the tab in the strip while this route renders.
const SETTINGS_TAB_ID = getWorkspaceTabId(settingsTabTarget());

function SettingsLayout() {
  const { orgId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { has } = usePermissions();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await apiPost("/api/auth/sign-out");
    } finally {
      // Reload either way: the cookie is likely gone, and a fresh load bounces
      // through sign-in if it isn't.
      window.location.reload();
    }
  }

  // Hidden outright without the permission — the page would only be able to
  // tell them they can't see it.
  // Section labels are msg()-encoded in the registry; m() decodes + translates.
  const m = useMessages();
  const navItems = SETTINGS_SECTIONS.filter(
    (s) => !s.requiresPermission || has(s.requiresPermission),
  ).map((s) => ({
    to: s.key ? `/org/${orgId}/settings/${s.key}` : `/org/${orgId}/settings`,
    label: s.label,
  }));

  return (
    // This element is the Settings tab's `role="tabpanel"`. The tab lives in
    // the strip like any other, but its content is route-rendered here rather
    // than by WorkspaceTabsViewport, which skips the tab while this route is
    // mounted (isRouteHostedTabPanel) so there is exactly one panel with this
    // id — the visible one. Without it the selected tab's aria-controls
    // pointed at an empty, display:none panel.
    <div className="flex h-full" {...workspaceTabPanelProps(SETTINGS_TAB_ID)}>
      <nav className="w-48 border-r border-border p-4 flex-shrink-0 flex flex-col">
        <h2 className="text-sm font-semibold text-on-surface-secondary mb-4">Settings</h2>
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              item.to === `/org/${orgId}/settings`
                ? pathname === `/org/${orgId}/settings`
                : pathname.startsWith(item.to);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={`block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-surface-overlay text-on-surface"
                      : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay/50"
                  }`}
                >
                  {m(item.label)}
                </Link>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="mt-auto pt-4 px-3 py-1.5 text-left text-sm text-danger hover:text-danger-strong disabled:opacity-50 transition-colors"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </nav>
      <div className="flex-1 overflow-auto p-6">
        <WebSettingsHost orgId={orgId}>
          <Outlet />
        </WebSettingsHost>
      </div>
    </div>
  );
}
