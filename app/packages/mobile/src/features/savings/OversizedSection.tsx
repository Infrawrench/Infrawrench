import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { formatMoney, type OversizedResource } from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { useRightsizing } from "./useRightsizing";

/**
 * "Oversized" — the native counterpart to the web/desktop right-sizing
 * section: machines whose p95 utilisation over the last 14 days sits well
 * under their size, with the recommended smaller size and the live-priced
 * monthly saving.
 *
 * Deliberately read-only here: applying a resize is a provider mutation that
 * usually needs the machine stopped first, and mobile ships no resource
 * editors (the same line that keeps billing read-only). Rows open the
 * resource; the Apply button lives on web and desktop.
 */
export function OversizedSection() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const rightsizing = useRightsizing();
  const data = rightsizing.data ?? null;

  function openResource(resource: OversizedResource) {
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(resource.pluginId)}/${encodeURIComponent(
        resource.resourceTypeId,
      )}/${encodeURIComponent(resource.id)}`,
    );
  }

  return (
    <>
      <SectionTitle>Oversized</SectionTitle>

      {rightsizing.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t compute right-sizing —{" "}
            {rightsizing.error instanceof Error ? rightsizing.error.message : "request failed"}
          </Text>
        </Card>
      ) : rightsizing.isLoading ? (
        <Card>
          <Text style={styles.muted}>Reading stored metrics and size catalogs…</Text>
        </Card>
      ) : data && data.accounts.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            Nothing looks oversized. A machine is flagged when two weeks of stored metrics put its
            p95 CPU (and memory, where measured) well under its size.
          </Text>
        </Card>
      ) : (
        data?.accounts.map((group) => (
          <View key={group.accountId} style={{ gap: spacing.sm }}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupTitle} numberOfLines={1}>
                {group.accountName} <Text style={styles.groupPlugin}>{group.pluginName}</Text>
              </Text>
              <Text style={styles.groupCount}>{group.resources.length} flagged</Text>
            </View>
            <Card list>
              {group.resources.map((r) => (
                <OversizedRow key={r.id} resource={r} onPress={() => openResource(r)} />
              ))}
            </Card>
          </View>
        ))
      )}

      {data !== null && data.accounts.length > 0 && (
        <Text style={styles.footnote}>
          Savings are quoted from each provider&apos;s live size catalog over {data.windowDays} days
          of stored metrics. Apply a resize from the web or desktop app — most providers require the
          machine to be stopped first.
        </Text>
      )}
    </>
  );
}

function OversizedRow({ resource, onPress }: { resource: OversizedResource; onPress: () => void }) {
  const memory =
    resource.memoryMeasured && resource.memoryP95 !== null
      ? `p95 mem ${resource.memoryP95}%`
      : "mem not measured";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {resource.displayName}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {resource.currentSize.label} → {resource.recommendedSize.label} · p95 CPU{" "}
          {resource.cpuP95}% · {memory}
        </Text>
      </View>
      {/* A change without a quotable price shows nothing rather than a zero. */}
      {resource.monthlySaving !== null && (
        <View style={styles.savingCell}>
          <Text style={styles.saving}>
            {formatMoney(resource.monthlySaving, resource.currency)}
          </Text>
          <Text style={styles.savingUnit}>/mo</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  groupHeader: { flexDirection: "row", alignItems: "baseline", gap: spacing.md },
  groupTitle: { color: colors.text, fontSize: 14, fontWeight: "500", flex: 1 },
  groupPlugin: { color: colors.textMuted, fontWeight: "400" },
  groupCount: { color: colors.textFaint, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  savingCell: { alignItems: "flex-end" },
  saving: { color: colors.text, fontSize: 14, fontWeight: "500" },
  savingUnit: { color: colors.textFaint, fontSize: 11 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
