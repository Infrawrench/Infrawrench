import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useLogWorkspaces } from "./useLogWorkspaces";

/**
 * Saved log-workspace queries, read-only: the list shows each query's stream
 * count, search expression and alert state, and tapping one opens the viewer
 * that tails its streams. Composing a query (picking resources, editing the
 * expression, toggling the alert) is a web/desktop authoring task.
 */
export function LogWorkspacesScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const queries = useLogWorkspaces();

  if (queries.isLoading) return <LoadingView />;
  if (queries.isError) {
    return (
      <ErrorView
        message={queries.error instanceof Error ? queries.error.message : "Failed to load"}
        onRetry={() => void queries.refetch()}
      />
    );
  }

  const list = queries.data?.queries ?? [];
  if (list.length === 0) {
    return (
      <EmptyView message="No saved log queries. Build one in the Log workspace on the web or desktop app." />
    );
  }

  return (
    <Screen onRefresh={() => void queries.refetch()} refreshing={queries.isRefetching}>
      <Card list>
        {list.map((q) => {
          const alertBit = q.alertEnabled
            ? q.lastEvalError
              ? "alert error"
              : q.lastMatchAt
                ? `matched ${new Date(q.lastMatchAt).toLocaleString()}`
                : "alert on"
            : null;
          return (
            <Row
              key={q.id}
              title={q.name}
              subtitle={[
                `${q.resources.length} stream${q.resources.length === 1 ? "" : "s"}`,
                q.search ? `“${q.search}”` : "no filter",
                ...(alertBit ? [alertBit] : []),
              ].join(" · ")}
              onPress={() => router.push(`/org/${orgId}/log-workspaces/${q.id}`)}
            />
          );
        })}
      </Card>
      <Text
        style={{
          color: colors.textMuted,
          fontSize: 12,
          paddingHorizontal: spacing.md,
          paddingBottom: spacing.md,
        }}
      >
        Saved queries are read-only on mobile. Edit them in the Log workspace on the web or desktop
        app.
      </Text>
    </Screen>
  );
}
