import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore, RESOURCES_CHANGED_EVENT } from "@infrawrench/ui";
import { ResourceDetailClient } from "@/components/ResourceDetailClient";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute(
  "/resources/$pluginId/$resourceTypeId/$resourceId",
)({
  component: ResourceDetailPage,
  validateSearch: (search: Record<string, unknown>): { accountId?: string } => ({
    ...(typeof search["accountId"] === "string" ? { accountId: search["accountId"] } : {}),
  }),
});

function ResourceDetailPage() {
  const { pluginId, resourceTypeId, resourceId: rawResourceId } = Route.useParams();
  const decodedResourceId = decodeURIComponent(rawResourceId);
  const resourceId = decodedResourceId;
  const { accountId } = Route.useSearch();
  const locationHash = useRouterState({ select: (s) => s.location.hash });
  const currentView = locationHash.replace(/^#/, "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const detailUrl = `/api/resources/${pluginId}/${resourceTypeId}/detail?resourceId=${encodeURIComponent(resourceId)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}`;

  useEffect(() => {
    setData(null);
    setError(null);
    let retries = 0;
    let cancelled = false;

    function load() {
      apiGet(detailUrl)
        .then((d) => { if (!cancelled) setData(d); })
        .catch((e) => {
          if (cancelled) return;
          // Retry up to 3 times on "not found" — resource may still be propagating
          if (retries < 3 && e.message?.includes("not found")) {
            retries++;
            setTimeout(load, 1000 * retries);
          } else {
            setError(e.message);
          }
        });
    }
    load();
    return () => { cancelled = true; };
  }, [detailUrl]);

  // Update tab title with real resource name (prefix SSH/SFTP like desktop)
  useEffect(() => {
    if (!data) return;
    const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
    if (activeWorkspaceTabId) {
      const viewSuffix = currentView === "ssh"
        ? `SSH: ${data.resourceDisplayName}`
        : currentView === "sftp"
          ? `SFTP: ${data.resourceDisplayName}`
          : data.resourceDisplayName;
      setWorkspaceTabTitle(activeWorkspaceTabId, viewSuffix);
    }
  }, [data, currentView]);

  // Auto-refresh every 30s + on resource-changed events
  useEffect(() => {
    function refresh() {
      apiGet(detailUrl).then(setData).catch(() => {});
    }
    const id = setInterval(refresh, 30_000);
    window.addEventListener(RESOURCES_CHANGED_EVENT, refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener(RESOURCES_CHANGED_EVENT, refresh);
    };
  }, [detailUrl]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  if (!data) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <ResourceDetailClient
      detailSchema={data.detailSchema}
      childResources={data.childResources}
      childTypes={data.childTypes}
      pluginId={data.pluginId}
      pluginLogoSvg={data.pluginLogoSvg}
      resourceId={data.resourceId}
      accountId={data.accountId}
      resourceTypeId={data.resourceTypeId}
      peerPanes={data.peerPanes}
      canDelete={data.canDelete}
      hasManifestEditor={data.hasManifestEditor}
      resourceDisplayName={data.resourceDisplayName}
      resourceTypeLabel={data.resourceTypeLabel}
      hasSqlEditor={data.hasSqlEditor}
      hasStorageBrowser={data.hasStorageBrowser}
      hasKvConsole={data.hasKvConsole}
      kvDriverName={data.kvDriverName}
      isMongoDb={data.isMongoDb}
      hasDockerActions={data.hasDockerActions}
      hasSshTerminal={data.hasSshTerminal}
      hasSftpBrowser={data.hasSftpBrowser}
      sshHost={data.sshHost}
      containerId={data.containerId}
      databaseName={data.databaseName}
      storageBucketName={data.storageBucketName}
      initialView={currentView === "ssh" || currentView === "sftp" ? currentView : undefined}
    />
  );
}
