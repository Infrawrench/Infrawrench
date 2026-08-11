import type {
  PeerPaneContext,
  PeerPaneResourceGroup,
  PeerPaneSchema,
} from "@infrawrench/plugin-base";

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
import type { CostIndex } from "./cost-surface.js";
import { describeUtilizationGap } from "./metrics-api.js";
import { describeRateSource, NO_RATE_GUIDANCE } from "./node-rates.js";
import { formatDailyCost } from "./cost-model.js";

/**
 * Build the peer pane (the side panel showing related resources). We list
 * every resource type in parallel, then assemble groups in display order;
 * empty groups without create support are hidden.
 *
 * Cost allocation runs alongside the listings and is folded into each pill's
 * `subtitle`. It is deliberately best-effort: a cluster whose `/api/v1/nodes`
 * is forbidden, or which has no rate for its nodes, still renders the full
 * workload listing — just without money.
 */
export async function renderPeerPane(
  context: PeerPaneContext,
  listerCtx: ListerContext,
  resolveCosts: () => Promise<CostIndex | undefined>,
): Promise<PeerPaneSchema> {
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
    costs,
  ] = await Promise.all([
    listers.listNamespaces(listerCtx, accountId),
    listers.listPods(listerCtx, accountId),
    listers.listDeployments(listerCtx, accountId),
    listers.listServices(listerCtx, accountId),
    listers.listStatefulSets(listerCtx, accountId),
    listers.listDaemonSets(listerCtx, accountId),
    listers.listJobs(listerCtx, accountId),
    listers.listCronJobs(listerCtx, accountId),
    listers.listIngresses(listerCtx, accountId),
    // Never let cost break the pane. A cluster whose node list is forbidden is
    // still a cluster you want to see the workloads of; `resolveCosts` already
    // swallows its own failures and resolves to undefined.
    resolveCosts(),
  ]);

  const allGroups: PeerPaneResourceGroup[] = [
    namespacePeerGroup(namespaces, costs),
    podPeerGroup(pods, costs),
    deploymentPeerGroup(deployments, costs),
    statefulSetPeerGroup(statefulSets, costs),
    daemonSetPeerGroup(daemonSets, costs),
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
    ...(costs ? buildCostGuidance(costs) : {}),
  };
}

/**
 * The explanation that sits above the groups: where the money came from, or
 * why there isn't any.
 *
 * `guidance` is rendered as a banner alongside the resource groups when both
 * are present (it fully replaces them only when the groups are empty, which is
 * the host's unreachable-peer case). That is what lets a cost caveat coexist
 * with the workload listing instead of hiding it.
 */
function buildCostGuidance(costs: CostIndex): Pick<PeerPaneSchema, "guidance"> {
  const suggestions: string[] = [];

  if (costs.unpriced) {
    const title =
      "Showing capacity and efficiency without cost — no hourly rate is available for this cluster's nodes.";
    return { guidance: { title, suggestions: [...NO_RATE_GUIDANCE] } };
  }

  const partial = costs.cluster.unpricedNodes.length > 0;
  if (partial) {
    suggestions.push(
      `No rate for ${costs.cluster.unpricedNodes.length} of ${costs.cluster.nodeCount} nodes (${costs.cluster.unpricedNodes.slice(0, 3).join(", ")}${costs.cluster.unpricedNodes.length > 3 ? ", …" : ""}). Their workloads show no cost.`,
    );
  }

  const utilizationGap = describeUtilizationGap(costs.utilizationStatus);
  if (utilizationGap) suggestions.push(utilizationGap);

  const idle = costs.cluster.dailyIdleCost;
  if (idle != null && idle > 0) {
    suggestions.push(
      `Idle, schedulable capacity accounts for ${formatDailyCost(idle, costs.currency)} — that is the cluster being larger than its workloads, not any one team's spend.`,
    );
  }

  // Volumes nothing mounts are the storage twin of idle capacity, and the most
  // common cause is invisible: a StatefulSet's volumeClaimTemplate PVCs default
  // to Retain on both scale-down and delete, so shrinking one leaves its disks
  // behind, billing, until someone deletes them by hand.
  const { storage, loadBalancers } = costs.cluster;
  if (storage.unattachedCount > 0) {
    const money = formatDailyCost(storage.dailyUnattachedCost, costs.currency);
    suggestions.push(
      `${storage.unattachedCount} persistent volume claim${storage.unattachedCount === 1 ? "" : "s"} (${Math.round(storage.unattachedGib)}Gi${money ? `, ${money}` : ""}) ${storage.unattachedCount === 1 ? "is" : "are"} bound but mounted by no running pod. Scaling a StatefulSet down leaves its volumes behind by default.`,
    );
  }
  if (storage.unboundCount > 0) {
    suggestions.push(
      `${storage.unboundCount} claim${storage.unboundCount === 1 ? "" : "s"} never bound to a volume — nothing was provisioned, so nothing is charged, but the pods waiting on them cannot start.`,
    );
  }
  if (storage.gib > 0 && storage.dailyAttributedCost == null) {
    suggestions.push(
      `${Math.round(storage.gib)}Gi of persistent volumes are shown without cost — no per-GiB-month price is configured for ${storage.unpricedClasses.join(", ") || "these storage classes"}.`,
    );
  }
  if (loadBalancers.count > 0 && loadBalancers.anyUnpriced) {
    suggestions.push(
      `${loadBalancers.provisionedCount} provisioned load balancer${loadBalancers.provisionedCount === 1 ? "" : "s"} ${loadBalancers.provisionedCount === 1 ? "is" : "are"} counted without cost — no per-load-balancer price is configured.`,
    );
  }
  if (costs.cluster.hourlyControlPlaneCost == null) {
    // Stated only when there are managed-looking signals would be guesswork, so
    // it is stated whenever the fee is absent: a self-managed cluster's control
    // plane really is already in the node compute above, and saying so is the
    // only way a reader can tell that case from a missing price.
    suggestions.push(
      "No managed control-plane fee is included. On EKS, GKE or AKS that flat per-cluster charge is on the cloud account; on a self-managed cluster it is already counted, because the control-plane nodes are nodes.",
    );
  }

  if (suggestions.length === 0) return {};

  return {
    guidance: {
      title: `Derived allocation — node prices from ${describeRateSource(costs.rateSource)}. These are apportioned estimates, not billed amounts.`,
      suggestions,
    },
  };
}
