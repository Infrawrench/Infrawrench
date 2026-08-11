import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { Modal } from "../components/Modal.js";
import { SavingsSection } from "../savings/SavingsSection.js";
import { OversizedSection } from "../savings/OversizedSection.js";
import { CreditBurndownSection } from "./CreditBurndownSection.js";
import { CommitmentsSection } from "./CommitmentsSection.js";
import { NetworkFlowSection } from "./NetworkFlowSection.js";
import type {
  OrphanedResource,
  OrphansClient,
  OversizedResource,
  RightsizingClient,
} from "../savings/types.js";
import { SleepSchedulesSection } from "../schedules/SleepSchedulesSection.js";
import type { SchedulesClient, SleepSchedule } from "../schedules/types.js";
import { BudgetCard } from "./BudgetCard.js";
import { CostAnomaliesSection } from "./CostAnomaliesSection.js";
import { CostChangeAlertsSection } from "./CostChangeAlertsSection.js";
import { EfficiencyAlertsSection } from "./EfficiencyAlertsSection.js";
import { TagGovernanceSection } from "./TagGovernanceSection.js";
import { SavedFiltersSection } from "./SavedFiltersSection.js";
import { ScenarioModelsSection } from "./ScenarioModelsSection.js";
import { UnitCostsSection } from "./UnitCostsSection.js";
import { BudgetConfigModal, DEFAULT_BUDGET_INPUT } from "./BudgetConfigModal.js";
import { CostGraphCard } from "./CostGraphCard.js";
import { CostCollectionNotice } from "./CostCollectionNotice.js";
import { DEFAULT_COST_GRAPH_CONFIG, DIMENSION_LABELS } from "./CostGraphConfigModal.js";
import type { BudgetInput, CostAccountStatus, CostDimensionId, CostGraphConfig } from "./config.js";
import type { BudgetWithStatus, CostsClient, CostsPanelDashboard } from "./types.js";

/**
 * The overview chart is deliberately not configurable the way a dashboard cost
 * graph is: it answers "what is this org spending right now", and the only
 * choice worth offering is what to break it down by. Anything more belongs on a
 * dashboard, where it can be saved.
 */
const OVERVIEW_GROUP_BYS: CostDimensionId[] = ["provider", "account", "service"];

function overviewConfig(groupBy: CostDimensionId, adjusted: boolean): CostGraphConfig {
  return {
    ...DEFAULT_COST_GRAPH_CONFIG,
    chartType: "stacked_bar",
    binning: "daily",
    dateRange: { kind: "relative", preset: "mtd" },
    groupBy,
    showForecast: true,
    // Omitted rather than sent as `false`: the request an unadjusted overview
    // issues stays byte-identical to the one it always issued, and the card's
    // "Adjusted" caption is driven by the response, not by this flag.
    ...(adjusted ? { adjusted: true } : {}),
  };
}

function budgetToInput(budget: BudgetWithStatus): BudgetInput {
  return {
    name: budget.name,
    amountCents: budget.amountCents,
    currency: budget.currency,
    filters: budget.filters,
    thresholds: budget.thresholds,
    // Round-tripped, or editing a budget's name would quietly move it back to
    // the cash basis it was deliberately taken off.
    ...(budget.costBasis ? { costBasis: budget.costBasis } : {}),
    // Same rule: a rename must not silently detach the saved filter scoping
    // this budget — updates are full replaces.
    ...(budget.savedFilterId ? { savedFilterId: budget.savedFilterId } : {}),
  };
}

function placementSummary(budget: BudgetWithStatus): string {
  const count = budget.placements.length;
  if (count === 0) return "On no dashboard";
  if (count === 1) return `On ${budget.placements[0]!.dashboardName}`;
  return `On ${count} dashboards`;
}

export interface CostsPanelProps {
  client: CostsClient;
  /** Open a dashboard by id — the placement list links to them. */
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
  /**
   * Data access for the "Potential savings" section. Omitted when the host
   * can't answer the query at all — desktop in local-only mode has no org to
   * classify — and the section is then left out rather than shown empty.
   */
  orphans?: OrphansClient | undefined;
  /** Open a flagged resource's detail view from the savings section. */
  onOpenResource?: ((resource: OrphanedResource, accountId: string) => void) | undefined;
  /**
   * Data access for the "Oversized" right-sizing section. Cloud-only — the
   * percentiles live in the metrics warehouse — so desktop leaves it off in
   * local mode, same rule as schedules.
   */
  rightsizing?: RightsizingClient | undefined;
  /** Open an oversized resource's detail view. */
  onOpenOversizedResource?: ((resource: OversizedResource, accountId: string) => void) | undefined;
  /**
   * Data access for the "Sleep schedules" section. Omitted when the host has
   * no schedule store (desktop in local-only mode) — the section is then left
   * out rather than shown empty.
   */
  schedules?: SchedulesClient | undefined;
  /** Open a scheduled resource's detail view from the schedules section. */
  onOpenScheduledResource?: ((schedule: SleepSchedule) => void) | undefined;
  /**
   * Open a URL outside the app shell — new tab on web, system browser on
   * desktop. Used by the credit burndown section for the provider's top-up
   * page and for the "your key can't see this balance" help link.
   */
  onOpenExternal?: ((url: string) => void) | undefined;
}

/**
 * Org-level home for spend, budgets and waste, a sibling of the Agents and
 * Workflows panels.
 *
 * A budget is an org object, not a dashboard object: it keeps evaluating and
 * alerting whether or not any dashboard shows it. Before this panel existed the
 * only way to reach one was to find a dashboard carrying its card, so removing
 * the card made a still-firing budget unreachable. Dashboard cards are now
 * views onto the rows listed here, and each row says which dashboards it
 * appears on.
 */
export function CostsPanel({
  client,
  onOpenDashboard,
  orphans,
  onOpenResource,
  rightsizing,
  onOpenOversizedResource,
  schedules,
  onOpenScheduledResource,
  onOpenExternal,
}: CostsPanelProps) {
  const uid = useId();
  const [budgets, setBudgets] = useState<BudgetWithStatus[] | null>(null);
  const [statuses, setStatuses] = useState<CostAccountStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<CostDimensionId>("provider");
  /**
   * Raw by default, always. The overview is the number people quote, and the
   * one they check against an invoice; showing it marked up because somebody in
   * Settings wrote a rule would make it a number nobody could reconcile. The
   * toggle only appears for an org that actually has rules — an org with none
   * would be offered a switch between two identical figures.
   */
  const [adjusted, setAdjusted] = useState(false);
  const [hasBillingRules, setHasBillingRules] = useState(false);
  const [editing, setEditing] = useState<{ budget: BudgetWithStatus | null } | null>(null);
  const [placing, setPlacing] = useState<BudgetWithStatus | null>(null);

  const canWrite = Boolean(client.createBudget && client.updateBudget && client.deleteBudget);
  const canPlace = Boolean(client.addBudgetToDashboard && client.removeBudgetPlacement);

  const refresh = useCallback(async () => {
    // A failure here has to be visible: an empty budget list and a broken
    // budget list look identical, and one of them means alerts you think you
    // have configured are not being shown to you.
    try {
      setBudgets(await client.listBudgets());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client.listBillingRules) return;
    let cancelled = false;
    client
      .listBillingRules()
      .then((next) => {
        if (!cancelled) setHasBillingRules(next.some((r) => r.enabled));
      })
      // Advisory only: without it the toggle stays hidden and the panel shows
      // collected spend, which is the safe direction to fail in.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    client
      .loadCostStatus()
      .then((next) => {
        if (!cancelled) setStatuses(next);
      })
      .catch(() => {
        // The notice is advisory; the budgets below are the point of the panel
        // and must still render if collection status is unavailable.
        if (!cancelled) setStatuses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const overview = useMemo(() => overviewConfig(groupBy, adjusted), [groupBy, adjusted]);

  async function saveBudget(input: BudgetInput) {
    if (editing?.budget) await client.updateBudget?.(editing.budget.id, input);
    else await client.createBudget?.(input);
    setEditing(null);
    await refresh();
  }

  async function deleteBudget(budget: BudgetWithStatus) {
    const where =
      budget.placements.length > 0
        ? `\n\nIts card will also be removed from ${budget.placements.map((p) => p.dashboardName).join(", ")}.`
        : "";
    if (!window.confirm(`Delete the budget "${budget.name}"? Its alerts stop firing.${where}`)) {
      return;
    }
    await client.deleteBudget?.(budget.id);
    await refresh();
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        <CostCollectionNotice statuses={statuses} />

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-on-surface">This month</h2>
            <div className="flex items-center gap-2">
              {hasBillingRules && (
                <label className="flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary">
                  <input
                    type="checkbox"
                    checked={adjusted}
                    onChange={(e) => setAdjusted(e.target.checked)}
                    className="accent-amber-500"
                  />
                  Apply billing rules
                </label>
              )}
              <label
                htmlFor={`${uid}-groupby`}
                className="text-xs font-medium text-on-surface-secondary"
              >
                Break down by
              </label>
              <select
                id={`${uid}-groupby`}
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as CostDimensionId)}
                className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500"
              >
                {OVERVIEW_GROUP_BYS.map((dim) => (
                  <option key={dim} value={dim}>
                    {DIMENSION_LABELS[dim]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {/*
            The card draws into a `height: 100%` ResponsiveContainer, so it
            needs a parent with a real height. On a dashboard the grid row
            supplies one; here the page is a plain flex column, and the card's
            `min-h` alone leaves the container measuring zero — the chart
            renders nothing at all. Give it the height, same `[&>*]:h-full`
            trick the dashboard's grid item uses.
          */}
          <div className="h-80 [&>*]:h-full">
            <CostGraphCard title="Month to date" config={overview} api={client} />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-on-surface">Budgets</h2>
            {canWrite && (
              <button
                type="button"
                onClick={() => setEditing({ budget: null })}
                className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
              >
                New budget
              </button>
            )}
          </div>

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              Couldn&rsquo;t load budgets — {error}{" "}
              <button type="button" onClick={() => void refresh()} className="underline">
                Retry
              </button>
            </div>
          )}

          {budgets === null && error === null && (
            <p role="status" className="text-sm text-on-surface-faint">
              Loading budgets…
            </p>
          )}

          {budgets?.length === 0 && (
            <p className="text-sm text-on-surface-faint">
              No budgets yet. A budget tracks a monthly amount against all spend or a filtered
              slice, and alerts when it crosses a threshold.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {(budgets ?? []).map((budget) => (
              <div key={budget.id} className="flex flex-col gap-1.5">
                <BudgetCard
                  budget={budget}
                  onEdit={canWrite ? () => setEditing({ budget }) : undefined}
                />
                <div className="flex items-center justify-between gap-2 px-1 text-xs text-on-surface-faint">
                  <PlacementList budget={budget} onOpenDashboard={onOpenDashboard} />
                  <div className="flex items-center gap-2">
                    {canPlace && (
                      <button
                        type="button"
                        onClick={() => setPlacing(budget)}
                        className="hover:text-on-surface-secondary underline"
                      >
                        Dashboards
                      </button>
                    )}
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => void deleteBudget(budget)}
                        className="hover:text-danger underline"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Below Budgets on purpose: budgets are the most consequential
            referents of a saved filter, and the section's edit modal names
            them before a re-scope is saved. */}
        {client.listSavedFilters && <SavedFiltersSection client={client} />}

        {/* Next to saved filters, and for the same reason: a scenario model is
            a named cost object the graphs above apply by reference, not a
            preference. It also sits within sight of Budgets, which is where a
            model's sharpest consequence lives — a budget can opt its forecast
            thresholds into one. */}
        {client.listScenarioModels && <ScenarioModelsSection client={client} />}

        {/* Directly under saved filters, and above tag governance, because a
            business metric is the same kind of object: a named declaration the
            cost graphs above apply by reference. It is also the section a user
            has to visit before "cost per customer" means anything anywhere. */}
        <UnitCostsSection client={client} />

        <TagGovernanceSection client={client} />

        <CostAnomaliesSection client={client} />
        {/* Next to anomalies on purpose — the two are siblings a user should
            compare: anomalies are unconfigured statistical outliers, change
            alerts are configured "moved more than X% vs the prior period". */}
        <CostChangeAlertsSection client={client} />
        {/* The third sibling in the alert family, and last of the three
            because it reads on a different clock. Budgets, anomalies and
            change alerts all answer "did something happen yesterday"; these
            three answer "is something quietly wrong" — a commitment about to
            lapse, a commitment nobody is using, a unit cost going the wrong
            way. Nobody acts on them within the hour, and putting them above
            the two that are read that way would bury those. */}
        <EfficiencyAlertsSection client={client} />
        {/* Above the savings sections on purpose: those are about spending
            less, this is about not stopping. A pot running dry is an outage. */}
        <CreditBurndownSection client={client} {...(onOpenExternal ? { onOpenExternal } : {})} />

        {/* First of the savings-shaped sections: commitments are the largest
            single lever on a big bill, and the planner's recommendations are
            what the orphan/oversize findings below should be weighed against.
            Distinct from the credit burndown above — credits are a prepaid
            pot with a runway, commitments are a purchase with a term. */}
        <CommitmentsSection client={client} />

        {/* Network costs sit here, after commitments and before the
            resource-shaped findings, because they are the other lever that is
            invisible in the cost dimensions: the orphan and oversize sections
            below both act on a *resource*, while an egress bill is a property
            of a conversation between two of them. */}
        <NetworkFlowSection client={client} />

        {orphans && <SavingsSection client={orphans} onOpenResource={onOpenResource} />}
        {rightsizing && (
          <OversizedSection client={rightsizing} onOpenResource={onOpenOversizedResource} />
        )}
        {schedules && (
          <SleepSchedulesSection client={schedules} onOpenResource={onOpenScheduledResource} />
        )}
      </div>

      {editing && (
        <BudgetConfigModal
          initialInput={editing.budget ? budgetToInput(editing.budget) : DEFAULT_BUDGET_INPUT}
          api={client}
          onSave={saveBudget}
          onClose={() => setEditing(null)}
        />
      )}

      {placing && (
        <PlacementModal
          budget={placing}
          client={client}
          onClose={() => setPlacing(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function PlacementList({
  budget,
  onOpenDashboard,
}: {
  budget: BudgetWithStatus;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  if (budget.placements.length === 1 && onOpenDashboard) {
    const only = budget.placements[0]!;
    return (
      <button
        type="button"
        onClick={() => onOpenDashboard(only.dashboardId)}
        className="truncate hover:text-on-surface-secondary underline"
        title={`Open ${only.dashboardName}`}
      >
        On {only.dashboardName}
      </button>
    );
  }
  return <span className="truncate">{placementSummary(budget)}</span>;
}

/**
 * Add or remove this budget's dashboard cards. Adding is the "add an existing
 * budget" half of the dashboard "+" menu, reached from the budget's own side.
 */
function PlacementModal({
  budget,
  client,
  onClose,
  onChanged,
}: {
  budget: BudgetWithStatus;
  client: CostsClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [dashboards, setDashboards] = useState<CostsPanelDashboard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .listDashboards()
      .then(setDashboards)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={`Dashboards showing ${budget.name}`}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">Show on a dashboard</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          A card is a view onto this budget. Removing one leaves the budget and its alerts intact.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}
        {dashboards === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            Loading dashboards…
          </p>
        )}

        <ul className="flex flex-col gap-1">
          {(dashboards ?? []).map((d) => {
            const placement = budget.placements.find((p) => p.dashboardId === d.id);
            return (
              <li key={d.id} className="flex items-center justify-between gap-3 py-1">
                <span className="truncate text-sm text-on-surface">{d.name}</span>
                {placement ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client.removeBudgetPlacement!(placement.widgetId))
                    }
                    className="text-xs text-on-surface-faint hover:text-danger underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client.addBudgetToDashboard!(d.id, budget.id, budget.name))
                    }
                    className="text-xs text-on-surface-secondary hover:text-on-surface underline disabled:opacity-50"
                  >
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
