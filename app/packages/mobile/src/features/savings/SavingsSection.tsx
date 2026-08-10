import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { formatMoney, type OrphanedResource } from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { useOrphans } from "./useOrphans";

/**
 * "Potential savings" — the native counterpart to `SavingsSection` on web and
 * desktop. Resources a provider plugin's orphan heuristic flagged (unattached
 * volumes, unassigned IPs), grouped by account, each with the plugin's reason
 * and, where the org collects per-resource billing rows, trailing spend.
 *
 * It sits on the Costs tab under the month-to-date chart and budgets rather
 * than on a tab of its own, exactly as on the other two surfaces: spend and
 * waste answer one question, and a separate tab made people go looking.
 */
export function SavingsSection() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const orphans = useOrphans();
  const data = orphans.data ?? null;

  // `costBasis: "unavailable"` is a local-desktop-mode signal the web API never
  // emits — but it is part of the contract, and a column of blanks reads as
  // "this costs nothing", so honour it here too rather than assume.
  const showCost = data !== null && data.costBasis !== "unavailable";
  // Ownership is a cloud record, and `costBasis: "unavailable"` marks the one
  // store that has none. Mobile is cloud-only, but the signal is part of the
  // contract, so honour it rather than label every row "Unowned".
  const showOwner = showCost;

  function openResource(resource: OrphanedResource) {
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(resource.pluginId)}/${encodeURIComponent(
        resource.resourceTypeId,
      )}/${encodeURIComponent(resource.id)}`,
    );
  }

  return (
    <>
      <SectionTitle>Potential savings</SectionTitle>

      {orphans.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load potential savings —{" "}
            {orphans.error instanceof Error ? orphans.error.message : "request failed"}
          </Text>
        </Card>
      ) : orphans.isLoading ? (
        <Card>
          <Text style={styles.muted}>Scanning synced resources…</Text>
        </Card>
      ) : data && data.accounts.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            Nothing looks wasted right now. Resources are flagged when a provider plugin&apos;s
            heuristic matches — unattached volumes, unassigned IPs — so an empty list is the good
            outcome.
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
                <OrphanRow
                  key={r.id}
                  resource={r}
                  showCost={showCost}
                  showOwner={showOwner}
                  costWindowDays={data.costWindowDays}
                  onPress={() => openResource(r)}
                />
              ))}
            </Card>
          </View>
        ))
      )}

      {data !== null && data.accounts.length > 0 && (
        <Text style={styles.footnote}>
          {showCost
            ? `Cost figures are best-effort, matched from collected per-resource billing rows over the last ${data.costWindowDays} days; most providers don't report cost at resource granularity.`
            : "No cost figures here — the flags themselves never depend on billing data."}{" "}
          {showOwner && data.unownedCount > 0
            ? `${data.unownedCount} of ${data.totalCount} have no recorded owner. `
            : ""}
          Confirm a resource really is unused before deleting it.
        </Text>
      )}
    </>
  );
}

function OrphanRow({
  resource,
  showCost,
  showOwner,
  costWindowDays,
  onPress,
}: {
  resource: OrphanedResource;
  showCost: boolean;
  showOwner: boolean;
  costWindowDays: number;
  onPress: () => void;
}) {
  // A resource with no matching billing rows shows nothing rather than a zero:
  // "no per-resource cost rows for this" is not "this is free".
  const cost = showCost ? resource.cost : null;
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
          {resource.resourceTypeName} · {resource.reason}
        </Text>
        {showOwner && (
          // "Unowned" is rendered rather than omitted: it is the finding, and a
          // missing line on a phone reads as "not loaded" rather than "nobody
          // has claimed this".
          <Text style={resource.owner ? styles.owner : styles.unowned} numberOfLines={1}>
            {resource.owner
              ? `${resource.owner.displayName}${resource.owner.isLabel ? " (team)" : ""}`
              : "Unowned"}
          </Text>
        )}
      </View>
      {cost && (
        <View style={styles.costCell}>
          <Text style={styles.cost}>{formatMoney(cost.amount, cost.currency)}</Text>
          <Text style={styles.costWindow}>/ {costWindowDays}d</Text>
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
  owner: { color: colors.textMuted, fontSize: 12 },
  unowned: { color: colors.textFaint, fontSize: 12, fontStyle: "italic" },
  costCell: { alignItems: "flex-end" },
  cost: { color: colors.text, fontSize: 14, fontWeight: "500" },
  costWindow: { color: colors.textFaint, fontSize: 11 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
