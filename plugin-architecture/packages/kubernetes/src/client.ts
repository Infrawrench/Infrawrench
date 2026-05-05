import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  PeerPaneContext,
  PeerPaneSchema,
  PeerPaneResourceGroup,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

import type {
  K8sList,
  K8sNamespace,
  K8sPod,
  K8sDeployment,
  K8sService,
  K8sStatefulSet,
  K8sDaemonSet,
  K8sJob,
  K8sCronJob,
  K8sIngress,
  K8sConfigMap,
  K8sSecret,
  K8sEvent,
  ParsedKubeconfig,
} from "./types.js";
import { parseKubeconfig } from "./types.js";

import yaml from "js-yaml";

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

import {
  namespacePeerGroup,
  podPeerGroup,
  deploymentPeerGroup,
  statefulSetPeerGroup,
  daemonSetPeerGroup,
  servicePeerGroup,
  ingressPeerGroup,
  jobPeerGroup,
  cronJobPeerGroup,
} from "./peer-groups.js";

import * as listers from "./resource-listers.js";
import type { ListerContext } from "./resource-listers.js";
import { SYSTEM_NAMESPACES } from "./resource-listers.js";

function k8sApiForKind(kind: string): { plural: string; namespaced: boolean } | null {
  switch (kind) {
    case "Pod":
      return { plural: "pods", namespaced: true };
    case "Service":
      return { plural: "services", namespaced: true };
    case "Deployment":
      return { plural: "deployments", namespaced: true };
    case "StatefulSet":
      return { plural: "statefulsets", namespaced: true };
    case "DaemonSet":
      return { plural: "daemonsets", namespaced: true };
    case "ReplicaSet":
      return { plural: "replicasets", namespaced: true };
    case "Job":
      return { plural: "jobs", namespaced: true };
    case "CronJob":
      return { plural: "cronjobs", namespaced: true };
    case "Ingress":
      return { plural: "ingresses", namespaced: true };
    case "IngressClass":
      return { plural: "ingressclasses", namespaced: false };
    case "ConfigMap":
      return { plural: "configmaps", namespaced: true };
    case "Secret":
      return { plural: "secrets", namespaced: true };
    case "Namespace":
      return { plural: "namespaces", namespaced: false };
    case "ServiceAccount":
      return { plural: "serviceaccounts", namespaced: true };
    case "PersistentVolumeClaim":
      return { plural: "persistentvolumeclaims", namespaced: true };
    case "PersistentVolume":
      return { plural: "persistentvolumes", namespaced: false };
    case "StorageClass":
      return { plural: "storageclasses", namespaced: false };
    case "Role":
      return { plural: "roles", namespaced: true };
    case "RoleBinding":
      return { plural: "rolebindings", namespaced: true };
    case "ClusterRole":
      return { plural: "clusterroles", namespaced: false };
    case "ClusterRoleBinding":
      return { plural: "clusterrolebindings", namespaced: false };
    case "HorizontalPodAutoscaler":
      return { plural: "horizontalpodautoscalers", namespaced: true };
    case "NetworkPolicy":
      return { plural: "networkpolicies", namespaced: true };
    case "PodDisruptionBudget":
      return { plural: "poddisruptionbudgets", namespaced: true };
    case "Endpoints":
      return { plural: "endpoints", namespaced: true };
    case "ResourceQuota":
      return { plural: "resourcequotas", namespaced: true };
    case "LimitRange":
      return { plural: "limitranges", namespaced: true };
    default:
      return null;
  }
}

function k8sKindForType(typeId: string): string {
  switch (typeId) {
    case "k8s-pod":
      return "Pod";
    case "k8s-deployment":
      return "Deployment";
    case "k8s-service":
      return "Service";
    case "k8s-statefulset":
      return "StatefulSet";
    case "k8s-daemonset":
      return "DaemonSet";
    case "k8s-job":
      return "Job";
    case "k8s-cronjob":
      return "CronJob";
    case "k8s-ingress":
      return "Ingress";
    case "k8s-configmap":
      return "ConfigMap";
    case "k8s-secret":
      return "Secret";
    case "k8s-namespace":
      return "Namespace";
    default:
      return typeId;
  }
}

function formatAge(isoTimestamp: string | undefined): string {
  if (!isoTimestamp) return "<unknown>";
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (isNaN(ms) || ms < 0) return "<unknown>";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatEventAge(evt: K8sEvent): string {
  const ts = evt.lastTimestamp ?? evt.eventTime ?? evt.firstTimestamp;
  return formatAge(ts);
}

function formatDescribe(kind: string, obj: Record<string, unknown>, events: K8sEvent[]): string {
  const lines: string[] = [];
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  lines.push(`Name:         ${meta["name"] ?? ""}`);
  if (meta["namespace"]) lines.push(`Namespace:    ${meta["namespace"]}`);
  lines.push(`Kind:         ${kind}`);
  if (meta["creationTimestamp"]) {
    lines.push(
      `Created:      ${String(meta["creationTimestamp"])} (${formatAge(String(meta["creationTimestamp"]))} ago)`,
    );
  }
  const labels = meta["labels"] as Record<string, string> | undefined;
  if (labels && Object.keys(labels).length > 0) {
    lines.push("Labels:");
    for (const [k, v] of Object.entries(labels)) lines.push(`              ${k}=${v}`);
  }
  const annotations = meta["annotations"] as Record<string, string> | undefined;
  if (annotations && Object.keys(annotations).length > 0) {
    lines.push("Annotations:");
    for (const [k, v] of Object.entries(annotations)) lines.push(`              ${k}: ${v}`);
  }

  lines.push("");
  lines.push("Spec / Status:");
  lines.push("--------------");
  const { metadata: _m, ...rest } = obj as { metadata?: unknown } & Record<string, unknown>;
  const yamlBody = yaml.dump(rest, { lineWidth: 120, noRefs: true, sortKeys: false });
  for (const line of yamlBody.split("\n")) lines.push(line ? `  ${line}` : "");

  lines.push("");
  lines.push("Events:");
  if (events.length === 0) {
    lines.push("  <none>");
  } else {
    lines.push("  Type       Reason           Age     From              Message");
    lines.push("  ----       ------           ----    ----              -------");
    for (const e of [...events].sort((a, b) => {
      const ta = new Date(a.lastTimestamp ?? a.eventTime ?? a.firstTimestamp ?? 0).getTime();
      const tb = new Date(b.lastTimestamp ?? b.eventTime ?? b.firstTimestamp ?? 0).getTime();
      return tb - ta;
    })) {
      const type = (e.type ?? "").padEnd(10);
      const reason = (e.reason ?? "").padEnd(16);
      const age = formatEventAge(e).padEnd(7);
      const from = (e.source?.component ?? "").padEnd(17);
      const msg = (e.message ?? "").replace(/\s+/g, " ");
      lines.push(`  ${type} ${reason} ${age} ${from} ${msg}`);
    }
  }

  return lines.join("\n");
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: string; hostname?: string; message?: string };
    if (c.code && c.hostname) return `${c.code} (${c.hostname})`;
    if (c.code) return c.code;
    if (c.message) return c.message;
  }
  return err.message;
}

export class KubernetesClient implements PluginClient {
  private readonly parsed: ParsedKubeconfig;
  private readonly services?: HostServices;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
    this.parsed = parseKubeconfig(kubeconfig);
    if (services) this.services = services;
  }

  private async k8sFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const { server, token, caCertData } = this.parsed;
    if (!server) throw new Error("Kubernetes plugin: no server in kubeconfig");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string> | undefined) ?? {}),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (caCertData && this.services?.http) {
      const caPem = atob(caCertData);
      let result;
      try {
        result = await this.services.http.request({
          url: `${server}${path}`,
          method: options?.method ?? "GET",
          headers,
          ...(options?.body ? { body: String(options.body) } : {}),
          caCert: caPem,
        });
      } catch (err) {
        throw new Error(
          `Kubernetes API unreachable at ${server}${path}: ${describeFetchError(err)}`,
        );
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`K8s API error ${result.status} at ${server}${path}: ${result.body}`);
      }
      return JSON.parse(result.body) as T;
    }

    let res;
    try {
      res = await fetch(`${server}${path}`, { ...options, headers });
    } catch (err) {
      throw new Error(`Kubernetes API unreachable at ${server}${path}: ${describeFetchError(err)}`);
    }
    if (!res.ok)
      throw new Error(`K8s API error ${res.status} at ${server}${path}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private get listerCtx(): ListerContext {
    return { k8sFetch: (path, opts) => this.k8sFetch(path, opts) };
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
    const f = resource.fields;

    switch (resourceTypeId) {
      case "k8s-cluster": {
        try {
          const ver = await this.k8sFetch<{ gitVersion: string }>("/version");
          return [{ label: "Version", value: ver.gitVersion }];
        } catch {
          return [];
        }
      }
      case "k8s-deployment":
      case "k8s-statefulset": {
        const ready = Number(f["readyReplicas"] ?? 0);
        const desired = Number(f["replicas"] ?? 0);
        const variant = ready === desired ? "status-healthy" : "status-degraded";
        return [
          { label: "Replicas", value: `${ready}/${desired}`, variant },
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      }
      case "k8s-daemonset": {
        const ready = Number(f["numberReady"] ?? 0);
        const desired = Number(f["desiredNumberScheduled"] ?? 0);
        const variant = ready === desired ? "status-healthy" : "status-degraded";
        return [
          { label: "Ready", value: `${ready}/${desired}`, variant },
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      }
      case "k8s-pod": {
        const phase = String(f["phase"] ?? "Unknown");
        const variant =
          phase === "Running"
            ? "status-healthy"
            : phase === "Succeeded"
              ? "status-healthy"
              : phase === "Failed"
                ? "status-error"
                : "status-degraded";
        return [
          { label: "Phase", value: phase, variant },
          ...(f["restartCount"] != null
            ? [{ label: "Restarts", value: String(f["restartCount"]) }]
            : []),
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      }
      case "k8s-service":
        return [
          { label: "Type", value: String(f["type"] ?? "ClusterIP") },
          { label: "Cluster IP", value: String(f["clusterIP"] ?? "") },
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      case "k8s-job": {
        const succeeded = Number(f["succeeded"] ?? 0);
        const active = Number(f["active"] ?? 0);
        return [
          { label: "Succeeded", value: String(succeeded) },
          { label: "Active", value: String(active) },
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      }
      case "k8s-ingress":
        return [{ label: "Namespace", value: String(f["namespace"] ?? "") }];
      case "k8s-namespace":
        return [{ label: "Name", value: String(f["name"] ?? "") }];
      case "k8s-cronjob":
        return [
          { label: "Schedule", value: String(f["schedule"] ?? "") },
          ...(f["suspended"] === "true"
            ? [{ label: "Suspended", value: "Yes", variant: "status-degraded" as const }]
            : []),
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      case "k8s-secret":
        return [
          { label: "Type", value: String(f["type"] ?? "Opaque") },
          { label: "Entries", value: String(f["dataCount"] ?? 0) },
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      case "k8s-configmap":
        return [
          { label: "Entries", value: String(f["dataCount"] ?? 0) },
          { label: "Namespace", value: String(f["namespace"] ?? "") },
        ];
      default:
        return [];
    }
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
    const accountId = context.accountId;

    const [
      namespaces,
      pods,
      deployments,
      services,
      statefulSets,
      daemonSets,
      jobs,
      cronJobs,
      ingresses,
    ] = await Promise.all([
      listers.listNamespaces(this.listerCtx, accountId),
      listers.listPods(this.listerCtx, accountId),
      listers.listDeployments(this.listerCtx, accountId),
      listers.listServices(this.listerCtx, accountId),
      listers.listStatefulSets(this.listerCtx, accountId),
      listers.listDaemonSets(this.listerCtx, accountId),
      listers.listJobs(this.listerCtx, accountId),
      listers.listCronJobs(this.listerCtx, accountId),
      listers.listIngresses(this.listerCtx, accountId),
    ]);

    const allGroups: PeerPaneResourceGroup[] = [
      namespacePeerGroup(namespaces),
      podPeerGroup(pods),
      deploymentPeerGroup(deployments),
      statefulSetPeerGroup(statefulSets),
      daemonSetPeerGroup(daemonSets),
      servicePeerGroup(services),
      ingressPeerGroup(ingresses),
      jobPeerGroup(jobs),
      cronJobPeerGroup(cronJobs),
    ];
    const groups = allGroups.filter((g) => g.items.length > 0 || g.supportsCreate);

    return {
      supportsK9s: true,
      supportsSecretImport: true,
      resourceGroups: groups,
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const hasParent = !!parentResourceId;
    const namespaceField = async (): Promise<CreateResourceConfig["fields"][number]> => {
      let namespaceOptions: { id: string; label: string }[] = [{ id: "default", label: "default" }];
      try {
        const nsData = await this.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
        namespaceOptions = nsData.items
          .filter((ns) => !SYSTEM_NAMESPACES.has(ns.metadata.name))
          .map((ns) => ({ id: ns.metadata.name, label: ns.metadata.name }))
          .sort((a, b) => a.label.localeCompare(b.label));
      } catch {
        /* fall back to default */
      }
      return {
        key: "namespace",
        label: "Namespace",
        kind: "select",
        required: true,
        defaultValue: "default",
        options: namespaceOptions,
      };
    };

    if (typeId === "k8s-pod") {
      const fields: CreateResourceConfig["fields"] = [
        {
          key: "name",
          label: "Pod Name",
          kind: "text",
          required: true,
          defaultValue: `scratch-${Date.now().toString(36)}`,
          description: "A unique name for your scratch pod",
        },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "image",
          label: "OS Image",
          kind: "select",
          required: true,
          defaultValue: "ubuntu:24.04",
          description: "Base OS for your scratch pod",
          options: [
            { id: "ubuntu:24.04", label: "Ubuntu 24.04 LTS" },
            { id: "ubuntu:22.04", label: "Ubuntu 22.04 LTS" },
            { id: "debian:12", label: "Debian 12 (Bookworm)" },
            { id: "debian:11", label: "Debian 11 (Bullseye)" },
            { id: "alpine:3.20", label: "Alpine 3.20" },
            { id: "fedora:40", label: "Fedora 40" },
            { id: "rockylinux:9", label: "Rocky Linux 9" },
            { id: "amazonlinux:2023", label: "Amazon Linux 2023" },
            { id: "archlinux:latest", label: "Arch Linux (latest)" },
            { id: "custom", label: "Custom image\u2026" },
          ],
        },
        {
          key: "customImage",
          label: "Custom Image",
          kind: "text",
          required: true,
          description: "Full container image reference (e.g. myregistry.io/myimage:tag)",
          showWhen: { fieldKey: "image", fieldValue: "custom" },
        },
        {
          key: "ttl",
          label: "Time to Live",
          kind: "select",
          required: true,
          defaultValue: "3600",
          description: "Pod auto-terminates and is cleaned up after this duration",
          options: [
            { id: "900", label: "15 minutes" },
            { id: "1800", label: "30 minutes" },
            { id: "3600", label: "1 hour" },
            { id: "7200", label: "2 hours" },
            { id: "14400", label: "4 hours" },
            { id: "28800", label: "8 hours" },
            { id: "86400", label: "24 hours" },
          ],
        },
      );
      return { fields };
    }
    if (typeId === "k8s-configmap") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "Name", kind: "text", required: true },
      ];
      if (!hasParent) {
        fields.push({
          key: "namespace",
          label: "Namespace",
          kind: "text",
          required: true,
          defaultValue: "default",
        });
      }
      return { fields };
    }
    if (typeId === "k8s-namespace") {
      return {
        fields: [
          {
            key: "name",
            label: "Namespace Name",
            kind: "text",
            required: true,
            description: "Lowercase letters, numbers, and hyphens",
          },
        ],
      };
    }

    if (typeId === "k8s-secret") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "Secret Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push({
        key: "type",
        label: "Secret Type",
        kind: "select",
        required: true,
        defaultValue: "Opaque",
        options: [
          { id: "Opaque", label: "Opaque (generic)" },
          { id: "kubernetes.io/dockerconfigjson", label: "Docker Registry" },
          { id: "kubernetes.io/tls", label: "TLS Certificate" },
          { id: "kubernetes.io/basic-auth", label: "Basic Auth" },
        ],
      });
      return { fields };
    }

    if (typeId === "k8s-deployment") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "Deployment Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "e.g. nginx:latest or myregistry.io/myapp:v1",
        },
        {
          key: "replicas",
          label: "Replicas",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 100,
          stepValue: 1,
        },
        {
          key: "containerPort",
          label: "Container Port",
          kind: "number",
          required: false,
          description: "Port the container listens on",
          defaultValue: "80",
        },
      );
      return { fields };
    }

    if (typeId === "k8s-service") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "Service Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "type",
          label: "Service Type",
          kind: "select",
          required: true,
          defaultValue: "ClusterIP",
          options: [
            { id: "ClusterIP", label: "ClusterIP" },
            { id: "NodePort", label: "NodePort" },
            { id: "LoadBalancer", label: "LoadBalancer" },
          ],
        },
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          description: "Port the service exposes",
        },
        {
          key: "targetPort",
          label: "Target Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          description: "Port on the target pods",
        },
        {
          key: "selector",
          label: "Selector (app label)",
          kind: "text",
          required: true,
          description: "Value of the app label to select pods, e.g. my-app",
        },
      );
      return { fields };
    }

    if (typeId === "k8s-ingress") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "Ingress Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "ingressClassName",
          label: "Ingress Class",
          kind: "text",
          required: false,
          description: "e.g. nginx, traefik",
        },
        {
          key: "host",
          label: "Host",
          kind: "text",
          required: true,
          description: "e.g. app.example.com",
        },
        {
          key: "serviceName",
          label: "Backend Service",
          kind: "text",
          required: true,
          description: "Name of the Service to route to",
        },
        {
          key: "servicePort",
          label: "Service Port",
          kind: "number",
          required: true,
          defaultValue: "80",
        },
      );
      return { fields };
    }

    if (typeId === "k8s-job") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "Job Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "e.g. busybox:latest",
        },
        {
          key: "command",
          label: "Command",
          kind: "text",
          required: false,
          description: "e.g. echo hello",
        },
        {
          key: "completions",
          label: "Completions",
          kind: "number",
          required: false,
          defaultValue: "1",
        },
      );
      return { fields };
    }

    if (typeId === "k8s-cronjob") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "CronJob Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "schedule",
          label: "Schedule",
          kind: "text",
          required: true,
          description: "Cron expression, e.g. */5 * * * *",
        },
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "e.g. busybox:latest",
        },
        {
          key: "command",
          label: "Command",
          kind: "text",
          required: false,
          description: "e.g. echo hello",
        },
      );
      return { fields };
    }

    if (typeId === "k8s-statefulset") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "StatefulSet Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "e.g. postgres:16",
        },
        {
          key: "replicas",
          label: "Replicas",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 100,
        },
        {
          key: "serviceName",
          label: "Headless Service Name",
          kind: "text",
          required: true,
          description: "Name of the governing headless Service",
        },
        {
          key: "containerPort",
          label: "Container Port",
          kind: "number",
          required: false,
          defaultValue: "80",
        },
      );
      return { fields };
    }

    if (typeId === "k8s-daemonset") {
      const fields: CreateResourceConfig["fields"] = [
        { key: "name", label: "DaemonSet Name", kind: "text", required: true },
      ];
      if (!hasParent) fields.push(await namespaceField());
      fields.push(
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "e.g. fluentd:latest",
        },
        {
          key: "containerPort",
          label: "Container Port",
          kind: "number",
          required: false,
        },
      );
      return { fields };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const now = new Date().toISOString();
    const parentNamespace = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const namespace = fields["namespace"] || parentNamespace || "default";
    const name = fields["name"] || "unnamed";

    if (typeId === "k8s-pod") {
      const rawImage = fields["image"] || "ubuntu:24.04";
      const image = rawImage === "custom" ? fields["customImage"] || "ubuntu:24.04" : rawImage;
      const ttlSeconds = parseInt(fields["ttl"] || "3600", 10);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

      await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "infrawrench",
              "infrawrench.io/ephemeral": "true",
            },
            annotations: {
              "infrawrench.io/ttl-seconds": String(ttlSeconds),
              "infrawrench.io/expires-at": expiresAt,
            },
          },
          spec: {
            activeDeadlineSeconds: ttlSeconds,
            restartPolicy: "Never",
            containers: [
              {
                name: "scratch",
                image,
                command: ["sleep", String(ttlSeconds)],
                stdin: true,
                tty: true,
              },
            ],
          },
        }),
      });

      return {
        id: `${accountId}:k8s-pod:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
        accountId,
        displayName: name,
        fields: {
          name,
          namespace,
          image,
          status: "Pending",
          containerName: "scratch",
          ephemeral: "true",
          ttlSeconds,
          expiresAt,
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-configmap") {
      await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "infrawrench" } },
          data: {},
        }),
      });
      return {
        id: `${accountId}:k8s-configmap:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-configmap",
        accountId,
        displayName: name,
        fields: { name, namespace, dataCount: 0, keys: "" },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-namespace") {
      await this.k8sFetch("/api/v1/namespaces", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name,
            labels: { "app.kubernetes.io/managed-by": "infrawrench" },
          },
        }),
      });
      return {
        id: `${accountId}:k8s-namespace:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-namespace",
        accountId,
        displayName: name,
        fields: { name },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-cluster:cluster`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-secret") {
      const secretType = fields["type"] || "Opaque";
      await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "infrawrench" },
          },
          type: secretType,
          data: {},
        }),
      });
      return {
        id: `${accountId}:k8s-secret:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-secret",
        accountId,
        displayName: name,
        fields: { name, namespace, type: secretType, keys: "", dataCount: 0 },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-deployment") {
      const image = fields["image"] || "nginx:latest";
      const replicas = parseInt(fields["replicas"] || "1", 10);
      const containerPort = fields["containerPort"] ? parseInt(fields["containerPort"], 10) : 80;

      await this.k8sFetch(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "infrawrench", app: name },
          },
          spec: {
            replicas,
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name } },
              spec: {
                containers: [
                  {
                    name,
                    image,
                    ports: [{ containerPort }],
                  },
                ],
              },
            },
          },
        }),
      });
      return {
        id: `${accountId}:k8s-deployment:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-deployment",
        accountId,
        displayName: name,
        fields: { name, namespace, replicas },
        resolvedOutputs: { readyReplicas: "0", image },
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-service") {
      const svcType = fields["type"] || "ClusterIP";
      const port = parseInt(fields["port"] || "80", 10);
      const targetPort = parseInt(fields["targetPort"] || "80", 10);
      const selector = fields["selector"] || name;

      await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/services`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "infrawrench" },
          },
          spec: {
            type: svcType,
            selector: { app: selector },
            ports: [{ port, targetPort, protocol: "TCP" }],
          },
        }),
      });
      return {
        id: `${accountId}:k8s-service:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-service",
        accountId,
        displayName: name,
        fields: {
          name,
          namespace,
          type: svcType,
          clusterIP: "",
          ports: `${port}→${targetPort}/TCP`,
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-ingress") {
      const host = fields["host"] || "localhost";
      const serviceName = fields["serviceName"] || "";
      const servicePort = parseInt(fields["servicePort"] || "80", 10);
      const body: Record<string, unknown> = {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        spec: {
          rules: [
            {
              host,
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: {
                      service: { name: serviceName, port: { number: servicePort } },
                    },
                  },
                ],
              },
            },
          ],
        },
      };
      if (fields["ingressClassName"]) {
        (body["spec"] as Record<string, unknown>)["ingressClassName"] = fields["ingressClassName"];
      }
      await this.k8sFetch(
        `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return {
        id: `${accountId}:k8s-ingress:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-ingress",
        accountId,
        displayName: name,
        fields: {
          name,
          namespace,
          ingressClassName: fields["ingressClassName"] || "",
          hosts: host,
          address: "",
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-job") {
      const image = fields["image"] || "busybox:latest";
      const completions = parseInt(fields["completions"] || "1", 10);
      const container: Record<string, unknown> = { name: "job", image };
      if (fields["command"]) {
        container["command"] = ["/bin/sh", "-c", fields["command"]];
      }
      await this.k8sFetch(`/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "infrawrench" },
          },
          spec: {
            completions,
            template: {
              spec: {
                restartPolicy: "Never",
                containers: [container],
              },
            },
          },
        }),
      });
      return {
        id: `${accountId}:k8s-job:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-job",
        accountId,
        displayName: name,
        fields: { name, namespace, completions: String(completions), status: "Active", image },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-cronjob") {
      const image = fields["image"] || "busybox:latest";
      const schedule = fields["schedule"] || "*/5 * * * *";
      const container: Record<string, unknown> = { name: "cronjob", image };
      if (fields["command"]) {
        container["command"] = ["/bin/sh", "-c", fields["command"]];
      }
      await this.k8sFetch(`/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/cronjobs`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "batch/v1",
          kind: "CronJob",
          metadata: {
            name,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "infrawrench" },
          },
          spec: {
            schedule,
            jobTemplate: {
              spec: {
                template: {
                  spec: {
                    restartPolicy: "Never",
                    containers: [container],
                  },
                },
              },
            },
          },
        }),
      });
      return {
        id: `${accountId}:k8s-cronjob:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-cronjob",
        accountId,
        displayName: name,
        fields: { name, namespace, schedule, suspended: "false", lastSchedule: "" },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-statefulset") {
      const image = fields["image"] || "nginx:latest";
      const replicas = parseInt(fields["replicas"] || "1", 10);
      const serviceName = fields["serviceName"] || name;
      const containerPort = fields["containerPort"] ? parseInt(fields["containerPort"], 10) : 80;
      await this.k8sFetch(
        `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/statefulsets`,
        {
          method: "POST",
          body: JSON.stringify({
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            metadata: {
              name,
              namespace,
              labels: { "app.kubernetes.io/managed-by": "infrawrench", app: name },
            },
            spec: {
              serviceName,
              replicas,
              selector: { matchLabels: { app: name } },
              template: {
                metadata: { labels: { app: name } },
                spec: {
                  containers: [{ name, image, ports: [{ containerPort }] }],
                },
              },
            },
          }),
        },
      );
      return {
        id: `${accountId}:k8s-statefulset:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-statefulset",
        accountId,
        displayName: name,
        fields: { name, namespace, replicas, readyReplicas: 0, image },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-daemonset") {
      const image = fields["image"] || "fluentd:latest";
      const ports = fields["containerPort"]
        ? [{ containerPort: parseInt(fields["containerPort"], 10) }]
        : [];
      await this.k8sFetch(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "DaemonSet",
          metadata: {
            name,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "infrawrench", app: name },
          },
          spec: {
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name } },
              spec: {
                containers: [{ name, image, ...(ports.length ? { ports } : {}) }],
              },
            },
          },
        }),
      });
      return {
        id: `${accountId}:k8s-daemonset:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-daemonset",
        accountId,
        displayName: name,
        fields: { name, namespace, desiredNumberScheduled: 0, numberReady: 0, image },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    throw new Error(`Kubernetes plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const path = this.buildResourcePath(resourceId);
    await this.k8sFetch(path, { method: "DELETE" });
  }

  /**
   * Map a resource type ID to its K8s API path components.
   * Returns [apiPrefix, pluralResource] where the full path is:
   *   {apiPrefix}/namespaces/{ns}/{pluralResource}/{name}
   * or for non-namespaced resources:
   *   {apiPrefix}/{pluralResource}/{name}
   */
  private k8sApiPath(typeId: string): { prefix: string; plural: string; namespaced: boolean } {
    switch (typeId) {
      case "k8s-pod":
        return { prefix: "/api/v1", plural: "pods", namespaced: true };
      case "k8s-deployment":
        return { prefix: "/apis/apps/v1", plural: "deployments", namespaced: true };
      case "k8s-service":
        return { prefix: "/api/v1", plural: "services", namespaced: true };
      case "k8s-statefulset":
        return { prefix: "/apis/apps/v1", plural: "statefulsets", namespaced: true };
      case "k8s-daemonset":
        return { prefix: "/apis/apps/v1", plural: "daemonsets", namespaced: true };
      case "k8s-job":
        return { prefix: "/apis/batch/v1", plural: "jobs", namespaced: true };
      case "k8s-cronjob":
        return { prefix: "/apis/batch/v1", plural: "cronjobs", namespaced: true };
      case "k8s-ingress":
        return { prefix: "/apis/networking.k8s.io/v1", plural: "ingresses", namespaced: true };
      case "k8s-configmap":
        return { prefix: "/api/v1", plural: "configmaps", namespaced: true };
      case "k8s-secret":
        return { prefix: "/api/v1", plural: "secrets", namespaced: true };
      case "k8s-namespace":
        return { prefix: "/api/v1", plural: "namespaces", namespaced: false };
      default:
        throw new Error(`Unknown resource type for manifest: ${typeId}`);
    }
  }

  /** Parse the resource type, namespace, and name from a resource ID */
  private parseResourceId(resourceId: string): { typeId: string; namespace: string; name: string } {
    // Format: {accountId}:{typeId}:{namespace}:{name} (namespaced)
    //     or: {accountId}:{typeId}:{name}             (non-namespaced, e.g. namespace)
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (parts.length >= 4) {
      return { typeId, namespace: parts[2]!, name: parts[3]! };
    }
    return { typeId, namespace: "", name: parts[2] ?? "" };
  }

  private buildResourcePath(resourceId: string): string {
    const { typeId, namespace, name } = this.parseResourceId(resourceId);
    const api = this.k8sApiPath(typeId);
    if (api.namespaced) {
      return `${api.prefix}/namespaces/${encodeURIComponent(namespace)}/${api.plural}/${encodeURIComponent(name)}`;
    }
    return `${api.prefix}/${api.plural}/${encodeURIComponent(name)}`;
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const path = this.buildResourcePath(resourceId);
    const raw = await this.k8sFetch<Record<string, unknown>>(path);
    // Strip managed fields — they're noisy and kubectl hides them by default
    if (raw.metadata && typeof raw.metadata === "object") {
      delete (raw.metadata as Record<string, unknown>).managedFields;
    }
    return yaml.dump(raw, { lineWidth: 120, noRefs: true, sortKeys: false });
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const path = this.buildResourcePath(resourceId);
    const body = yaml.load(manifest);
    await this.k8sFetch(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async importYaml(_accountId: string, yamlText: string): Promise<{ applied: number }> {
    const docs = (yaml.loadAll(yamlText) as Array<Record<string, unknown> | null>).filter(
      (d): d is Record<string, unknown> => !!d && typeof d === "object",
    );
    if (docs.length === 0) throw new Error("No YAML documents found");

    let applied = 0;
    for (const [i, doc] of docs.entries()) {
      const apiVersion = String(doc["apiVersion"] ?? "");
      const kind = String(doc["kind"] ?? "");
      const metadata = (doc["metadata"] ?? {}) as Record<string, unknown>;
      const name = String(metadata["name"] ?? "");
      const namespace = String(metadata["namespace"] ?? "");
      if (!apiVersion || !kind || !name) {
        throw new Error(`Document ${i + 1}: missing apiVersion, kind, or metadata.name`);
      }

      const api = k8sApiForKind(kind);
      if (!api) throw new Error(`Document ${i + 1}: unsupported kind "${kind}"`);

      const prefix = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
      const q = "fieldManager=infrawrench&force=true";
      const path = api.namespaced
        ? `${prefix}/namespaces/${encodeURIComponent(namespace || "default")}/${api.plural}/${encodeURIComponent(name)}?${q}`
        : `${prefix}/${api.plural}/${encodeURIComponent(name)}?${q}`;

      await this.k8sFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/apply-patch+yaml" },
        body: yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false }),
      });
      applied++;
    }
    return { applied };
  }

  async describeResource(typeId: string, resourceId: string, _accountId: string): Promise<string> {
    const { namespace, name } = this.parseResourceId(resourceId);
    const kind = k8sKindForType(typeId);

    const objectPath = this.buildResourcePath(resourceId);
    const obj = await this.k8sFetch<Record<string, unknown>>(objectPath);
    if (obj.metadata && typeof obj.metadata === "object") {
      delete (obj.metadata as Record<string, unknown>).managedFields;
    }

    let events: K8sEvent[] = [];
    if (namespace) {
      try {
        const eventsPath =
          `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` +
          `?fieldSelector=involvedObject.kind=${encodeURIComponent(kind)},involvedObject.name=${encodeURIComponent(name)}`;
        const data = await this.k8sFetch<K8sList<K8sEvent>>(eventsPath);
        events = data.items;
      } catch (e) {
        console.warn(`[describe] k8s events fetch failed (non-fatal):`, e);
      }
    }

    const text = formatDescribe(kind, obj, events);
    return text;
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const { namespace, name } = this.parseResourceId(resourceId);
    if (!namespace)
      throw new Error(`Kubernetes plugin: logs require a namespaced resource (${typeId})`);

    const podRef = await this.resolvePodForLogs(typeId, namespace, name);
    const pod = await this.k8sFetch<K8sPod>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podRef)}`,
    );
    const containers = pod.spec.containers.map((c) => c.name);
    if (containers.length === 0)
      throw new Error(`Kubernetes plugin: pod ${namespace}/${podRef} has no containers`);

    const activeContainer =
      params.container && containers.includes(params.container) ? params.container : containers[0]!;

    const query = new URLSearchParams();
    query.set("container", activeContainer);
    query.set("tailLines", String(params.tailLines ?? 500));
    query.set("timestamps", "true");
    if (params.previous) query.set("previous", "true");

    const path =
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podRef)}/log` +
      `?${query.toString()}`;
    const text = await this.k8sFetchText(path);
    return { text, containers, activeContainer };
  }

  /** Plain-text variant of k8sFetch — the /log endpoint returns text, not JSON. */
  private async k8sFetchText(path: string): Promise<string> {
    const { server, token, caCertData } = this.parsed;
    if (!server) throw new Error("Kubernetes plugin: no server in kubeconfig");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (caCertData && this.services?.http) {
      const caPem = atob(caCertData);
      let result;
      try {
        result = await this.services.http.request({
          url: `${server}${path}`,
          method: "GET",
          headers,
          caCert: caPem,
        });
      } catch (err) {
        throw new Error(
          `Kubernetes API unreachable at ${server}${path}: ${describeFetchError(err)}`,
        );
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`K8s API error ${result.status} at ${server}${path}: ${result.body}`);
      }
      return result.body;
    }

    let res;
    try {
      res = await fetch(`${server}${path}`, { headers });
    } catch (err) {
      throw new Error(`Kubernetes API unreachable at ${server}${path}: ${describeFetchError(err)}`);
    }
    if (!res.ok)
      throw new Error(`K8s API error ${res.status} at ${server}${path}: ${await res.text()}`);
    return res.text();
  }

  /**
   * Resolve the pod name to fetch logs from. For k8s-pod this is the name
   * itself. For workload types (deployment, statefulset, daemonset, job) we
   * read the object's spec selector, query pods by label, and pick the first
   * running one.
   */
  private async resolvePodForLogs(
    typeId: string,
    namespace: string,
    name: string,
  ): Promise<string> {
    if (typeId === "k8s-pod") return name;

    let labelSelector: string;
    if (typeId === "k8s-job") {
      // Jobs get a standard `job-name` label applied to their pods.
      labelSelector = `job-name=${name}`;
    } else if (
      typeId === "k8s-deployment" ||
      typeId === "k8s-statefulset" ||
      typeId === "k8s-daemonset"
    ) {
      const api =
        typeId === "k8s-deployment"
          ? "deployments"
          : typeId === "k8s-statefulset"
            ? "statefulsets"
            : "daemonsets";
      const obj = await this.k8sFetch<{
        spec?: { selector?: { matchLabels?: Record<string, string> } };
      }>(
        `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${api}/${encodeURIComponent(name)}`,
      );
      const match = obj.spec?.selector?.matchLabels;
      if (!match || Object.keys(match).length === 0) {
        throw new Error(`Kubernetes plugin: ${typeId} ${name} has no matchLabels`);
      }
      labelSelector = Object.entries(match)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
    } else if (typeId === "k8s-service") {
      const obj = await this.k8sFetch<{ spec?: { selector?: Record<string, string> } }>(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
      );
      const match = obj.spec?.selector;
      if (!match || Object.keys(match).length === 0) {
        throw new Error(`Kubernetes plugin: service ${name} has no pod selector`);
      }
      labelSelector = Object.entries(match)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
    } else {
      throw new Error(`Kubernetes plugin: logs not supported for type "${typeId}"`);
    }

    const podList = await this.k8sFetch<K8sList<K8sPod>>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` +
        `?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
    const candidate = podList.items.find((p) => p.status.phase === "Running") ?? podList.items[0];
    if (!candidate)
      throw new Error(`Kubernetes plugin: no pods matched ${labelSelector} in ${namespace}`);
    return candidate.metadata.name;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }
}
