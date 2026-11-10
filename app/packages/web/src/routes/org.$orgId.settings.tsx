import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useGT } from "gt-react";
import { useDisabledProducts } from "@/lib/disabled-products";
import {
  SettingsNavGroups,
  getWorkspaceTabId,
  settingsTabTarget,
  workspaceTabPanelProps,
} from "@infrawrench/ui";
import { analyticsEnabled, openConsentPrompt, resetAnalytics } from "@infrawrench/analytics";
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
  const gt = useGT();
  const { orgId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { has } = usePermissions();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    resetAnalytics();
    try {
      await apiPost("/api/auth/sign-out");
    } finally {
      // Reload either way: the cookie is likely gone, and a fresh load bounces
      // through sign-in if it isn't.
      window.location.reload();
    }
  }

  // Sections the caller cannot read are hidden outright (the page could only
  // refuse), and so are those of an app the organization turned off.
  const disabledProducts = useDisabledProducts(orgId);

  return (
    // This element is the Settings tab's `role="tabpanel"`. The tab lives in
    // the strip like any other, but its content is route-rendered here rather
    // than by WorkspaceTabsViewport, which skips the tab while this route is
    // mounted (isRouteHostedTabPanel) so there is exactly one panel with this
    // id: the visible one. Without it the selected tab's aria-controls
    // pointed at an empty, display:none panel.
    <div className="flex h-full min-h-0" {...workspaceTabPanelProps(SETTINGS_TAB_ID)}>
      <nav className="w-48 border-r border-border flex-shrink-0 flex flex-col min-h-0">
        <h2 className="px-4 pt-4 mb-4 text-sm font-semibold text-on-surface-secondary">
          {gt("Settings")}
        </h2>
        {/* Only the list scrolls, so Sign out stays reachable however many
            sections there are. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4">
          <SettingsNavGroups
            has={has}
            disabledProducts={disabledProducts}
            renderItem={(section, label) => {
              const to = section.key
                ? `/org/${orgId}/settings/${section.key}`
                : `/org/${orgId}/settings`;
              const isActive = section.key ? pathname.startsWith(to) : pathname === to;
              return (
                <Link
                  to={to}
                  className={`block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-surface-overlay text-on-surface"
                      : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay/50"
                  }`}
                >
                  {label}
                </Link>
              );
            }}
          />
        </div>
        <div className="p-4 flex flex-col">
          {analyticsEnabled() && (
            <button
              type="button"
              onClick={openConsentPrompt}
              className="px-3 py-1.5 text-left text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
            >
              {gt("Cookie preferences")}
            </button>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="px-3 py-1.5 text-left text-sm text-danger hover:text-danger-strong disabled:opacity-50 transition-colors"
          >
            {signingOut ? gt("Signing out…") : gt("Sign out")}
          </button>
        </div>
      </nav>
      <div className="flex-1 overflow-auto p-6">
        <WebSettingsHost orgId={orgId}>
          <Outlet />
        </WebSettingsHost>
      </div>
    </div>
  );
}
