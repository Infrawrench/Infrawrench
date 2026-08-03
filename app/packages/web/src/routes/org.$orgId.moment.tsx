import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { MomentPanel, type MomentEvent } from "@infrawrench/ui";
import { createWebMomentClient } from "@/lib/moment-client";

export const Route = createFileRoute("/org/$orgId/moment")({
  component: MomentPage,
  // `at` + `window` in the URL make a moment shareable: an alert notification
  // can deep-link straight into its window.
  validateSearch: (search: Record<string, unknown>): { at?: string; window?: number } => {
    const result: { at?: string; window?: number } = {};
    if (typeof search.at === "string" && !Number.isNaN(Date.parse(search.at))) {
      result.at = search.at;
    }
    const window = Number(search.window);
    if (Number.isFinite(window) && window > 0) result.window = Math.round(window);
    return result;
  },
});

/**
 * The moment view — "what changed around 03:14?". The screen itself lives in
 * `@infrawrench/ui` so desktop renders the identical panel; this route is the
 * web host: an `apiGet`-backed client, URL sync, and the deep links onto each
 * event's native screen.
 */
function MomentPage() {
  const { orgId } = Route.useParams();
  const { at, window: windowMinutes } = Route.useSearch();
  const navigate = useNavigate();
  const client = useMemo(() => createWebMomentClient(orgId), [orgId]);

  const openEvent = (event: MomentEvent) => {
    const link = event.link;
    if (!link) return;
    if (link.url) {
      window.open(link.url, "_blank", "noopener,noreferrer");
      return;
    }
    switch (link.kind) {
      case "resource":
        if (event.pluginId && event.resourceTypeId && event.resourceId) {
          void navigate({
            to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
            params: {
              orgId,
              pluginId: event.pluginId,
              resourceTypeId: event.resourceTypeId,
              resourceId: event.resourceId,
            },
            search: event.accountId ? { accountId: event.accountId } : {},
          });
        }
        break;
      case "workflow-run":
        void navigate({ to: "/org/$orgId/workflows", params: { orgId } });
        break;
      case "deployment":
        void navigate({ to: "/org/$orgId/deployments", params: { orgId } });
        break;
      case "costs":
        void navigate({ to: "/org/$orgId/costs", params: { orgId } });
        break;
      case "audit":
        void navigate({ to: "/org/$orgId/settings/audit-log", params: { orgId } });
        break;
      case "freeze":
        void navigate({ to: "/org/$orgId/settings/freezes", params: { orgId } });
        break;
      case "expiring":
        void navigate({ to: "/org/$orgId/expiring", params: { orgId } });
        break;
      case "changes":
      case "incident":
      default:
        void navigate({ to: "/org/$orgId/changes", params: { orgId } });
        break;
    }
  };

  return (
    <MomentPanel
      // Keyed by org so switching org refetches rather than showing the
      // previous org's events under the new org's window.
      key={orgId}
      client={client}
      initialAt={at}
      initialWindowMinutes={windowMinutes}
      onQueryChange={(query) =>
        void navigate({
          to: "/org/$orgId/moment",
          params: { orgId },
          search: {
            ...(query.at ? { at: query.at } : {}),
            window: query.windowMinutes,
          },
          replace: true,
        })
      }
      onOpenEvent={openEvent}
      onOpenUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")}
    />
  );
}
