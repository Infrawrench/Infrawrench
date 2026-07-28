import { useLocalSearchParams } from "expo-router";
import { ErrorView } from "@/components/ui";
import { KvConsoleScreen } from "@/features/tools/KvConsoleScreen";
import { KvBrowserScreen } from "@/features/tools/KvBrowserScreen";
import { LogsScreen } from "@/features/tools/LogsScreen";
import { MongoBrowserScreen } from "@/features/tools/MongoBrowserScreen";
import { PeerPaneScreen } from "@/features/tools/PeerPaneScreen";
import { SpeechScreen } from "@/features/tools/SpeechScreen";

/**
 * Per-resource tools that need a full screen on a phone: logs, the KV console,
 * the Mongo document browser, the KV namespace browser, the speech test
 * surface and peer panes. Web renders these as tabs and bottom panels inside
 * the resource page; there's no room for that here, so each is pushed as its
 * own screen.
 *
 * Every parameter rides in the query string — resource ids contain characters
 * that any packed path segment would collide with.
 */
export default function ToolRoute() {
  const params = useLocalSearchParams<{
    tool: string;
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    pluginId?: string;
    parentResourceId?: string;
    driver?: string;
    database?: string;
    peerPluginId?: string;
    tailLines?: string;
    supportsPrevious?: string;
  }>();

  const { tool, accountId } = params;
  if (!tool || !accountId) return <ErrorView message="Invalid link." />;

  switch (tool) {
    case "logs":
      if (!params.pluginId || !params.resourceTypeId || !params.resourceId) {
        return <ErrorView message="Invalid logs link." />;
      }
      return (
        <LogsScreen
          pluginId={params.pluginId}
          resourceTypeId={params.resourceTypeId}
          resourceId={params.resourceId}
          accountId={accountId}
          parentResourceId={params.parentResourceId}
          defaultTailLines={params.tailLines ? Number(params.tailLines) : undefined}
          supportsPrevious={params.supportsPrevious === "true"}
        />
      );
    case "kv-console":
      return (
        <KvConsoleScreen
          accountId={accountId}
          driverName={params.driver ?? "redis"}
          pluginId={params.pluginId}
          parentResourceId={params.parentResourceId}
        />
      );
    case "mongo":
      return (
        <MongoBrowserScreen
          accountId={accountId}
          databaseName={params.database ?? "test"}
          pluginId={params.pluginId}
          parentResourceId={params.parentResourceId}
        />
      );
    case "kv-browser":
      if (!params.resourceTypeId || !params.resourceId) {
        return <ErrorView message="Invalid KV browser link." />;
      }
      return (
        <KvBrowserScreen
          accountId={accountId}
          resourceTypeId={params.resourceTypeId}
          resourceId={params.resourceId}
        />
      );
    case "speech":
      if (!params.pluginId || !params.resourceTypeId || !params.resourceId) {
        return <ErrorView message="Invalid speech link." />;
      }
      return (
        <SpeechScreen
          pluginId={params.pluginId}
          resourceTypeId={params.resourceTypeId}
          resourceId={params.resourceId}
          accountId={accountId}
          parentResourceId={params.parentResourceId}
        />
      );
    case "peer-pane":
      if (
        !params.pluginId ||
        !params.resourceTypeId ||
        !params.resourceId ||
        !params.peerPluginId
      ) {
        return <ErrorView message="Invalid integration link." />;
      }
      return (
        <PeerPaneScreen
          pluginId={params.pluginId}
          resourceTypeId={params.resourceTypeId}
          resourceId={params.resourceId}
          accountId={accountId}
          parentResourceId={params.parentResourceId}
          peerPluginId={params.peerPluginId}
        />
      );
    default:
      return <ErrorView message={`Unknown tool "${tool}".`} />;
  }
}
