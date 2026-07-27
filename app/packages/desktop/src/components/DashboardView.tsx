import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SpotlightSearch } from "./SpotlightSearch";
import { invoke } from "../lib/invoke";
import { useDroppable } from "@dnd-kit/core";
import {
  useUIStore,
  useTabId,
  SortableDashboardCard,
  SortableContext,
  rectSortingStrategy,
  cardOrderIndex,
  dashboardCardId,
  moveDashboardCard,
  orderDashboardCards,
  getListableResourceTypes,
  formatErrorMessage,
  toast,
  type DashboardCardKind,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins, getPlugin } from "../plugins/loader";
import {
  buildHostServices,
  buildKvHostServices,
  buildMemcachedHostServices,
  buildDockerHostServices,
} from "../lib/sql-drivers";
import { resolveTunneledHost } from "../lib/ssh-tunnel";
import { setSqlSession } from "../lib/sql-session";
import {
  accountTabTarget,
  navigateToWorkspaceTarget,
  resourceTabTarget,
  workflowsTabTarget,
} from "../lib/workspace-tabs";
import { unpinWorkflow } from "../lib/pins";
import { WorkflowPinCard } from "./DashboardView/WorkflowPinCard";
import {
  getCloudDashboard,
  getCloudEnrichedPin,
  probeCloudPins,
  unpinCloudResource,
  reorderCloudCards,
  renameCloudDashboard,
  deleteCloudDashboard,
  queryCloudCosts,
  loadCloudCostDimensionValues,
  loadCloudCostStatus,
  listCloudBudgets,
  createCloudBudget,
  updateCloudBudget,
  createCloudWidget,
  updateCloudWidget,
  deleteCloudWidget,
  type CloudProbeItem,
} from "../lib/cloud-api";
import {
  BudgetConfigModal,
  BudgetPickerModal,
  BudgetWidgetCard,
  CostCollectionNotice,
  CostGraphCard,
  CostGraphConfigModal,
  DEFAULT_BUDGET_INPUT,
  DEFAULT_COST_GRAPH_CONFIG,
  type BudgetInput,
  type BudgetWithStatus,
  type CostAccountStatus,
  type CostApi,
  type CostGraphConfig,
  type DashboardWidget,
} from "@infrawrench/ui/cost";
import { ResourceCard } from "./DashboardView/ResourceCard";
import type { CardStatus, PinnedRow, PluginMeta } from "./DashboardView/types";

/** One card in the dashboard grid, whichever table it came from. */
type DashboardCard =
  | { kind: "resource"; id: string; gridX: number; row: PinnedRow }
  | {
      kind: "workflow";
      id: string;
      gridX: number;
      workflowPin: { pinId: string; workflowId: string; gridX: number };
    }
  | { kind: "widget"; id: string; gridX: number; widget: DashboardWidget };

interface DashboardViewProps {
  dashboardId: string;
}

export function DashboardView({ dashboardId }: DashboardViewProps) {
  const navigate = useNavigate();
  const [pinned, setPinned] = useState<PinnedRow[]>([]);
  const [workflowPins, setWorkflowPins] = useState<
    { pinId: string; workflowId: string; gridX: number }[]
  >([]);
  const [pluginMeta, setPluginMeta] = useState<Record<string, PluginMeta>>({});
  const [loading, setLoading] = useState(true);
  const [dashboardName, setDashboardName] = useState("");
  const [isHome, setIsHome] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [notFound, setNotFound] = useState(false);
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});

  const [spotlightMode, setSpotlightMode] = useState<"pin" | "navigate" | null>(null);
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [budgets, setBudgets] = useState<Map<string, BudgetWithStatus>>(new Map());
  const [costStatus, setCostStatus] = useState<CostAccountStatus[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [costModal, setCostModal] = useState<{ widget: DashboardWidget | null } | null>(null);
  const [budgetModal, setBudgetModal] = useState<{ widget: DashboardWidget | null } | null>(null);
  const [budgetPickerOpen, setBudgetPickerOpen] = useState(false);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);
  const tabId = useTabId();

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const { setNodeRef, isOver } = useDroppable({ id: `dashboard:${dashboardId}` });

  /**
   * One card per grid slot, whichever table it came from — the three kinds are
   * dragged as a single sequence. Cloud dashboards carry resource pins and
   * widgets; local ones carry resource pins and workflow pins.
   */
  const cards = useMemo(
    () =>
      orderDashboardCards<DashboardCard>([
        ...pinned.map((row) => ({
          kind: "resource" as const,
          id: row.resource_id,
          gridX: row.grid_x,
          row,
        })),
        ...workflowPins.map((workflowPin) => ({
          kind: "workflow" as const,
          id: workflowPin.workflowId,
          gridX: workflowPin.gridX,
          workflowPin,
        })),
        ...widgets.map((widget) => ({
          kind: "widget" as const,
          id: widget.id,
          gridX: widget.gridX,
          widget,
        })),
      ]),
    [pinned, workflowPins, widgets],
  );
  // The reorder listener is registered once; a ref keeps it off the card list
  // without going stale.
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const handleReorder = useCallback(
    (e: Event) => {
      const { activeCardId, overCardId } = (e as CustomEvent).detail as {
        activeCardId: string;
        overCardId: string;
      };
      // Resource pins, workflow pins, and widgets share one sequence, so a
      // drag renumbers every card and the new index becomes its gridX.
      const next = moveDashboardCard(cardsRef.current, activeCardId, overCardId);
      if (next === cardsRef.current) return;
      const indexOf = cardOrderIndex(next);
      const gridXFor = (kind: DashboardCardKind, id: string, fallback: number) =>
        indexOf.get(dashboardCardId(kind, id)) ?? fallback;

      setPinned((prev) =>
        prev.map((r) => ({ ...r, grid_x: gridXFor("resource", r.resource_id, r.grid_x) })),
      );
      setWorkflowPins((prev) =>
        prev.map((w) => ({ ...w, gridX: gridXFor("workflow", w.workflowId, w.gridX) })),
      );
      setWidgets((prev) => prev.map((w) => ({ ...w, gridX: gridXFor("widget", w.id, w.gridX) })));

      void (async () => {
        const orgId = useUIStore.getState().activeCloudOrgId;
        if (orgId) {
          await reorderCloudCards(
            orgId,
            dashboardId,
            next.map(({ kind, id }) => ({ kind, id })),
          );
          return;
        }
        // Local dashboards hold resource pins and workflow pins; widgets are
        // cloud-only, so nothing else can appear in the sequence here.
        const db = await getDb();
        await Promise.all(
          next.map((card, i) =>
            card.kind === "workflow"
              ? db.execute(
                  "UPDATE dashboard_workflow_pins SET grid_x = $1 WHERE dashboard_id = $2 AND workflow_id = $3",
                  [i, dashboardId, card.id],
                )
              : db.execute(
                  "UPDATE dashboard_pins SET grid_x = $1 WHERE dashboard_id = $2 AND resource_id = $3",
                  [i, dashboardId, card.id],
                ),
          ),
        );
      })();
    },
    [dashboardId],
  );

  useEffect(() => {
    window.addEventListener("iw:dashboard-card-reorder", handleReorder);
    return () => window.removeEventListener("iw:dashboard-card-reorder", handleReorder);
  }, [handleReorder]);

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const plugins = await loadPlugins();
      const meta: Record<string, PluginMeta> = {};
      for (const p of plugins) {
        const m = p.plugin.manifest;
        meta[m.id] = {
          logoSvg: m.logoSvg,
          displayName: m.displayName,
          terminalResourceTypeIds: p.plugin.resourceTypes.flatMap((t) =>
            t.supportsTerminal ? [t.id] : [],
          ),
        };
      }
      setPluginMeta(meta);

      const orgId = useUIStore.getState().activeCloudOrgId;
      let loadedName: string;
      let isDefault: boolean;
      let rows: PinnedRow[];

      if (orgId) {
        const full = await getCloudDashboard(orgId, dashboardId);
        if (!full) {
          setNotFound(true);
          return;
        }
        loadedName = full.dashboard.name;
        isDefault = full.dashboard.isDefault;
        setWidgets(full.widgets ?? []);
        if ((full.widgets ?? []).some((w) => w.kind === "budget")) {
          void listCloudBudgets(orgId)
            .then((rows) => setBudgets(new Map(rows.map((b) => [b.id, b]))))
            .catch(() => {});
        }
        // Any cost surface is only as good as the collection behind it — pull
        // the per-account state so the notice can explain an empty graph.
        if ((full.widgets ?? []).some((w) => w.kind === "cost_graph" || w.kind === "budget")) {
          void loadCloudCostStatus(orgId)
            .then(setCostStatus)
            .catch(() => {
              /* the notice is advisory — a failed status fetch stays silent */
            });
        }

        const enriched = await Promise.all(
          [...full.pins]
            .sort((a, b) => a.gridX - b.gridX)
            .map(async (pin) => {
              try {
                const detail = await getCloudEnrichedPin(orgId, pin.pinId);
                return detail ? { detail, gridX: pin.gridX } : null;
              } catch {
                return null;
              }
            }),
        );
        rows = [];
        const initialStatus: Record<string, CardStatus> = {};
        for (const entry of enriched) {
          if (!entry) continue;
          const e = entry.detail;
          rows.push({
            resource_id: e.resourceId,
            grid_x: entry.gridX,
            plugin_id: e.pluginId,
            resource_type_id: e.resourceTypeId,
            account_id: e.accountId,
            display_name: e.displayName,
            fields_json: JSON.stringify(e.fieldsJson ?? {}),
            outputs_json: JSON.stringify(e.outputsJson ?? {}),
          });
          const isSshTarget = !!meta[e.pluginId]?.terminalResourceTypeIds.includes(
            e.resourceTypeId,
          );
          initialStatus[e.resourceId] = {
            phase: e.status.phase === "ok" ? "ok" : "error",
            ...(e.status.stats !== undefined ? { stats: e.status.stats } : {}),
            ...(e.status.sparkline !== undefined ? { sparkline: e.status.sparkline } : {}),
            ...(e.status.sparklineLabel !== undefined
              ? { sparklineLabel: e.status.sparklineLabel }
              : {}),
            ...(e.status.resourceCounts !== undefined
              ? { resourceCounts: e.status.resourceCounts }
              : {}),
            ...(e.status.error !== undefined ? { error: e.status.error } : {}),
            ...(isSshTarget
              ? { sshTarget: true, resourceId: e.resourceId, accountId: e.accountId }
              : {}),
          };
        }
        setCardStatus((prev) => ({ ...prev, ...initialStatus }));
        // Workflow pins are local-only; cloud dashboards don't carry them.
        setWorkflowPins([]);
      } else {
        // Cost widgets are cloud-only; local dashboards never carry them.
        setWidgets([]);
        const db = await getDb();
        const nameRows = await db.select<{ name: string; is_default: number }[]>(
          "SELECT name, is_default FROM dashboards WHERE id = $1 LIMIT 1",
          [dashboardId],
        );
        if (!nameRows[0]) {
          setNotFound(true);
          return;
        }
        loadedName = nameRows[0].name;
        isDefault = nameRows[0].is_default === 1;

        rows = await db.select<PinnedRow[]>(
          `
          SELECT r.id as resource_id, dp.grid_x, r.plugin_id, r.resource_type_id,
                 r.account_id, r.display_name, r.fields_json, r.outputs_json
          FROM dashboard_pins dp
          JOIN resources r ON r.id = dp.resource_id
          WHERE dp.dashboard_id = $1
          ORDER BY dp.grid_x ASC, dp.created_at DESC
          LIMIT 50
        `,
          [dashboardId],
        );

        // Workflow pins are local-only (desktop workflows live in SQLite).
        const wfRows = await db.select<{ pin_id: string; workflow_id: string; grid_x: number }[]>(
          `
          SELECT dwp.id as pin_id, dwp.workflow_id, dwp.grid_x
          FROM dashboard_workflow_pins dwp
          JOIN workflows w ON w.id = dwp.workflow_id
          WHERE dwp.dashboard_id = $1 AND dwp.deleted_at IS NULL AND w.deleted_at IS NULL
          ORDER BY dwp.grid_x ASC, dwp.created_at ASC
        `,
          [dashboardId],
        );
        setWorkflowPins(
          wfRows.map((r) => ({ pinId: r.pin_id, workflowId: r.workflow_id, gridX: r.grid_x })),
        );
      }

      setDashboardName(loadedName);
      setIsHome(isDefault);

      if (tabId) useUIStore.getState().setWorkspaceTabTitle(tabId, loadedName);

      // Keep "ok" cards as-is so pinning a new resource doesn't flash "Connecting…".
      setCardStatus((prev) => {
        const next: Record<string, CardStatus> = {};
        for (const row of rows) {
          if (prev[row.resource_id]?.phase === "ok") {
            next[row.resource_id] = prev[row.resource_id]!;
          }
        }
        return next;
      });

      setPinned(rows);
    } catch {
      // empty dashboard
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    void load();
  }, [load, dashboardPinsVersion]);

  // Cmd/Ctrl+K (navigate) is handled globally in the root layout so it works in
  // every tab; here the spotlight is only opened in "pin" mode via the + tiles.

  useEffect(() => {
    if (pinned.length === 0) return;
    let cancelled = false;

    async function connectAllCloud(orgId: string) {
      const items: CloudProbeItem[] = pinned.map((r) => ({
        resourceId: r.resource_id,
        accountId: r.account_id,
        pluginId: r.plugin_id,
        resourceTypeId: r.resource_type_id,
      }));
      if (items.length === 0) return;

      if (!cancelled) {
        setCardStatus((prev) => {
          const next = { ...prev };
          for (const it of items) {
            if (prev[it.resourceId]?.phase !== "ok") next[it.resourceId] = { phase: "connecting" };
          }
          return next;
        });
      }

      try {
        const results = await probeCloudPins(orgId, items);
        if (cancelled) return;
        const connectedAccountIds: string[] = [];
        setCardStatus((prev) => {
          const next = { ...prev };
          for (const row of pinned) {
            const res = results[row.resource_id];
            if (!res) continue;
            const isSshTarget = !!pluginMeta[row.plugin_id]?.terminalResourceTypeIds.includes(
              row.resource_type_id,
            );
            next[row.resource_id] = {
              phase: res.phase,
              ...(res.stats !== undefined ? { stats: res.stats } : {}),
              ...(res.sparkline !== undefined ? { sparkline: res.sparkline } : {}),
              ...(res.sparklineLabel !== undefined ? { sparklineLabel: res.sparklineLabel } : {}),
              ...(res.resourceCounts !== undefined ? { resourceCounts: res.resourceCounts } : {}),
              ...(res.error !== undefined ? { error: res.error } : {}),
              ...(isSshTarget
                ? { sshTarget: true, resourceId: row.resource_id, accountId: row.account_id }
                : {}),
            };
            if (res.phase === "ok") connectedAccountIds.push(row.account_id);
          }
          return next;
        });
        for (const id of connectedAccountIds) setAccountConnected(id, true);
      } catch (e) {
        if (cancelled) return;
        const err = formatErrorMessage(e);
        setCardStatus((prev) => {
          const next = { ...prev };
          for (const it of items) {
            if (prev[it.resourceId]?.phase !== "ok") {
              next[it.resourceId] = { phase: "error", error: err };
            }
          }
          return next;
        });
      }
    }

    async function connectAll() {
      const cloudOrgId = useUIStore.getState().activeCloudOrgId;
      if (cloudOrgId) {
        await connectAllCloud(cloudOrgId);
        return;
      }
      const credsByAccount = new Map<string, Record<string, string>>();

      const accountIds = [...new Set(pinned.map((r) => r.account_id))];
      await Promise.all(
        accountIds.map(async (accountId) => {
          try {
            const creds = await invoke<Record<string, string>>("account_get_credentials", {
              accountId,
            });
            credsByAccount.set(accountId, creds);
          } catch {
            /* skip this account */
          }
        }),
      );

      const connectableIds = pinned.flatMap((r) =>
        credsByAccount.has(r.account_id) ? [r.resource_id] : [],
      );

      if (connectableIds.length === 0) return;

      if (!cancelled) {
        setCardStatus((prev) => {
          const next = { ...prev };
          for (const id of connectableIds) {
            if (prev[id]?.phase !== "ok") next[id] = { phase: "connecting" };
          }
          return next;
        });
      }

      await Promise.all(
        pinned.map(async (row) => {
          const creds = credsByAccount.get(row.account_id);
          if (!creds) return;
          let alreadyOk = false;
          setCardStatus((prev) => {
            alreadyOk = prev[row.resource_id]?.phase === "ok";
            return prev;
          });
          if (alreadyOk) return;

          if (row.resource_type_id === "__account__") {
            try {
              const loaded = await getPlugin(row.plugin_id);
              if (!loaded) throw new Error(`Plugin not found: ${row.plugin_id}`);
              const sqlDecl = loaded.plugin.manifest.sqlDriver;
              const hostServices = sqlDecl
                ? buildHostServices(sqlDecl.driver, creds[sqlDecl.credentialKey] ?? "")
                : undefined;
              const client = loaded.plugin.createClient(creds, hostServices);
              const topLevelTypes = getListableResourceTypes(loaded.plugin.resourceTypes);
              const results = await Promise.allSettled(
                topLevelTypes.map(async (t) => ({
                  typeLabel: t.pluralDisplayName,
                  count: (await client.listResources(t.id, row.account_id)).length,
                })),
              );
              const resourceCounts = results.flatMap((r) =>
                r.status === "fulfilled" && r.value.count > 0
                  ? [(r as PromiseFulfilledResult<{ typeLabel: string; count: number }>).value]
                  : [],
              );

              if (!cancelled) {
                setAccountConnected(row.account_id, true);
                setCardStatus((prev) => ({
                  ...prev,
                  [row.resource_id]: { phase: "ok", resourceCounts },
                }));
              }
            } catch (e) {
              if (!cancelled) {
                setCardStatus((prev) => ({
                  ...prev,
                  [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
                }));
              }
            }
            return;
          }

          const meta = pluginMeta[row.plugin_id];

          if (meta?.terminalResourceTypeIds.includes(row.resource_type_id)) {
            try {
              const loaded = await getPlugin(row.plugin_id);
              if (loaded) {
                const client = loaded.plugin.createClient(creds);
                const stats = client.fetchDashboardStats
                  ? await client.fetchDashboardStats(
                      row.resource_type_id,
                      row.resource_id,
                      row.account_id,
                    )
                  : undefined;
                if (!cancelled) {
                  setAccountConnected(row.account_id, true);
                  setCardStatus((prev) => ({
                    ...prev,
                    [row.resource_id]: {
                      phase: "ok",
                      stats,
                      sshTarget: true,
                      resourceId: row.resource_id,
                      accountId: row.account_id,
                    },
                  }));
                }
              }
            } catch {
              // Stats are best-effort decoration for SSH-target cards — the card's
              // purpose is connecting, so keep it usable without stats.
              if (!cancelled) {
                setAccountConnected(row.account_id, true);
                setCardStatus((prev) => ({
                  ...prev,
                  [row.resource_id]: {
                    phase: "ok",
                    sshTarget: true,
                    resourceId: row.resource_id,
                    accountId: row.account_id,
                  },
                }));
              }
            }
            return;
          }

          const loaded = await getPlugin(row.plugin_id);
          if (!loaded) return;
          const manifest = loaded.plugin.manifest;

          let hostServices: Parameters<typeof loaded.plugin.createClient>[1];
          if (manifest.sqlDriver) {
            const cs = creds[manifest.sqlDriver.credentialKey] ?? "";
            hostServices = buildHostServices(manifest.sqlDriver.driver, cs);
            setSqlSession(row.account_id, { connectionString: cs });
          } else if (manifest.kvDriver) {
            const cs = creds[manifest.kvDriver.credentialKey] ?? "";
            hostServices =
              manifest.kvDriver.driver === "memcached"
                ? buildMemcachedHostServices(manifest.kvDriver.driver, cs)
                : buildKvHostServices(manifest.kvDriver.driver, cs);
          } else if (manifest.dockerDriver) {
            const rawDockerHost = creds[manifest.dockerDriver.credentialKey] ?? "";
            const effectiveDockerHost = await resolveTunneledHost(row.account_id, rawDockerHost);
            hostServices = buildDockerHostServices(
              manifest.dockerDriver.driver,
              effectiveDockerHost,
            );
          }

          const client = loaded.plugin.createClient(creds, hostServices);

          // Cache the schema for SQL editor autocomplete on the detail page.
          if (manifest.sqlDriver && client.introspect) {
            const cs = creds[manifest.sqlDriver.credentialKey] ?? "";
            void client
              .introspect()
              .then((tables) => {
                if (tables && tables.length > 0) {
                  setSqlSession(row.account_id, {
                    connectionString: cs,
                    tablesJson: JSON.stringify(tables),
                  });
                }
              })
              .catch(() => undefined);
          }

          try {
            const stats = client.fetchDashboardStats
              ? await client.fetchDashboardStats(
                  row.resource_type_id,
                  row.resource_id,
                  row.account_id,
                )
              : undefined;

            let sparkline: Array<{ timestamp: number; value: number }> | undefined;
            let sparklineLabel: string | undefined;
            const resourceTypeDef = loaded.plugin.resourceTypes.find(
              (t) => t.id === row.resource_type_id,
            );
            if (resourceTypeDef?.supportsMetrics && client.fetchMetricSeries) {
              try {
                const series = await client.fetchMetricSeries(
                  row.resource_type_id,
                  row.resource_id,
                  row.account_id,
                );
                const first = series[0];
                if (first && first.points.length >= 2) {
                  sparkline = first.points;
                  sparklineLabel = first.label;
                }
              } catch {
                /* sparkline is non-critical */
              }
            }

            if (!cancelled) {
              setAccountConnected(row.account_id, true);
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "ok", stats, sparkline, sparklineLabel },
              }));
            }
          } catch (e) {
            if (!cancelled) {
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
              }));
            }
          }
        }),
      );
    }

    void connectAll();

    const interval = setInterval(() => {
      void connectAll();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pinned]);

  async function unpin(resourceId: string) {
    if (activeCloudOrgId) {
      await unpinCloudResource(activeCloudOrgId, dashboardId, resourceId);
    } else {
      const db = await getDb();
      await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1 AND dashboard_id = $2", [
        resourceId,
        dashboardId,
      ]);
    }
    setPinned((prev) => prev.filter((r) => r.resource_id !== resourceId));
  }

  async function unpinPinnedWorkflow(workflowId: string) {
    const db = await getDb();
    await unpinWorkflow(workflowId, dashboardId, db);
    setWorkflowPins((prev) => prev.filter((w) => w.workflowId !== workflowId));
  }

  async function saveName(name: string) {
    const trimmed = name.trim() || "Dashboard";
    setDashboardName(trimmed);
    setEditingName(false);
    if (activeCloudOrgId) {
      await renameCloudDashboard(activeCloudOrgId, dashboardId, trimmed);
    } else {
      const db = await getDb();
      await db.execute("UPDATE dashboards SET name = $1 WHERE id = $2", [trimmed, dashboardId]);
    }
    const tabsToRename = useUIStore
      .getState()
      .workspaceTabs.flatMap((tab) =>
        tab.target.kind === "dashboard" && tab.target.dashboardId === dashboardId ? [tab.id] : [],
      );
    for (const tabId of tabsToRename) {
      useUIStore.getState().setWorkspaceTabTitle(tabId, trimmed);
    }
  }

  async function deleteDashboard() {
    if (isHome) return;
    if (activeCloudOrgId) {
      await deleteCloudDashboard(activeCloudOrgId, dashboardId);
    } else {
      const db = await getDb();
      await db.execute("DELETE FROM dashboard_pins WHERE dashboard_id = $1", [dashboardId]);
      await db.execute("DELETE FROM dashboards WHERE id = $1", [dashboardId]);
    }
    removeWorkspaceTabs(
      useUIStore
        .getState()
        .workspaceTabs.flatMap((tab) =>
          tab.target.kind === "dashboard" && tab.target.dashboardId === dashboardId ? [tab.id] : [],
        ),
    );
    navigate({ to: "/" });
  }

  function goToResource(row: PinnedRow) {
    if (row.resource_type_id === "__account__") {
      void navigateToWorkspaceTarget(navigate, accountTabTarget(row.account_id), {
        label: row.display_name,
      });
    } else {
      void navigateToWorkspaceTarget(navigate, resourceTabTarget(row.account_id, row.resource_id), {
        label: row.display_name,
      });
    }
  }

  const costApi: CostApi = useMemo(
    () => ({
      queryCosts: (req) => {
        const orgId = useUIStore.getState().activeCloudOrgId;
        if (!orgId) return Promise.reject(new Error("Cost graphs require cloud mode"));
        return queryCloudCosts(orgId, req);
      },
      loadDimensionValues: (dimension, tagKey) => {
        const orgId = useUIStore.getState().activeCloudOrgId;
        if (!orgId) return Promise.resolve([]);
        return loadCloudCostDimensionValues(orgId, dimension, tagKey);
      },
      loadCostStatus: () => {
        const orgId = useUIStore.getState().activeCloudOrgId;
        if (!orgId) return Promise.resolve([]);
        return loadCloudCostStatus(orgId);
      },
    }),
    [],
  );

  const refetchBudgets = useCallback(async () => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) return;
    try {
      const rows = await listCloudBudgets(orgId);
      setBudgets(new Map(rows.map((b) => [b.id, b])));
    } catch (e) {
      // Without their row a budget card sits on its loading skeleton forever,
      // which is indistinguishable from a slow network.
      toast.error("Couldn't load budgets", { description: formatErrorMessage(e) });
    }
  }, []);

  async function removeWidget(widgetId: string) {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) return;
    await deleteCloudWidget(orgId, widgetId);
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
  }

  async function saveCostWidget(
    widget: DashboardWidget | null,
    title: string,
    config: CostGraphConfig,
  ) {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) return;
    if (widget) {
      const updated = await updateCloudWidget(orgId, widget.id, { title, config });
      setWidgets((prev) => prev.map((w) => (w.id === widget.id ? { ...w, ...updated } : w)));
    } else {
      const created = await createCloudWidget(orgId, {
        dashboardId,
        kind: "cost_graph",
        title,
        config,
      });
      setWidgets((prev) => [...prev, created]);
    }
  }

  async function saveBudgetWidget(widget: DashboardWidget | null, input: BudgetInput) {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) return;
    if (widget) {
      await updateCloudBudget(orgId, (widget.config as { budgetId: string }).budgetId, input);
    } else {
      const budget = await createCloudBudget(orgId, input);
      const created = await createCloudWidget(orgId, {
        dashboardId,
        kind: "budget",
        title: input.name,
        config: { version: 1, budgetId: budget.id },
      });
      setWidgets((prev) => [...prev, created]);
    }
    await refetchBudgets();
  }

  /** Show a budget that already exists on this dashboard. */
  async function addExistingBudget(budget: BudgetWithStatus) {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) return;
    const created = await createCloudWidget(orgId, {
      dashboardId,
      kind: "budget",
      title: budget.name,
      config: { version: 1, budgetId: budget.id },
    });
    setWidgets((prev) => [...prev, created]);
    await refetchBudgets();
  }

  const loadAllBudgets = useCallback(() => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    return orgId ? listCloudBudgets(orgId) : Promise.resolve([]);
  }, []);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        Loading…
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        Dashboard not found.
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col h-full transition-colors ${isOver ? "bg-accent-muted/20" : ""}`}
    >
      <div className="px-8 pt-8 pb-4 border-b border-border/50 flex items-center justify-between">
        <div>
          {editingName ? (
            <input
              ref={nameInputRef}
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
            <h1
              className="text-2xl font-semibold text-on-surface cursor-default hover:text-white"
              onDoubleClick={() => setEditingName(true)}
              title="Double-click to rename"
            >
              {dashboardName}
            </h1>
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

      <div className="flex-1 overflow-auto px-8 py-6">
        <CostCollectionNotice
          statuses={costStatus}
          onOpenExternal={(url) => void invoke("open_external_url", { url })}
        />
        {pinned.length === 0 && workflowPins.length === 0 && widgets.length === 0 ? (
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                activeCloudOrgId ? setAddMenuOpen((v) => !v) : setSpotlightMode("pin")
              }
              className={`w-full flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed transition-colors ${isOver ? "border-blue-500 text-accent" : "border-border text-on-surface-faint hover:border-border-strong hover:text-on-surface-muted"}`}
            >
              <span className="text-3xl mb-3">⊞</span>
              <p className="text-sm">
                {activeCloudOrgId ? "Click to add to this dashboard" : "Click to add a resource"}
              </p>
              <p className="text-xs mt-1 opacity-60">or drag a resource or workflow here</p>
            </button>
            {addMenuOpen && (
              <DashboardAddMenu
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
                onPickExistingBudget={() => {
                  setAddMenuOpen(false);
                  setBudgetPickerOpen(true);
                }}
                onClose={() => setAddMenuOpen(false)}
              />
            )}
          </div>
        ) : (
          <SortableContext
            items={cards.map((c) => `dashboard-card:${dashboardCardId(c.kind, c.id)}`)}
            strategy={rectSortingStrategy}
          >
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
            >
              {cards.map((card) => (
                <SortableDashboardCard
                  key={dashboardCardId(card.kind, card.id)}
                  id={dashboardCardId(card.kind, card.id)}
                  // The wrapper is the grid item, so a cost graph's span
                  // belongs here rather than on the card.
                  className={
                    card.kind === "widget" && card.widget.kind === "cost_graph"
                      ? "col-span-2"
                      : undefined
                  }
                >
                  {card.kind === "resource" ? (
                    <ResourceCard
                      row={card.row}
                      pluginMeta={pluginMeta[card.row.plugin_id]}
                      status={cardStatus[card.row.resource_id]}
                      onOpen={() => goToResource(card.row)}
                      onUnpin={() => void unpin(card.row.resource_id)}
                      onConnect={
                        cardStatus[card.row.resource_id]?.sshTarget
                          ? () => goToResource(card.row)
                          : undefined
                      }
                    />
                  ) : card.kind === "workflow" ? (
                    <WorkflowPinCard
                      workflowId={card.workflowPin.workflowId}
                      onOpen={() =>
                        void navigateToWorkspaceTarget(navigate, workflowsTabTarget(), {
                          label: "Workflows",
                        })
                      }
                      onUnpin={() => void unpinPinnedWorkflow(card.workflowPin.workflowId)}
                    />
                  ) : card.widget.kind === "cost_graph" ? (
                    <CostGraphCard
                      title={card.widget.title}
                      config={card.widget.config as CostGraphConfig}
                      api={costApi}
                      onEdit={() => setCostModal({ widget: card.widget })}
                      onRemove={() => void removeWidget(card.widget.id)}
                    />
                  ) : (
                    <BudgetWidgetCard
                      budget={budgets.get((card.widget.config as { budgetId: string }).budgetId)}
                      onEdit={() => setBudgetModal({ widget: card.widget })}
                      onRemove={() => void removeWidget(card.widget.id)}
                    />
                  )}
                </SortableDashboardCard>
              ))}

              <div className="relative min-h-[140px]">
                <button
                  type="button"
                  onClick={() =>
                    activeCloudOrgId ? setAddMenuOpen((v) => !v) : setSpotlightMode("pin")
                  }
                  className={`w-full h-full rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-1.5 transition-colors ${isOver ? "border-blue-500 text-accent bg-accent-muted" : "border-border text-on-surface-faint hover:border-border-strong hover:text-on-surface-muted"}`}
                >
                  <span className="text-2xl">+</span>
                  <span className="text-xs">{activeCloudOrgId ? "Add" : "Add resource"}</span>
                </button>
                {addMenuOpen && (
                  <DashboardAddMenu
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
                    onPickExistingBudget={() => {
                      setAddMenuOpen(false);
                      setBudgetPickerOpen(true);
                    }}
                    onClose={() => setAddMenuOpen(false)}
                  />
                )}
              </div>
            </div>
          </SortableContext>
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

        {budgetPickerOpen && (
          <BudgetPickerModal
            loadBudgets={loadAllBudgets}
            excludeIds={widgets
              .filter((w) => w.kind === "budget")
              .map((w) => (w.config as { budgetId: string }).budgetId)}
            onPick={addExistingBudget}
            onClose={() => setBudgetPickerOpen(false)}
          />
        )}

        {spotlightMode && (
          <SpotlightSearch
            dashboardId={dashboardId}
            mode={spotlightMode}
            onClose={() => setSpotlightMode(null)}
            onPinned={() => {
              bumpDashboardPins();
              setSpotlightMode(null);
            }}
            onNavigate={(result) => {
              setSpotlightMode(null);
              void navigateToWorkspaceTarget(
                navigate,
                resourceTabTarget(result.accountId, result.id),
                { label: result.displayName },
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

function DashboardAddMenu({
  onPickResource,
  onPickCostGraph,
  onPickBudget,
  onPickExistingBudget,
  onClose,
}: {
  onPickResource: () => void;
  onPickCostGraph: () => void;
  onPickBudget: () => void;
  onPickExistingBudget: () => void;
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
      {/* Mouse-only click-away backdrop; keyboard users close the menu with Escape (handled above). */}
      <div aria-hidden="true" className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 w-52 rounded-xl border border-border bg-surface-raised shadow-xl overflow-hidden py-1">
        <button type="button" onClick={onPickResource} className={itemClass}>
          <span className="text-on-surface-faint">▣</span> Pin a resource
        </button>
        <button type="button" onClick={onPickCostGraph} className={itemClass}>
          <span className="text-on-surface-faint">▤</span> Cost graph
        </button>
        <button type="button" onClick={onPickBudget} className={itemClass}>
          <span className="text-on-surface-faint">◔</span> New budget
        </button>
        <button type="button" onClick={onPickExistingBudget} className={itemClass}>
          <span className="text-on-surface-faint">◕</span> Existing budget
        </button>
      </div>
    </>
  );
}
