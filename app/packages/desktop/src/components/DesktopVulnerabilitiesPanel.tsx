import { useCallback, useEffect, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  RESOURCES_CHANGED_EVENT,
  VulnerabilitiesSection,
  useUIStore,
  type VulnerabilityDismissalTarget,
  type VulnerabilityListResponse,
  type VulnerabilityRunningRef,
  type VulnerabilitySettings,
  type VulnerabilitySettingsPatch,
} from "@infrawrench/ui";
import {
  dismissCloudVulnerability,
  fetchCloudVulnerabilities,
  fetchCloudVulnerabilitySettings,
  restoreCloudVulnerability,
  updateCloudVulnerabilitySettings,
} from "@/lib/cloud-resources";

interface DesktopVulnerabilitiesPanelProps {
  openResource: (resource: VulnerabilityRunningRef) => void;
  openPosture: () => void;
}

/**
 * Desktop host for the shared Vulnerabilities section. Cloud only, unlike
 * Posture next to it: findings are collected from each provider's scanner by
 * the cloud poller, and local mode has no poller, so it gets an explanation
 * instead of an empty list that would read as "nothing found".
 */
export function DesktopVulnerabilitiesPanel({
  openResource,
  openPosture,
}: DesktopVulnerabilitiesPanelProps) {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<VulnerabilityListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<VulnerabilitySettings | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  // The desktop does not read `/team/me`, so Dismiss is always offered and a
  // member without `resources:write` gets the server's 403 in the section's
  // error banner: the Posture stance.
  const dismiss = useCallback(
    async (input: VulnerabilityDismissalTarget & { reason: string }) => {
      if (!activeCloudOrgId) return;
      await dismissCloudVulnerability(
        activeCloudOrgId,
        input.advisoryId,
        input.artifactKey,
        input.reason,
      );
      reload.current();
    },
    [activeCloudOrgId],
  );

  const restore = useCallback(
    async (input: VulnerabilityDismissalTarget) => {
      if (!activeCloudOrgId) return;
      await restoreCloudVulnerability(activeCloudOrgId, input.advisoryId, input.artifactKey);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const updateSettings = useCallback(
    async (patch: VulnerabilitySettingsPatch) => {
      if (!activeCloudOrgId) return;
      setSettings(await updateCloudVulnerabilitySettings(activeCloudOrgId, patch));
    },
    [activeCloudOrgId],
  );

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    setData(null);
    setError(null);
    if (!activeCloudOrgId) return;
    const orgId = activeCloudOrgId;
    function load() {
      const seq = ++latest;
      fetchCloudVulnerabilities(orgId)
        .then((d) => {
          if (!cancelled && seq === latest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && seq === latest)
            setError(e instanceof Error ? e.message : "Failed to load the vulnerabilities");
        });
    }
    load();
    reload.current = load;
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId, reloadKey]);

  // Settings are behind `org:settings:write`; a 403 (or any failure) simply
  // leaves the settings card hidden, which is what the web host does for a
  // caller without the permission.
  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    if (!activeCloudOrgId) return;
    fetchCloudVulnerabilitySettings(activeCloudOrgId)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId]);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Vulnerabilities")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            Vulnerability findings are a cloud feature: the cloud poller collects them from each
            provider&apos;s scanner, and a local workspace has no poller. Sign in to an organization
            to see what is running with a known vulnerability.
          </p>
        </T>
      </div>
    );
  }

  return (
    <VulnerabilitiesSection
      data={data}
      error={error}
      onRetry={retry}
      onOpenResource={openResource}
      onOpenPosture={openPosture}
      onDismiss={dismiss}
      onRestore={restore}
      settings={settings}
      onUpdateSettings={settings ? updateSettings : undefined}
    />
  );
}
