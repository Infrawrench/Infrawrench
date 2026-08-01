import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChangesPanel } from "@infrawrench/ui";
import { createWebChangesClient } from "@/lib/changes-client";
import { createWebStatusIncidentsClient } from "@/lib/status-incidents-client";

export const Route = createFileRoute("/org/$orgId/changes")({
  component: ChangesFeedPage,
});

/**
 * Org-wide change timeline. The feed itself lives in `@infrawrench/ui` so
 * desktop renders the identical panel; this route is the web host — an
 * `apiGet`-backed client and the resource link.
 */
function ChangesFeedPage() {
  const { orgId } = Route.useParams();
  const navigate = useNavigate();
  const client = useMemo(() => createWebChangesClient(orgId), [orgId]);
  const statusClient = useMemo(() => createWebStatusIncidentsClient(orgId), [orgId]);

  return (
    <ChangesPanel
      // Keyed by org so switching org refetches rather than showing the
      // previous org's events under the new org's filters.
      key={orgId}
      client={client}
      statusClient={statusClient}
      onOpenUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")}
      onOpenResource={(entry) =>
        void navigate({
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: {
            orgId,
            pluginId: entry.pluginId,
            resourceTypeId: entry.resourceTypeId,
            resourceId: entry.resourceId,
          },
          search: { accountId: entry.accountId },
        })
      }
    />
  );
}
