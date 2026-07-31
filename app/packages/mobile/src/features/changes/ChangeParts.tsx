import { StyleSheet, Text, View } from "react-native";
import {
  CHANGE_KIND_LABELS,
  formatChangeValue,
  type ResourceChangeEntry,
  type ResourceChangeKind,
} from "@infrawrench/client-core";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Native counterparts of `@infrawrench/ui`'s `ChangeKindBadge` /
 * `ChangeDiffList`. The wording and the colour coding come from client-core so
 * "Appeared" reads the same on every surface; only the markup differs, because
 * the web parts are `<span>`s with Tailwind classes and this app has no DOM.
 */

const KIND_COLORS: Record<ResourceChangeKind, string> = {
  created: colors.success,
  updated: colors.accent,
  deleted: colors.danger,
};

export function ChangeKindBadge({ kind }: { kind: ResourceChangeKind }) {
  const tint = KIND_COLORS[kind];
  return (
    <View style={[styles.badge, { borderColor: tint }]}>
      <Text style={[styles.badgeText, { color: tint }]}>{CHANGE_KIND_LABELS[kind]}</Text>
    </View>
  );
}

/**
 * Per-field before → after rows for an "updated" event.
 *
 * Stacked rather than laid out on one line: a phone has no room for
 * `field  old → new` side by side once a value is an endpoint or a JSON blob,
 * and `formatChangeValue` already caps a value at 120 characters, so the tall
 * shape is bounded.
 */
export function ChangeDiffList({ entry }: { entry: ResourceChangeEntry }) {
  if (entry.changeKind !== "updated" || entry.diff.length === 0) return null;
  return (
    <View style={{ gap: spacing.sm }}>
      {entry.diff.map((field) => (
        <View key={field.field} style={{ gap: 2 }}>
          <Text style={styles.fieldName}>{field.field}</Text>
          <Text style={styles.fromValue}>{formatChangeValue(field.from)}</Text>
          <Text style={styles.toValue}>→ {formatChangeValue(field.to)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 11, fontWeight: "600" },
  fieldName: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  fromValue: { color: colors.textFaint, fontSize: 12, fontFamily: "monospace" },
  toValue: { color: colors.text, fontSize: 12, fontFamily: "monospace" },
});
