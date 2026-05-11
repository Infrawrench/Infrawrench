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

/**
 * Build the peer pane (the side panel showing related resources). We list
 * every resource type in parallel, then assemble groups in display order;
 * empty groups without create support are hidden.
 */
export async function renderPeerPane(
  context: PeerPaneContext,
  listerCtx: ListerContext,
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
