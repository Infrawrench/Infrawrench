import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { T, useGT } from "gt-react";
import { MomentPanel, useUIStore, type MomentEvent } from "@infrawrench/ui";
import { createDesktopMomentClient } from "@/lib/moment-client";
import { getWorkspaceNavigateArgs, resourceTabTarget } from "@/lib/workspace-tabs";
import { invoke } from "@/lib/invoke";

export const Route = createFileRoute("/moment")({
  component: MomentPage,
  // Same search contract as web's `/org/$orgId/moment` so in-app links can
  // carry a timestamp + window into the page.
  validateSearch: (search: Record<string, unknown>): { at?: string; window?: number } => {
    const result: { at?: string; window?: number } = {};
    if (typeof search.at === "string" && !Number.isNaN(Date.parse(search.at))) {
      result.at = search.at;
    }
    // Round before validating so a fractional value can't round down to 0.
    const window = Math.round(Number(search.window));
    if (Number.isFinite(window) && window > 0) result.window = window;
    return result;
  },
});

/**
 * The moment view on desktop — the same panel web renders, over the
 * `cloud_moment` IPC. A plain route rather than a workspace tab, for the same
 * reasons as Changes: no per-instance state worth keeping mounted, and the
 * page is cloud-only so a restored tab could outlive its org. The guard below
 * covers signing out with the page open.
 */
function MomentPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const { at, window: windowMinutes } = Route.useSearch();
  const client = useMemo(() => createDesktopMomentClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Investigate a moment")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            The moment view merges feeds recorded by Infrawrench Cloud — the change timeline,
            provider incidents, cost anomalies, workflow runs, deployments and more. Local-only mode
            records none of them — sign in to an organization to investigate one.
          </p>
        </T>
      </div>
    );
  }

  const openEvent = (event: MomentEvent) => {
    const link = event.link;
    if (!link) return;
    if (link.url) {
      void invoke("open_external_url", { url: link.url });
      return;
    }
    switch (link.kind) {
      case "resource":
        if (event.pluginId && event.resourceTypeId && event.resourceId && event.accountId) {
          void navigate(
            getWorkspaceNavigateArgs(
              resourceTabTarget(
                event.accountId,
                event.resourceId,
                event.pluginId,
                event.resourceTypeId,
              ),
            ),
          );
        }
        break;
      case "workflow-run":
        void navigate({ to: "/workflows" });
        break;
      case "deployment":
        void navigate({ to: "/deployments" });
        break;
      case "costs":
        void navigate({ to: "/costs" });
        break;
      case "expiring":
        void navigate({ to: "/expiring" });
        break;
      case "changes":
      case "incident":
        void navigate({ to: "/changes" });
        break;
      // Desktop has no audit-log or change-freeze screens (org settings are
      // web-only) — those events stay in the timeline without navigation.
      default:
        break;
    }
  };

  return (
    <MomentPanel
      // Keyed by org so switching org refetches rather than showing the
      // previous org's events.
      key={activeCloudOrgId}
      client={client}
      initialAt={at}
      initialWindowMinutes={windowMinutes}
      onQueryChange={(query) =>
        void navigate({
          to: "/moment",
          search: {
            ...(query.at ? { at: query.at } : {}),
            window: query.windowMinutes,
          },
          replace: true,
        })
      }
      onOpenEvent={openEvent}
      onOpenUrl={(url) => void invoke("open_external_url", { url })}
    />
  );
}
