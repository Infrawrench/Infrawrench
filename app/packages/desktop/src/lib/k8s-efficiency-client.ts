/**
 * The desktop Kubernetes efficiency client (cloud mode): report calls are
 * typed calls to the contract's `k8sEfficiencyReports` domain over the cloud
 * transport (`./cloud-client.ts`), folders go through the cost-report folder
 * client and sharing through the settings transport. Built per org, like the
 * Canvases client.
 */
import { Schema } from "effect";
import {
  K8S_EFFICIENCY_FILTER_DIMENSIONS,
  type CostFilter,
  type KubernetesEfficiencyConfig,
  type KubernetesEfficiencyReportInput,
} from "@infrawrench/client-core";
import type { KubernetesEfficiencyClient } from "@infrawrench/ui/k8s-efficiency";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";
import { listCloudCostReportFolders } from "./cloud-costs";
import { createDesktopSharingClient } from "./cost-reports-client";

const reports = () => cloudClient("k8sEfficiencyReports").k8sEfficiencyReports;

const isFilterDimension = Schema.is(Schema.Literals(K8S_EFFICIENCY_FILTER_DIMENSIONS));
const isFilterOp = Schema.is(Schema.Literals(["in", "not_in"]));

/**
 * A filter as the endpoint takes it. client-core types the config's filters
 * as any cost filter; a Kubernetes efficiency report reads only the
 * `account`, `region` and `tag` dimensions with `in`/`not_in` (the editor
 * offers nothing else), so anything wider is refused before sending, as the
 * server would refuse it.
 */
function filterPayload(filter: CostFilter) {
  const { dimension, op } = filter;
  if (!isFilterDimension(dimension) || !isFilterOp(op)) {
    throw new Error(
      `Kubernetes efficiency reports filter on account, region or tag with in or not_in, not ${dimension} ${op}`,
    );
  }
  return {
    dimension,
    op,
    values: filter.values,
    ...(filter.tagKey !== undefined ? { tagKey: filter.tagKey } : {}),
  };
}

/** The config the endpoint takes: the optional keys the editor leaves `undefined` are dropped. */
function configPayload(config: KubernetesEfficiencyConfig) {
  return {
    version: config.version,
    dateRange: config.dateRange,
    granularity: config.granularity,
    filters: config.filters.map(filterPayload),
    groupBy: config.groupBy,
    ...(config.groupByLabelKey !== undefined ? { groupByLabelKey: config.groupByLabelKey } : {}),
    ...(config.categories !== undefined ? { categories: config.categories } : {}),
    idle: config.idle,
    basis: config.basis,
  };
}

function reportPayload(input: KubernetesEfficiencyReportInput) {
  return {
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    config: configPayload(input.config),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
  };
}

export function createDesktopKubernetesEfficiencyClient(orgId: string): KubernetesEfficiencyClient {
  return {
    sharing: createDesktopSharingClient(),
    listReports: () => runRpc(reports().list({ params: { orgId } })),
    getReport: (reportId: string) => runRpc(reports().get({ params: { orgId, id: reportId } })),
    runReport: (reportId: string) => runRpc(reports().run({ params: { orgId, id: reportId } })),
    query: async (config: KubernetesEfficiencyConfig) =>
      runRpc(reports().query({ params: { orgId }, payload: { config: configPayload(config) } })),
    getOptions: () => runRpc(reports().options({ params: { orgId } })),
    getTagValues: async (tagKey: string) =>
      (await runRpc(reports().values({ params: { orgId }, query: { tagKey } }))).values,
    listFolders: () => listCloudCostReportFolders(orgId),
    createReport: async (input: KubernetesEfficiencyReportInput) =>
      runRpc(reports().create({ params: { orgId }, payload: reportPayload(input) })),
    updateReport: async (reportId: string, input: KubernetesEfficiencyReportInput) =>
      runRpc(reports().update({ params: { orgId, id: reportId }, payload: reportPayload(input) })),
    deleteReport: async (reportId: string) => {
      await runRpc(reports().delete({ params: { orgId, id: reportId } }));
    },
  };
}
