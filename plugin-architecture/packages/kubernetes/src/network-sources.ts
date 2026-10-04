/**
 * Reading what a cluster can say about its own network traffic.
 *
 * The Kubernetes API itself has no byte counters: `metrics.k8s.io` is CPU and
 * memory only. Everything here reaches *past* the API server, through its
 * proxy subresources, to two sources that do count, each optional and each
 * detected rather than configured:
 *
 * 1. **The kubelet's Summary API**, `GET /api/v1/nodes/{node}/proxy/stats/summary`.
 *    Every kubelet serves it (it is what metrics-server itself reads), and each
 *    pod entry carries `network.rxBytes` / `network.txBytes`: cumulative
 *    counters for the pod's network namespace since it started. Needs `get` on
 *    `nodes/proxy`. Field names are the `json` tags of
 *    `k8s.io/kubelet/pkg/apis/stats/v1alpha1` (`podRef`, `startTime`,
 *    `network`, with `InterfaceStats` inlined into `NetworkStats`).
 * 2. **Cilium's Hubble metrics**, scraped from each agent pod at
 *    `GET /api/v1/namespaces/{ns}/pods/{pod}:9965/proxy/metrics`. Hubble counts
 *    *flows*, not bytes: `hubble_flows_processed_total` has no byte value, and
 *    neither does any other Hubble metric. What it does have, when the operator
 *    configured `labelsContext`, is `source_namespace` / `source_workload` /
 *    `destination_namespace` / `destination_workload` on every series, which
 *    is exactly the *who talks to whom* the kubelet counter lacks. So Hubble
 *    supplies the destination mix and the kubelet supplies the bytes.
 *
 * Neither is required. A cluster with neither still gets the node-level flow
 * log path (see `network-flows.ts`) when its cloud account collects flows.
 */

import type { K8sFetch } from "./shared.js";

/** A node as the network model needs it. */
export interface NetNode {
  name: string;
  zone: string;
  region: string;
  /** Cloud the node runs on, from `spec.providerID`'s scheme: `aws`, `gce`, … */
  cloud: string;
  /**
   * The provider's own id for the machine (`i-0abc…` on EC2), which is what a
   * cloud account's flow collection stores as the endpoint ref. Empty when the
   * provider id does not name one.
   */
  instanceRef: string;
}

/** A running pod as the network model needs it. */
export interface NetPod {
  namespace: string;
  name: string;
  node: string;
  workload: string;
  workloadKind: string;
  /** Pods on the host network share the node's counters and are never attributed. */
  hostNetwork: boolean;
  /** Epoch ms the pod started, or `null` when the API did not say. */
  startedAt: number | null;
  labels: Record<string, string>;
}

/** Raw node shape: only the fields read here. */
interface RawNode {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { providerID?: string };
}

/** Raw pod shape: only the fields read here. */
export interface RawPod {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }>;
  };
  spec?: { nodeName?: string; hostNetwork?: boolean };
  status?: { phase?: string; startTime?: string };
}

/**
 * Split a `spec.providerID` into the cloud and the machine id that cloud's
 * flow logs name.
 *
 * The formats are the cloud controller managers' own:
 * `aws:///us-east-1a/i-0abc…`, `gce://project/zone/instance`,
 * `azure:///subscriptions/…/virtualMachines/name` (or a scale set instance,
 * `…/virtualMachineScaleSets/pool/virtualMachines/3`), `digitalocean://12345`.
 * The last path segment is the machine id in every one of them.
 */
export function parseProviderId(providerId: string | undefined): {
  cloud: string;
  instanceRef: string;
} {
  if (!providerId) return { cloud: "", instanceRef: "" };
  const match = /^([a-z0-9-]+):\/\/(.*)$/i.exec(providerId.trim());
  if (!match) return { cloud: "", instanceRef: "" };
  const cloud = match[1]!.toLowerCase();
  const segments = match[2]!.split("/").filter(Boolean);
  return { cloud, instanceRef: segments[segments.length - 1] ?? "" };
}

/**
 * Which Infrawrench plugin publishes the transfer rates for a provider id
 * scheme. Only clouds whose plugin publishes a rate card are named; anything
 * else prices from the cluster's own overrides or not at all.
 */
export function ratePluginForCloud(cloud: string): string | undefined {
  switch (cloud) {
    case "aws":
      return "aws";
    case "gce":
      return "gcp";
    case "azure":
      return "azure";
    case "digitalocean":
      return "digitalocean";
    default:
      return undefined;
  }
}

export function toNetNode(node: RawNode): NetNode {
  const labels = node.metadata.labels ?? {};
  const { cloud, instanceRef } = parseProviderId(node.spec?.providerID);
  return {
    name: node.metadata.name,
    zone:
      labels["topology.kubernetes.io/zone"] ??
      labels["failure-domain.beta.kubernetes.io/zone"] ??
      "",
    region:
      labels["topology.kubernetes.io/region"] ??
      labels["failure-domain.beta.kubernetes.io/region"] ??
      "",
    cloud,
    instanceRef,
  };
}

/** One pod's network counters, as of `measuredAt`. */
export interface PodCounter {
  namespace: string;
  name: string;
  txBytes: number;
  rxBytes: number;
  /** Epoch ms of the measurement (the summary's `time`, else when we asked). */
  measuredAt: number;
  /** Epoch ms the pod started, per the kubelet. */
  startedAt: number | null;
}

interface SummaryInterface {
  name?: string;
  rxBytes?: number;
  txBytes?: number;
}

interface SummaryPod {
  podRef?: { name?: string; namespace?: string };
  startTime?: string;
  network?: SummaryInterface & { time?: string; interfaces?: SummaryInterface[] };
}

/**
 * Pull per-pod counters out of one kubelet Summary response.
 *
 * `network.txBytes` is the pod's default interface; `interfaces` lists every
 * interface in the pod's network namespace. Summing `interfaces` when present
 * catches a second interface (Multus) the default would miss; the default is
 * the fallback for kubelets that only fill the inline fields.
 */
export function parseSummaryPods(body: unknown, fallbackNow: number): PodCounter[] {
  const pods = (body as { pods?: SummaryPod[] } | null)?.pods;
  if (!Array.isArray(pods)) return [];
  const out: PodCounter[] = [];
  for (const pod of pods) {
    const name = pod.podRef?.name;
    const namespace = pod.podRef?.namespace;
    const network = pod.network;
    if (!name || !namespace || !network) continue;
    let tx = 0;
    let rx = 0;
    if (Array.isArray(network.interfaces) && network.interfaces.length > 0) {
      for (const iface of network.interfaces) {
        tx += finiteOrZero(iface.txBytes);
        rx += finiteOrZero(iface.rxBytes);
      }
    } else {
      tx = finiteOrZero(network.txBytes);
      rx = finiteOrZero(network.rxBytes);
    }
    const measured = network.time ? Date.parse(network.time) : NaN;
    const started = pod.startTime ? Date.parse(pod.startTime) : NaN;
    out.push({
      namespace,
      name,
      txBytes: tx,
      rxBytes: rx,
      measuredAt: Number.isFinite(measured) ? measured : fallbackNow,
      startedAt: Number.isFinite(started) ? started : null,
    });
  }
  return out;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Run `work` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await work(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Kubelet counters for every node that answered, and how many did not. */
export interface CounterReadResult {
  counters: PodCounter[];
  nodesRead: number;
  nodesFailed: number;
  /** The first failure, for the setup message when every node failed. */
  firstError: string | null;
}

/** Read the kubelet Summary from every node, a few at a time. */
export async function readPodCounters(
  fetch: K8sFetch,
  nodeNames: string[],
  now: number,
): Promise<CounterReadResult> {
  const settled = await mapLimited(nodeNames, 6, (name) =>
    fetch<unknown>(`/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`),
  );
  const counters: PodCounter[] = [];
  let nodesRead = 0;
  let nodesFailed = 0;
  let firstError: string | null = null;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      nodesRead += 1;
      counters.push(...parseSummaryPods(result.value, now));
    } else {
      nodesFailed += 1;
      firstError ??= result.reason instanceof Error ? result.reason.message : String(result.reason);
    }
  }
  return { counters, nodesRead, nodesFailed, firstError };
}

/** One Hubble series, reduced to the labels the model uses. */
export interface HubbleFlowSample {
  sourceNamespace: string;
  sourceWorkload: string;
  destinationNamespace: string;
  destinationWorkload: string;
  /** `egress`, `ingress`, `unknown` or empty when `traffic_direction` is not configured. */
  direction: string;
  /** Flow count: a weight, never bytes. */
  flows: number;
}

/**
 * Parse `hubble_flows_processed_total` lines from a Prometheus text exposition.
 *
 * Only series carrying a `source_workload` label are useful: without
 * `labelsContext` configured Hubble reports protocol and verdict alone, which
 * says nothing about who was talking, and those series are skipped rather than
 * read as "nobody".
 */
export function parseHubbleFlows(text: string): HubbleFlowSample[] {
  const out: HubbleFlowSample[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("hubble_flows_processed_total{")) continue;
    const close = line.lastIndexOf("}");
    if (close < 0) continue;
    const labels = parsePromLabels(line.slice("hubble_flows_processed_total{".length, close));
    const value = Number(
      line
        .slice(close + 1)
        .trim()
        .split(/\s+/)[0],
    );
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!("source_workload" in labels)) continue;
    // Dropped flows never left the pod, so they moved no billable bytes.
    if (labels["verdict"] && labels["verdict"] !== "FORWARDED") continue;
    out.push({
      sourceNamespace: labels["source_namespace"] ?? "",
      sourceWorkload: labels["source_workload"] ?? "",
      destinationNamespace: labels["destination_namespace"] ?? "",
      destinationWorkload: labels["destination_workload"] ?? "",
      direction: labels["traffic_direction"] ?? "",
      flows: value,
    });
  }
  return out;
}

/** `a="x",b="y\"z"` → `{a: "x", b: "y\"z"}`, honouring Prometheus escapes. */
export function parsePromLabels(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (body[i] === "," || body[i] === " ") i++;
    const eq = body.indexOf("=", i);
    if (eq < 0) break;
    const key = body.slice(i, eq).trim();
    i = eq + 1;
    if (body[i] !== '"') break;
    i++;
    let value = "";
    while (i < body.length && body[i] !== '"') {
      if (body[i] === "\\" && i + 1 < body.length) {
        const next = body[i + 1];
        value += next === "n" ? "\n" : next;
        i += 2;
        continue;
      }
      value += body[i];
      i++;
    }
    i++;
    if (key) out[key] = value;
  }
  return out;
}

/** The Hubble metrics port every Cilium chart uses by default. */
const HUBBLE_METRICS_PORT = 9965;

/** Hubble flow samples from every Cilium agent that answered. */
export interface HubbleReadResult {
  samples: HubbleFlowSample[];
  agents: number;
  agentsRead: number;
  /** True when at least one agent exposed workload-labelled series. */
  workloadLabelled: boolean;
}

/**
 * Find Cilium agent pods and scrape their Hubble metrics.
 *
 * Agents are found by the chart's own label, `k8s-app=cilium`, in whatever
 * namespace they run (`kube-system` by default, `cilium` on some installs).
 */
export async function readHubbleFlows(
  fetchText: (path: string) => Promise<string>,
  pods: RawPod[],
): Promise<HubbleReadResult> {
  const agents = pods.filter(
    (p) => p.metadata.labels?.["k8s-app"] === "cilium" && p.status?.phase === "Running",
  );
  if (agents.length === 0)
    return { samples: [], agents: 0, agentsRead: 0, workloadLabelled: false };
  const settled = await mapLimited(agents, 6, (pod) =>
    fetchText(
      `/api/v1/namespaces/${encodeURIComponent(pod.metadata.namespace ?? "kube-system")}/pods/` +
        `${encodeURIComponent(pod.metadata.name)}:${HUBBLE_METRICS_PORT}/proxy/metrics`,
    ),
  );
  const samples: HubbleFlowSample[] = [];
  let agentsRead = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    agentsRead += 1;
    samples.push(...parseHubbleFlows(result.value));
  }
  return { samples, agents: agents.length, agentsRead, workloadLabelled: samples.length > 0 };
}
