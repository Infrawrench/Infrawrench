import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  formatIncidentDuration,
  incidentSeverityLabel,
  incidentStatusLabel,
  INCIDENT_ARTIFACT_LABELS,
  type IncidentTimelineEntry,
} from "@infrawrench/client-core";
import { Button, Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";
import {
  useAddIncidentNote,
  useIncident,
  useIncidentTimeline,
  useTransitionIncident,
} from "./useIncidents";

/**
 * One incident: the header facts, the artefacts (loudly, when one failed), the
 * joined timeline, and a note box.
 *
 * The timeline arrives already ordered and windowed from
 * `buildIncidentTimeline` on the server — this screen renders and does not
 * decide, so the phone, the browser and the postmortem export cannot disagree
 * about what happened.
 */
export function IncidentDetailScreen({ incidentId }: { incidentId: string }) {
  const detail = useIncident(incidentId);
  const timeline = useIncidentTimeline(incidentId);
  const addNote = useAddIncidentNote(incidentId);
  const transition = useTransitionIncident(incidentId);
  const [note, setNote] = useState("");

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError || !detail.data) {
    return (
      <ErrorView
        message={
          detail.error instanceof Error ? detail.error.message : "Couldn't load the incident."
        }
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const { incident } = detail.data;
  const failed = incident.artifacts.filter((a) => a.status === "failed");

  return (
    <Screen
      onRefresh={() => {
        void detail.refetch();
        void timeline.refetch();
      }}
      refreshing={detail.isRefetching}
    >
      <View style={{ gap: spacing.xs }}>
        <Text style={styles.heading}>{incident.title}</Text>
        <Text style={styles.subtitle}>
          {incidentSeverityLabel(incident.severity)} · {incidentStatusLabel(incident.status)} ·{" "}
          {formatIncidentDuration(incident.startedAt, incident.resolvedAt)}
          {incident.declaredByName ? ` · ${incident.declaredByName}` : ""}
        </Text>
        {incident.summary ? <Text style={styles.body}>{incident.summary}</Text> : null}
      </View>

      {failed.length > 0 && (
        <View style={styles.failedBox}>
          <Text style={styles.failedTitle}>
            {failed.length === 1 ? "One thing" : `${failed.length} things`} this declaration asked
            for did not happen
          </Text>
          {failed.map((artifact) => (
            <Text key={artifact.id} style={styles.failedLine}>
              {INCIDENT_ARTIFACT_LABELS[artifact.kind] ?? artifact.kind} — {artifact.error}
            </Text>
          ))}
          <Text style={styles.footnote}>Retry them on the web or desktop app.</Text>
        </View>
      )}

      {incident.status !== "resolved" && (
        <View style={{ gap: spacing.sm }}>
          {incident.status === "open" && (
            <Button
              label="Mark mitigated"
              variant="secondary"
              disabled={transition.isPending}
              onPress={() => transition.mutate("mitigated")}
            />
          )}
          <Button
            label="Resolve"
            disabled={transition.isPending}
            onPress={() => transition.mutate("resolved")}
          />
        </View>
      )}

      <SectionTitle>Add a note</SectionTitle>
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Failed over to the replica…"
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        multiline
      />
      <Button
        label={addNote.isPending ? "Adding…" : "Add note"}
        variant="secondary"
        disabled={addNote.isPending || !note.trim()}
        onPress={() =>
          addNote.mutate(note.trim(), {
            onSuccess: () => setNote(""),
          })
        }
      />

      <SectionTitle>Timeline</SectionTitle>
      {timeline.isLoading && <Text style={styles.footnote}>Assembling the timeline…</Text>}
      {timeline.isError && (
        <Text style={styles.failedLine}>The timeline could not be assembled. Pull to refresh.</Text>
      )}
      {timeline.data && timeline.data.entries.length === 0 && (
        <Text style={styles.footnote}>
          Nothing else was recorded in this window — the change feed, deploys and alerts were all
          quiet while this was happening.
        </Text>
      )}
      {timeline.data && timeline.data.entries.length > 0 && (
        <Card list>
          {timeline.data.entries.map((entry) => (
            <TimelineRow key={entry.id} entry={entry} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return colors.danger;
    case "warning":
      return colors.warning;
    default:
      return colors.accent;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function TimelineRow({ entry }: { entry: IncidentTimelineEntry }) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: severityColor(entry.severity) }]} />
      <View style={styles.rowMain}>
        <Text style={styles.rowMeta}>
          {formatTime(entry.at)}
          {entry.authorName ? ` · ${entry.authorName}` : ""}
        </Text>
        <Text style={styles.rowTitle}>{entry.title}</Text>
        {entry.detail ? <Text style={styles.rowDetail}>{entry.detail}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { color: colors.text, fontSize: 19, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 13 },
  body: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  footnote: { color: colors.textFaint, fontSize: 12, lineHeight: 17 },
  failedBox: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  failedTitle: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  failedLine: { color: colors.textSecondary, fontSize: 12 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 15,
    minHeight: 64,
    textAlignVertical: "top",
  },
  row: { flexDirection: "row", gap: spacing.md, padding: spacing.md },
  rowMain: { flex: 1, gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  rowMeta: { color: colors.textFaint, fontSize: 11 },
  rowTitle: { color: colors.text, fontSize: 14 },
  rowDetail: { color: colors.textMuted, fontSize: 12 },
});
