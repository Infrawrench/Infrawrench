import type { ResourceInstance } from "@infrawrench/plugin-base";

import type {
  K8sList,
  K8sNamespace,
  K8sNode,
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
} from "./types.js";

export interface ListerContext {
  k8sFetch<T>(path: string, options?: RequestInit): Promise<T>;
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
        instanceType: labels["node.kubernetes.io/instance-type"] ?? "",
        zone: labels["topology.kubernetes.io/zone"] ?? "",
        version: n.status?.nodeInfo?.kubeletVersion ?? "",
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

export async function listPods(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sPod>>("/api/v1/pods");
  const results: ResourceInstance[] = [];

  for (const pod of data.items) {
    if (SYSTEM_NAMESPACES.has(pod.metadata.namespace ?? "")) continue;

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
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sDeployment>>("/apis/apps/v1/deployments");
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
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sStatefulSet>>("/apis/apps/v1/statefulsets");
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
}

export async function listDaemonSets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const now = new Date().toISOString();
  const data = await ctx.k8sFetch<K8sList<K8sDaemonSet>>("/apis/apps/v1/daemonsets");
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
