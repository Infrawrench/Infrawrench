import { Children, Fragment, isValidElement, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, radii, spacing } from "@/lib/theme";

/** Scrollable screen container with pull-to-refresh. */
export function Screen({
  children,
  onRefresh,
  refreshing = false,
  style,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[{ padding: spacing.lg, gap: spacing.md }, style]}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

/**
 * Flatten children to the list a separator run cares about.
 *
 * `Children.toArray` already flattens mapped arrays and drops the `null`s and
 * `false`s that conditional children render, but it treats a Fragment as a
 * single child — and a row list assembled inside a ternary is usually wrapped
 * in one. Recursing means call sites don't have to know that.
 */
function flattenChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement(child) && child.type === Fragment
      ? flattenChildren((child.props as { children?: ReactNode }).children)
      : [child],
  );
}

/** Interleave hairlines between siblings — between only, never trailing. */
function withSeparators(children: ReactNode): ReactNode[] {
  return flattenChildren(children).map((child, i) => (
    <Fragment key={i}>
      {i > 0 && <View style={styles.separator} />}
      {child}
    </Fragment>
  ));
}

/**
 * Surface container. Pass `list` when the card holds nothing but a run of
 * `Row`s: it then drops its vertical padding and inter-child gap and draws the
 * separators itself.
 *
 * Separators belong to the container because only the container knows which
 * row is last — when `Row` drew its own bottom border every list ended with a
 * hairline dangling above the card's border. Dropping the vertical padding
 * matters for the same reason: card padding *plus* the first row's own padding
 * stacked into a conspicuous gap above the first row, and the gap between rows
 * left the separator sitting closer to the row above it than the row below.
 */
export function Card({
  children,
  list = false,
  style,
}: {
  children: ReactNode;
  list?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  if (!list) return <View style={[styles.card, style]}>{children}</View>;
  return <View style={[styles.card, styles.cardList, style]}>{withSeparators(children)}</View>;
}

/**
 * A run of `Row`s with separators between them, for cards that hold other
 * content too (a `SectionTitle`, a trailing `Button`) and so can't be `list`.
 */
export function RowGroup({ children }: { children: ReactNode }) {
  return <View>{withSeparators(children)}</View>;
}

/**
 * A standalone hairline, for the cards that use a single `Row` as a header
 * above other content and want a rule under it.
 */
export function Separator() {
  return <View style={styles.separator} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({
  title,
  subtitle,
  right,
  onPress,
}: {
  title: string;
  subtitle?: string | undefined;
  right?: ReactNode | undefined;
  onPress?: (() => void) | undefined;
}) {
  const content = (
    <>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </>
  );
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {content}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.buttonText, variant === "secondary" && { color: colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function LoadingView() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
      <Text style={{ color: colors.danger, textAlign: "center", marginBottom: spacing.md }}>
        {message}
      </Text>
      {onRetry && <Button label="Retry" variant="secondary" onPress={onRetry} />}
    </View>
  );
}

export function EmptyView({ message }: { message: string }) {
  return (
    <View style={styles.center}>
      <Text style={{ color: colors.textMuted, textAlign: "center" }}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardList: { paddingVertical: 0, gap: 0 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  rowSubtitle: { color: colors.textMuted, fontSize: 12 },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.sm,
    alignItems: "center",
    alignSelf: "flex-start",
  },
  buttonSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  buttonDanger: { backgroundColor: colors.danger },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
});
