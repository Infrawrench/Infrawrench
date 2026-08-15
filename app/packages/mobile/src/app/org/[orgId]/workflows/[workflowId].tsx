import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
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

interface WorkflowRunLog {
  at: number;
  level: string;
  message: string;
}

interface WorkflowRun {
  id: string;
  /** "pending" | "running" | "success" | "failure" | "canceled" */
  status: string;
  triggerSource: string;
  durationMs: number | null;
  createdAt: string;
  /** The runs endpoint returns each run's logs with the row — no second fetch. */
  logs?: WorkflowRunLog[] | null;
  error?: { message: string } | null;
  output?: unknown;
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

/** Mirrors the web/desktop run-history labels (`ui/src/workflows/RunHistory.tsx`). */
function triggerLabel(source: string): string {
  switch (source) {
    case "manual":
      return "Manual";
    case "cron":
      return "Schedule";
    case "git":
      return "Git push";
    case "api":
      return "API";
    case "budget":
      return "Budget";
    default:
      return source;
  }
}

/** "820 ms" / "3.4s" / "2m 05s" — same thresholds as the web run history. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function logColor(level: string): string {
  if (level === "error") return colors.danger;
  if (level === "warn") return colors.warning;
  return colors.textSecondary;
}

/** One run: tap to reveal the logs, error and output it recorded. */
function RunRow({ run }: { run: WorkflowRun }) {
  const [expanded, setExpanded] = useState(false);
  const logs = run.logs ?? [];
  const hasDetail = logs.length > 0 || Boolean(run.error) || run.output != null;
  const inFlight = run.status === "running" || run.status === "pending";

  return (
    <View>
      <Pressable
        style={styles.runRow}
        disabled={!hasDetail}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${run.status} run, ${triggerLabel(run.triggerSource)}`}
      >
        <View style={[styles.statusDot, { backgroundColor: statusColor(run.status) }]} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 14 }}>
            {run.status}
            <Text style={{ color: colors.textMuted }}> · {triggerLabel(run.triggerSource)}</Text>
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {new Date(run.createdAt).toLocaleString()}
            {inFlight
              ? " · in progress"
              : typeof run.durationMs === "number"
                ? ` · ${formatDuration(run.durationMs)}`
                : ""}
          </Text>
        </View>
        {hasDetail ? <Text style={styles.disclosure}>{expanded ? "▾" : "▸"}</Text> : null}
      </Pressable>
      {expanded ? (
        <View style={styles.runDetail}>
          {logs.map((log, i) => (
            <Text key={i} style={[styles.logLine, { color: logColor(log.level) }]} selectable>
              {log.message}
            </Text>
          ))}
          {run.error ? (
            <Text style={[styles.logLine, { color: colors.danger }]} selectable>
              Error: {run.error.message}
            </Text>
          ) : null}
          {run.output != null ? (
            <Text style={[styles.logLine, { color: colors.textSecondary }]} selectable>
              {JSON.stringify(run.output, null, 2)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
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
          (runs.data ?? []).map((run) => <RunRow key={run.id} run={run} />)
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
  disclosure: { color: colors.textMuted, fontSize: 14, paddingHorizontal: spacing.xs },
  runDetail: {
    backgroundColor: colors.background,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: 2,
  },
  logLine: { fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
});
