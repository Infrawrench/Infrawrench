import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { WebExpiryPanel } from "@/components/WebExpiryPanel";

export const Route = createFileRoute("/org/$orgId/expiring")({
  component: ExpiringPage,
});

/**
 * The cross-provider Expiry radar. The feed itself lives in `@infrawrench/ui`
 * so desktop renders the identical screen; this route is the web host — an
 * `apiGet`-backed fetch and the resource link. A plain route rather than a
 * workspace tab, matching the Changes screen: the feed has no per-instance
 * state worth keeping mounted.
 */
function ExpiringPage() {
  const { orgId } = Route.useParams();
  const navigate = useNavigate();

  return (
    <WebExpiryPanel
      // Keyed by org so switching org remounts and refetches rather than
      // showing the previous org's deadlines.
      key={orgId}
      orgId={orgId}
      openResource={(item) =>
        void navigate({
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: {
            orgId,
            pluginId: item.pluginId,
            resourceTypeId: item.resourceTypeId,
            resourceId: item.resourceId,
          },
          search: { accountId: item.accountId },
        })
      }
    />
  );
}
