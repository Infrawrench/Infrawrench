import { useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import { JitAccessPanel, useUIStore } from "@infrawrench/ui";
import { hasPermission, type OrgMembership } from "@infrawrench/client-core";
import { createDesktopSettingsApi } from "@/lib/settings-client";

interface DesktopJitAccessPanelProps {
  openPolicies: () => void;
}

/**
 * Desktop host for the shared just-in-time access panel. **Cloud mode only**:
 * policies, approvals and the expiry sweep all live in the cloud, and a local
 * workspace has no approvers.
 *
 * The transport is the settings proxy (`cloud_settings_request`) rather than
 * a channel of its own: the tab and the policies settings section speak one
 * API prefix, `jit-access`, so one allowlist entry covers both, and a second
 * channel would be a second allowlist for the same surface.
 */
export function DesktopJitAccessPanel({ openPolicies }: DesktopJitAccessPanelProps) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const api = useMemo(() => createDesktopSettingsApi(), []);
  const [permissions, setPermissions] = useState<readonly string[] | null>(null);

  useEffect(() => {
    if (!activeCloudOrgId) return;
    let cancelled = false;
    api
      .get<OrgMembership>(`/api/org/${activeCloudOrgId}/team/me`)
      .then((me) => {
        if (!cancelled) setPermissions(me.permissions);
      })
      .catch(() => {
        if (!cancelled) setPermissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, activeCloudOrgId]);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6">
        <T>
          <p className="text-sm text-on-surface-muted">
            Just-in-time access needs Infrawrench Cloud. Sign in to an organization to request or
            approve access.
          </p>
        </T>
      </div>
    );
  }
  if (permissions === null) {
    return <p className="p-6 text-sm text-on-surface-faint">{gt("Loading…")}</p>;
  }
  return (
    <JitAccessPanel
      orgId={activeCloudOrgId}
      api={api}
      canRead={hasPermission(permissions, "access:read")}
      canRequest={hasPermission(permissions, "access:request")}
      onOpenPolicies={hasPermission(permissions, "org:settings:write") ? openPolicies : undefined}
    />
  );
}
