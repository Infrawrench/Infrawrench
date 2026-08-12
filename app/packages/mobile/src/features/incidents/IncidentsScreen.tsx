import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_SEVERITIES,
  formatIncidentDuration,
  incidentSeverityLabel,
  incidentStatusLabel,
  type Incident,
  type IncidentSeverity,
  type IncidentStatus,
} from "@infrawrench/client-core";
import { Button, Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { useDeclareIncident, useIncidents } from "./useIncidents";

const FILTERS: Array<{ id: IncidentStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
];

/**
 * Declared incidents on the phone.
 *
 * This is the one authoring surface mobile gets in this feature, and
 * deliberately so — it breaks the read-only-billing line for a reason. The
 * three things you do at 03:14 are declare, read what happened, and write a
 * note, and all three happen while you are away from a laptop. What stays on
 * web/desktop is everything you do *afterwards*: editing the incident,
 * retrying artefacts, and the postmortem export, none of which is urgent and
 * all of which is a text-heavy job a phone is bad at.
 *
 * The declare sheet offers a title and a severity only. The artefact tick
 * boxes are web/desktop's: choosing whether to freeze the whole org's
 * destructive actions is not a decision to take on a lock screen, so the
 * phone's declaration takes the safe defaults (announce, pin the moment, no
 * freeze, nothing published).
 */
export function IncidentsScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const [filter, setFilter] = useState<IncidentStatus | "all">("all");
  const [declaring, setDeclaring] = useState(false);
  const incidents = useIncidents(filter);

  if (incidents.isLoading) return <LoadingView />;
  if (incidents.isError) {
    return (
      <ErrorView
        message={
          incidents.error instanceof Error ? incidents.error.message : "Couldn't load incidents."
        }
        onRetry={() => void incidents.refetch()}
      />
    );
  }

  const list = incidents.data?.incidents ?? [];

  return (
    <Screen onRefresh={() => void incidents.refetch()} refreshing={incidents.isRefetching}>
      <View style={styles.filters}>
        {FILTERS.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === option.id }}
            onPress={() => setFilter(option.id)}
            style={[styles.chip, filter === option.id && styles.chipActive]}
          >
            <Text style={[styles.chipText, filter === option.id && styles.chipTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Button label="Declare incident" variant="danger" onPress={() => setDeclaring(true)} />

      {list.length === 0 ? (
        <EmptyView message="No incidents. Long may it last." />
      ) : (
        <Card list>
          {list.map((incident) => (
            <IncidentRow
              key={incident.id}
              incident={incident}
              onPress={() => router.push(`/org/${orgId}/incidents/${incident.id}`)}
            />
          ))}
        </Card>
      )}

      <Text style={styles.footnote}>
        Incidents you declared — not provider outages, which appear on the Moment view. Editing,
        retrying failed artefacts and the postmortem export live on the web and desktop apps.
      </Text>

      <DeclareSheet visible={declaring} onClose={() => setDeclaring(false)} />
    </Screen>
  );
}

function severityColor(severity: string): string {
  switch (severity) {
    case "sev1":
      return colors.danger;
    case "sev2":
      return colors.warning;
    default:
      return colors.textFaint;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "open":
      return colors.danger;
    case "mitigated":
      return colors.warning;
    default:
      return colors.textFaint;
  }
}

function IncidentRow({ incident, onPress }: { incident: Incident; onPress: () => void }) {
  const failed = incident.artifacts.filter((a) => a.status === "failed").length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${incidentSeverityLabel(incident.severity)} ${incident.title}, ${incidentStatusLabel(incident.status)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.dot, { backgroundColor: severityColor(incident.severity) }]} />
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {incident.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {incidentSeverityLabel(incident.severity)} ·{" "}
          {formatIncidentDuration(incident.startedAt, incident.resolvedAt)}
          {incident.declaredByName ? ` · ${incident.declaredByName}` : ""}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </Text>
      </View>
      <Text style={[styles.status, { color: statusColor(incident.status) }]}>
        {incidentStatusLabel(incident.status).toLowerCase()}
      </Text>
    </Pressable>
  );
}

/**
 * Title + severity, and nothing else. See the note on the screen: a phone is
 * the wrong place to decide whether to freeze the org.
 */
function DeclareSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>(DEFAULT_INCIDENT_SEVERITY);
  const declare = useDeclareIncident();

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    declare.mutate(
      // Safe defaults, spelled out rather than left to the server so the phone
      // can never be the surface that silently froze an organisation.
      {
        title: trimmed,
        severity,
        actions: { openFreeze: false, pinMoment: true, postSlack: true },
      },
      {
        onSuccess: (incident) => {
          setTitle("");
          onClose();
          if (incident) router.push(`/org/${orgId}/incidents/${incident.id}`);
        },
      },
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Declare an incident</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Checkout is returning 500s"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoFocus
          />
          <View style={styles.filters}>
            {INCIDENT_SEVERITIES.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: severity === option.id }}
                onPress={() => setSeverity(option.id)}
                style={[styles.chip, severity === option.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, severity === option.id && styles.chipTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.footnote}>
            Announces through your alert routing rules and pins the moment. Freezing changes and
            publishing to a status page are web and desktop decisions.
          </Text>
          {declare.isError && (
            <Text style={styles.error}>
              {declare.error instanceof Error ? declare.error.message : "Couldn't declare."}
            </Text>
          )}
          <Button
            label={declare.isPending ? "Declaring…" : "Declare"}
            variant="danger"
            disabled={declare.isPending || !title.trim()}
            onPress={submit}
          />
          <Button label="Cancel" variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: 12 },
  chipTextActive: { color: "#fff" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md },
  rowPressed: { opacity: 0.6 },
  rowMain: { flex: 1, gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { color: colors.text, fontSize: 15 },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  status: { fontSize: 12 },
  footnote: { color: colors.textFaint, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13 },
  sheetBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: colors.background,
    padding: spacing.lg,
    gap: spacing.md,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
  },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 15,
  },
});
