import { useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  DroppableDashboardArea,
  SortableDashboardCard,
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  SparklineChart,
  useUIStore,
  formatErrorMessage,
  extractHostLabel,
  toast,
} from "@infrawrench/ui";
import type { ProbeStatus } from "@infrawrench/plugin-base";
import { WorkflowDashboardCard, type WorkflowDashboardCardData } from "@infrawrench/ui/workflows";
import {
  BudgetCard,
  BudgetConfigModal,
  CostGraphCard,
  CostGraphConfigModal,
  DEFAULT_BUDGET_INPUT,
  DEFAULT_COST_GRAPH_CONFIG,
  type BudgetInput,
  type BudgetWithStatus,
  type CostApi,
  type CostDimensionOption,
  type CostGraphConfig,
  type CostQueryRequest,
  type CostQueryResponse,
  type DashboardWidget,
} from "@infrawrench/ui/cost";
import { apiGet, apiPost, apiDelete, apiPatch, apiPut } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { SpotlightSearch } from "./SpotlightSearch";

export interface WorkflowPin {
  pinId: string;
  workflowId: string;
  gridX: number;
  name: string;
  lastRunAt: string | null;
  lastStatus: "success" | "failure" | "running" | "pending" | null;
  metrics: Array<{ key: string; label: string; unit: string | null; value: unknown }>;
}

interface PinnedResource {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

interface PinDetail {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  displayName: string;
  pluginId: string;
  pluginLogoSvg: string;
  pluginDisplayName: string;
  resourceTypeId: string;
  accountId: string;
  fieldsJson: unknown;
  outputsJson: unknown;
  status: ProbeStatus;
}

interface DashboardViewProps {
  dashboardId: string;
  dashboardName: string;
  isHome?: boolean | undefined;
  pins: PinnedResource[];
  workflowPins?: WorkflowPin[] | undefined;
  widgets?: DashboardWidget[] | undefined;
}

export function DashboardView({
  dashboardId,
  dashboardName: initialName,
  isHome = false,
  pins: initialPins,
  workflowPins: initialWorkflowPins,
  widgets: initialWidgets,
}: DashboardViewProps) {
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [pins, setPins] = useState(initialPins);
  const [workflowPins, setWorkflowPins] = useState<WorkflowPin[]>(initialWorkflowPins ?? []);
  const [widgets, setWidgets] = useState<DashboardWidget[]>(initialWidgets ?? []);
  const [spotlightMode, setSpotlightMode] = useState<"pin" | "navigate" | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [costModal, setCostModal] = useState<{ widget: DashboardWidget | null } | null>(null);
  const [budgetModal, setBudgetModal] = useState<{ widget: DashboardWidget | null } | null>(null);
  const [budgets, setBudgets] = useState<Map<string, BudgetWithStatus>>(new Map());
  const [dashboardName, setDashboardName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);

  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);

  useEffect(() => {
    setPins(initialPins);
  }, [initialPins]);

  useEffect(() => {
    setWorkflowPins(initialWorkflowPins ?? []);
  }, [initialWorkflowPins]);

  useEffect(() => {
    setWidgets(initialWidgets ?? []);
  }, [initialWidgets]);

  const costApi: CostApi = useMemo(
    () => ({
      queryCosts: (req: CostQueryRequest) =>
        apiPost<CostQueryResponse>(`/api/org/${orgId}/costs/query`, req),
      loadDimensionValues: async (dimension: string, tagKey?: string) => {
        const params = new URLSearchParams({ dimension });
        if (tagKey) params.set("tagKey", tagKey);
        const res = await apiGet<{ values: Array<string | CostDimensionOption> }>(
          `/api/org/${orgId}/costs/dimensions?${params}`,
        );
        return res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v));
      },
    }),
    [orgId],
  );

  const refetchBudgets = useCallback(async () => {
    try {
      const rows = await apiGet<BudgetWithStatus[]>(`/api/org/${orgId}/budgets`);
      setBudgets(new Map(rows.map((b) => [b.id, b])));
    } catch {
      /* budget cards show their own empty state */
    }
  }, [orgId]);

  const hasBudgetWidgets = widgets.some((w) => w.kind === "budget");
  useEffect(() => {
    if (hasBudgetWidgets) void refetchBudgets();
  }, [hasBudgetWidgets, refetchBudgets]);

  async function handleRemoveWidget(widgetId: string) {
    try {
      await apiDelete(`/api/org/${orgId}/dashboards/widgets/${widgetId}`);
      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
    } catch (e) {
      toast.error("Couldn't remove widget", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function saveCostWidget(
    widget: DashboardWidget | null,
    title: string,
    config: CostGraphConfig,
  ) {
    if (widget) {
      const updated = await apiPatch<DashboardWidget>(
        `/api/org/${orgId}/dashboards/widgets/${widget.id}`,
        { title, config },
      );
      setWidgets((prev) => prev.map((w) => (w.id === widget.id ? { ...w, ...updated } : w)));
    } else {
      const created = await apiPost<DashboardWidget>(`/api/org/${orgId}/dashboards/widgets`, {
        dashboardId,
        kind: "cost_graph",
        title,
        config,
      });
      setWidgets((prev) => [...prev, created]);
    }
  }

  async function saveBudgetWidget(widget: DashboardWidget | null, input: BudgetInput) {
    if (widget) {
      const budgetId = (widget.config as { budgetId: string }).budgetId;
      await apiPut(`/api/org/${orgId}/budgets/${budgetId}`, input);
    } else {
      const budget = await apiPost<{ id: string }>(`/api/org/${orgId}/budgets`, input);
      const created = await apiPost<DashboardWidget>(`/api/org/${orgId}/dashboards/widgets`, {
        dashboardId,
        kind: "budget",
        title: input.name,
        config: { version: 1, budgetId: budget.id },
      });
      setWidgets((prev) => [...prev, created]);
    }
    await refetchBudgets();
  }

  const refetchWorkflowPins = useCallback(async () => {
    try {
      const res = await apiGet<{ workflowPins?: WorkflowPin[] }>(
        `/api/org/${orgId}/dashboards/${dashboardId}`,
      );
      setWorkflowPins(res.workflowPins ?? []);
    } catch {
      /* keep stale data on transient failure */
    }
  }, [orgId, dashboardId]);

  async function handleUnpinWorkflow(workflowId: string) {
    try {
      await apiPost(`/api/org/${orgId}/dashboards/workflow-unpin`, { dashboardId, workflowId });
      setWorkflowPins((prev) => prev.filter((p) => p.workflowId !== workflowId));
    } catch (e) {
      toast.error("Couldn't unpin workflow", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleRunWorkflow(workflowId: string) {
    try {
      await apiPost(`/api/org/${orgId}/workflows/${workflowId}/run`, {});
      await refetchWorkflowPins();
    } catch (e) {
      toast.error("Workflow run failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const handleReorder = useCallback(
    (e: Event) => {
      const { activeResourceId, overResourceId } = (e as CustomEvent).detail as {
        activeResourceId: string;
        overResourceId: string;
      };
      setPins((prev) => {
        const oldIndex = prev.findIndex((p) => p.resourceId === activeResourceId);
        const newIndex = prev.findIndex((p) => p.resourceId === overResourceId);
        if (oldIndex === -1 || newIndex === -1) return prev;
        const next = arrayMove(prev, oldIndex, newIndex);
        void apiPost(`/api/org/${orgId}/dashboards/${dashboardId}/reorder`, {
          resourceIds: next.map((p) => p.resourceId),
        });
        return next;
      });
    },
    [dashboardId, orgId],
  );

  useEffect(() => {
    window.addEventListener("iw:dashboard-card-reorder", handleReorder);
    return () => window.removeEventListener("iw:dashboard-card-reorder", handleReorder);
  }, [handleReorder]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightMode("navigate");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleUnpin(pinId: string, resourceId: string) {
    try {
      await apiPost(`/api/org/${orgId}/dashboards/unpin`, { dashboardId, resourceId });
      setPins((prev) => prev.filter((p) => p.pinId !== pinId));
    } catch (e) {
      console.error("Failed to unpin:", e);
      toast.error("Couldn't unpin", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function saveName(name: string) {
    const trimmed = name.trim() || "Dashboard";
    setDashboardName(trimmed);
    setEditingName(false);
    try {
      await apiPost(`/api/org/${orgId}/dashboards/${dashboardId}/rename`, { name: trimmed });
    } catch (e) {
      console.error("Failed to rename:", e);
      toast.error("Couldn't rename dashboard", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function deleteDashboard() {
    if (isHome) return;
    try {
      await apiDelete(`/api/org/${orgId}/dashboards/${dashboardId}`);
      void navigate({ to: "/org/$orgId", params: { orgId } });
    } catch (e) {
      console.error("Failed to delete:", e);
      toast.error("Couldn't delete dashboard", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-4 border-b border-border/50 flex items-center justify-between">
        <div>
          {editingName ? (
            <input
              ref={(el) => el?.focus()}
              aria-label="Dashboard name"
              defaultValue={dashboardName}
              onBlur={(e) => void saveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName(e.currentTarget.value);
                if (e.key === "Escape") setEditingName(false);
              }}
              className="text-2xl font-semibold bg-transparent border-b border-blue-500 text-on-surface focus:outline-none"
            />
          ) : (
            <div className="flex items-center gap-2">
              <h1
                className="text-2xl font-semibold text-on-surface cursor-default hover:text-white"
                onDoubleClick={() => setEditingName(true)}
                title="Double-click to rename"
              >
                {dashboardName}
              </h1>
              <button
                type="button"
                onClick={() => setEditingName(true)}
                aria-label="Rename dashboard"
                className="text-xs text-on-surface-faint hover:text-on-surface-muted transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Rename
              </button>
            </div>
          )}
        </div>

        {!isHome && (
          <button
            type="button"
            onClick={() => void deleteDashboard()}
            title="Delete dashboard"
            className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Delete
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 py-6">
        <DroppableDashboardArea dashboardId={dashboardId}>
          {pins.length === 0 && workflowPins.length === 0 && widgets.length === 0 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setAddMenuOpen((v) => !v)}
                className="w-full flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed border-border text-on-surface-faint hover:border-border-strong hover:text-on-surface-muted transition-colors"
              >
                <span className="text-3xl mb-3">&#8862;</span>
                <p className="text-sm">Click to add to this dashboard</p>
                <p className="text-xs mt-1 opacity-60">or drag a resource or workflow here</p>
              </button>
              {addMenuOpen && (
                <AddMenu
                  onPickResource={() => {
                    setAddMenuOpen(false);
                    setSpotlightMode("pin");
                  }}
                  onPickCostGraph={() => {
                    setAddMenuOpen(false);
                    setCostModal({ widget: null });
                  }}
                  onPickBudget={() => {
                    setAddMenuOpen(false);
                    setBudgetModal({ widget: null });
                  }}
                  onClose={() => setAddMenuOpen(false)}
                />
              )}
            </div>
          ) : (
            <SortableContext
              items={pins.map((p) => `dashboard-card:${p.resourceId}`)}
              strategy={rectSortingStrategy}
            >
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
              >
                {pins.map((pin) => (
                  <SortableDashboardCard key={pin.pinId} id={pin.resourceId}>
                    <PinCard
                      pinId={pin.pinId}
                      orgId={orgId}
                      onUnpin={() => void handleUnpin(pin.pinId, pin.resourceId)}
                      onOpen={(detail) =>
                        void navigate({
                          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                          params: {
                            orgId,
                            pluginId: detail.pluginId,
                            resourceTypeId: detail.resourceTypeId,
                            resourceId: detail.resourceId,
                          },
                        })
                      }
                    />
                  </SortableDashboardCard>
                ))}

                {workflowPins.map((wf) => (
                  <WorkflowDashboardCard
                    key={wf.pinId}
                    data={toCardData(wf)}
                    onOpen={() => void navigate({ to: "/org/$orgId/workflows", params: { orgId } })}
                    onUnpin={() => void handleUnpinWorkflow(wf.workflowId)}
                    onRun={() => handleRunWorkflow(wf.workflowId)}
                  />
                ))}

                {widgets.map((widget) =>
                  widget.kind === "cost_graph" ? (
                    <CostGraphCard
                      key={widget.id}
                      title={widget.title}
                      config={widget.config as CostGraphConfig}
                      api={costApi}
                      onEdit={() => setCostModal({ widget })}
                      onRemove={() => void handleRemoveWidget(widget.id)}
                    />
                  ) : (
                    (() => {
                      const budget = budgets.get((widget.config as { budgetId: string }).budgetId);
                      return budget ? (
                        <BudgetCard
                          key={widget.id}
                          budget={budget}
                          onEdit={() => setBudgetModal({ widget })}
                          onRemove={() => void handleRemoveWidget(widget.id)}
                        />
                      ) : (
                        <div
                          key={widget.id}
                          className="rounded-2xl border border-border bg-surface-raised flex items-center justify-center text-xs text-on-surface-faint min-h-[140px]"
                        >
                          Loading budget…
                        </div>
                      );
                    })()
                  ),
                )}

                <div className="relative min-h-[140px]">
                  <button
                    type="button"
                    onClick={() => setAddMenuOpen((v) => !v)}
                    className="w-full h-full rounded-2xl border-2 border-dashed border-border text-on-surface-faint hover:border-border-strong hover:text-on-surface-muted flex flex-col items-center justify-center gap-1.5 transition-colors"
                  >
                    <span className="text-2xl">+</span>
                    <span className="text-xs">Add</span>
                  </button>
                  {addMenuOpen && (
                    <AddMenu
                      onPickResource={() => {
                        setAddMenuOpen(false);
                        setSpotlightMode("pin");
                      }}
                      onPickCostGraph={() => {
                        setAddMenuOpen(false);
                        setCostModal({ widget: null });
                      }}
                      onPickBudget={() => {
                        setAddMenuOpen(false);
                        setBudgetModal({ widget: null });
                      }}
                      onClose={() => setAddMenuOpen(false)}
                    />
                  )}
                </div>
              </div>
            </SortableContext>
          )}
        </DroppableDashboardArea>

        {spotlightMode && (
          <SpotlightSearch
            dashboardId={dashboardId}
            mode={spotlightMode}
            onClose={() => setSpotlightMode(null)}
            onPinned={() => {
              bumpDashboardPins();
              setSpotlightMode(null);
            }}
          />
        )}

        {costModal && (
          <CostGraphConfigModal
            initialConfig={
              costModal.widget
                ? (costModal.widget.config as CostGraphConfig)
                : DEFAULT_COST_GRAPH_CONFIG
            }
            initialTitle={costModal.widget?.title ?? ""}
            api={costApi}
            onSave={(title, config) => saveCostWidget(costModal.widget, title, config)}
            onClose={() => setCostModal(null)}
          />
        )}

        {budgetModal && (
          <BudgetConfigModal
            initialInput={
              budgetModal.widget
                ? budgetToInput(
                    budgets.get((budgetModal.widget.config as { budgetId: string }).budgetId),
                  )
                : DEFAULT_BUDGET_INPUT
            }
            api={costApi}
            onSave={(input) => saveBudgetWidget(budgetModal.widget, input)}
            onClose={() => setBudgetModal(null)}
          />
        )}
      </div>
    </div>
  );
}

function budgetToInput(budget: BudgetWithStatus | undefined): BudgetInput {
  if (!budget) return DEFAULT_BUDGET_INPUT;
  return {
    name: budget.name,
    amountCents: budget.amountCents,
    currency: budget.currency,
    filters: budget.filters as BudgetInput["filters"],
    thresholds: budget.thresholds,
  };
}

function AddMenu({
  onPickResource,
  onPickCostGraph,
  onPickBudget,
  onClose,
}: {
  onPickResource: () => void;
  onPickCostGraph: () => void;
  onPickBudget: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const itemClass =
    "w-full text-left px-3 py-2 text-sm text-on-surface-secondary hover:text-on-surface hover:bg-surface-sunken transition-colors flex items-center gap-2";

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 w-48 rounded-xl border border-border bg-surface-raised shadow-xl overflow-hidden py-1">
        <button type="button" onClick={onPickResource} className={itemClass}>
          <span className="text-on-surface-faint">▣</span> Pin a resource
        </button>
        <button type="button" onClick={onPickCostGraph} className={itemClass}>
          <span className="text-on-surface-faint">▤</span> Cost graph
        </button>
        <button type="button" onClick={onPickBudget} className={itemClass}>
          <span className="text-on-surface-faint">◔</span> Budget
        </button>
      </div>
    </>
  );
}

function toCardData(wf: WorkflowPin): WorkflowDashboardCardData {
  return {
    workflowId: wf.workflowId,
    name: wf.name,
    lastRunAt: wf.lastRunAt,
    lastStatus: wf.lastStatus,
    metrics: wf.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      unit: m.unit,
      value: (m.value ?? null) as number | string | boolean | null,
    })),
  };
}

function PinCard({
  pinId,
  orgId,
  onUnpin,
  onOpen,
}: {
  pinId: string;
  orgId: string;
  onUnpin: () => void;
  onOpen: (detail: PinDetail) => void;
}) {
  const [store, setStore] = useState<{
    forKey: string;
    detail: PinDetail | null;
    loadError: string | null;
  }>({ forKey: "", detail: null, loadError: null });
  const [unpinning, setUnpinning] = useState(false);

  const key = `${orgId}/${pinId}`;
  const detail = store.forKey === key ? store.detail : null;
  const loadError = store.forKey === key ? store.loadError : null;

  useEffect(() => {
    let cancelled = false;
    apiGet<PinDetail>(`/api/org/${orgId}/dashboards/pin/${pinId}`)
      .then((d) => {
        if (!cancelled) setStore({ forKey: key, detail: d, loadError: null });
      })
      .catch((e) => {
        if (!cancelled) setStore({ forKey: key, detail: null, loadError: formatErrorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [pinId, orgId, key]);

  if (loadError) {
    return (
      <div className="rounded-2xl border border-border bg-surface-raised p-5">
        <p className="text-xs text-red-500">{loadError}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="rounded-2xl border border-border bg-surface-raised p-5 flex flex-col gap-3 min-h-[140px] animate-pulse">
        <div className="h-4 w-20 rounded bg-surface-sunken" />
        <div className="h-5 w-32 rounded bg-surface-sunken" />
        <div className="mt-auto h-3 w-24 rounded bg-surface-sunken" />
      </div>
    );
  }

  const fields =
    typeof detail.fieldsJson === "string"
      ? (() => {
          try {
            return JSON.parse(detail.fieldsJson) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : ((detail.fieldsJson as Record<string, unknown>) ?? {});
  const host = extractHostLabel(fields);

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={async () => {
          setUnpinning(true);
          try {
            onUnpin();
          } finally {
            setUnpinning(false);
          }
        }}
        disabled={unpinning}
        title="Remove from dashboard"
        aria-label="Remove from dashboard"
        className="absolute top-2 right-2 size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-all opacity-0 group-hover:opacity-100 text-xs flex items-center justify-center z-10"
      >
        &#10005;
      </button>

      <button
        type="button"
        onClick={() => onOpen(detail)}
        className="flex-1 flex flex-col p-5 text-left gap-3"
      >
        <div className="flex items-center gap-2">
          {detail.pluginLogoSvg ? (
            <div
              className="size-6 flex-shrink-0"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: detail.pluginLogoSvg }}
            />
          ) : (
            <span className="text-xs text-on-surface-faint font-mono">{detail.pluginId}</span>
          )}
          <span className="text-xs text-on-surface-muted">{detail.pluginDisplayName}</span>
        </div>

        <div>
          <p className="text-base font-semibold text-on-surface leading-tight">
            {detail.displayName}
          </p>
          {host && <p className="text-xs text-on-surface-muted mt-0.5 truncate">{host}</p>}
        </div>
      </button>

      <ConnectionFooter status={detail.status} />
    </div>
  );
}

function ConnectionFooter({ status }: { status: ProbeStatus }) {
  if (status.phase === "error") {
    return (
      <div
        className="px-5 py-3 border-t border-border flex items-center gap-2"
        title={status.error}
      >
        <img className="size-1.5 rounded-full bg-red-500 flex-shrink-0" alt="Error" />
        <span className="text-xs text-red-500 truncate">{status.error ?? "Connection failed"}</span>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-t border-border space-y-1">
      <div className="flex items-center gap-1.5 mb-1">
        <img className="size-1.5 rounded-full bg-blue-400 flex-shrink-0" alt="Connected" />
        <span className="text-xs text-on-surface-faint">Connected</span>
      </div>
      {status.stats?.map((stat) => {
        const color =
          stat.variant === "status-healthy"
            ? "text-green-400"
            : stat.variant === "status-degraded"
              ? "text-yellow-400"
              : stat.variant === "status-error"
                ? "text-red-400"
                : "text-on-surface-tertiary";
        return (
          <div key={stat.label} className="flex justify-between text-xs">
            <span className="text-on-surface-faint">{stat.label}</span>
            <span className={color}>{stat.value}</span>
          </div>
        );
      })}
      {status.sparkline && status.sparkline.length >= 2 && (
        <div className="flex items-center gap-2 mt-2.5">
          <SparklineChart points={status.sparkline} width={120} height={24} />
          {status.sparklineLabel && (
            <span className="text-[10px] text-on-surface-faint">{status.sparklineLabel}</span>
          )}
        </div>
      )}
      {status.resourceCounts?.map(({ typeLabel, count }) => (
        <div key={typeLabel} className="flex justify-between text-xs">
          <span className="text-on-surface-faint">{typeLabel}</span>
          <span className="text-on-surface-tertiary">{count}</span>
        </div>
      ))}
    </div>
  );
}
