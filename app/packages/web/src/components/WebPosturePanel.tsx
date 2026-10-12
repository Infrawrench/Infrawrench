import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  LeakedCredentialsSection,
  PostureSection,
  type LeakedCredentialsClient,
  type PostureFinding,
  type PostureListResponse,
} from "@infrawrench/ui";
import type {
  LeakRotateInput,
  LeakedSecret,
  LeakedSecretListResponse,
} from "@infrawrench/client-core";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

interface WebPosturePanelProps {
  orgId: string;
  openResource: (finding: PostureFinding) => void;
  openAccount: (accountId: string) => void;
}

/**
 * Web host for the shared posture checks: fetches the org's findings from the
 * API and refreshes when resources change. Same wiring as WebExpiryPanel: a
 * failed *refresh* must not blank findings that are already drawn, so the
 * last loaded data stays on screen under the section's banner.
 */
export function WebPosturePanel({ orgId, openResource, openAccount }: WebPosturePanelProps) {
  const [data, setData] = useState<PostureListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Until the shell's permission read lands `has()` is false, so the dismiss
  // buttons stay hidden rather than offering an action that would 403.
  const { has } = usePermissions();
  const canDismiss = has("resources:write");
  const canRotate = has("secrets:write");

  // The leaked-credentials category. Without `secrets:write` it gets only the
  // list, which renders it read-only.
  const leakClient = useMemo<LeakedCredentialsClient>(() => {
    const base = `/api/org/${orgId}/leaked-secrets`;
    const post = async (path: string, body: unknown) =>
      (await apiPost<{ leak: LeakedSecret }>(`${base}${path}`, body)).leak;
    return {
      list: () => apiGet<LeakedSecretListResponse>(base),
      ...(canRotate
        ? {
            rotate: (id: string, input: LeakRotateInput) =>
              post(`/${encodeURIComponent(id)}/rotate`, input),
            markRotated: (id: string, input: { resolveUpstream?: boolean }) =>
              post(`/${encodeURIComponent(id)}/mark-rotated`, input),
            dismiss: (
              id: string,
              input: Parameters<NonNullable<LeakedCredentialsClient["dismiss"]>>[1],
            ) => post(`/${encodeURIComponent(id)}/dismiss`, input),
            reopen: (id: string) => post(`/${encodeURIComponent(id)}/reopen`, {}),
            scan: () =>
              apiPost<{ scanned: number; newLeaks: number; errors: number }>(`${base}/scan`, {}),
          }
        : {}),
    };
  }, [orgId, canRotate]);
  // The load effect owns the refresh; dismiss/restore need to trigger one
  // without re-running the effect's teardown, so they go through a ref the
  // effect installs.
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const dismiss = useCallback(
    async (finding: PostureFinding, reason: string) => {
      await apiPost(`/api/org/${orgId}/posture/dismissals`, {
        resourceId: finding.resourceId,
        ruleId: finding.ruleId,
        reason,
      });
      reload.current();
    },
    [orgId],
  );

  const restore = useCallback(
    async (finding: PostureFinding) => {
      const query = new URLSearchParams({
        resourceId: finding.resourceId,
        ruleId: finding.ruleId,
      });
      await apiDelete(`/api/org/${orgId}/posture/dismissals?${query.toString()}`);
      reload.current();
    },
    [orgId],
  );

  useEffect(() => {
    let cancelled = false;
    // Refreshes within this effect (initial load + RESOURCES_CHANGED_EVENT)
    // can resolve out of order; only the newest request may write state.
    let latestRequest = 0;
    // Clear on org change: without this the previous org's findings stay on
    // screen until the new fetch resolves, which reads as this org's feed.
    setData(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<PostureListResponse>(`/api/org/${orgId}/posture`)
        .then((d) => {
          if (!cancelled && request === latestRequest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && request === latestRequest)
            setError(e instanceof Error ? e.message : "Failed to load the posture findings");
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

  return (
    <PostureSection
      data={data}
      error={error}
      onRetry={retry}
      onOpenResource={openResource}
      // Members can read the screen but not silence it; without the
      // permission the section renders without the buttons rather than
      // offering an action that would 403.
      onDismiss={canDismiss ? dismiss : undefined}
      onRestore={canDismiss ? restore : undefined}
      leakedCredentials={
        <LeakedCredentialsSection
          // Remounts when the permission read lands so the actions appear.
          key={canRotate ? "rw" : "ro"}
          client={leakClient}
          onOpenAccount={openAccount}
          onOpenResource={(leak) => {
            if (!leak.matchedAccountId || !leak.matchedResourceId) return;
            openResource({
              accountId: leak.matchedAccountId,
              resourceId: leak.matchedResourceId,
              pluginId: leak.matchedPluginId ?? "",
              resourceTypeId: leak.matchedResourceTypeId ?? "",
            } as PostureFinding);
          }}
        />
      }
    />
  );
}
