import type {
  CostFetchRange,
  CostRow,
  QuotaUsage,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PeerPaneContext,
  PeerPaneSchema,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

import type { K8sList, K8sNamespace, ParsedKubeconfig } from "./types.js";
import { parseKubeconfig } from "./types.js";

import {
  renderClusterDetail,
  renderGenericDetail,
  renderNamespaceDetail,
  renderPodDetail,
  renderDeploymentDetail,
  renderServiceDetail,
  renderStatefulSetDetail,
  renderDaemonSetDetail,
  renderJobDetail,
  renderCronJobDetail,
  renderIngressDetail,
  renderConfigMapDetail,
  renderSecretDetail,
} from "./detail-renderers.js";

import * as listers from "./resource-listers.js";
import type { ListerContext } from "./resource-listers.js";

import { K8sFetcher, buildResourcePath } from "./shared.js";
import { fetchDashboardStats } from "./dashboard-stats.js";
import { getCreateConfig } from "./create-config.js";
import { createResource } from "./create-resource.js";
import { getLogs } from "./logs.js";
import { applyManifest, describeResource, getManifest, importYaml } from "./manifest-ops.js";
import { renderPeerPane } from "./peer-pane.js";
import { computeClusterCost, type ClusterCostResult } from "./cluster-cost.js";
import { buildCostIndex, type CostIndex } from "./cost-surface.js";
import { parseNodeRates, type NodeRateTable } from "./node-rates.js";
import { allocationToCostRows } from "./cost-data.js";
import { fetchK8sQuotas } from "./quotas.js";
import { buildCostMetricSeries } from "./metric-series.js";

/**
 * How long a cost snapshot is reused.
 *
 * One peer-pane render asks for the allocation from several places (pill
 * subtitles, dashboard stats, the namespace table) and each computation is
 * three cluster-wide list calls. 30s is long enough to collapse those into
 * one pass and short enough that a refresh after scaling a Deployment shows
 * the new number.
 */
const COST_CACHE_MS = 30_000;

/**
 * Kubernetes plugin client. This is a thin composition layer: it parses the
 * kubeconfig, owns a shared `K8sFetcher` for HTTP machinery, and delegates
 * each PluginClient method to a focused module in this package.
 */
export class KubernetesClient implements PluginClient {
  private readonly parsed: ParsedKubeconfig;
  private readonly services?: HostServices;
  private readonly fetcher: K8sFetcher;
  private readonly rates: NodeRateTable;
  private costCache: { at: number; promise: Promise<ClusterCostResult> } | null = null;
  /**
   * The most recent successful cost index. `renderDetail` is synchronous — it
   * cannot await an allocation — so it renders the cost table from whatever
   * the last async pass (dashboard stats, peer pane, metrics) computed, and
   * omits the table entirely on a cold client. That is why the cost sections
   * are all conditional rather than showing "loading".
   */
  private lastCostIndex: CostIndex | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
    // Node prices arrive from the parent cloud plugin through the peer
    // integration's credentialMappings, or from the optional field on a
    // standalone Kubernetes account. Absent means "no money", not "free".
    this.rates = parseNodeRates(credentials["nodeHourlyRates"]);
    if (services) this.services = services;
    // When the host k8s driver is available it owns all auth via the
    // official SDK, so the hand-rolled parser's output is unused. Wrap the
    // parse in try/catch so kubeconfigs the hand-rolled path can't make
    // sense of (exec creds, OIDC) still work via the driver.
    try {
      this.parsed = parseKubeconfig(kubeconfig);
    } catch (err) {
      if (!this.services?.k8s) throw err;
      this.parsed = { server: "" };
    }
    this.fetcher = new K8sFetcher(this.parsed, this.services);
  }

  private k8sFetch = <T>(path: string, options?: RequestInit): Promise<T> => {
    return this.fetcher.fetch<T>(path, options);
  };

  private get listerCtx(): ListerContext {
    return { k8sFetch: this.k8sFetch };
  }

  /** Cost allocation, cached briefly and shared by every surface. */
  private clusterCost(): Promise<ClusterCostResult> {
    const now = Date.now();
    if (this.costCache && now - this.costCache.at < COST_CACHE_MS) return this.costCache.promise;
    const promise = computeClusterCost(this.k8sFetch, this.rates);
    this.costCache = { at: now, promise };
    return promise;
  }

  /**
   * Cost allocation for display. Swallows failures: a cluster whose node list
   * is forbidden, or which has no metrics-server, still renders everything
   * else. Nothing about cost is allowed to break a listing.
   */
  private async costIndex(): Promise<CostIndex | undefined> {
    try {
      const result = await this.clusterCost();
      const index = buildCostIndex(
        result.allocation,
        result.rateSource,
        result.utilization.status,
        new Date().toISOString(),
      );
      this.lastCostIndex = index;
      return index;
    } catch {
      this.costCache = null;
      return undefined;
    }
  }

  async listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "k8s-cluster":
        return listers.listClusters(this.listerCtx, accountId);
      case "k8s-namespace":
        return listers.listNamespaces(this.listerCtx, accountId);
      case "k8s-node":
        return listers.listNodes(this.listerCtx, accountId);
      case "k8s-pod":
        return listers.listPods(this.listerCtx, accountId);
      case "k8s-deployment":
        return listers.listDeployments(this.listerCtx, accountId);
      case "k8s-service":
        // The host passes the create-form `namespace` field as a region hint;
        // services are namespace-scoped, so use it to scope the picker.
        return listers.listServices(this.listerCtx, accountId, opts?.regionHint);
      case "k8s-statefulset":
        return listers.listStatefulSets(this.listerCtx, accountId);
      case "k8s-daemonset":
        return listers.listDaemonSets(this.listerCtx, accountId);
      case "k8s-job":
        return listers.listJobs(this.listerCtx, accountId);
      case "k8s-cronjob":
        return listers.listCronJobs(this.listerCtx, accountId);
      case "k8s-ingress":
        return listers.listIngresses(this.listerCtx, accountId);
      case "k8s-configmap":
        return listers.listConfigMaps(this.listerCtx, accountId);
      case "k8s-secret":
        return listers.listSecrets(this.listerCtx, accountId);
      default:
        throw new Error(`Kubernetes plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Kubernetes plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    if (typeId === "k8s-cluster" && outputKey === "serverVersion") {
      try {
        const data = await this.k8sFetch<{ gitVersion: string }>("/version");
        return data.gitVersion;
      } catch {
        return "unknown";
      }
    }
    if (typeId === "k8s-service" && outputKey === "serviceName") {
      // Resource id is `${accountId}:k8s-service:${namespace}:${name}`.
      return resourceId.split(":").pop() ?? "";
    }
    throw new Error(`Kubernetes plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const [resource, costs] = await Promise.all([
      this.getResource(resourceTypeId, resourceId, accountId),
      this.costIndex(),
    ]);
    return fetchDashboardStats(resource, this.k8sFetch, costs);
  }

  /**
   * Time series for the Metrics tab. Also what the *cloud* cluster resource
   * shows on its own Metrics tab: the six managed-Kubernetes resource types
   * set `exposeMetricsToParent` on their kubernetes peer integration, so the
   * host calls this with the peer's credentials and merges the result into the
   * parent's chart.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const costs = await this.costIndex();
    if (!costs) return [];

    // The parent cloud cluster asks with its own resource type id, which is
    // not one of ours (doks-cluster, gke-cluster, …). Treat anything we don't
    // recognise as "the whole cluster" — that is what the parent is.
    const known = new Set([
      "k8s-cluster",
      "k8s-namespace",
      "k8s-pod",
      "k8s-deployment",
      "k8s-statefulset",
      "k8s-daemonset",
    ]);
    if (!known.has(resourceTypeId)) {
      return buildCostMetricSeries("k8s-cluster", {}, "cluster", costs, timeRange);
    }

    const resource = await this.getResource(resourceTypeId, resourceId, accountId).catch(
      () => null,
    );
    if (!resource) return [];
    return buildCostMetricSeries(
      resourceTypeId,
      resource.fields,
      resource.displayName,
      costs,
      timeRange,
    );
  }

  /**
   * Derived per-namespace / per-workload allocation, written as daily cost
   * rows. Not billed amounts — see `cost-data.ts`.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const result = await this.clusterCost();
    return allocationToCostRows(result.allocation, range);
  }

  /**
   * Quota readings from the cluster's own `ResourceQuota` objects — one
   * unpaginated list across every namespace. See `quotas.ts` for why node
   * capacity and `LimitRange` are deliberately not in here.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    return fetchK8sQuotas({ fetch: this.k8sFetch });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const costs = this.lastCostIndex;
    switch (resource.resourceTypeId) {
      case "k8s-cluster":
        return renderClusterDetail(resource, costs);
      case "k8s-namespace":
        return renderNamespaceDetail(resource, costs);
      case "k8s-pod":
        return renderPodDetail(resource, costs);
      case "k8s-deployment":
        return renderDeploymentDetail(resource, costs);
      case "k8s-service":
        return renderServiceDetail(resource);
      case "k8s-statefulset":
        return renderStatefulSetDetail(resource, costs);
      case "k8s-daemonset":
        return renderDaemonSetDetail(resource, costs);
      case "k8s-job":
        return renderJobDetail(resource);
      case "k8s-cronjob":
        return renderCronJobDetail(resource);
      case "k8s-ingress":
        return renderIngressDetail(resource);
      case "k8s-configmap":
        return renderConfigMapDetail(resource);
      case "k8s-secret":
        return renderSecretDetail(resource);
      default:
        return renderGenericDetail(resource);
    }
  }

  async listNamespacesForImport(_accountId: string): Promise<string[]> {
    const data = await this.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
    return data.items.map((ns) => ns.metadata.name).sort();
  }

  async importSecret(
    _accountId: string,
    config: { namespace: string; secretName: string; data: Record<string, string> },
  ): Promise<void> {
    const encoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.data)) {
      encoded[key] = btoa(value);
    }

    await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/secrets`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: config.secretName,
          namespace: config.namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        type: "Opaque",
        data: encoded,
      }),
    });
  }

  async renderPeerPane(context: PeerPaneContext): Promise<PeerPaneSchema> {
    // The peer pane shares the client's cost cache rather than recomputing:
    // one render touches the allocation from several places.
    return renderPeerPane(context, this.listerCtx, () => this.costIndex());
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(typeId, parentResourceId, this.k8sFetch);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return createResource(typeId, accountId, fields, parentResourceId, this.k8sFetch);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const path = buildResourcePath(resourceId);
    await this.k8sFetch(path, { method: "DELETE" });
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    return getManifest(resourceId, this.k8sFetch);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    return applyManifest(resourceId, manifest, this.k8sFetch);
  }

  async importYaml(_accountId: string, yamlText: string): Promise<{ applied: number }> {
    return importYaml(yamlText, this.k8sFetch);
  }

  async describeResource(typeId: string, resourceId: string, _accountId: string): Promise<string> {
    return describeResource(typeId, resourceId, this.k8sFetch);
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    return getLogs(typeId, resourceId, params, this.fetcher);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }
}
