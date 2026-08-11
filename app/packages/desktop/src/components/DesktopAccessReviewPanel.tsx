import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  AccessReviewSection,
  DEFAULT_ACCESS_REVIEW_STALE_DAYS,
  useUIStore,
  type AccessFinding,
  type AccessPrincipal,
  type AccessReviewResponse,
} from "@infrawrench/ui";
import {
  dismissCloudAccessFinding,
  exportCloudAccessReview,
  fetchCloudAccessReview,
  invokeCloudAction,
  restoreCloudAccessFinding,
} from "@/lib/cloud-resources";

interface DesktopAccessReviewPanelProps {
  openResource: (principal: AccessPrincipal) => void;
}

/** Save a generated document through the browser's own download path. */
function download(filename: string, mediaType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Desktop host for the shared access review. **Cloud mode only**, unlike
 * Posture and Expiring: two of the review's five rules read state that only
 * exists in the cloud — the resource-ownership records and the shared
 * dismissal store — and a local review that answered "unowned" for every
 * principal would be describing the desktop app rather than the customer's
 * clouds. The sidebar tile is gated the same way (see SidebarDashboards).
 */
export function DesktopAccessReviewPanel({ openResource }: DesktopAccessReviewPanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<AccessReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [staleDays, setStaleDays] = useState(DEFAULT_ACCESS_REVIEW_STALE_DAYS);
  // The load effect owns refreshing; the mutations trigger one through a ref
  // so they don't have to re-run the effect (and tear down its listener).
  const reload = useRef<() => void>(() => {});

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const dismiss = useCallback(
    async (finding: AccessFinding, reason: string) => {
      if (!activeCloudOrgId) return;
      await dismissCloudAccessFinding(activeCloudOrgId, finding.resourceId, finding.ruleId, reason);
      reload.current();
    },
    [activeCloudOrgId],
  );

  const restore = useCallback(
    async (finding: AccessFinding) => {
      if (!activeCloudOrgId) return;
      await restoreCloudAccessFinding(activeCloudOrgId, finding.resourceId, finding.ruleId);
      reload.current();
    },
    [activeCloudOrgId],
  );

  /**
   * Revoke through the existing invoke-action IPC — the same path the resource
   * detail view's action buttons take, with the same server-side permission
   * check, change-freeze gate and audit row. The review never calls a provider
   * itself; it only knows which action the plugin declared.
   */
  const revoke = useCallback(
    async (principal: AccessPrincipal) => {
      if (!activeCloudOrgId || !principal.revokeActionId) return;
      const confirmed = window.confirm(
        `Revoke ${principal.displayName}? This runs the provider's own revoke action — ` +
          `anything using this principal stops working.`,
      );
      if (!confirmed) return;
      await invokeCloudAction(activeCloudOrgId, {
        pluginId: principal.pluginId,
        accountId: principal.accountId,
        resourceTypeId: principal.resourceTypeId,
        resourceId: principal.resourceId,
        actionId: principal.revokeActionId,
      });
      reload.current();
    },
    [activeCloudOrgId],
  );

  const exportReview = useCallback(
    (format: "csv" | "json") => {
      if (!activeCloudOrgId) return;
      void exportCloudAccessReview(activeCloudOrgId, format, staleDays)
        .then((body) => {
          const stamp = new Date().toISOString().slice(0, 10);
          download(
            `access-review-${stamp}.${format}`,
            format === "csv" ? "text/csv" : "application/json",
            body,
          );
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "Failed to export the access review");
        });
    },
    [activeCloudOrgId, staleDays],
  );

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    // Clear on org/window change: without this the previous context's review
    // stays on screen until the new fetch resolves.
    setData(null);
    setError(null);
    if (!activeCloudOrgId) {
      setError("Sign in to Infrawrench Cloud to review your cloud principals.");
      return;
    }
    function load() {
      const seq = ++latest;
      fetchCloudAccessReview(activeCloudOrgId!, staleDays)
        .then((d) => {
          if (!cancelled && seq === latest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && seq === latest)
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
  }, [activeCloudOrgId, reloadKey, staleDays]);

  return (
    <AccessReviewSection
      data={data}
      error={error}
      onRetry={retry}
      staleDays={staleDays}
      onStaleDaysChange={setStaleDays}
      onOpenResource={openResource}
      // The server rejects a caller without `resources:write`, so the buttons
      // are always offered here and the error surfaces inline — the desktop
      // has no cheap permission read outside the org layout.
      onDismiss={dismiss}
      onRestore={restore}
      onRevoke={revoke}
      onExport={exportReview}
    />
  );
}
