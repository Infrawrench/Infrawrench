import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
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
  renderGenericDetail,
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

/**
 * Kubernetes plugin client. This is a thin composition layer: it parses the
 * kubeconfig, owns a shared `K8sFetcher` for HTTP machinery, and delegates
 * each PluginClient method to a focused module in this package.
 */
export class KubernetesClient implements PluginClient {
  private readonly parsed: ParsedKubeconfig;
  private readonly services?: HostServices;
  private readonly fetcher: K8sFetcher;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
    this.parsed = parseKubeconfig(kubeconfig);
    if (services) this.services = services;
    this.fetcher = new K8sFetcher(this.parsed, this.services);
  }

  private k8sFetch = <T>(path: string, options?: RequestInit): Promise<T> => {
    return this.fetcher.fetch<T>(path, options);
  };

  private get listerCtx(): ListerContext {
    return { k8sFetch: this.k8sFetch };
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "k8s-cluster":
        return listers.listClusters(this.listerCtx, accountId);
      case "k8s-namespace":
        return listers.listNamespaces(this.listerCtx, accountId);
      case "k8s-pod":
        return listers.listPods(this.listerCtx, accountId);
      case "k8s-deployment":
        return listers.listDeployments(this.listerCtx, accountId);
      case "k8s-service":
        return listers.listServices(this.listerCtx, accountId);
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
    _resourceId: string,
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
    throw new Error(`Kubernetes plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    return fetchDashboardStats(resource, this.k8sFetch);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "k8s-pod":
        return renderPodDetail(resource);
      case "k8s-deployment":
        return renderDeploymentDetail(resource);
      case "k8s-service":
        return renderServiceDetail(resource);
      case "k8s-statefulset":
        return renderStatefulSetDetail(resource);
      case "k8s-daemonset":
        return renderDaemonSetDetail(resource);
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
    return renderPeerPane(context, this.listerCtx);
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
