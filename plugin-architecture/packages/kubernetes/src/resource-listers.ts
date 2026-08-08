import type { ResourceInstance } from "@infrawrench/plugin-base";

import { effectivePodResources } from "./pod-resources.js";
import { formatCores, formatMemory } from "./quantity.js";

import type {
  K8sList,
  K8sNamespace,
  K8sNode,
  K8sPod,
  K8sPodSpec,
  K8sDeployment,
  K8sService,
  K8sStatefulSet,
  K8sDaemonSet,
  K8sJob,
  K8sCronJob,
  K8sIngress,
  K8sIngressBackend,
  K8sConfigMap,
  K8sSecret,
} from "./types.js";

export interface ListerContext {
  k8sFetch<T>(path: string, options?: RequestInit): Promise<T>;
}

/**
 * Options every namespaced lister accepts.
 *
 * `includeSystemNamespaces` exists for exactly one caller: cost allocation.
 * The listings deliberately hide the control-plane namespaces because a user
 * browsing their workloads does not want to wade through `kube-system` — but
 * kube-system's pods are on the same nodes, hold real capacity, and cost real
 * money. Inheriting the skip-set into cost allocation would make that spend
 * silently vanish and would make every other namespace's share look larger
 * than it is. So cost passes `includeSystemNamespaces: true` and labels those
 * namespaces rather than dropping them.
 */
export interface ListerOptions {
  includeSystemNamespaces?: boolean;
}

/** Should this namespace be dropped from a listing? */
function skipNamespace(namespace: string | undefined, opts?: ListerOptions): boolean {
  if (opts?.includeSystemNamespaces) return false;
  return SYSTEM_NAMESPACES.has(namespace ?? "");
}

export const SYSTEM_NAMESPACES = new Set([
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

/**
 * `namespace/name` — the identity a namespaced object actually has.
 *
 * Cross-object references inside a namespaced spec (a pod's ConfigMap volume,
 * an Ingress backend) name only the bare object, because Kubernetes resolves
 * them within the referrer's own namespace. A bare `config` names a different
 * ConfigMap in every namespace, so listers store the qualified form on both
 * sides of a reference and the dependency graph matches those instead.
 */
function qualify(namespace: string | undefined, name: string): string {
  return `${namespace ?? "default"}/${name}`;
}

/**
 * The ConfigMaps and Secrets a pod spec names, namespace-qualified and joined
 * for the graph (which splits comma-separated values into one edge each).
 * Everything here is already on the object the list call returned — volumes
 * (including projected sources), `envFrom` / `env.valueFrom` on every
 * container, and image-pull secrets.
 */
function podReferences(
  spec: K8sPodSpec,
  namespace: string | undefined,
): { configMaps: string; secrets: string } {
  const configMaps = new Set<string>();
  const secrets = new Set<string>();
  const add = (into: Set<string>, name: string | undefined) => {
    if (name) into.add(qualify(namespace, name));
  };

  for (const volume of spec.volumes ?? []) {
    add(configMaps, volume.configMap?.name);
    add(secrets, volume.secret?.secretName);
    for (const source of volume.projected?.sources ?? []) {
      add(configMaps, source.configMap?.name);
      add(secrets, source.secret?.name);
    }
  }
  for (const container of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    for (const from of container.envFrom ?? []) {
      add(configMaps, from.configMapRef?.name);
      add(secrets, from.secretRef?.name);
    }
    for (const entry of container.env ?? []) {
      add(configMaps, entry.valueFrom?.configMapKeyRef?.name);
      add(secrets, entry.valueFrom?.secretKeyRef?.name);
    }
  }
  for (const pullSecret of spec.imagePullSecrets ?? []) add(secrets, pullSecret.name);

  return { configMaps: [...configMaps].join(", "), secrets: [...secrets].join(", ") };
}

/**
 * The four resource fields every pod-bearing object carries, so the peer pane,
 * the detail view and the cost model all read the same numbers from the same
 * place. Stored as display strings (`250m`, `512Mi`) because that is what
 * `fields` is — the machine-readable values are re-derived by the cost model
 * from the raw API objects, not from these.
 */
function resourceFields(spec: K8sPodSpec): Record<string, string> {
  const { requests, limits } = effectivePodResources(spec);
  return {
    requestCpu: formatCores(requests.cpuCores),
    requestMemory: formatMemory(requests.memoryBytes),
    limitCpu: formatCores(limits.cpuCores),
    limitMemory: formatMemory(limits.memoryBytes),
  };
}

export async function listClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  let name = "cluster";
  try {
    const ver = await ctx.k8sFetch<{ gitVersion: string }>("/version");
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

export async function listNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
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
}

export async function listNodes(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sNode>>("/api/v1/nodes");
  return data.items.map((n) => {
    const ready = (n.status?.conditions ?? []).find((c) => c.type === "Ready");
    const labels = n.metadata.labels ?? {};
    // Capacity is the whole machine — what the cloud bill is for. Allocatable
    // is capacity minus kube-reserved, system-reserved and eviction headroom,
    // i.e. what the scheduler will actually hand out. Cost allocation needs
    // both: the invoice is against capacity, but idle is measured against
    // allocatable, and the gap between them is nobody's workload.
    const capacityCpu = n.status?.capacity?.["cpu"] ?? "";
    const capacityMemory = n.status?.capacity?.["memory"] ?? "";
    return {
      id: `${accountId}:k8s-node:${n.metadata.name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-node",
      accountId,
      displayName: n.metadata.name,
      fields: {
        name: n.metadata.name,
        ready: ready?.status === "True" ? "true" : "false",
        unschedulable: n.spec?.unschedulable ? "true" : "false",
        // Well-known labels. The `beta.kubernetes.io` / `failure-domain.beta`
        // forms are the pre-1.17 spellings; long deprecated but still set by
        // older node bootstrappers, so fall back to them rather than showing
        // an empty instance type (which would cost us the price lookup).
        instanceType:
          labels["node.kubernetes.io/instance-type"] ??
          labels["beta.kubernetes.io/instance-type"] ??
          "",
        zone:
          labels["topology.kubernetes.io/zone"] ??
          labels["failure-domain.beta.kubernetes.io/zone"] ??
          "",
        region:
          labels["topology.kubernetes.io/region"] ??
          labels["failure-domain.beta.kubernetes.io/region"] ??
          "",
        version: n.status?.nodeInfo?.kubeletVersion ?? "",
        capacityCpu,
        capacityMemory,
        allocatableCpu: n.status?.allocatable?.["cpu"] ?? "",
        allocatableMemory: n.status?.allocatable?.["memory"] ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-cluster:default`,
      createdAt: n.metadata.creationTimestamp,
      updatedAt: now,
    };
  });
}

export async function listPods(
  ctx: ListerContext,
  accountId: string,
  opts?: ListerOptions,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sPod>>("/api/v1/pods");
  const results: ResourceInstance[] = [];

  for (const pod of data.items) {
    if (skipNamespace(pod.metadata.namespace, opts)) continue;

    const isEphemeral = pod.metadata.labels?.["infrawrench.io/ephemeral"] === "true";
    const phase = pod.status.phase;

    // Auto-cleanup: delete expired ephemeral pods that K8s has already terminated
    if (isEphemeral && (phase === "Failed" || phase === "Succeeded")) {
      const ns = pod.metadata.namespace ?? "default";
      ctx
        .k8sFetch(
          `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod.metadata.name)}`,
          { method: "DELETE" },
        )
        .catch(() => {
          /* silently ignore cleanup errors */
        });
      continue; // exclude terminated ephemeral pods from the list
    }

    const container = pod.spec.containers[0];
    const restarts = pod.status.containerStatuses?.[0]?.restartCount ?? 0;
    // Why a not-Running pod isn't running. Two places hold the answer: an
    // unschedulable pod's PodScheduled condition ("0/3 nodes are available: 3
    // Insufficient cpu…"), and a scheduled-but-stuck container's waiting state
    // ("ImagePullBackOff: … 401 Unauthorized"). Without either, a stuck
    // rollout is undiagnosable from a listing.
    const scheduled = (pod.status.conditions ?? []).find((cond) => cond.type === "PodScheduled");
    const waiting = pod.status.containerStatuses?.[0]?.state?.waiting;
    let statusReason = "";
    if (phase === "Pending" && scheduled?.status === "False") {
      statusReason = `${scheduled.reason ?? ""}${scheduled.message ? `: ${scheduled.message}` : ""}`;
    } else if (waiting?.reason) {
      statusReason = `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ""}`;
    }
    // Generous cap: registry-pull failures put the decisive part (the HTTP
    // status) at the very end of a long message.
    statusReason = statusReason.slice(0, 1500);
    const expiresAt = isEphemeral
      ? (pod.metadata.annotations?.["infrawrench.io/expires-at"] ?? "")
      : "";
    const ttlSeconds = isEphemeral
      ? (pod.metadata.annotations?.["infrawrench.io/ttl-seconds"] ?? "")
      : "";
    const { configMaps, secrets } = podReferences(pod.spec, pod.metadata.namespace);

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
        statusReason,
        containerName: container?.name ?? pod.metadata.name,
        restarts,
        nodeName: pod.spec.nodeName ?? "",
        ...resourceFields(pod.spec),
        configMaps,
        secrets,
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
}

export async function listDeployments(
  ctx: ListerContext,
  accountId: string,
  opts?: ListerOptions,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sDeployment>>("/apis/apps/v1/deployments");
  return data.items
    .filter((d) => !skipNamespace(d.metadata.namespace, opts))
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
          serviceAccountName: d.spec.template.spec.serviceAccountName ?? "",
          ...resourceFields(d.spec.template.spec),
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${d.metadata.namespace ?? "default"}`,
        createdAt: d.metadata.creationTimestamp,
        updatedAt: now,
      };
    });
}

export async function listServices(
  ctx: ListerContext,
  accountId: string,
  namespaceHint?: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  // When the caller (e.g. a create-form picker) only cares about one
  // namespace, scope the request to that namespace instead of fanning out.
  const path = namespaceHint
    ? `/api/v1/namespaces/${encodeURIComponent(namespaceHint)}/services`
    : "/api/v1/services";
  const data = await ctx.k8sFetch<K8sList<K8sService>>(path);
  return data.items
    .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
    .map((s) => {
      const ports = (s.spec.ports ?? []).map((p) => `${p.port}/${p.protocol}`).join(", ");
      const hasSelector = !!s.spec.selector && Object.keys(s.spec.selector).length > 0;
      // A LoadBalancer's provisioned address — what a deploy actually waits
      // for. Mapped the way the ingress lister maps its address.
      const externalIP = (s.status?.loadBalancer?.ingress ?? [])
        .map((lb) => lb.ip ?? lb.hostname ?? "")
        .filter(Boolean)
        .join(", ");
      return {
        id: `${accountId}:k8s-service:${s.metadata.namespace}:${s.metadata.name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-service",
        accountId,
        displayName: s.metadata.name,
        fields: {
          name: s.metadata.name,
          namespace: s.metadata.namespace ?? "default",
          qualifiedName: qualify(s.metadata.namespace, s.metadata.name),
          type: s.spec.type,
          clusterIP: s.spec.clusterIP ?? "",
          externalIP,
          ports,
          hasSelector: hasSelector ? "true" : "false",
        },
        resolvedOutputs: { serviceName: s.metadata.name },
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
        createdAt: s.metadata.creationTimestamp,
        updatedAt: now,
      };
    });
}

export async function listStatefulSets(
  ctx: ListerContext,
  accountId: string,
  opts?: ListerOptions,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sStatefulSet>>("/apis/apps/v1/statefulsets");
  return data.items
    .filter((s) => !skipNamespace(s.metadata.namespace, opts))
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
          serviceAccountName: s.spec.template.spec.serviceAccountName ?? "",
          ...resourceFields(s.spec.template.spec),
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
        createdAt: s.metadata.creationTimestamp,
        updatedAt: now,
      };
    });
}

export async function listDaemonSets(
  ctx: ListerContext,
  accountId: string,
  opts?: ListerOptions,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sDaemonSet>>("/apis/apps/v1/daemonsets");
  return data.items
    .filter((d) => !skipNamespace(d.metadata.namespace, opts))
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
          ...resourceFields(d.spec.template.spec),
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${d.metadata.namespace ?? "default"}`,
        createdAt: d.metadata.creationTimestamp,
        updatedAt: now,
      };
    });
}

export async function listJobs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sJob>>("/apis/batch/v1/jobs");
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
      // A scheduled Job carries its CronJob in `ownerReferences` — the one
      // pointer that survives into the listing (the name alone is generated,
      // e.g. "backup-28401120").
      const cronJob =
        (j.metadata.ownerReferences ?? []).find((ref) => ref.kind === "CronJob")?.name ?? "";
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
          cronJob,
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${j.metadata.namespace ?? "default"}`,
        createdAt: j.metadata.creationTimestamp,
        updatedAt: now,
      };
    });
}

export async function listCronJobs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sCronJob>>("/apis/batch/v1/cronjobs");
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
        qualifiedName: qualify(c.metadata.namespace, c.metadata.name),
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
}

export async function listIngresses(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sIngress>>("/apis/networking.k8s.io/v1/ingresses");
  return data.items
    .filter((i) => !SYSTEM_NAMESPACES.has(i.metadata.namespace ?? ""))
    .map((i) => {
      const hosts = (i.spec.rules ?? []).map((r) => r.host ?? "*").join(", ");
      const lbIngress = i.status?.loadBalancer?.ingress ?? [];
      const address = lbIngress
        .map((lb) => lb.ip ?? lb.hostname ?? "")
        .filter(Boolean)
        .join(", ");
      // Every path's backing Service. An Ingress can only route to Services in
      // its own namespace, so the qualified name is exact.
      const backends = new Set<string>();
      const addBackend = (backend: K8sIngressBackend | undefined) => {
        const serviceName = backend?.service?.name;
        if (serviceName) backends.add(qualify(i.metadata.namespace, serviceName));
      };
      addBackend(i.spec.defaultBackend);
      for (const rule of i.spec.rules ?? []) {
        for (const path of rule.http?.paths ?? []) addBackend(path.backend);
      }
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
          services: [...backends].join(", "),
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${i.metadata.namespace ?? "default"}`,
        createdAt: i.metadata.creationTimestamp,
        updatedAt: now,
      };
    });
}

export async function listConfigMaps(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sConfigMap>>("/api/v1/configmaps");
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
          qualifiedName: qualify(cm.metadata.namespace, cm.metadata.name),
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
}

export async function listSecrets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sSecret>>("/api/v1/secrets");
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
            qualifiedName: qualify(s.metadata.namespace, s.metadata.name),
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
}
