import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CostGraphConfig } from "@infrawrench/client-core";
import { CostCollectionNotice } from "@/components/CostCollectionNotice";
import { EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { BudgetCard } from "@/features/dashboard/BudgetCard";
import { CostGraphCard } from "@/features/dashboard/CostGraphCard";
import { useBudgets } from "@/features/dashboard/useBudgets";
import { useCostStatus } from "@/features/dashboard/useCostStatus";

/**
 * The org's spend and budgets, mirroring the Costs panel on web and desktop.
 *
 * This is where a budget lives, independent of any dashboard: it keeps
 * evaluating and alerting whether or not a dashboard shows it, so a budget push
 * always has somewhere to land even when its card has been removed. Read-only
 * here, as on web: a budget is created and edited from a dashboard card, and
 * this panel is the org-wide list of what exists.
 */
const OVERVIEW_CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "relative", preset: "mtd" },
  groupBy: "provider",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: true,
};

export default function CostsScreen() {
  const queryClient = useQueryClient();
  const budgets = useBudgets();
  const costStatus = useCostStatus();

  const rows = useMemo(() => [...(budgets.data?.values() ?? [])], [budgets.data]);

  if (budgets.isLoading) return <LoadingView />;
  if (budgets.isError) {
    return (
      <ErrorView
        message={budgets.error instanceof Error ? budgets.error.message : "Failed to load"}
        onRetry={() => void budgets.refetch()}
      />
    );
  }

  return (
    <Screen
      onRefresh={() => {
        void budgets.refetch();
        void queryClient.invalidateQueries({ queryKey: ["cost-status"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-query"] });
      }}
      refreshing={budgets.isRefetching}
    >
      <CostCollectionNotice statuses={costStatus.data ?? []} />

      <SectionTitle>This month</SectionTitle>
      <CostGraphCard title="Month to date" config={OVERVIEW_CONFIG} />

      <SectionTitle>Budgets</SectionTitle>
      {rows.length === 0 ? (
        <EmptyView message="No budgets yet. Add one from a dashboard — edit it, add a card, and pick New budget — to track a monthly amount and get alerted before the bill does." />
      ) : (
        rows.map((b) => <BudgetCard key={b.id} budget={b} />)
      )}
    </Screen>
  );
}
