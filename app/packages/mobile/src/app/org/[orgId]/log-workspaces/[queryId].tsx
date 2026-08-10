import { useLocalSearchParams } from "expo-router";
import { LogWorkspaceViewerScreen } from "@/features/log-workspaces/LogWorkspaceViewerScreen";

/** One saved query's merged tail — the target of log-match push alerts. */
export default function LogWorkspaceViewerRoute() {
  const { queryId } = useLocalSearchParams<{ queryId: string }>();
  if (!queryId) return null;
  return <LogWorkspaceViewerScreen queryId={queryId} />;
}
