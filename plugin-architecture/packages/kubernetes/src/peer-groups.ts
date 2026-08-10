import type { PeerPaneResource, ResourceInstance } from "@infrawrench/plugin-base";
import { mapPeerStatus, mapJobStatus } from "./types.js";

export function namespacePeerGroup(namespaces: ResourceInstance[]) {
  return {
    title: `Namespaces (${namespaces.length})`,
    resourceTypeId: "k8s-namespace" as const,
    pluginId: "kubernetes" as const,
    items: namespaces.map((ns): PeerPaneResource => ({
      id: ns.id,
      pluginId: ns.pluginId,
      resourceTypeId: ns.resourceTypeId,
      displayName: ns.displayName,
      subtitle: String(ns.fields["phase"] ?? "Active"),
      status: ns.fields["phase"] === "Terminating" ? "degraded" : "healthy",
      fields: ns.fields,
      namespace: String(ns.fields["name"] ?? ns.displayName),
      ...(ns.externalId ? { externalId: ns.externalId } : {}),
    })),
  };
}

export function podPeerGroup(pods: ResourceInstance[]) {
  return {
    title: `Pods (${pods.length})`,
    resourceTypeId: "k8s-pod" as const,
    pluginId: "kubernetes" as const,
    supportsCreate: true,
    items: pods.map((pod): PeerPaneResource => ({
      id: pod.id,
      pluginId: pod.pluginId,
      resourceTypeId: pod.resourceTypeId,
      displayName: pod.displayName,
      subtitle: [String(pod.fields["namespace"] ?? ""), String(pod.fields["image"] ?? "")]
        .filter(Boolean)
        .join(" · "),
      status: mapPeerStatus(String(pod.fields["status"] ?? "")),
      fields: pod.fields,
      supportsExec: true,
      namespace: String(pod.fields["namespace"] ?? ""),
      ...(pod.externalId ? { externalId: pod.externalId } : {}),
      ...(pod.fields["containerName"]
        ? { containerName: String(pod.fields["containerName"]) }
        : {}),
    })),
  };
}

export function deploymentPeerGroup(deployments: ResourceInstance[]) {
  return {
    title: `Deployments (${deployments.length})`,
    resourceTypeId: "k8s-deployment" as const,
    pluginId: "kubernetes" as const,
    items: deployments.map((d): PeerPaneResource => {
      const ready = d.fields["readyReplicas"] ?? 0;
      const desired = d.fields["replicas"] ?? 0;
      return {
        id: d.id,
        pluginId: d.pluginId,
        resourceTypeId: d.resourceTypeId,
        displayName: d.displayName,
        subtitle: [String(d.fields["namespace"] ?? ""), `${ready}/${desired} ready`]
          .filter(Boolean)
          .join(" · "),
        status:
          Number(ready) === Number(desired) && Number(desired) > 0
            ? "healthy"
            : Number(ready) > 0
              ? "degraded"
              : Number(desired) === 0
                ? "unknown"
                : "error",
        fields: d.fields,
        namespace: String(d.fields["namespace"] ?? ""),
        ...(d.externalId ? { externalId: d.externalId } : {}),
      };
    }),
  };
}

export function statefulSetPeerGroup(items: ResourceInstance[]) {
  return {
    title: `StatefulSets (${items.length})`,
    resourceTypeId: "k8s-statefulset" as const,
    pluginId: "kubernetes" as const,
    items: items.map((s): PeerPaneResource => {
      const ready = s.fields["readyReplicas"] ?? 0;
      const desired = s.fields["replicas"] ?? 0;
      return {
        id: s.id,
        pluginId: s.pluginId,
        resourceTypeId: s.resourceTypeId,
        displayName: s.displayName,
        subtitle: [String(s.fields["namespace"] ?? ""), `${ready}/${desired} ready`]
          .filter(Boolean)
          .join(" · "),
        status:
          Number(ready) === Number(desired) && Number(desired) > 0
            ? "healthy"
            : Number(ready) > 0
              ? "degraded"
              : "error",
        fields: s.fields,
        namespace: String(s.fields["namespace"] ?? ""),
        ...(s.externalId ? { externalId: s.externalId } : {}),
      };
    }),
  };
}

export function daemonSetPeerGroup(items: ResourceInstance[]) {
  return {
    title: `DaemonSets (${items.length})`,
    resourceTypeId: "k8s-daemonset" as const,
    pluginId: "kubernetes" as const,
    items: items.map((d): PeerPaneResource => {
      const ready = Number(d.fields["numberReady"] ?? 0);
      const desired = Number(d.fields["desiredNumberScheduled"] ?? 0);
      return {
        id: d.id,
        pluginId: d.pluginId,
        resourceTypeId: d.resourceTypeId,
        displayName: d.displayName,
        subtitle: [String(d.fields["namespace"] ?? ""), `${ready}/${desired} scheduled`]
          .filter(Boolean)
          .join(" · "),
        status: ready === desired && desired > 0 ? "healthy" : ready > 0 ? "degraded" : "error",
        fields: d.fields,
        namespace: String(d.fields["namespace"] ?? ""),
        ...(d.externalId ? { externalId: d.externalId } : {}),
      };
    }),
  };
}

export function servicePeerGroup(items: ResourceInstance[]) {
  return {
    title: `Services (${items.length})`,
    resourceTypeId: "k8s-service" as const,
    pluginId: "kubernetes" as const,
    items: items.map((s): PeerPaneResource => ({
      id: s.id,
      pluginId: s.pluginId,
      resourceTypeId: s.resourceTypeId,
      displayName: s.displayName,
      subtitle: [
        String(s.fields["namespace"] ?? ""),
        String(s.fields["type"] ?? ""),
        String(s.fields["ports"] ?? ""),
      ]
        .filter(Boolean)
        .join(" · "),
      status: "healthy",
      fields: s.fields,
      namespace: String(s.fields["namespace"] ?? ""),
      ...(s.externalId ? { externalId: s.externalId } : {}),
    })),
  };
}

export function ingressPeerGroup(items: ResourceInstance[]) {
  return {
    title: `Ingresses (${items.length})`,
    resourceTypeId: "k8s-ingress" as const,
    pluginId: "kubernetes" as const,
    items: items.map((i): PeerPaneResource => ({
      id: i.id,
      pluginId: i.pluginId,
      resourceTypeId: i.resourceTypeId,
      displayName: i.displayName,
      subtitle: [String(i.fields["namespace"] ?? ""), String(i.fields["hosts"] ?? "")]
        .filter(Boolean)
        .join(" · "),
      status: "healthy",
      fields: i.fields,
      namespace: String(i.fields["namespace"] ?? ""),
      ...(i.externalId ? { externalId: i.externalId } : {}),
    })),
  };
}

export function jobPeerGroup(items: ResourceInstance[]) {
  return {
    title: `Jobs (${items.length})`,
    resourceTypeId: "k8s-job" as const,
    pluginId: "kubernetes" as const,
    items: items.map((j): PeerPaneResource => ({
      id: j.id,
      pluginId: j.pluginId,
      resourceTypeId: j.resourceTypeId,
      displayName: j.displayName,
      subtitle: [String(j.fields["namespace"] ?? ""), String(j.fields["completions"] ?? "")]
        .filter(Boolean)
        .join(" · "),
      status: mapJobStatus(String(j.fields["status"] ?? "")),
      fields: j.fields,
      namespace: String(j.fields["namespace"] ?? ""),
      ...(j.externalId ? { externalId: j.externalId } : {}),
    })),
  };
}

export function cronJobPeerGroup(items: ResourceInstance[]) {
  return {
    title: `CronJobs (${items.length})`,
    resourceTypeId: "k8s-cronjob" as const,
    pluginId: "kubernetes" as const,
    items: items.map((c): PeerPaneResource => ({
      id: c.id,
      pluginId: c.pluginId,
      resourceTypeId: c.resourceTypeId,
      displayName: c.displayName,
      subtitle: [String(c.fields["namespace"] ?? ""), String(c.fields["schedule"] ?? "")]
        .filter(Boolean)
        .join(" · "),
      status: c.fields["suspended"] === "true" ? "degraded" : "healthy",
      fields: c.fields,
      namespace: String(c.fields["namespace"] ?? ""),
      ...(c.externalId ? { externalId: c.externalId } : {}),
    })),
  };
}
