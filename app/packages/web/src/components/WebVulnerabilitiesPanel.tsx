import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  VulnerabilitiesSection,
  type VulnerabilityDismissalTarget,
  type VulnerabilityListResponse,
  type VulnerabilityRunningRef,
  type VulnerabilitySettings,
  type VulnerabilitySettingsPatch,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

interface WebVulnerabilitiesPanelProps {
  orgId: string;
  openResource: (resource: VulnerabilityRunningRef) => void;
  openPosture: () => void;
}

/**
 * Web host for the shared Vulnerabilities section: fetches the org's joined
 * feed from the API and refreshes when resources change. Same wiring as
 * WebPosturePanel: a failed *refresh* keeps the last feed on screen.
 */
export function WebVulnerabilitiesPanel({
  orgId,
  openResource,
  openPosture,
}: WebVulnerabilitiesPanelProps) {
  const [data, setData] = useState<VulnerabilityListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<VulnerabilitySettings | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Until the shell's permission read lands `has()` is false, so the buttons
  // and the settings card stay hidden rather than offering a call that 403s.
  const { has } = usePermissions();
  const canDismiss = has("resources:write");
  const canManageSettings = has("org:settings:write");
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const dismiss = useCallback(
    async (input: VulnerabilityDismissalTarget & { reason: string }) => {
      await apiPost(`/api/org/${orgId}/vulnerabilities/dismissals`, {
        advisoryId: input.advisoryId,
        artifactKey: input.artifactKey,
        ...(input.reason.trim() ? { reason: input.reason.trim() } : {}),
      });
      reload.current();
    },
    [orgId],
  );

  const restore = useCallback(
    async (input: VulnerabilityDismissalTarget) => {
      const query = new URLSearchParams({
        advisoryId: input.advisoryId,
        artifactKey: input.artifactKey,
      });
      await apiDelete(`/api/org/${orgId}/vulnerabilities/dismissals?${query.toString()}`);
      reload.current();
    },
    [orgId],
  );

  const updateSettings = useCallback(
    async (patch: VulnerabilitySettingsPatch) => {
      const next = await apiPut<VulnerabilitySettings>(
        `/api/org/${orgId}/vulnerabilities/settings`,
        patch,
      );
      setSettings(next);
    },
    [orgId],
  );

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    // Clear on org change so the previous org's feed never reads as this one's.
    setData(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<VulnerabilityListResponse>(`/api/org/${orgId}/vulnerabilities`)
        .then((d) => {
          if (!cancelled && request === latestRequest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && request === latestRequest)
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
  }, [orgId, reloadKey]);

  // Settings are read behind `org:settings:write`, so only callers who could
  // change them fetch them; everyone else simply gets no settings card.
  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    if (!canManageSettings) return;
    apiGet<VulnerabilitySettings>(`/api/org/${orgId}/vulnerabilities/settings`)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        // A settings read failing leaves the card hidden; the feed still works.
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, canManageSettings]);

  return (
    <VulnerabilitiesSection
      data={data}
      error={error}
      onRetry={retry}
      onOpenResource={openResource}
      onOpenPosture={openPosture}
      onDismiss={canDismiss ? dismiss : undefined}
      onRestore={canDismiss ? restore : undefined}
      settings={canManageSettings ? settings : null}
      onUpdateSettings={canManageSettings ? updateSettings : undefined}
    />
  );
}
