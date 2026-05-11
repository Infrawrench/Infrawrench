import type { HostServices } from "@infrawrench/plugin-base";

import type { K8sEvent, ParsedKubeconfig } from "./types.js";

import yaml from "js-yaml";

export function k8sApiForKind(kind: string): { plural: string; namespaced: boolean } | null {
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

export function k8sKindForType(typeId: string): string {
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

/**
 * Map a resource type ID to its K8s API path components.
 * Returns [apiPrefix, pluralResource] where the full path is:
 *   {apiPrefix}/namespaces/{ns}/{pluralResource}/{name}
 * or for non-namespaced resources:
 *   {apiPrefix}/{pluralResource}/{name}
 */
export function k8sApiPath(typeId: string): {
  prefix: string;
  plural: string;
  namespaced: boolean;
} {
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
export function parseResourceId(resourceId: string): {
  typeId: string;
  namespace: string;
  name: string;
} {
  // Format: {accountId}:{typeId}:{namespace}:{name} (namespaced)
  //     or: {accountId}:{typeId}:{name}             (non-namespaced, e.g. namespace)
  const parts = resourceId.split(":");
  const typeId = parts[1] ?? "";
  if (parts.length >= 4) {
    return { typeId, namespace: parts[2]!, name: parts[3]! };
  }
  return { typeId, namespace: "", name: parts[2] ?? "" };
}

export function buildResourcePath(resourceId: string): string {
  const { typeId, namespace, name } = parseResourceId(resourceId);
  const api = k8sApiPath(typeId);
  if (api.namespaced) {
    return `${api.prefix}/namespaces/${encodeURIComponent(namespace)}/${api.plural}/${encodeURIComponent(name)}`;
  }
  return `${api.prefix}/${api.plural}/${encodeURIComponent(name)}`;
}

export function formatAge(isoTimestamp: string | undefined): string {
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

export function formatEventAge(evt: K8sEvent): string {
  const ts = evt.lastTimestamp ?? evt.eventTime ?? evt.firstTimestamp;
  return formatAge(ts);
}

export function formatDescribe(
  kind: string,
  obj: Record<string, unknown>,
  events: K8sEvent[],
): string {
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

export function describeFetchError(err: unknown): string {
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

/**
 * Shared HTTP machinery for talking to the Kubernetes API server. Handles
 * bearer-token auth, CA-cert pinning via the host's http service when
 * available, and surfaces useful errors. JSON variant returns parsed JSON;
 * text variant is used for the /log endpoint which returns plain text.
 */
export class K8sFetcher {
  constructor(
    private readonly parsed: ParsedKubeconfig,
    private readonly services?: HostServices,
  ) {}

  async fetch<T>(path: string, options?: RequestInit): Promise<T> {
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
      res = await fetch(`${server}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Kubernetes API unreachable at ${server}${path}: ${describeFetchError(err)}`);
    }
    if (!res.ok)
      throw new Error(`K8s API error ${res.status} at ${server}${path}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** Plain-text variant of fetch — the /log endpoint returns text, not JSON. */
  async fetchText(path: string): Promise<string> {
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
}

export type K8sFetch = <T>(path: string, options?: RequestInit) => Promise<T>;
