import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  isCostsPanelTab,
  type CostGraphConfig,
  type CostsPanelTab,
} from "@infrawrench/client-core";
import { CostCollectionNotice } from "@/components/CostCollectionNotice";
import { CostVisibilityNotice } from "@/components/CostVisibilityNotice";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
  TabStrip,
} from "@/components/ui";
import { CarbonSection } from "@/features/costs/CarbonSection";
import { CommitmentsSection } from "@/features/costs/CommitmentsSection";
import { CostAnomaliesSection } from "@/features/costs/CostAnomaliesSection";
import { CostChangeAlertsSection } from "@/features/costs/CostChangeAlertsSection";
import { EfficiencyAlertsSection } from "@/features/costs/EfficiencyAlertsSection";
import { TagGovernanceSection } from "@/features/costs/TagGovernanceSection";
import { UnitCostsSection } from "@/features/costs/UnitCostsSection";
import { BudgetTree } from "@/features/costs/BudgetTree";
import { CostGraphCard } from "@/features/dashboard/CostGraphCard";
import { useBudgets } from "@/features/dashboard/useBudgets";
import { useCostStatus } from "@/features/dashboard/useCostStatus";
import { ExtendedSupportSection } from "@/features/savings/ExtendedSupportSection";
import { OversizedSection } from "@/features/savings/OversizedSection";
import { SavingsSection } from "@/features/savings/SavingsSection";
import { SchedulesSection } from "@/features/schedules/SchedulesSection";
import { RealizedSavingsSection } from "@/features/savings/RealizedSavingsSection";

/**
 * The org's spend, budgets, anomalies, and potential savings; the Costs panel
 * of web and desktop, split into the same tabs (minus Network).
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
/** Mobile has no network tab: flow collection is set up on web or desktop. */
const TABS: ReadonlyArray<{ id: CostsPanelTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "savings", label: "Savings" },
  { id: "commitments", label: "Commitments" },
  { id: "carbon", label: "Carbon" },
  { id: "allocation", label: "Allocation" },
];

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
  const router = useRouter();
  const queryClient = useQueryClient();
  const { orgId } = useOrgApi();
  const budgets = useBudgets();
  const costStatus = useCostStatus();
  // A push names the tab holding the section it is about.
  const params = useLocalSearchParams<{ tab?: string }>();
  const linkedTab =
    isCostsPanelTab(params.tab) && TABS.some((t) => t.id === params.tab) ? params.tab : null;
  const [tab, setTab] = useState<CostsPanelTab>(linkedTab ?? "overview");
  // A second push while the screen is open changes the param, not the mount.
  useEffect(() => {
    if (linkedTab) setTab(linkedTab);
  }, [linkedTab]);

  const rows = useMemo(() => [...(budgets.data?.values() ?? [])], [budgets.data]);

  return (
    <Screen
      onRefresh={() => {
        void budgets.refetch();
        void queryClient.invalidateQueries({ queryKey: ["cost-status"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-query"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-anomalies"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-alerts"] });
        void queryClient.invalidateQueries({ queryKey: ["cost-alert-events"] });
        void queryClient.invalidateQueries({ queryKey: ["efficiency-alerts"] });
        void queryClient.invalidateQueries({ queryKey: ["commitments"] });
        void queryClient.invalidateQueries({ queryKey: ["tag-compliance"] });
        void queryClient.invalidateQueries({ queryKey: ["business-metrics"] });
        void queryClient.invalidateQueries({ queryKey: ["unit-costs"] });
        void queryClient.invalidateQueries({ queryKey: ["untagged-spend"] });
        void queryClient.invalidateQueries({ queryKey: ["orphans"] });
        void queryClient.invalidateQueries({ queryKey: ["rightsizing"] });
        void queryClient.invalidateQueries({ queryKey: ["extended-support"] });
        void queryClient.invalidateQueries({ queryKey: ["schedules"] });
        void queryClient.invalidateQueries({ queryKey: ["carbon"] });
        void queryClient.invalidateQueries({ queryKey: ["realized-savings"] });
      }}
      refreshing={budgets.isRefetching}
    >
      <CostVisibilityNotice />
      <CostCollectionNotice statuses={costStatus.data ?? []} />

      <TabStrip tabs={TABS} value={tab} onChange={setTab} />

      {tab === "overview" && (
        <>
          <SectionTitle>This month</SectionTitle>
          <CostGraphCard title="Month to date" config={OVERVIEW_CONFIG} />

          {/*
            Reports are their own page, not a section: the list can be long, and a
            report is an object you navigate to rather than a summary you scan.
          */}
          <Card list>
            <Row
              title="Cost reports"
              subtitle="Saved cost graphs, shared across dashboards"
              onPress={() => router.push(`/org/${orgId}/cost-reports`)}
            />
            <Row
              title="Canvases"
              subtitle="Reports built from a description, refreshed on open"
              onPress={() => router.push(`/org/${orgId}/cost-canvases`)}
            />
          </Card>

          <SectionTitle>Budgets</SectionTitle>
          {budgets.isLoading ? (
            <LoadingView />
          ) : budgets.isError ? (
            <ErrorView
              message={budgets.error instanceof Error ? budgets.error.message : "Failed to load"}
              onRetry={() => void budgets.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyView message="No budgets yet. Add one from a dashboard card (New budget) to track spend and get alerted before the bill does." />
          ) : (
            <BudgetTree budgets={rows} />
          )}
        </>
      )}

      {/* Same grouping and order as the web/desktop tabs. */}
      {tab === "alerts" && (
        <>
          <CostAnomaliesSection />
          <CostChangeAlertsSection />
          <EfficiencyAlertsSection />
        </>
      )}

      {tab === "savings" && (
        <>
          <SavingsSection />
          <OversizedSection />
          <ExtendedSupportSection />
          <SchedulesSection />
          <RealizedSavingsSection />
        </>
      )}

      {tab === "commitments" && <CommitmentsSection />}

      {tab === "carbon" && <CarbonSection />}

      {tab === "allocation" && (
        <>
          <UnitCostsSection />
          <TagGovernanceSection />
        </>
      )}
    </Screen>
  );
}
