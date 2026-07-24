import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";

/**
 * Read-only coding-agent sessions list (GET /api/org/:orgId/agents/sessions —
 * see app/packages/web/src/api/routes/agents.ts rowToSession). Creating,
 * opening, and deleting sessions stays on web/desktop.
 */

interface AgentSession {
  id: string;
  repo: string;
  projectName: string;
  workspaceName: string;
  tool: string;
  branchName: string;
  /** e.g. "setting-up" | "up" | "failed" */
  status: string;
  createdAt: string;
  updatedAt: string;
}

function statusColor(status: string): string {
  switch (status) {
    case "up":
      return colors.success;
    case "failed":
      return colors.danger;
    default:
      return colors.warning;
  }
}

function toolLabel(tool: string): string {
  return tool === "claude-code" ? "Claude Code" : tool === "codex" ? "Codex" : tool;
}

export default function AgentsScreen() {
  const { api, orgId } = useOrgApi();

  const sessions = useQuery({
    queryKey: ["agent-sessions", orgId],
    queryFn: () => api.org<AgentSession[]>(orgId, "/agents/sessions"),
  });

  if (sessions.isLoading) return <LoadingView />;
  if (sessions.isError) {
    return (
      <ErrorView
        message={
          sessions.error instanceof Error ? sessions.error.message : "Failed to load agent sessions"
        }
        onRetry={() => void sessions.refetch()}
      />
    );
  }

  const rows = sessions.data ?? [];
  if (rows.length === 0) {
    return <EmptyView message="No agent sessions. Start one from the web or desktop app." />;
  }

  return (
    <Screen onRefresh={() => void sessions.refetch()} refreshing={sessions.isRefetching}>
      <Card>
        <SectionTitle>Agent sessions</SectionTitle>
        {rows.map((session) => (
          <Row
            key={session.id}
            title={session.projectName || session.repo}
            subtitle={`${toolLabel(session.tool)} · ${session.branchName} · ${new Date(session.createdAt).toLocaleString()}`}
            right={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: statusColor(session.status),
                  }}
                />
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>{session.status}</Text>
              </View>
            }
          />
        ))}
      </Card>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Interactive agent control (opening terminals, creating and deleting sessions) is available
        on the web and desktop apps.
      </Text>
    </Screen>
  );
}
