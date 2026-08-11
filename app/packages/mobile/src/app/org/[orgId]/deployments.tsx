import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  CHANGE_IMPACT_CONFIDENCE_LABELS,
  costBasisLabel,
  fetchDeploymentCostImpact,
  formatChangeCostImpact,
  formatSignedPerDay,
} from "@infrawrench/client-core";
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
  const [openRunId, setOpenRunId] = useState<string | null>(null);

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
            <View key={run.id}>
              <Row
                title={run.repo ?? run.image ?? run.env}
                subtitle={subtitleFor(run)}
                // Successful runs open their cost impact; nothing else has one.
                onPress={
                  run.status === "success"
                    ? () => setOpenRunId(openRunId === run.id ? null : run.id)
                    : undefined
                }
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
              {openRunId === run.id && <DeployCostImpact runId={run.id} />}
            </View>
          ))}
        </RowGroup>
      </Card>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Deploy history is read-only on mobile. Start a deploy from the web app or the CLI.
      </Text>
    </Screen>
  );
}

/**
 * What one deploy did to the run rate, per resource it provisioned.
 *
 * Read-only like the rest of this screen: web and desktop additionally offer
 * "Annotate cost graph", which writes the finding onto the charts. That is a
 * `costs:write` action on shared org state, the same line the anomaly
 * thresholds and the custom-graph editor already sit on.
 *
 * Fetched only when a run is opened — measuring is two ClickHouse reads and a
 * history page has fifty runs on it.
 */
function DeployCostImpact({ runId }: { runId: string }) {
  const { api, orgId } = useOrgApi();
  const impact = useQuery({
    queryKey: ["deploy-cost-impact", orgId, runId],
    queryFn: () => fetchDeploymentCostImpact(api, orgId, runId),
    retry: false,
  });

  if (impact.isLoading) {
    return <Text style={styles.costHint}>Measuring…</Text>;
  }
  if (impact.isError || !impact.data) {
    return <Text style={styles.costHint}>Cost impact unavailable for this run.</Text>;
  }
  const data = impact.data;
  if (data.resources.length === 0) {
    return (
      <Text style={styles.costHint}>
        This deploy provisioned no resources, so there is nothing to attribute to it.
      </Text>
    );
  }

  return (
    <View style={{ gap: 4, paddingBottom: 12 }}>
      <Text style={styles.costTotal}>
        {data.total.length === 0
          ? "No measurable cost impact"
          : data.total.map((t) => formatSignedPerDay(t.deltaPerDay, t.currency)).join(", ")}
        {"  "}
        <Text style={styles.costHint}>
          {costBasisLabel(data.costBasis)}, {data.windowDays}d before/after ·{" "}
          {CHANGE_IMPACT_CONFIDENCE_LABELS[data.confidence].toLowerCase()}
          {data.unknownResources > 0
            ? ` · ${data.unknownResources} not measurable, excluded from the total`
            : ""}
        </Text>
      </Text>
      {data.resources.map((r) => (
        <Text key={r.resourceId} style={styles.costHint} numberOfLines={2}>
          {r.displayName} — {formatChangeCostImpact(r.impact, { verbose: true })}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  costTotal: { color: colors.text, fontSize: 13, fontWeight: "500" },
  costHint: { color: colors.textFaint, fontSize: 11 },
});
