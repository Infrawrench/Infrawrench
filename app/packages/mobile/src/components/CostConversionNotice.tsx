import { StyleSheet, Text, View } from "react-native";
import type { CostConversion } from "@infrawrench/client-core";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Native counterpart to the web/desktop `CostConversionNotice`.
 *
 * The mobile app is read-only for this feature — there is no native rate
 * editor, and that is a deliberate omission (see KNOWLEDGE.md's list, alongside
 * read-only billing): stating an exchange rate is a finance-governance act
 * gated on `org:settings:write`, done once a period against an accounting
 * system that is not on a phone. What mobile must not do is show a converted
 * total without the caveat, which is what this component is for.
 *
 * Renders nothing when nothing was converted, so every org that has not opted
 * in sees exactly what it saw before.
 */
export function CostConversionNotice({ conversion }: { conversion?: CostConversion | undefined }) {
  if (!conversion) return null;
  const { displayCurrency, converted, unconverted } = conversion;
  if (converted.length === 0 && unconverted.length === 0) return null;

  return (
    <>
      {converted.length > 0 && (
        <View style={styles.neutralBox}>
          <Text style={styles.neutralHeading}>Amounts are converted to {displayCurrency}</Text>
          {converted.map((entry) => (
            <Text key={entry.currency} style={styles.message}>
              {entry.currency} → {displayCurrency}{" "}
              {entry.rates.map((r) => `${r.rate} from ${r.effectiveFrom}`).join(", ")}
              {entry.rates.length > 1 ? " (rate changed mid-period)" : ""}
            </Text>
          ))}
          <Text style={styles.footnote}>
            These are your organization&apos;s own rates, set in Settings → Currency on the web or
            desktop app. Infrawrench does not fetch live exchange rates. Spend already in{" "}
            {displayCurrency} is not converted.
          </Text>
        </View>
      )}

      {unconverted.length > 0 && (
        <View style={styles.box}>
          <Text style={styles.heading}>
            {unconverted.length === 1
              ? `Spend in ${unconverted[0]} is not included in the ${displayCurrency} figure`
              : `Spend in ${unconverted.length} currencies is not included in the ${displayCurrency} figure`}
          </Text>
          {unconverted.length > 1 &&
            unconverted.map((currency) => (
              <Text key={currency} style={styles.message}>
                {currency}
              </Text>
            ))}
          <Text style={styles.footnote}>
            No exchange rate is configured for {unconverted.length === 1 ? "it" : "them"}, or none
            covers every day in this range, so the amounts are shown separately in their own
            currency rather than folded in or dropped.
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
  message: { color: colors.textSecondary, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
