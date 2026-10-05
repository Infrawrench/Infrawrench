/**
 * Pod-level network attribution: which workloads moved bytes across which
 * billing boundary, for one closed UTC day.
 *
 * This plugs the cluster into the host's existing network-flow pipeline
 * (`manifest.networkFlows`), so a Kubernetes account's traffic lands in the
 * same forward-only store, behind the same org opt-in, priced by the same
 * arithmetic, as a cloud account's VPC flow logs. What is specific to a
 * cluster is *where the bytes come from*, and there are three sources, used in
 * order of how much they actually know:
 *
 * 1. **The cloud's own flow logs, joined through the node.** When the org
 *    already collects flows on the cloud account that owns the nodes, that
 *    pass has classified every byte leaving each node's interface as same-zone,
 *    cross-zone, cross-region or internet, exactly, from the wire. The host's
 *    `observedEgress` lookup returns that per node, and each node's bytes are
 *    split across the pods on it by their kubelet counters. The boundary is
 *    observed; only the split between pods sharing a node is apportioned.
 * 2. **An in-cluster flow source** (Cilium Hubble, see `network-sources.ts`)
 *    names who each workload talks to, and the boundary follows from where the
 *    peer's pods run: same zone, another zone, another region. Hubble counts
 *    flows rather than bytes, so its counts weight the kubelet byte counter.
 * 3. **The kubelet counter alone.** Bytes per pod with no destination at all.
 *    The boundary is `unknown` by construction and the record says so. It is
 *    still worth storing: it ranks workloads by how much they send, and with a
 *    billed data-transfer source configured the host can apportion real money
 *    by it (labelled as the weakest basis).
 *
 * **What it deliberately does not do.** It never assigns node traffic it
 * cannot place to a pod: when the node's interface moved more than its pods'
 * counters account for (host-network pods, the kubelet, image pulls) the
 * difference stays on the node as its own row. And it never prices an
 * unknown boundary: `unknown` costs zero here and is labelled, because a guessed
 * boundary is a guessed price.
 *
 * **Why a day is an average.** Kubelet counters are cumulative since the pod
 * started and the plugin is stateless, so a pod's bytes for the day are its
 * lifetime average rate times the part of the day it was running. A pod that
 * ran yesterday and is gone now is invisible. Both limits are stated on the
 * surface; neither inflates anything.
 */

import {
  NetworkFlowSetupError,
  type NetworkFlowCapabilityDeclaration,
  type NetworkFlowEndpoint,
  type NetworkFlowFetchRange,
  type NetworkFlowFetchResult,
  type NetworkFlowMethod,
  type NetworkFlowRecord,
  type NetworkFlowScope,
  type NetworkFlowSource,
  type NetworkFlowTotal,
} from "@infrawrench/plugin-base";

import { ownerWorkload } from "./pod-resources.js";
import type { K8sFetch } from "./shared.js";
import {
  ratePluginForCloud,
  readHubbleFlows,
  readPodCounters,
  toNetNode,
  type HubbleFlowSample,
  type NetNode,
  type NetPod,
  type PodCounter,
  type RawPod,
} from "./network-sources.js";

const DAY_MS = 86_400_000;

/**
 * The capability. The rate card is deliberately empty: a cluster has no
 * transfer prices of its own. Each fetch names the cloud whose card applies
 * (`ratesFromPlugin`) plus any per-cluster overrides, and the host resolves
 * them; with neither, bytes are stored with no money attached.
 */
export const KUBERNETES_NETWORK_FLOW_CAPABILITY: NetworkFlowCapabilityDeclaration = {
  rates: { currency: "USD", asOf: "2026-10-04", perGb: {} },
  maxPairsPerDay: 500,
  // Counters describe the pods running *now*: yesterday is the only closed day
  // a snapshot can speak for with any honesty.
  maxHistoryDays: 1,
  // Pod traffic leaves through node interfaces a cloud account's flow log may
  // already count: never add these rows to an org-wide total.
  recut: true,
};

/** Reserved prefix in the `nodeHourlyRates` field: `network/cross_zone=0.01`. */
const NETWORK_RATE_PREFIX = "network/";

const OVERRIDABLE_SCOPES: ReadonlySet<NetworkFlowScope> = new Set([
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "provider_service",
  "nat_gateway",
  "private_interconnect",
]);

/**
 * Per-cluster transfer-rate overrides, per GB, from the same optional rates
 * field that prices nodes, volumes and load balancers.
 *
 * Read here rather than in `node-rates.ts` so the compute rate table is
 * untouched: `network/…` keys contain a slash, which no instance type does, so
 * the compute parser already ignores them as instance types that never match.
 * The JSON form takes a `networkPerGb` object keyed by scope.
 */
export function parseNetworkRateOverrides(
  raw: string | undefined | null,
): Partial<Record<NetworkFlowScope, number>> | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  const out: Partial<Record<NetworkFlowScope, number>> = {};
  const accept = (scope: string, value: unknown) => {
    const rate = typeof value === "number" ? value : Number(value);
    if (!OVERRIDABLE_SCOPES.has(scope as NetworkFlowScope)) return;
    if (!Number.isFinite(rate) || rate < 0) return;
    out[scope as NetworkFlowScope] = rate;
  };
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const map = parsed["networkPerGb"];
      if (map && typeof map === "object") {
        for (const [scope, value] of Object.entries(map as Record<string, unknown>)) {
          accept(scope, value);
        }
      }
    } catch {
      return undefined;
    }
  } else {
    for (const entry of text.split(/[,\n]/)) {
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      const name = entry.slice(0, eq).trim();
      if (!name.startsWith(NETWORK_RATE_PREFIX)) continue;
      accept(name.slice(NETWORK_RATE_PREFIX.length), entry.slice(eq + 1).trim());
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Bytes a pod sent during `day`, from its lifetime-average rate. */
export function podBytesForDay(counter: PodCounter, startedAt: number | null, day: string): number {
  const start = counter.startedAt ?? startedAt;
  if (start === null) return 0;
  const uptime = counter.measuredAt - start;
  // Under a minute of uptime is a rate made of noise.
  if (uptime < 60_000 || counter.txBytes <= 0) return 0;
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const dayEnd = dayStart + DAY_MS;
  const overlap = Math.min(dayEnd, counter.measuredAt) - Math.max(dayStart, start);
  if (overlap <= 0) return 0;
  return (counter.txBytes / uptime) * overlap;
}

export function workloadRef(pod: Pick<NetPod, "namespace" | "workload" | "workloadKind">): string {
  return `${pod.namespace}/${pod.workloadKind}/${pod.workload}`;
}

/** The token a boundary class is stored under when the peer is not named. */
export function peerClassEndpoint(scope: NetworkFlowScope): NetworkFlowEndpoint {
  switch (scope) {
    case "internet_egress":
      return { ref: "internet", label: "Internet" };
    case "intra_zone":
      return { ref: "k8s:peers/intra_zone", label: "Same-zone peers" };
    case "cross_zone":
      return { ref: "k8s:peers/cross_zone", label: "Peers in another zone" };
    case "cross_region":
      return { ref: "k8s:peers/cross_region", label: "Peers in another region" };
    case "provider_service":
      return { ref: "k8s:peers/provider_service", label: "Cloud provider services" };
    case "nat_gateway":
      return { ref: "k8s:peers/nat_gateway", label: "Through a NAT gateway" };
    case "private_interconnect":
      return { ref: "k8s:peers/private_interconnect", label: "VPN / interconnect" };
    default:
      return { ref: "k8s:peers/unknown", label: "Unclassified peers" };
  }
}

/** Peers that name a place the user can act on, even without a resource id. */
function classIsActionable(scope: NetworkFlowScope): boolean {
  return scope === "internet_egress" || scope === "provider_service" || scope === "nat_gateway";
}

export const UNOBSERVED_DESTINATION: NetworkFlowEndpoint = {
  ref: "k8s:unobserved",
  label: "Destination not observed",
};

export const OUTSIDE_CLUSTER_DESTINATION: NetworkFlowEndpoint = {
  ref: "k8s:outside-cluster",
  label: "Outside the cluster",
};

export interface ClusterNetworkInput {
  day: string;
  nodes: NetNode[];
  pods: NetPod[];
  counters: PodCounter[];
  hubble: HubbleFlowSample[];
  /** node name → egress bytes by boundary, from the cloud account's flow logs. */
  nodeEgress: Map<string, Partial<Record<NetworkFlowScope, number>>>;
}

export interface ClusterNetworkOutput {
  flows: NetworkFlowRecord[];
  totals: NetworkFlowTotal[];
  /** Bytes per method, so the source list can say which one carried the day. */
  bytesByMethod: Record<NetworkFlowMethod, number>;
}

/**
 * The pure model: inventory, counters, flow weights and node egress in;
 * aggregated workload records out. No I/O, so every branch is testable.
 */
export function buildClusterNetworkFlows(input: ClusterNetworkInput): ClusterNetworkOutput {
  const { day } = input;
  const nodes = new Map(input.nodes.map((n) => [n.name, n]));
  const podsByKey = new Map(input.pods.map((p) => [`${p.namespace}/${p.name}`, p]));
  const flows: NetworkFlowRecord[] = [];
  const bytesByMethod: Record<NetworkFlowMethod, number> = {
    flow_log: 0,
    in_cluster_flows: 0,
    counter_estimate: 0,
  };

  const emit = (record: Omit<NetworkFlowRecord, "date" | "direction">) => {
    if (!(record.bytes > 0)) return;
    flows.push({ ...record, date: day, direction: "egress" });
    if (record.method) bytesByMethod[record.method] += record.bytes;
  };

  // Day bytes per attributable pod. Host-network pods share the node's
  // network namespace, so their "counter" is the whole node's: never a pod's.
  const podBytes = new Map<string, number>();
  for (const counter of input.counters) {
    const key = `${counter.namespace}/${counter.name}`;
    const pod = podsByKey.get(key);
    if (!pod || pod.hostNetwork) continue;
    const bytes = podBytesForDay(counter, pod.startedAt, day);
    if (bytes > 0) podBytes.set(key, bytes);
  }

  const bytesOnNode = new Map<string, number>();
  for (const [key, bytes] of podBytes) {
    const node = podsByKey.get(key)!.node;
    bytesOnNode.set(node, (bytesOnNode.get(node) ?? 0) + bytes);
  }

  // Hubble weights per source workload (namespace/name, as Hubble names it).
  // Egress-observed series only when the operator configured direction: a
  // pod-to-pod flow is otherwise seen at both ends, which is harmless for a
  // ratio but not when one end is outside the cluster and only seen once.
  const haveDirection = input.hubble.some((s) => s.direction === "egress");
  const weights = new Map<string, Map<string, number>>();
  for (const sample of input.hubble) {
    if (haveDirection && sample.direction !== "egress") continue;
    if (!sample.sourceWorkload || !sample.sourceNamespace) continue;
    const src = `${sample.sourceNamespace}/${sample.sourceWorkload}`;
    const dst = sample.destinationWorkload
      ? `${sample.destinationNamespace}/${sample.destinationWorkload}`
      : "";
    let map = weights.get(src);
    if (!map) weights.set(src, (map = new Map()));
    map.set(dst, (map.get(dst) ?? 0) + sample.flows);
  }

  const podsByWorkloadName = new Map<string, NetPod[]>();
  for (const pod of input.pods) {
    if (pod.hostNetwork) continue;
    const key = `${pod.namespace}/${pod.workload}`;
    const list = podsByWorkloadName.get(key);
    if (list) list.push(pod);
    else podsByWorkloadName.set(key, [pod]);
  }

  const sourceEndpoint = (pod: NetPod): NetworkFlowEndpoint => {
    const node = nodes.get(pod.node);
    return {
      ref: workloadRef(pod),
      label: `${pod.namespace}/${pod.workload}`,
      ...(node?.zone ? { zone: node.zone } : {}),
      ...(node?.region ? { region: node.region } : {}),
    };
  };

  for (const [key, bytes] of podBytes) {
    const pod = podsByKey.get(key)!;
    const node = nodes.get(pod.node);
    const source = sourceEndpoint(pod);

    // 1. The cloud's flow log, through the node.
    const egress = input.nodeEgress.get(pod.node);
    const nodeTotal = egress ? sumValues(egress) : 0;
    if (egress && nodeTotal > 0) {
      // Never hand a pod more than the node moved, and never more than its
      // own counter's share of what the pods on the node sent.
      const denominator = Math.max(bytesOnNode.get(pod.node) ?? 0, nodeTotal);
      for (const [scope, scopeBytes] of Object.entries(egress) as [NetworkFlowScope, number][]) {
        const destination = peerClassEndpoint(scope);
        emit({
          source,
          destination,
          scope,
          attribution: classIsActionable(scope) ? "resolved" : "unattributed",
          bytes: (scopeBytes * bytes) / denominator,
          method: "flow_log",
        });
      }
      continue;
    }

    // 2. An in-cluster flow source naming the peers.
    const mix = weights.get(`${pod.namespace}/${pod.workload}`);
    const mixTotal = mix ? sumValues(Object.fromEntries(mix)) : 0;
    if (mix && mixTotal > 0) {
      for (const [dst, weight] of mix) {
        const part = (bytes * weight) / mixTotal;
        if (!dst) {
          // Hubble's `world` is everything outside the cluster: the internet,
          // but equally a managed database in the same VPC. Which boundary it
          // crossed is not in the data, so it is not priced as either.
          emit({
            source,
            destination: OUTSIDE_CLUSTER_DESTINATION,
            scope: "unknown",
            attribution: "unattributed",
            bytes: part,
            method: "in_cluster_flows",
          });
          continue;
        }
        const peers = podsByWorkloadName.get(dst) ?? [];
        if (peers.length === 0 || !node?.zone) {
          emit({
            source,
            destination: { ref: `k8s:workload/${dst}`, label: dst },
            scope: "unknown",
            attribution: "unattributed",
            bytes: part,
            method: "in_cluster_flows",
          });
          continue;
        }
        const first = peers[0]!;
        const destination: NetworkFlowEndpoint = {
          ref: workloadRef(first),
          label: dst,
          ...(node.region ? { region: node.region } : {}),
        };
        // Spread over where the peer's replicas run: a Service balances
        // across them, so a peer with two of three replicas in our zone takes
        // two thirds of our traffic for free and one third across a boundary.
        const share = new Map<NetworkFlowScope, number>();
        for (const peer of peers) {
          const peerNode = nodes.get(peer.node);
          const scope: NetworkFlowScope = !peerNode?.zone
            ? "unknown"
            : peerNode.zone === node.zone
              ? "intra_zone"
              : node.region && peerNode.region && peerNode.region !== node.region
                ? "cross_region"
                : "cross_zone";
          share.set(scope, (share.get(scope) ?? 0) + 1);
        }
        for (const [scope, count] of share) {
          emit({
            source,
            destination,
            scope,
            attribution: scope === "unknown" ? "unattributed" : "resolved",
            bytes: (part * count) / peers.length,
            method: "in_cluster_flows",
          });
        }
      }
      continue;
    }

    // 3. The counter alone: bytes, no boundary.
    emit({
      source,
      destination: UNOBSERVED_DESTINATION,
      scope: "unknown",
      attribution: "unattributed",
      bytes,
      method: "counter_estimate",
    });
  }

  // What each flow-logged node moved beyond its pods' counters stays on the
  // node. This is also the whole answer for a node whose kubelet we could not
  // read: the boundary mix is still exact, only the pod split is missing.
  for (const [nodeName, egress] of input.nodeEgress) {
    const nodeTotal = sumValues(egress);
    if (nodeTotal <= 0) continue;
    const podTotal = bytesOnNode.get(nodeName) ?? 0;
    const remainderShare = podTotal >= nodeTotal ? 0 : 1 - podTotal / nodeTotal;
    if (remainderShare <= 0) continue;
    const node = nodes.get(nodeName);
    const source: NetworkFlowEndpoint = {
      ref: `k8s:node/${nodeName}`,
      label: `${nodeName} (node and host-network traffic)`,
      ...(node?.zone ? { zone: node.zone } : {}),
      ...(node?.region ? { region: node.region } : {}),
    };
    for (const [scope, scopeBytes] of Object.entries(egress) as [NetworkFlowScope, number][]) {
      emit({
        source,
        destination: peerClassEndpoint(scope),
        scope,
        attribution: "unattributed",
        bytes: scopeBytes * remainderShare,
        method: "flow_log",
      });
    }
  }

  // Exact by construction: the host's residual is then only what it truncated.
  const totalsByScope = new Map<NetworkFlowScope, number>();
  for (const flow of flows) {
    totalsByScope.set(flow.scope, (totalsByScope.get(flow.scope) ?? 0) + flow.bytes);
  }
  const totals: NetworkFlowTotal[] = [...totalsByScope].map(([scope, bytes]) => ({
    date: day,
    scope,
    direction: "egress",
    bytes,
  }));

  return { flows, totals, bytesByMethod };
}

function sumValues(map: Partial<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(map)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/** Raw node list shape. */
interface RawNodeList {
  items?: Array<{
    metadata: { name: string; labels?: Record<string, string> };
    spec?: { providerID?: string };
  }>;
}

export function toNetPods(pods: RawPod[]): NetPod[] {
  const out: NetPod[] = [];
  for (const pod of pods) {
    const phase = pod.status?.phase;
    if (phase !== "Running") continue;
    const namespace = pod.metadata.namespace ?? "default";
    const { workload, workloadKind } = ownerWorkload(
      pod.metadata.ownerReferences,
      pod.metadata.labels,
      pod.metadata.name,
    );
    const started = pod.status?.startTime ? Date.parse(pod.status.startTime) : NaN;
    out.push({
      namespace,
      name: pod.metadata.name,
      node: pod.spec?.nodeName ?? "",
      workload,
      workloadKind,
      hostNetwork: pod.spec?.hostNetwork === true,
      startedAt: Number.isFinite(started) ? started : null,
      labels: pod.metadata.labels ?? {},
    });
  }
  return out;
}

/** The single most common non-empty value, or `""`. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

const HELP_URL = "https://kubernetes.io/docs/reference/instrumentation/node-metrics/";

export interface KubernetesNetworkDeps {
  fetch: K8sFetch;
  fetchText: (path: string) => Promise<string>;
  /** The account's `nodeHourlyRates` credential, for `network/…` overrides. */
  ratesField: string | undefined;
  now?: number;
}

/**
 * Read one closed day for a cluster. Throws {@link NetworkFlowSetupError} when
 * no source could say anything at all, so the host shows the fix instead of
 * retrying hourly.
 */
export async function fetchKubernetesNetworkFlows(
  deps: KubernetesNetworkDeps,
  range: NetworkFlowFetchRange,
): Promise<NetworkFlowFetchResult> {
  const now = deps.now ?? Date.now();
  const [nodeList, podList] = await Promise.all([
    deps.fetch<RawNodeList>("/api/v1/nodes"),
    deps.fetch<{ items?: RawPod[] }>("/api/v1/pods"),
  ]);
  const nodes = (nodeList.items ?? []).map(toNetNode);
  const rawPods = podList.items ?? [];
  const pods = toNetPods(rawPods);

  const [counterRead, hubbleRead, observed] = await Promise.all([
    readPodCounters(
      deps.fetch,
      nodes.map((n) => n.name),
      now,
    ),
    readHubbleFlows(deps.fetchText, rawPods).catch(() => ({
      samples: [],
      agents: 0,
      agentsRead: 0,
      workloadLabelled: false,
    })),
    range.observedEgress
      ? range.observedEgress(nodes.map((n) => n.instanceRef).filter(Boolean)).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (range.signal?.aborted) {
    throw new Error(`Host withdrew network-flow authorization while collecting ${range.day}`);
  }

  const nodeByInstance = new Map(nodes.filter((n) => n.instanceRef).map((n) => [n.instanceRef, n]));
  const nodeEgress = new Map<string, Partial<Record<NetworkFlowScope, number>>>();
  for (const row of observed) {
    const node = nodeByInstance.get(row.ref);
    if (!node || !(row.bytes > 0)) continue;
    let entry = nodeEgress.get(node.name);
    if (!entry) nodeEgress.set(node.name, (entry = {}));
    entry[row.scope] = (entry[row.scope] ?? 0) + row.bytes;
  }

  const sources: NetworkFlowSource[] = [];
  const cluster = "cluster";
  sources.push({
    id: "vpc-flow-logs",
    target: cluster,
    destinationType: "flow_log",
    usable: nodeEgress.size > 0,
    ...(nodeEgress.size > 0
      ? {}
      : {
          unusableReason: range.observedEgress
            ? "No flow logs were collected for this cluster's nodes on the cloud account that owns " +
              "them. Turn on network flow collection for that account (AWS VPC flow logs to " +
              "CloudWatch Logs) and boundaries become exact rather than inferred."
            : "This host does not share other accounts' flow logs with the cluster.",
        }),
  });
  sources.push({
    id: "cilium-hubble",
    target: cluster,
    destinationType: "in_cluster_flows",
    usable: hubbleRead.workloadLabelled,
    ...(hubbleRead.workloadLabelled
      ? {}
      : {
          unusableReason:
            hubbleRead.agents === 0
              ? "No Cilium agents found, so there is no in-cluster record of which workload talks to which."
              : hubbleRead.agentsRead === 0
                ? "Cilium agents are running but their Hubble metrics endpoint (port 9965) could not be read through the API server proxy."
                : "Hubble metrics are on but carry no workload labels. Enable the flow metric with " +
                  "labelsContext including source_namespace, source_workload, destination_namespace and destination_workload.",
          helpUrl: "https://docs.cilium.io/en/stable/observability/metrics/",
        }),
  });
  sources.push({
    id: "kubelet-stats",
    target: cluster,
    destinationType: "counter",
    usable: counterRead.nodesRead > 0,
    ...(counterRead.nodesRead > 0
      ? {}
      : {
          unusableReason:
            "Per-pod network counters could not be read from the kubelet. The kubeconfig needs " +
            "`get` on `nodes/proxy` to read /stats/summary." +
            (counterRead.firstError ? ` (${counterRead.firstError.slice(0, 200)})` : ""),
          helpUrl: HELP_URL,
        }),
  });

  if (counterRead.nodesRead === 0 && nodeEgress.size === 0) {
    throw new NetworkFlowSetupError(
      sources.find((s) => s.id === "kubelet-stats")!.unusableReason!,
      HELP_URL,
    );
  }

  const built = buildClusterNetworkFlows({
    day: range.day,
    nodes,
    pods,
    counters: counterRead.counters,
    hubble: hubbleRead.samples,
    nodeEgress,
  });

  const ratesFromPlugin = ratePluginForCloud(mostCommon(nodes.map((n) => n.cloud)));
  const rateOverrides = parseNetworkRateOverrides(deps.ratesField);

  return {
    sources,
    flows: built.flows,
    totals: built.totals,
    ...(counterRead.nodesFailed > 0 ? { degraded: true } : {}),
    ...(ratesFromPlugin ? { ratesFromPlugin } : {}),
    ...(rateOverrides ? { rateOverrides } : {}),
  };
}
