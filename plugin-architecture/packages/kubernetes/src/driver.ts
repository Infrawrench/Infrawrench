/**
 * Kubernetes node driver. Runs in the Node host process (Electron main /
 * poller) and wraps the official `@kubernetes/client-node` SDK so we
 * inherit its full kubeconfig handling: `exec` credential plugins
 * (gke-gcloud-auth-plugin, aws-iam-authenticator), `auth-provider`, OIDC,
 * multi-context configs, in-cluster service-account tokens, etc.
 *
 * The browser-fallback `K8sFetcher` in `./shared.ts` only understands the
 * simple bearer-token / cert paths — anything fancier silently breaks.
 * When the host registers this driver, the plugin client prefers it via
 * `services.k8s.command(...)`; otherwise it falls back to the fetcher.
 *
 * The driver is intentionally a thin command dispatcher: it returns the
 * same JSON shapes the K8s REST API would (lists with `items`, etc.) so
 * downstream lister / detail code is path-agnostic.
 */
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  BatchV1Api,
  NetworkingV1Api,
  VersionApi,
  PatchStrategy,
} from "@kubernetes/client-node";
import type { K8sNodeDriver } from "@infrawrench/plugin-base";

interface CachedConfig {
  kubeconfig: string;
  kc: KubeConfig;
  core: CoreV1Api;
  apps: AppsV1Api;
  batch: BatchV1Api;
  networking: NetworkingV1Api;
  version: VersionApi;
}

// Avoid re-parsing the same kubeconfig on every list call. Most accounts
// will hit this cache for the entire lifetime of the host process.
const cache = new Map<string, CachedConfig>();

function getConfig(kubeconfig: string): CachedConfig {
  const cached = cache.get(kubeconfig);
  if (cached) return cached;
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  const entry: CachedConfig = {
    kubeconfig,
    kc,
    core: kc.makeApiClient(CoreV1Api),
    apps: kc.makeApiClient(AppsV1Api),
    batch: kc.makeApiClient(BatchV1Api),
    networking: kc.makeApiClient(NetworkingV1Api),
    version: kc.makeApiClient(VersionApi),
  };
  cache.set(kubeconfig, entry);
  return entry;
}

function str(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = params?.[key];
  return typeof v === "string" ? v : undefined;
}

function bool(params: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = params?.[key];
  return typeof v === "boolean" ? v : undefined;
}

function num(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = params?.[key];
  return typeof v === "number" ? v : undefined;
}

export const driver = {
  id: "kubernetes",

  async command(
    kubeconfig: string,
    op: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const c = getConfig(kubeconfig);

    switch (op) {
      case "getVersion":
        return c.version.getCode();

      case "listNamespaces":
        return c.core.listNamespace();

      case "listPods": {
        const namespace = str(params, "namespace");
        if (namespace) return c.core.listNamespacedPod({ namespace });
        return c.core.listPodForAllNamespaces();
      }
      case "listServices": {
        const namespace = str(params, "namespace");
        if (namespace) return c.core.listNamespacedService({ namespace });
        return c.core.listServiceForAllNamespaces();
      }
      case "listConfigMaps": {
        const namespace = str(params, "namespace");
        if (namespace) return c.core.listNamespacedConfigMap({ namespace });
        return c.core.listConfigMapForAllNamespaces();
      }
      case "listSecrets": {
        const namespace = str(params, "namespace");
        if (namespace) return c.core.listNamespacedSecret({ namespace });
        return c.core.listSecretForAllNamespaces();
      }
      case "listDeployments": {
        const namespace = str(params, "namespace");
        if (namespace) return c.apps.listNamespacedDeployment({ namespace });
        return c.apps.listDeploymentForAllNamespaces();
      }
      case "listStatefulSets": {
        const namespace = str(params, "namespace");
        if (namespace) return c.apps.listNamespacedStatefulSet({ namespace });
        return c.apps.listStatefulSetForAllNamespaces();
      }
      case "listDaemonSets": {
        const namespace = str(params, "namespace");
        if (namespace) return c.apps.listNamespacedDaemonSet({ namespace });
        return c.apps.listDaemonSetForAllNamespaces();
      }
      case "listJobs": {
        const namespace = str(params, "namespace");
        if (namespace) return c.batch.listNamespacedJob({ namespace });
        return c.batch.listJobForAllNamespaces();
      }
      case "listCronJobs": {
        const namespace = str(params, "namespace");
        if (namespace) return c.batch.listNamespacedCronJob({ namespace });
        return c.batch.listCronJobForAllNamespaces();
      }
      case "listIngresses": {
        const namespace = str(params, "namespace");
        if (namespace) return c.networking.listNamespacedIngress({ namespace });
        return c.networking.listIngressForAllNamespaces();
      }

      case "getPodLog": {
        const name = str(params, "name");
        const namespace = str(params, "namespace");
        if (!name || !namespace) throw new Error("getPodLog: name and namespace required");
        const container = str(params, "container");
        const tailLines = num(params, "tailLines");
        const previous = bool(params, "previous");
        const timestamps = bool(params, "timestamps");
        return c.core.readNamespacedPodLog({
          name,
          namespace,
          ...(container !== undefined ? { container } : {}),
          ...(tailLines !== undefined ? { tailLines } : {}),
          ...(previous !== undefined ? { previous } : {}),
          ...(timestamps !== undefined ? { timestamps } : {}),
        });
      }

      case "getEvents": {
        const namespace = str(params, "namespace");
        const fieldSelector = str(params, "fieldSelector");
        if (namespace) {
          return c.core.listNamespacedEvent({
            namespace,
            ...(fieldSelector ? { fieldSelector } : {}),
          });
        }
        return c.core.listEventForAllNamespaces(fieldSelector ? { fieldSelector } : {});
      }

      case "applyManifest": {
        // Server-side apply via PATCH application/apply-patch+yaml.
        const manifest = params["manifest"];
        if (!manifest || typeof manifest !== "object") {
          throw new Error("applyManifest: manifest object required");
        }
        const m = manifest as {
          apiVersion?: string;
          kind?: string;
          metadata?: { name?: string; namespace?: string };
        };
        const name = m.metadata?.name;
        const namespace = m.metadata?.namespace ?? "default";
        const kind = m.kind;
        if (!name || !kind) throw new Error("applyManifest: kind and metadata.name required");

        // Use the generic raw fetch path the SDK exposes so we don't have to
        // hand-roll a switch over every kind. SSA via PATCH is uniform.
        const apiVersion = m.apiVersion ?? "v1";
        const plural = pluralForKind(kind);
        const prefix = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
        const isNamespaced = isKindNamespaced(kind);
        const path = isNamespaced
          ? `${prefix}/namespaces/${encodeURIComponent(namespace)}/${plural}/${encodeURIComponent(name)}`
          : `${prefix}/${plural}/${encodeURIComponent(name)}`;
        return rawRequest(c.kc, `${path}?fieldManager=infrawrench&force=true`, {
          method: "PATCH",
          headers: { "Content-Type": PatchStrategy.ServerSideApply },
          body: JSON.stringify(manifest),
        });
      }

      case "replaceManifest": {
        // PUT-style replace — used by the manifest editor.
        const manifest = params["manifest"];
        const resourcePath = str(params, "path");
        if (!manifest || !resourcePath) {
          throw new Error("replaceManifest: manifest and path required");
        }
        return rawRequest(c.kc, resourcePath, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(manifest),
        });
      }

      case "deleteResource": {
        const resourcePath = str(params, "path");
        if (!resourcePath) throw new Error("deleteResource: path required");
        return rawRequest(c.kc, resourcePath, { method: "DELETE" });
      }

      case "request": {
        // Generic fallback used by the K8sFetcher → driver shim so the
        // existing path-based call sites (manifest fetch, custom create
        // POSTs, etc.) keep working without per-op duplication.
        const path = str(params, "path");
        if (!path) throw new Error("request: path required");
        const method = str(params, "method") ?? "GET";
        const headers = (params["headers"] as Record<string, string> | undefined) ?? {};
        const body = str(params, "body");
        return rawRequest(c.kc, path, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
      }

      default:
        throw new Error(`Kubernetes driver: unknown op "${op}"`);
    }
  },
} satisfies K8sNodeDriver;

interface RawRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Make a raw HTTP request to the cluster the kubeconfig points at. We use
 * `applyToHTTPSOptions` (rather than the SDK's typed API surface) for
 * arbitrary paths so the client's existing path-based call sites keep
 * working with one shim. The SDK populates the auth header, TLS agent,
 * and CA from whatever the kubeconfig declares — including exec
 * credential plugins, OIDC refresh, etc.
 */
async function rawRequest(kc: KubeConfig, path: string, init: RawRequestInit): Promise<unknown> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error("Kubernetes driver: no current cluster in kubeconfig");
  const server = cluster.server.replace(/\/$/, "");
  const parsed = new URL(`${server}${path}`);
  const isHttps = parsed.protocol === "https:";

  const opts: https.RequestOptions = {
    method: init.method,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: `${parsed.pathname}${parsed.search}`,
    headers: { ...(init.headers ?? {}) },
  };
  await kc.applyToHTTPSOptions(opts);

  const mod = isHttps ? https : http;
  const { status, body } = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      req.on("error", reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    },
  );

  if (status < 200 || status >= 300) {
    throw new Error(`K8s API error ${status} at ${server}${path}: ${body}`);
  }
  if (init.method === "DELETE") {
    try {
      return JSON.parse(body);
    } catch {
      return { kind: "Status", status: "Success" };
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function pluralForKind(kind: string): string {
  // Covers everything the plugin currently creates / applies. Unknown kinds
  // fall through to a best-effort plural — server-side apply will surface a
  // 404 anyway if it's wrong.
  switch (kind) {
    case "Pod":
      return "pods";
    case "Service":
      return "services";
    case "Deployment":
      return "deployments";
    case "StatefulSet":
      return "statefulsets";
    case "DaemonSet":
      return "daemonsets";
    case "ReplicaSet":
      return "replicasets";
    case "Job":
      return "jobs";
    case "CronJob":
      return "cronjobs";
    case "Ingress":
      return "ingresses";
    case "ConfigMap":
      return "configmaps";
    case "Secret":
      return "secrets";
    case "Namespace":
      return "namespaces";
    case "ServiceAccount":
      return "serviceaccounts";
    case "PersistentVolumeClaim":
      return "persistentvolumeclaims";
    case "PersistentVolume":
      return "persistentvolumes";
    default:
      return `${kind.toLowerCase()}s`;
  }
}

function isKindNamespaced(kind: string): boolean {
  switch (kind) {
    case "Namespace":
    case "PersistentVolume":
    case "StorageClass":
    case "ClusterRole":
    case "ClusterRoleBinding":
    case "IngressClass":
      return false;
    default:
      return true;
  }
}
