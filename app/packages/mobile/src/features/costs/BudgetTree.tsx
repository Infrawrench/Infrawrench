import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  buildBudgetTree,
  type BudgetTreeNode,
  type BudgetWithStatus,
} from "@infrawrench/client-core";
import { BudgetCard } from "@/features/dashboard/BudgetCard";
import { colors, spacing } from "@/lib/theme";

/**
 * The org's budgets as the expandable tree web and desktop draw: each parent's
 * card is the rollup of the cards nested under it, so every level shows its
 * own actual and forecast against its own amount. A parent opens by default
 * when it carries a hierarchy warning or a child has fired, so the budget that
 * needs attention is never behind a collapsed row.
 */
export function BudgetTree({ budgets }: { budgets: BudgetWithStatus[] }) {
  return (
    <>
      {buildBudgetTree(budgets).map((node) => (
        <BudgetTreeItem key={node.budget.id} node={node} />
      ))}
    </>
  );
}

function BudgetTreeItem({ node }: { node: BudgetTreeNode }) {
  const { budget, children } = node;
  const needsAttention =
    (budget.hierarchyWarnings?.length ?? 0) > 0 ||
    children.some((c) => c.budget.currentMonthEvents.length > 0);
  const [open, setOpen] = useState(needsAttention);
  return (
    <View style={styles.item}>
      <BudgetCard budget={budget} />
      {children.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((v) => !v)}
            hitSlop={8}
          >
            <Text style={styles.toggle}>
              {open ? "▾" : "▸"} {children.length} child budgets
            </Text>
          </Pressable>
          {open ? (
            <View style={styles.children}>
              {children.map((child) => (
                <BudgetTreeItem key={child.budget.id} node={child} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { gap: spacing.sm },
  toggle: { color: colors.textMuted, fontSize: 13, paddingHorizontal: spacing.xs },
  children: {
    gap: spacing.sm,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
    paddingLeft: spacing.md,
  },
});
