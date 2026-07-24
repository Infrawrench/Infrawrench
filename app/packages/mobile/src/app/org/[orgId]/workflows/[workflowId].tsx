import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Read-only workflow detail: GET /workflows/:id and GET /workflows/:id/runs
 * (app/packages/web/src/api/routes/workflows.ts). Manual runs use the plain
 * HTTP POST /workflows/:id/run endpoint (non-interactive; interactive
 * debugging stays on web/desktop over the workflow:* WS frames).
 */

interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  source: string;
  enabled: boolean;
  trigger: { kind?: string } | null;
  updatedAt: string;
}

interface WorkflowRun {
  id: string;
  /** "pending" | "running" | "success" | "failure" | "canceled" */
  status: string;
  triggerSource: string;
  durationMs: number | null;
  createdAt: string;
}

function statusColor(status: string): string {
  switch (status) {
    case "success":
      return colors.success;
    case "failure":
      return colors.danger;
    case "running":
    case "pending":
      return colors.warning;
    default:
      return colors.textMuted;
  }
}

export default function WorkflowDetailScreen() {
  const { workflowId } = useLocalSearchParams<{ workflowId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);

  const id = workflowId ?? "";
  const detail = useQuery({
    queryKey: ["workflow", orgId, id],
    queryFn: () => api.org<WorkflowDetail>(orgId, `/workflows/${encodeURIComponent(id)}`),
    enabled: id.length > 0,
  });
  const runs = useQuery({
    queryKey: ["workflow-runs", orgId, id],
    queryFn: () => api.org<WorkflowRun[]>(orgId, `/workflows/${encodeURIComponent(id)}/runs`),
    enabled: id.length > 0,
  });

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError || !detail.data) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load workflow"}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const wf = detail.data;

  async function runNow() {
    setRunning(true);
    try {
      await api.org<{ runId: string; result: unknown }>(
        orgId,
        `/workflows/${encodeURIComponent(id)}/run`,
        { method: "POST" },
      );
      Alert.alert("Workflow finished", "The run completed. Pull the run list to see its result.");
      await queryClient.invalidateQueries({ queryKey: ["workflow-runs", orgId, id] });
    } catch (e) {
      Alert.alert("Run failed", e instanceof Error ? e.message : "The workflow run failed.");
      await queryClient.invalidateQueries({ queryKey: ["workflow-runs", orgId, id] });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Screen
      onRefresh={() => {
        void detail.refetch();
        void runs.refetch();
      }}
      refreshing={detail.isRefetching || runs.isRefetching}
    >
      <Text style={styles.title}>{wf.name}</Text>
      <Text style={styles.subtitle}>
        {(wf.trigger?.kind ?? "manual") + " trigger · "}
        {wf.enabled ? "enabled" : "disabled"}
      </Text>
      {wf.description ? <Text style={styles.description}>{wf.description}</Text> : null}

      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <Button
          label={running ? "Running…" : "Run"}
          disabled={running}
          onPress={() => void runNow()}
        />
      </View>
      <Text style={styles.note}>
        Runs from mobile are non-interactive. Debug and edit workflows from the web or desktop app.
      </Text>

      <Card>
        <SectionTitle>Source</SectionTitle>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={styles.source} selectable>
            {wf.source || "// This workflow has no source yet."}
          </Text>
        </ScrollView>
      </Card>

      <Card>
        <SectionTitle>Recent runs</SectionTitle>
        {runs.isLoading ? (
          <Text style={styles.note}>Loading runs…</Text>
        ) : runs.isError ? (
          <>
            <Text style={styles.note}>
              Failed to load runs
              {runs.error instanceof Error ? `: ${runs.error.message}` : "."}
            </Text>
            <Button label="Retry" variant="secondary" onPress={() => void runs.refetch()} />
          </>
        ) : (runs.data ?? []).length === 0 ? (
          <Text style={styles.note}>No runs yet.</Text>
        ) : (
          (runs.data ?? []).map((run) => (
            <View key={run.id} style={styles.runRow}>
              <View style={[styles.statusDot, { backgroundColor: statusColor(run.status) }]} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.text, fontSize: 14 }}>
                  {run.status}
                  <Text style={{ color: colors.textMuted }}> · {run.triggerSource}</Text>
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                  {new Date(run.createdAt).toLocaleString()}
                  {typeof run.durationMs === "number" ? ` · ${run.durationMs} ms` : ""}
                </Text>
              </View>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  subtitle: { color: colors.textMuted, fontSize: 13 },
  description: { color: colors.textSecondary, fontSize: 14 },
  note: { color: colors.textFaint, fontSize: 12 },
  source: {
    color: colors.textSecondary,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
    backgroundColor: colors.background,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
});
