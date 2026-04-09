import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { ResourceDetailClient } from "@/components/ResourceDetailClient";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute(
  "/resources/$pluginId/$resourceTypeId/$resourceId",
)({
  component: ResourceDetailPage,
});

function ResourceDetailPage() {
  const { pluginId, resourceTypeId, resourceId } = Route.useParams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet(`/api/resources/${pluginId}/${resourceTypeId}/${encodeURIComponent(resourceId)}/detail`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [pluginId, resourceTypeId, resourceId]);

  useEffect(() => {
    function onChanged() {
      apiGet(`/api/resources/${pluginId}/${resourceTypeId}/${encodeURIComponent(resourceId)}/detail`)
        .then(setData);
    }
    window.addEventListener("iw:resources-changed", onChanged);
    return () => window.removeEventListener("iw:resources-changed", onChanged);
  }, [pluginId, resourceTypeId, resourceId]);

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
      resourceTypeLabel={data.resourceTypeLabel}
      hasSqlEditor={data.hasSqlEditor}
      hasStorageBrowser={data.hasStorageBrowser}
      hasKvConsole={data.hasKvConsole}
      kvDriverName={data.kvDriverName}
      isMongoDb={data.isMongoDb}
      hasDockerActions={data.hasDockerActions}
      hasSshTerminal={data.hasSshTerminal}
      hasSftpBrowser={data.hasSftpBrowser}
      containerId={data.containerId}
      databaseName={data.databaseName}
      storageBucketName={data.storageBucketName}
    />
  );
}
