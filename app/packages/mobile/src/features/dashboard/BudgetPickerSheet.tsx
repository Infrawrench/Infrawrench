import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { formatMoney } from "@infrawrench/client-core";
import { Sheet } from "@/components/form";
import { Button, Card, EmptyView, LoadingView, Row } from "@/components/ui";
import { colors } from "@/lib/theme";
import { useBudgets } from "./useBudgets";

/**
 * Add a card for a budget that already exists. A budget is org-level and can
 * sit on several dashboards at once, so the ones already on this dashboard are
 * filtered out rather than offered twice.
 */
export function BudgetPickerSheet({
  visible,
  placedBudgetIds,
  onPick,
  onClose,
}: {
  visible: boolean;
  placedBudgetIds: ReadonlySet<string>;
  onPick: (budgetId: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const budgets = useBudgets(visible);
  const [adding, setAdding] = useState<string | null>(null);

  const rows = [...(budgets.data?.values() ?? [])].filter((b) => !placedBudgetIds.has(b.id));

  async function add(budgetId: string, name: string) {
    setAdding(budgetId);
    try {
      await onPick(budgetId, name);
      onClose();
    } catch {
      // Already reported by the mutation; leave the sheet open.
    } finally {
      setAdding(null);
    }
  }

  return (
    <Sheet
      visible={visible}
      title="Existing budget"
      onClose={onClose}
      footer={<Button label="Cancel" variant="secondary" onPress={onClose} />}
    >
      {budgets.isLoading ? (
        <LoadingView />
      ) : rows.length === 0 ? (
        <EmptyView message="Every budget in this organization is already on this dashboard." />
      ) : (
        <Card list>
          {rows.map((b) => (
            <Row
              key={b.id}
              title={b.name}
              subtitle={`${formatMoney(b.amountCents / 100, b.currency)} per month`}
              {...(adding ? {} : { onPress: () => void add(b.id, b.name) })}
              {...(adding === b.id ? { right: <ActivityIndicator color={colors.accent} /> } : {})}
            />
          ))}
        </Card>
      )}
    </Sheet>
  );
}
