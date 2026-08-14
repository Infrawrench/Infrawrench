import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT, useMessages } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import {
  SETTINGS_SECTIONS,
  SettingsHostProvider,
  SettingsSectionBody,
  useUIStore,
  type SettingsHostValue,
} from "@infrawrench/ui";
import { hasPermission, type OrgMembership } from "@infrawrench/client-core";
import { CLOUD_URL } from "../../env";
import { invoke } from "../lib/invoke";
import { createDesktopSettingsApi, requestText } from "../lib/settings-client";
import { mountPlaybackTerminal } from "../lib/playback-terminal";
import { createCloudApprovalsClient } from "../lib/cloud-workflows";
import { navigateToWorkspaceTarget, settingsTabTarget } from "../lib/workspace-tabs";
import { workflowsTabTarget } from "@infrawrench/ui";

/**
 * Cloud-mode org settings — the same sections the web app renders, over the
 * `cloud_settings_request` IPC proxy. Local-only mode has no org (and no
 * server to configure), so the panel asks for a cloud sign-in instead.
 */
export function DesktopSettingsPanel({ section }: { section: string }) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-on-surface-muted max-w-sm text-center">
          Organization settings live in Infrawrench Cloud. Sign in and pick an organization to
          manage its team, keys, alerts and billing from here.
        </p>
      </div>
    );
  }

  return <CloudSettings orgId={activeCloudOrgId} section={section} />;
}

function CloudSettings({ orgId, section }: { orgId: string; section: string }) {
  const navigate = useNavigate();
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(true);

  const api = useMemo(() => createDesktopSettingsApi(), []);

  const refreshPermissions = useCallback(async () => {
    setPermissionsLoading(true);
    try {
      const me = await api.get<OrgMembership>(`/api/org/${orgId}/team/me`);
      setPermissions(me.permissions);
    } catch {
      setPermissions([]);
    } finally {
      setPermissionsLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const value = useMemo<SettingsHostValue>(
    () => ({
      orgId,
      api,
      fetchText: requestText,
      has: (permission) => hasPermission(permissions, permission),
      hasAny: (...perms) => perms.some((p) => hasPermission(permissions, p)),
      permissionsLoading,
      refreshPermissions,
      openExternal: (url) => {
        // Always the system browser — Stripe checkout and password-reset
        // pages have no business inside the app shell.
        void invoke("open_external_url", { url });
      },
      onAccountDeleted: () => {
        // The account (and its tokens) are gone server-side; drop to
        // local-only mode and restart the renderer state.
        useUIStore.getState().setActiveCloudOrgId(null);
        window.location.reload();
      },
      approvals: createCloudApprovalsClient(orgId),
      openWorkspace: (surface) => {
        if (surface === "workflows") {
          void navigateToWorkspaceTarget(navigate, workflowsTabTarget(), { label: "Workflows" });
        } else {
          // Changes and Expiring are plain routes on desktop.
          void navigate({ to: `/${surface}` });
        }
      },
      openSection: (next) => {
        void navigateToWorkspaceTarget(navigate, settingsTabTarget(next || undefined), {
          label: "Settings",
        });
      },
      cloudOrigin: CLOUD_URL,
      mountPlaybackTerminal,
    }),
    [orgId, api, permissions, permissionsLoading, refreshPermissions, navigate],
  );

  const gt = useGT();
  // Section labels are msg()-encoded in the registry; m() decodes + translates.
  const m = useMessages();
  const navItems = SETTINGS_SECTIONS.filter(
    (s) => !s.requiresPermission || hasPermission(permissions, s.requiresPermission),
  );

  return (
    <SettingsHostProvider value={value}>
      <div className="flex h-full min-h-0">
        <nav className="w-48 border-r border-border p-4 flex-shrink-0 flex flex-col overflow-y-auto">
          <h2 className="text-sm font-semibold text-on-surface-secondary mb-4">{gt("Settings")}</h2>
          <ul className="space-y-1">
            {navItems.map((item) => {
              const isActive = section === item.key;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => value.openSection(item.key)}
                    className={`w-full text-left block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive
                        ? "bg-surface-overlay text-on-surface"
                        : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay/50"
                    }`}
                  >
                    {m(item.label)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex-1 overflow-auto p-6">
          {/* Keyed by section so each page mounts fresh and refetches, same as
              the web's route transitions. */}
          <div key={section}>
            <SettingsSectionBody section={section} />
          </div>
        </div>
      </div>
    </SettingsHostProvider>
  );
}
