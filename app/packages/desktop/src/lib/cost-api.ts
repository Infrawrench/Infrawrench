import { t } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import type { CostApi } from "@infrawrench/ui/cost";
import type { CostAnnotationInput, SavedCostFilterInput } from "@infrawrench/client-core";
import {
  createCloudCostAnnotation,
  createCloudSavedCostFilter,
  deleteCloudCostAnnotation,
  listCloudBusinessMetrics,
  listCloudCostAnnotations,
  listCloudCostScenarioModels,
  listCloudSavedCostFilters,
  loadCloudCostDimensionValues,
  loadCloudCostStatus,
  queryCloudCosts,
  queryCloudUnitCosts,
  updateCloudCostAnnotation,
} from "./cloud-costs";

/**
 * Costs are cloud-only: spend is collected server-side, so a desktop app in
 * local mode has nothing to show. Every call resolves the active org at call
 * time rather than closing over it — the org can change under a mounted panel
 * when the user switches org.
 */
export function requireCloudOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error(t("Costs require cloud mode — sign in to sync."));
  return orgId;
}

/**
 * The read-only cost calls every desktop cost surface shares: the dashboard's
 * cost cards, the Costs panel and the Cost reports page all render the same
 * components, so all three need the same `CostApi`.
 *
 * One definition on purpose. The graph editor's scenario, saved-filter and
 * unit-cost pickers render only when their loader is present, so a surface that
 * hand-rolls a smaller literal silently loses them — which is exactly what had
 * happened to the dashboard. The mirror of web's `createWebCostApi`.
 *
 * The list reads resolve empty in local mode rather than rejecting: a cost card
 * on a local dashboard should look like "nothing collected", not like an error.
 * The two that cannot answer without an org are `async`, so a local-mode call
 * *rejects* rather than throwing synchronously — `CostGraphCard` queries from an
 * effect with a `.catch()` and no `try`, where a sync throw would escape.
 */
export function createDesktopCostApi(): CostApi {
  return {
    queryCosts: async (req) => queryCloudCosts(requireCloudOrgId(), req),
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
    // Saved filters ride the base cost API because every surface that can
    // author a filter (graph modal, budget modal, report editor) offers the
    // picker and "Save these rows as a filter…". Management lives on the
    // Costs panel, which adds the mutating half to this.
    listSavedFilters: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return listCloudSavedCostFilters(orgId);
    },
    createSavedFilter: (input: SavedCostFilterInput) =>
      createCloudSavedCostFilter(requireCloudOrgId(), input),
    // Scenario models ride the base cost API for the same reason: the picker in
    // the graph editor needs the list, and so does the card that labels an
    // applied scenario.
    listScenarioModels: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return listCloudCostScenarioModels(orgId);
    },
    // Dated notes drawn over the chart. An org-wide note belongs on every cost
    // chart — the dashboard card as much as the saved report. The writes are
    // wired unconditionally (the server enforces `costs:write`), so a viewer's
    // 403 surfaces as the action's error rather than as a missing button.
    listCostAnnotations: (reportId?: string) => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return listCloudCostAnnotations(orgId, reportId);
    },
    createCostAnnotation: (input: CostAnnotationInput) =>
      createCloudCostAnnotation(requireCloudOrgId(), input),
    updateCostAnnotation: (annotationId: string, input: CostAnnotationInput) =>
      updateCloudCostAnnotation(requireCloudOrgId(), annotationId, input),
    deleteCostAnnotation: (annotationId: string) =>
      deleteCloudCostAnnotation(requireCloudOrgId(), annotationId),
    // Business metrics ride the base cost API for the same reason saved filters
    // do: the unit-cost picker in the graph editor needs them, and so does the
    // card that divides spend by one.
    listBusinessMetrics: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return listCloudBusinessMetrics(orgId);
    },
    queryUnitCosts: async (metricId, request) =>
      queryCloudUnitCosts(requireCloudOrgId(), metricId, request),
  };
}
