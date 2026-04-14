import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
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

const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "gke-managed-system",
  "gke-gmp-system",
  "gmp-system",
  "gke-managed-cim",
  "config-management-system",
  "config-management-monitoring",
  "asm-system",
  "istio-system",
  "knative-serving",
  "gke-managed-filestorecsi",
]);

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
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (caCertData && this.services?.http) {
      const caPem = atob(caCertData);
      const result = await this.services.http.request({
        url: `${server}${path}`,
        method: options?.method ?? "GET",
        headers,
        ...(options?.body ? { body: String(options.body) } : {}),
        caCert: caPem,
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`K8s API error ${result.status}: ${result.body}`);
      }
      return JSON.parse(result.body) as T;
    }

    const res = await fetch(`${server}${path}`, { headers, ...options });
    if (!res.ok) throw new Error(`K8s API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "k8s-cluster":
        return this.listClusters(accountId);
      case "k8s-namespace":
        return this.listNamespaces(accountId);
      case "k8s-pod":
        return this.listPods(accountId);
      case "k8s-deployment":
        return this.listDeployments(accountId);
      case "k8s-service":
        return this.listServices(accountId);
      case "k8s-statefulset":
        return this.listStatefulSets(accountId);
      case "k8s-daemonset":
        return this.listDaemonSets(accountId);
      case "k8s-job":
        return this.listJobs(accountId);
      case "k8s-cronjob":
        return this.listCronJobs(accountId);
      case "k8s-ingress":
        return this.listIngresses(accountId);
      case "k8s-configmap":
        return this.listConfigMaps(accountId);
      case "k8s-secret":
        return this.listSecrets(accountId);
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
    try {
      const data = await this.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
      return data.items.map((ns) => ns.metadata.name).sort();
    } catch {
      return ["default", "kube-system"];
    }
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

  async renderPeerPane(_context: PeerPaneContext): Promise<PeerPaneSchema> {
    const syntheticAccountId = "peer";

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
      this.listNamespaces(syntheticAccountId),
      this.listPods(syntheticAccountId),
      this.listDeployments(syntheticAccountId),
      this.listServices(syntheticAccountId),
      this.listStatefulSets(syntheticAccountId),
      this.listDaemonSets(syntheticAccountId),
      this.listJobs(syntheticAccountId),
      this.listCronJobs(syntheticAccountId),
      this.listIngresses(syntheticAccountId),
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

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "k8s-pod") {
      // Fetch available namespaces for the namespace picker
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
        fields: [
          {
            key: "name",
            label: "Pod Name",
            kind: "text",
            required: true,
            defaultValue: `scratch-${Date.now().toString(36)}`,
            description: "A unique name for your scratch pod",
          },
          {
            key: "namespace",
            label: "Namespace",
            kind: "select",
            required: true,
            defaultValue: "default",
            options: namespaceOptions,
          },
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
        ],
      };
    }
    if (typeId === "k8s-configmap") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "namespace",
            label: "Namespace",
            kind: "text",
            required: true,
            defaultValue: "default",
          },
        ],
      };
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
        fields: [
          { key: "name", label: "Secret Name", kind: "text", required: true },
          {
            key: "namespace",
            label: "Namespace",
            kind: "select",
            required: true,
            defaultValue: "default",
            options: namespaceOptions,
          },
          {
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
          },
        ],
      };
    }

    if (typeId === "k8s-deployment") {
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
        fields: [
          { key: "name", label: "Deployment Name", kind: "text", required: true },
          {
            key: "namespace",
            label: "Namespace",
            kind: "select",
            required: true,
            defaultValue: "default",
            options: namespaceOptions,
          },
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
        ],
      };
    }

    if (typeId === "k8s-service") {
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
        fields: [
          { key: "name", label: "Service Name", kind: "text", required: true },
          {
            key: "namespace",
            label: "Namespace",
            kind: "select",
            required: true,
            defaultValue: "default",
            options: namespaceOptions,
          },
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
        ],
      };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const now = new Date().toISOString();
    const namespace = fields["namespace"] || "default";
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

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  private async listClusters(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    let name = "cluster";
    try {
      const ver = await this.k8sFetch<{ gitVersion: string }>("/version");
      name = `cluster (${ver.gitVersion})`;
    } catch {
      /* use default name */
    }
    return [
      {
        id: `${accountId}:k8s-cluster:default`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-cluster",
        accountId,
        displayName: name,
        fields: { name },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async listNamespaces(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
      return data.items.map((ns) => ({
        id: `${accountId}:k8s-namespace:${ns.metadata.name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-namespace",
        accountId,
        displayName: ns.metadata.name,
        fields: {
          name: ns.metadata.name,
          phase: ns.status.phase,
          system: SYSTEM_NAMESPACES.has(ns.metadata.name) ? "true" : "false",
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-cluster:default`,
        createdAt: ns.metadata.creationTimestamp,
        updatedAt: now,
      }));
    } catch {
      return [];
    }
  }

  private async listPods(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sPod>>("/api/v1/pods");
      const results: ResourceInstance[] = [];

      for (const pod of data.items) {
        if (SYSTEM_NAMESPACES.has(pod.metadata.namespace ?? "")) continue;

        const isEphemeral = pod.metadata.labels?.["infrawrench.io/ephemeral"] === "true";
        const phase = pod.status.phase;

        // Auto-cleanup: delete expired ephemeral pods that K8s has already terminated
        if (isEphemeral && (phase === "Failed" || phase === "Succeeded")) {
          const ns = pod.metadata.namespace ?? "default";
          this.k8sFetch(
            `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod.metadata.name)}`,
            { method: "DELETE" },
          ).catch(() => {
            /* silently ignore cleanup errors */
          });
          continue; // exclude terminated ephemeral pods from the list
        }

        const container = pod.spec.containers[0];
        const restarts = pod.status.containerStatuses?.[0]?.restartCount ?? 0;
        const expiresAt = isEphemeral
          ? (pod.metadata.annotations?.["infrawrench.io/expires-at"] ?? "")
          : "";
        const ttlSeconds = isEphemeral
          ? (pod.metadata.annotations?.["infrawrench.io/ttl-seconds"] ?? "")
          : "";

        results.push({
          id: `${accountId}:k8s-pod:${pod.metadata.namespace}:${pod.metadata.name}`,
          pluginId: "kubernetes",
          resourceTypeId: "k8s-pod",
          accountId,
          displayName: pod.metadata.name,
          fields: {
            name: pod.metadata.name,
            namespace: pod.metadata.namespace ?? "default",
            image: container?.image ?? "",
            status: phase,
            containerName: container?.name ?? pod.metadata.name,
            restarts,
            ...(isEphemeral ? { ephemeral: "true", expiresAt, ttlSeconds } : {}),
          },
          resolvedOutputs: {},
          secretStates: [],
          parentResourceId: `${accountId}:k8s-namespace:${pod.metadata.namespace ?? "default"}`,
          createdAt: pod.metadata.creationTimestamp,
          updatedAt: now,
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sDeployment>>("/apis/apps/v1/deployments");
      return data.items
        .filter((d) => !SYSTEM_NAMESPACES.has(d.metadata.namespace ?? ""))
        .map((d) => {
          const container = d.spec.template.spec.containers[0];
          return {
            id: `${accountId}:k8s-deployment:${d.metadata.namespace}:${d.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-deployment",
            accountId,
            displayName: d.metadata.name,
            fields: {
              name: d.metadata.name,
              namespace: d.metadata.namespace ?? "default",
              replicas: d.spec.replicas ?? 0,
              readyReplicas: d.status.readyReplicas ?? 0,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${d.metadata.namespace ?? "default"}`,
            createdAt: d.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listServices(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sService>>("/api/v1/services");
      return data.items
        .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
        .map((s) => {
          const ports = (s.spec.ports ?? []).map((p) => `${p.port}/${p.protocol}`).join(", ");
          const hasSelector = !!s.spec.selector && Object.keys(s.spec.selector).length > 0;
          return {
            id: `${accountId}:k8s-service:${s.metadata.namespace}:${s.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-service",
            accountId,
            displayName: s.metadata.name,
            fields: {
              name: s.metadata.name,
              namespace: s.metadata.namespace ?? "default",
              type: s.spec.type,
              clusterIP: s.spec.clusterIP ?? "",
              ports,
              hasSelector: hasSelector ? "true" : "false",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
            createdAt: s.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listStatefulSets(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sStatefulSet>>("/apis/apps/v1/statefulsets");
      return data.items
        .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
        .map((s) => {
          const container = s.spec.template.spec.containers[0];
          return {
            id: `${accountId}:k8s-statefulset:${s.metadata.namespace}:${s.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-statefulset",
            accountId,
            displayName: s.metadata.name,
            fields: {
              name: s.metadata.name,
              namespace: s.metadata.namespace ?? "default",
              replicas: s.spec.replicas ?? 0,
              readyReplicas: s.status.readyReplicas ?? 0,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
            createdAt: s.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listDaemonSets(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sDaemonSet>>("/apis/apps/v1/daemonsets");
      return data.items
        .filter((d) => !SYSTEM_NAMESPACES.has(d.metadata.namespace ?? ""))
        .map((d) => {
          const container = d.spec.template.spec.containers[0];
          return {
            id: `${accountId}:k8s-daemonset:${d.metadata.namespace}:${d.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-daemonset",
            accountId,
            displayName: d.metadata.name,
            fields: {
              name: d.metadata.name,
              namespace: d.metadata.namespace ?? "default",
              desiredNumberScheduled: d.status.desiredNumberScheduled,
              numberReady: d.status.numberReady,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${d.metadata.namespace ?? "default"}`,
            createdAt: d.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listJobs(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sJob>>("/apis/batch/v1/jobs");
      return data.items
        .filter((j) => !SYSTEM_NAMESPACES.has(j.metadata.namespace ?? ""))
        .map((j) => {
          const container = j.spec.template.spec.containers[0];
          const succeeded = j.status.succeeded ?? 0;
          const failed = j.status.failed ?? 0;
          const active = j.status.active ?? 0;
          const completions = j.spec.completions ?? 1;
          let status: string;
          if (succeeded >= completions) status = "Complete";
          else if (failed > 0) status = "Failed";
          else if (active > 0) status = "Running";
          else status = "Pending";
          return {
            id: `${accountId}:k8s-job:${j.metadata.namespace}:${j.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-job",
            accountId,
            displayName: j.metadata.name,
            fields: {
              name: j.metadata.name,
              namespace: j.metadata.namespace ?? "default",
              completions: `${succeeded}/${completions}`,
              status,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${j.metadata.namespace ?? "default"}`,
            createdAt: j.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listCronJobs(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sCronJob>>("/apis/batch/v1/cronjobs");
      return data.items
        .filter((c) => !SYSTEM_NAMESPACES.has(c.metadata.namespace ?? ""))
        .map((c) => ({
          id: `${accountId}:k8s-cronjob:${c.metadata.namespace}:${c.metadata.name}`,
          pluginId: "kubernetes",
          resourceTypeId: "k8s-cronjob",
          accountId,
          displayName: c.metadata.name,
          fields: {
            name: c.metadata.name,
            namespace: c.metadata.namespace ?? "default",
            schedule: c.spec.schedule,
            suspended: String(c.spec.suspend ?? false),
            lastSchedule: c.status.lastScheduleTime ?? "",
          },
          resolvedOutputs: {},
          secretStates: [],
          parentResourceId: `${accountId}:k8s-namespace:${c.metadata.namespace ?? "default"}`,
          createdAt: c.metadata.creationTimestamp,
          updatedAt: now,
        }));
    } catch {
      return [];
    }
  }

  private async listIngresses(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sIngress>>("/apis/networking.k8s.io/v1/ingresses");
      return data.items
        .filter((i) => !SYSTEM_NAMESPACES.has(i.metadata.namespace ?? ""))
        .map((i) => {
          const hosts = (i.spec.rules ?? []).map((r) => r.host ?? "*").join(", ");
          const lbIngress = i.status?.loadBalancer?.ingress ?? [];
          const address = lbIngress
            .map((lb) => lb.ip ?? lb.hostname ?? "")
            .filter(Boolean)
            .join(", ");
          return {
            id: `${accountId}:k8s-ingress:${i.metadata.namespace}:${i.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-ingress",
            accountId,
            displayName: i.metadata.name,
            fields: {
              name: i.metadata.name,
              namespace: i.metadata.namespace ?? "default",
              ingressClassName: i.spec.ingressClassName ?? "",
              hosts,
              address,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${i.metadata.namespace ?? "default"}`,
            createdAt: i.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listConfigMaps(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sConfigMap>>("/api/v1/configmaps");
      return data.items
        .filter((cm) => !SYSTEM_NAMESPACES.has(cm.metadata.namespace ?? ""))
        .map((cm) => {
          const keys = Object.keys(cm.data ?? {});
          return {
            id: `${accountId}:k8s-configmap:${cm.metadata.namespace}:${cm.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-configmap",
            accountId,
            displayName: cm.metadata.name,
            fields: {
              name: cm.metadata.name,
              namespace: cm.metadata.namespace ?? "default",
              keys: keys.join(", "),
              dataCount: keys.length,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${cm.metadata.namespace ?? "default"}`,
            createdAt: cm.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listSecrets(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sSecret>>("/api/v1/secrets");
      return (
        data.items
          .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
          // Filter out service account tokens and other auto-generated secrets
          .filter((s) => s.type !== "kubernetes.io/service-account-token")
          .map((s) => {
            const keys = Object.keys(s.data ?? {});
            return {
              id: `${accountId}:k8s-secret:${s.metadata.namespace}:${s.metadata.name}`,
              pluginId: "kubernetes",
              resourceTypeId: "k8s-secret",
              accountId,
              displayName: s.metadata.name,
              fields: {
                name: s.metadata.name,
                namespace: s.metadata.namespace ?? "default",
                type: s.type ?? "Opaque",
                keys: keys.join(", "),
                dataCount: keys.length,
              },
              resolvedOutputs: {},
              secretStates: [],
              parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
              createdAt: s.metadata.creationTimestamp,
              updatedAt: now,
            };
          })
      );
    } catch {
      return [];
    }
  }
}
