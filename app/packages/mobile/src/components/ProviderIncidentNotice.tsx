import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOrgStatusIncidents,
  summarizeStatusIncident,
  type OrgStatusIncident,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";

const POLL_INTERVAL_MS = 60_000;

/**
 * Native counterpart to the web/desktop `ProviderIncidentBanner` — the
 * "is it me or is it them?" surface. Shows active provider status-page
 * incidents that overlap resources the org holds; renders nothing otherwise,
 * so screens mount it unconditionally. With `showResolvedCorrelation` it
 * also lists recently-resolved incidents that overlapped recorded changes —
 * the Changes screen's correlation section.
 */
export function ProviderIncidentNotice({
  showResolvedCorrelation = false,
}: {
  showResolvedCorrelation?: boolean;
}) {
  const { api, orgId } = useOrgApi();
  const incidents = useQuery({
    queryKey: ["status-incidents", orgId],
    queryFn: () => fetchOrgStatusIncidents(api, orgId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const all = incidents.data?.incidents ?? [];
  const active = all.filter(
    (i) => !i.resolvedAt && i.impact !== "maintenance" && i.affectedResourceCount > 0,
  );
  const resolved = showResolvedCorrelation
    ? all.filter((i) => i.resolvedAt && i.overlappingChangeCount > 0)
    : [];
  if (active.length === 0 && resolved.length === 0) return null;

  return (
    <View style={styles.box}>
      {active.length > 0 && (
        <Text style={styles.heading}>
          {active.length === 1 ? "Provider incident" : `${active.length} provider incidents`} —
          it&apos;s them, not you
        </Text>
      )}
      {active.map((incident) => (
        <IncidentRow key={incident.id} incident={incident} />
      ))}
      {resolved.length > 0 && (
        <>
          <Text style={styles.subheading}>Recently resolved</Text>
          {resolved.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} />
          ))}
        </>
      )}
    </View>
  );
}

function IncidentRow({ incident }: { incident: OrgStatusIncident }) {
  return (
    <View style={styles.item}>
      <Text style={styles.summary}>{summarizeStatusIncident(incident)}</Text>
      <Text style={styles.detail}>
        {incident.title}
        {incident.overlappingChangeCount > 0
          ? ` · ${incident.overlappingChangeCount} ${
              incident.overlappingChangeCount === 1 ? "change" : "changes"
            } during this incident`
          : ""}
      </Text>
      {incident.url ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(incident.url as string)}
        >
          <Text style={styles.link}>Provider status ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: "rgba(251, 191, 36, 0.1)",
    borderColor: "rgba(251, 191, 36, 0.4)",
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  heading: { color: colors.warning, fontSize: 14, fontWeight: "600" },
  subheading: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  item: { gap: 2 },
  summary: { color: colors.text, fontSize: 13, fontWeight: "500" },
  detail: { color: colors.textSecondary, fontSize: 12 },
  link: { color: colors.accent, fontSize: 13 },
});
