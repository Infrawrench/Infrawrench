import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  AccessReviewSection,
  DEFAULT_ACCESS_REVIEW_STALE_DAYS,
  type AccessFinding,
  type AccessPrincipal,
  type AccessReviewResponse,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

interface WebAccessReviewPanelProps {
  orgId: string;
  openResource: (principal: AccessPrincipal) => void;
}

/**
 * Web host for the shared access review: fetches the org's principals and
 * findings and refreshes when resources change. Same wiring as
 * WebPosturePanel — a failed *refresh* must not blank a drawn list, so the
 * last loaded data stays on screen under the section's banner.
 */
export function WebAccessReviewPanel({ orgId, openResource }: WebAccessReviewPanelProps) {
  const [data, setData] = useState<AccessReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [staleDays, setStaleDays] = useState(DEFAULT_ACCESS_REVIEW_STALE_DAYS);
  // Until the shell's permission read lands `has()` is false, so the write
  // actions stay hidden rather than offering something that would 403.
  const { has } = usePermissions();
  const canWrite = has("resources:write");
  // The load effect owns the refresh; the mutations need to trigger one
  // without re-running the effect's teardown, so they go through a ref.
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const dismiss = useCallback(
    async (finding: AccessFinding, reason: string) => {
      await apiPost(`/api/org/${orgId}/access-review/dismissals`, {
        resourceId: finding.resourceId,
        ruleId: finding.ruleId,
        reason,
      });
      reload.current();
    },
    [orgId],
  );

  const restore = useCallback(
    async (finding: AccessFinding) => {
      const query = new URLSearchParams({
        resourceId: finding.resourceId,
        ruleId: finding.ruleId,
      });
      await apiDelete(`/api/org/${orgId}/access-review/dismissals?${query.toString()}`);
      reload.current();
    },
    [orgId],
  );

  /**
   * Revoke through the ordinary invoke-action path — the same endpoint the
   * resource detail view's action buttons use, with the same permission, the
   * same change-freeze gate and the same audit row. The review never talks to
   * a provider itself; it only knows which action the plugin declared.
   */
  const revoke = useCallback(
    async (principal: AccessPrincipal) => {
      if (!principal.revokeActionId) return;
      const confirmed = window.confirm(
        `Revoke ${principal.displayName}? This runs the provider's own revoke action — ` +
          `anything using this principal stops working.`,
      );
      if (!confirmed) return;
      await apiPost(`/api/org/${orgId}/resources/invoke-action`, {
        pluginId: principal.pluginId,
        accountId: principal.accountId,
        resourceTypeId: principal.resourceTypeId,
        resourceId: principal.resourceId,
        actionId: principal.revokeActionId,
      });
      reload.current();
    },
    [orgId],
  );

  /**
   * The export is a plain navigation rather than a fetch: the response carries
   * a `Content-Disposition`, so letting the browser handle it gets the right
   * filename and costs no blob plumbing.
   */
  const exportReview = useCallback(
    (format: "csv" | "json") => {
      const query = new URLSearchParams({ format, staleDays: String(staleDays) });
      window.location.href = `/api/org/${orgId}/access-review/export?${query.toString()}`;
    },
    [orgId, staleDays],
  );

  useEffect(() => {
    let cancelled = false;
    // Refreshes within this effect can resolve out of order; only the newest
    // request may write state.
    let latestRequest = 0;
    // Clear on org (or window) change: without this the previous review stays
    // on screen until the new fetch resolves, which reads as the new one.
    setData(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<AccessReviewResponse>(`/api/org/${orgId}/access-review?staleDays=${staleDays}`)
        .then((d) => {
          if (!cancelled && request === latestRequest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && request === latestRequest)
            setError(e instanceof Error ? e.message : "Failed to load the access review");
        });
    }
    load();
    reload.current = load;
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, reloadKey, staleDays]);

  return (
    <AccessReviewSection
      data={data}
      error={error}
      onRetry={retry}
      staleDays={staleDays}
      onStaleDaysChange={setStaleDays}
      onOpenResource={openResource}
      // Members can read the review but not silence or act on it; without the
      // permission the section renders without those buttons rather than
      // offering an action that would 403.
      onDismiss={canWrite ? dismiss : undefined}
      onRestore={canWrite ? restore : undefined}
      onRevoke={canWrite ? revoke : undefined}
      onExport={exportReview}
    />
  );
}
