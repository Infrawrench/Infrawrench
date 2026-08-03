import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CostGraphConfig } from "@infrawrench/client-core";
import { CostCollectionNotice } from "@/components/CostCollectionNotice";
import { EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { CostAnomaliesSection } from "@/features/costs/CostAnomaliesSection";
import { TagGovernanceSection } from "@/features/costs/TagGovernanceSection";
import { BudgetCard } from "@/features/dashboard/BudgetCard";
import { CostGraphCard } from "@/features/dashboard/CostGraphCard";
import { useBudgets } from "@/features/dashboard/useBudgets";
import { useCostStatus } from "@/features/dashboard/useCostStatus";
import { SavingsSection } from "@/features/savings/SavingsSection";
import { SchedulesSection } from "@/features/schedules/SchedulesSection";

/**
 * The org's spend, budgets, anomalies, and potential savings — the Costs panel
 * of web and desktop, in the same order, so the four sections answer one
 * question together: what is this org spending, what did we promise to spend,
 * what changed unexpectedly, and what of it is wasted.
 *
 * This is where a budget lives, independent of any dashboard: it keeps
 * evaluating and alerting whether or not a dashboard shows it, so a budget push
 * always has somewhere to land even when its card has been removed. Read-only
 * here, as on web: a budget is created and edited from a dashboard card, and
 * this panel is the org-wide list of what exists.
 *
 * Each section owns its own query and its own failure. A budgets fetch that
 * fails must not blank the screen: a `cost_anomaly` push deep-links here, and
 * the anomaly it is about has to be readable regardless of what else on the
 * tab is having a bad day.
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

  return (
    <Screen
      onRefresh={() => {
        void budgets.refetch();
        void queryClient.invalidateQueries({ queryKey: ["cost-status"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-query"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-anomalies"] });
        void queryClient.invalidateQueries({ queryKey: ["tag-compliance"] });
        void queryClient.invalidateQueries({ queryKey: ["untagged-spend"] });
        void queryClient.invalidateQueries({ queryKey: ["orphans"] });
        void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      }}
      refreshing={budgets.isRefetching}
    >
      <CostCollectionNotice statuses={costStatus.data ?? []} />

      <SectionTitle>This month</SectionTitle>
      <CostGraphCard title="Month to date" config={OVERVIEW_CONFIG} />

      <SectionTitle>Budgets</SectionTitle>
      {budgets.isLoading ? (
        <LoadingView />
      ) : budgets.isError ? (
        <ErrorView
          message={budgets.error instanceof Error ? budgets.error.message : "Failed to load"}
          onRetry={() => void budgets.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyView message="No budgets yet. Add one from a dashboard — edit it, add a card, and pick New budget — to track a monthly amount and get alerted before the bill does." />
      ) : (
        rows.map((b) => <BudgetCard key={b.id} budget={b} />)
      )}

      <TagGovernanceSection />

      <CostAnomaliesSection />

      <SavingsSection />

      <SchedulesSection />
    </Screen>
  );
}
