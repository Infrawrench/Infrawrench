import { StyleSheet, Text, View } from "react-native";
import {
  formatMoney,
  showbackCentreHasChildren,
  taggedSpendPercent,
  type AccountTagCompliance,
  type ShowbackReportCentre,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useShowback, useTagCompliance, useUntaggedSpend } from "./useTagGovernance";

/** "$1,234 + €900", or an em dash when the bucket is empty. */
function formatTotals(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "—";
  return entries.map(([currency, amount]) => formatMoney(amount, currency)).join(" + ");
}

/**
 * Native counterpart to the tag governance section on web and desktop:
 * per-account compliance with the org tag policy and the share of spend
 * missing a required tag key. Read-only — the policy and allocation rules
 * are edited in the web app's org settings, the same deliberate omission as
 * anomaly threshold tuning.
 */
export function TagGovernanceSection() {
  const compliance = useTagCompliance();
  const untaggedQuery = useUntaggedSpend();
  const untagged = untaggedQuery.data ?? null;
  const showbackQuery = useShowback();
  const showbackCentres = showbackQuery.data?.centres ?? [];

  const policy = compliance.data?.policy;
  const hasPolicy = (policy?.requiredTags.length ?? 0) > 0;

  // No policy configured *and* nothing allocated: stay quiet rather than
  // advertising an empty report. An org with a centre tree but no tag policy
  // still gets its showback.
  if (!compliance.isLoading && !compliance.isError && !hasPolicy && showbackCentres.length === 0) {
    return null;
  }

  return (
    <>
      {showbackCentres.length > 0 && (
        <>
          <SectionTitle>Showback</SectionTitle>
          <Card list>
            {showbackCentres.map((centre) => (
              <ShowbackRow
                key={centre.costCentreId ?? "__unallocated__"}
                centre={centre}
                hasChildren={showbackCentreHasChildren(showbackCentres, centre)}
              />
            ))}
          </Card>
          <Text style={styles.footnote}>
            Last 30 days. A parent shows its whole subtree; cost centres are created and moved from
            the web app under Settings → Cost Centres.
          </Text>
        </>
      )}

      {/* Hidden entirely for an org with a centre tree but no tag policy —
          an empty compliance card is worse than no card. */}
      {(hasPolicy || compliance.isLoading || compliance.isError) && (
        <>
          <SectionTitle>Tag compliance</SectionTitle>

          {compliance.isError ? (
            <Card>
              <Text style={styles.error}>
                Couldn&apos;t load tag compliance —{" "}
                {compliance.error instanceof Error ? compliance.error.message : "request failed"}
              </Text>
            </Card>
          ) : compliance.isLoading ? (
            <Card>
              <Text style={styles.muted}>Loading tag compliance…</Text>
            </Card>
          ) : (
            <>
              {untagged !== null && untagged.currencies.length > 0 && (
                <Card>
                  <Text style={styles.untaggedTitle}>
                    Untagged spend · last 30 days · requires {untagged.requiredKeys.join(", ")}
                  </Text>
                  {untagged.currencies.map((currency) => {
                    const pct = taggedSpendPercent(untagged, currency);
                    return (
                      <View key={currency} style={styles.untaggedRow}>
                        <Text style={styles.untaggedAmount}>
                          {formatMoney(untagged.untaggedTotals[currency] ?? 0, currency)}
                          <Text style={styles.muted}>
                            {" "}
                            of {formatMoney(untagged.totals[currency] ?? 0, currency)}
                          </Text>
                        </Text>
                        {pct !== null && <Text style={styles.pct}>{pct}% tagged</Text>}
                      </View>
                    );
                  })}
                </Card>
              )}

              <Card list>
                {(compliance.data?.accounts ?? []).map((account) => (
                  <ComplianceRow key={account.accountId} account={account} />
                ))}
              </Card>

              <Text style={styles.footnote}>
                Required tags and enforcement are per organization; edit the policy from the web app
                under Settings → Tag Policy.
              </Text>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * One row of the showback tree. A parent shows its subtree total — the number
 * "what does Engineering cost" is asking for — with its own directly-allocated
 * spend underneath; a leaf shows the one number it has. Indentation is the only
 * tree affordance: the phone is read-only here.
 */
function ShowbackRow({
  centre,
  hasChildren,
}: {
  centre: ShowbackReportCentre;
  hasChildren: boolean;
}) {
  const unallocated = centre.costCentreId === null;
  return (
    <View style={[styles.row, { paddingLeft: centre.depth * 14 }]}>
      <View style={styles.rowMain}>
        <Text style={unallocated ? styles.unallocated : styles.title} numberOfLines={1}>
          {centre.name}
        </Text>
        {hasChildren && (
          <Text style={styles.subtitle} numberOfLines={1}>
            of which its own {formatTotals(centre.totals)}
          </Text>
        )}
      </View>
      <Text style={styles.amount}>
        {formatTotals(hasChildren ? centre.subtreeTotals : centre.totals)}
      </Text>
    </View>
  );
}

function ComplianceRow({ account }: { account: AccountTagCompliance }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {account.displayName}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {account.score === null
            ? "No taggable resources"
            : `${account.compliant} of ${account.evaluated} resources fully tagged`}
        </Text>
      </View>
      {account.score !== null && (
        <Text
          style={[
            styles.score,
            {
              color:
                account.score >= 90
                  ? colors.success
                  : account.score >= 50
                    ? colors.warning
                    : colors.danger,
            },
          ]}
        >
          {account.score}%
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  score: { fontSize: 15, fontWeight: "600" },
  untaggedTitle: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.sm },
  untaggedRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  untaggedAmount: { color: colors.text, fontSize: 15, fontWeight: "600" },
  pct: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted, fontSize: 13 },
  amount: { color: colors.textMuted, fontSize: 14, fontWeight: "500" },
  unallocated: { color: colors.textMuted, fontSize: 15, fontStyle: "italic" },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
