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
  const accountId = new URLSearchParams(window.location.search).get("accountId");
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

  useEffect(() => {
    function onChanged() {
      apiGet(detailUrl).then(setData);
    }
    window.addEventListener("iw:resources-changed", onChanged);
    return () => window.removeEventListener("iw:resources-changed", onChanged);
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
      containerId={data.containerId}
      databaseName={data.databaseName}
      storageBucketName={data.storageBucketName}
    />
  );
}
