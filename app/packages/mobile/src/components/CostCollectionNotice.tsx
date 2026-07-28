import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import {
  emptyCostAccounts,
  failingCostAccounts,
  type CostAccountStatus,
} from "@infrawrench/client-core";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Native counterpart to the web/desktop `CostCollectionNotice`. Explains why
 * budgets and cost graphs are empty, for both states that produce a blank
 * chart: collection that is failing (with the provider's fix deep-linked when
 * the plugin reported one), and collection that succeeds but has no spend to
 * report yet. Renders nothing when every account is collecting data.
 */
export function CostCollectionNotice({ statuses }: { statuses: CostAccountStatus[] }) {
  const failing = failingCostAccounts(statuses);
  const empty = emptyCostAccounts(statuses);
  if (failing.length === 0 && empty.length === 0) return null;

  return (
    <>
      {failing.length > 0 && (
        <View style={styles.box}>
          <Text style={styles.heading}>
            {failing.length === 1
              ? `Cost collection is failing for ${failing[0]!.displayName}`
              : `Cost collection is failing for ${failing.length} accounts`}
          </Text>
          {failing.map((s) => (
            <View key={s.accountId} style={styles.item}>
              <Text style={styles.message}>
                {failing.length > 1 ? `${s.displayName} — ` : ""}
                {s.costPollError!.message}
              </Text>
              {s.costPollError!.helpLink && (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(s.costPollError!.helpLink!.url)}
                >
                  <Text style={styles.link}>{s.costPollError!.helpLink!.label} ↗</Text>
                </Pressable>
              )}
            </View>
          ))}
          <Text style={styles.footnote}>
            Collection retries on its own — fix the cause and the next run backfills the gap.
          </Text>
        </View>
      )}

      {empty.length > 0 && (
        <View style={styles.neutralBox}>
          <Text style={styles.neutralHeading}>
            {empty.length === 1
              ? `No spend data yet for ${empty[0]!.displayName}`
              : `No spend data yet for ${empty.length} accounts`}
          </Text>
          {empty.length > 1 &&
            empty.map((s) => (
              <Text key={s.accountId} style={styles.message}>
                {s.displayName}
              </Text>
            ))}
          <Text style={styles.footnote}>
            Collection ran without error — the provider just hasn&apos;t reported any spend. A
            billing export enabled in the last day or two often has no rows to return yet.
          </Text>
        </View>
      )}
    </>
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
  neutralBox: {
    backgroundColor: colors.surfaceOverlay,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  heading: { color: colors.warning, fontSize: 14, fontWeight: "600" },
  neutralHeading: { color: colors.text, fontSize: 14, fontWeight: "600" },
  item: { gap: 2 },
  message: { color: colors.textSecondary, fontSize: 13 },
  link: { color: colors.accent, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
