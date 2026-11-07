import type { ResourceInstance } from "@infrawrench/plugin-base";
import { MongoDocumentBrowser } from "../../components/MongoDocumentBrowser";
import { KvConsole } from "../../components/KvConsole";
import { DockerActionsPanel } from "../../components/DockerActionsPanel";

interface DataPanelsProps {
  activeCloudOrgId: string | null;
  isKvPlugin: boolean;
  kvDriverName: string | null;
  /** The KV driver opens collections of documents rather than a key console. */
  kvDocumentBrowser: boolean;
  kvConnected: boolean;
  isDockerPlugin: boolean;
  dockerDriverName: string | null;
  dockerHost: string;
  resource: ResourceInstance | null;
  connectionString: string;
  accountId: string;
  peerPlugin: string | undefined;
  peerParent: string | undefined;
}

export function DataPanels({
  activeCloudOrgId,
  isKvPlugin,
  kvDriverName,
  kvDocumentBrowser,
  kvConnected,
  isDockerPlugin,
  dockerDriverName,
  dockerHost,
  resource,
  connectionString,
  accountId,
  peerPlugin,
  peerParent,
}: DataPanelsProps) {
  return (
    <>
      {!activeCloudOrgId && isKvPlugin && kvDocumentBrowser && kvDriverName && resource && (
        <MongoDocumentBrowser
          driverId={kvDriverName}
          connectionString={connectionString}
          databaseName={String(resource.fields["database"] ?? "test")}
          connected={kvConnected}
        />
      )}

      {!activeCloudOrgId && isKvPlugin && !kvDocumentBrowser && (
        <KvConsole
          mode="local"
          connectionString={connectionString}
          driverName={kvDriverName ?? "redis"}
          connected={kvConnected}
        />
      )}

      {activeCloudOrgId && isKvPlugin && !kvDocumentBrowser && (
        <KvConsole
          mode="cloud"
          orgId={activeCloudOrgId}
          accountId={accountId}
          {...(peerPlugin ? { pluginId: peerPlugin } : {})}
          {...(peerParent ? { parentResourceId: peerParent } : {})}
          driverName={kvDriverName ?? "redis"}
          connected={kvConnected}
        />
      )}

      {!activeCloudOrgId && isDockerPlugin && resource && (
        <DockerActionsPanel
          containerId={String(resource.resolvedOutputs["containerId"] ?? resource.externalId ?? "")}
          driverId={dockerDriverName ?? "docker"}
          dockerHost={dockerHost}
        />
      )}
    </>
  );
}
