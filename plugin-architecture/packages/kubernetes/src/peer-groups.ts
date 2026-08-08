import type { PeerPaneResource, ResourceInstance } from "@infrawrench/plugin-base";
import { mapPeerStatus, mapJobStatus } from "./types.js";
import type { CostIndex } from "./cost-surface.js";
import { applyCostStatus, costSubtitleSuffix, podEntry, workloadEntry } from "./cost-surface.js";

/**
 * Namespaces, most expensive first.
 *
 * Ordering by cost is the whole point of the group: a cluster has a handful of
 * namespaces and dozens of workloads, so "which namespace is the money in" is
 * the question a user can actually act on. When there is no cost data we fall
 * back to alphabetical, because an arbitrary order pretending to be a ranking
 * is worse than no ranking.
 */
export function namespacePeerGroup(namespaces: ResourceInstance[], costs?: CostIndex) {
  const items = namespaces.map((ns): PeerPaneResource => {
    const name = String(ns.fields["name"] ?? ns.displayName);
    const entry = costs?.namespaces.get(name);
    const phase = String(ns.fields["phase"] ?? "Active");
    const baseStatus = ns.fields["phase"] === "Terminating" ? "degraded" : "healthy";
    return {
      id: ns.id,
      pluginId: ns.pluginId,
      resourceTypeId: ns.resourceTypeId,
      displayName: ns.displayName,
      subtitle: `${phase}${costSubtitleSuffix(entry, costs?.currency ?? "USD")}`,
      status: applyCostStatus(baseStatus, entry, costs?.utilizationAvailable ?? false),
      fields: ns.fields,
      namespace: name,
      ...(ns.externalId ? { externalId: ns.externalId } : {}),
    };
  });

  if (costs) {
    items.sort((a, b) => {
      const av = costs.namespaces.get(a.namespace ?? "")?.dailyCost ?? -1;
      const bv = costs.namespaces.get(b.namespace ?? "")?.dailyCost ?? -1;
      return bv - av || a.displayName.localeCompare(b.displayName);
    });
  }

  // Only claim the ordering means something when it does. Without cost data
  // the list is alphabetical, and labelling that "by cost" would be a lie.
  const title =
    costs && !costs.unpriced
      ? `Namespaces (${namespaces.length}) · by cost`
      : `Namespaces (${namespaces.length})`;

  return {
    title,
    resourceTypeId: "k8s-namespace" as const,
    pluginId: "kubernetes" as const,
    items,
  };
}

export function podPeerGroup(pods: ResourceInstance[], costs?: CostIndex) {
  return {
    title: `Pods (${pods.length})`,
    resourceTypeId: "k8s-pod" as const,
    pluginId: "kubernetes" as const,
    supportsCreate: true,
    items: pods.map((pod): PeerPaneResource => {
      const namespace = String(pod.fields["namespace"] ?? "");
      const entry = podEntry(costs, namespace, String(pod.fields["name"] ?? pod.displayName));
      return {
        id: pod.id,
        pluginId: pod.pluginId,
        resourceTypeId: pod.resourceTypeId,
        displayName: pod.displayName,
        subtitle:
          [namespace, String(pod.fields["image"] ?? "")].filter(Boolean).join(" · ") +
          costSubtitleSuffix(entry, costs?.currency ?? "USD"),
        status: applyCostStatus(
          mapPeerStatus(String(pod.fields["status"] ?? "")),
          entry,
          costs?.utilizationAvailable ?? false,
        ),
        fields: pod.fields,
        supportsExec: true,
        namespace,
        ...(pod.externalId ? { externalId: pod.externalId } : {}),
        ...(pod.fields["containerName"]
          ? { containerName: String(pod.fields["containerName"]) }
          : {}),
      };
    }),
  };
}

export function deploymentPeerGroup(deployments: ResourceInstance[], costs?: CostIndex) {
  return {
    title: `Deployments (${deployments.length})`,
    resourceTypeId: "k8s-deployment" as const,
    pluginId: "kubernetes" as const,
    items: deployments.map((d): PeerPaneResource => {
      const ready = d.fields["readyReplicas"] ?? 0;
      const desired = d.fields["replicas"] ?? 0;
      const namespace = String(d.fields["namespace"] ?? "");
      const entry = workloadEntry(
        costs,
        namespace,
        "Deployment",
        String(d.fields["name"] ?? d.displayName),
      );
      const baseStatus =
        Number(ready) === Number(desired) && Number(desired) > 0
          ? ("healthy" as const)
          : Number(ready) > 0
            ? ("degraded" as const)
            : Number(desired) === 0
              ? ("unknown" as const)
              : ("error" as const);
      return {
        id: d.id,
        pluginId: d.pluginId,
        resourceTypeId: d.resourceTypeId,
        displayName: d.displayName,
        subtitle:
          [namespace, `${ready}/${desired} ready`].filter(Boolean).join(" · ") +
          costSubtitleSuffix(entry, costs?.currency ?? "USD"),
        status: applyCostStatus(baseStatus, entry, costs?.utilizationAvailable ?? false),
        fields: d.fields,
        namespace,
        ...(d.externalId ? { externalId: d.externalId } : {}),
      };
    }),
  };
}

export function statefulSetPeerGroup(items: ResourceInstance[], costs?: CostIndex) {
  return {
    title: `StatefulSets (${items.length})`,
    resourceTypeId: "k8s-statefulset" as const,
    pluginId: "kubernetes" as const,
    items: items.map((s): PeerPaneResource => {
      const ready = s.fields["readyReplicas"] ?? 0;
      const desired = s.fields["replicas"] ?? 0;
      const namespace = String(s.fields["namespace"] ?? "");
      const entry = workloadEntry(
        costs,
        namespace,
        "StatefulSet",
        String(s.fields["name"] ?? s.displayName),
      );
      const baseStatus =
        Number(ready) === Number(desired) && Number(desired) > 0
          ? ("healthy" as const)
          : Number(ready) > 0
            ? ("degraded" as const)
            : ("error" as const);
      return {
        id: s.id,
        pluginId: s.pluginId,
        resourceTypeId: s.resourceTypeId,
        displayName: s.displayName,
        subtitle:
          [namespace, `${ready}/${desired} ready`].filter(Boolean).join(" · ") +
          costSubtitleSuffix(entry, costs?.currency ?? "USD"),
        status: applyCostStatus(baseStatus, entry, costs?.utilizationAvailable ?? false),
        fields: s.fields,
        namespace,
        ...(s.externalId ? { externalId: s.externalId } : {}),
      };
    }),
  };
}

export function daemonSetPeerGroup(items: ResourceInstance[], costs?: CostIndex) {
  return {
    title: `DaemonSets (${items.length})`,
    resourceTypeId: "k8s-daemonset" as const,
    pluginId: "kubernetes" as const,
    items: items.map((d): PeerPaneResource => {
      const ready = Number(d.fields["numberReady"] ?? 0);
      const desired = Number(d.fields["desiredNumberScheduled"] ?? 0);
      const namespace = String(d.fields["namespace"] ?? "");
      const entry = workloadEntry(
        costs,
        namespace,
        "DaemonSet",
        String(d.fields["name"] ?? d.displayName),
      );
      const baseStatus =
        ready === desired && desired > 0
          ? ("healthy" as const)
          : ready > 0
            ? ("degraded" as const)
            : ("error" as const);
      return {
        id: d.id,
        pluginId: d.pluginId,
        resourceTypeId: d.resourceTypeId,
        displayName: d.displayName,
        subtitle:
          [namespace, `${ready}/${desired} scheduled`].filter(Boolean).join(" · ") +
          costSubtitleSuffix(entry, costs?.currency ?? "USD"),
        status: applyCostStatus(baseStatus, entry, costs?.utilizationAvailable ?? false),
        fields: d.fields,
        namespace,
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
