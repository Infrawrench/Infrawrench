import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  RowGroup,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";

/**
 * Read-only deploy history (GET /api/org/:orgId/deployments/runs — see
 * app/packages/web/src/api/routes/deployments.ts).
 *
 * Deploying stays on web and the CLI. It is a deliberate omission rather than a
 * gap: a deploy asks questions through `select(...)`, streams build output for
 * minutes, and ships production code — none of which suits a phone.
 */

interface DeploymentRunRow {
  id: string;
  env: string;
  repo: string | null;
  gitSha: string | null;
  image: string | null;
  status: string;
  origin: string;
  durationMs: number | null;
  startedAt: string;
}

function statusColor(status: string): string {
  if (status === "success") return colors.success;
  if (status === "failure") return colors.danger;
  return colors.textFaint;
}

function subtitleFor(run: DeploymentRunRow): string {
  const parts = [run.env || "—"];
  if (run.gitSha) parts.push(run.gitSha.slice(0, 7));
  if (run.durationMs !== null) parts.push(`${Math.round(run.durationMs / 1000)}s`);
  parts.push(run.origin);
  return parts.join(" · ");
}

export default function DeploymentsScreen() {
  const { api, orgId } = useOrgApi();

  const list = useQuery({
    queryKey: ["deployments", orgId],
    queryFn: () => api.org<DeploymentRunRow[]>(orgId, "/deployments/runs"),
  });

  if (list.isLoading) return <LoadingView />;
  if (list.isError) {
    return (
      <ErrorView
        message={list.error instanceof Error ? list.error.message : "Failed to load deployments"}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const runs = list.data ?? [];
  if (runs.length === 0) {
    return (
      <EmptyView message="No deploys yet. Run one from the web app or `infrawrench deploy`." />
    );
  }

  return (
    <Screen onRefresh={() => void list.refetch()} refreshing={list.isRefetching}>
      <Card>
        <SectionTitle>Deploys</SectionTitle>
        <RowGroup>
          {runs.map((run) => (
            <Row
              key={run.id}
              title={run.repo ?? run.image ?? run.env}
              subtitle={subtitleFor(run)}
              right={
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: statusColor(run.status),
                    }}
                  />
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>{run.status}</Text>
                </View>
              }
            />
          ))}
        </RowGroup>
      </Card>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Deploy history is read-only on mobile. Start a deploy from the web app or the CLI.
      </Text>
    </Screen>
  );
}
