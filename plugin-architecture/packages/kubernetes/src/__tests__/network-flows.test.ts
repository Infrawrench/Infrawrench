import { describe, expect, it } from "vitest";
import { NetworkFlowSetupError, applyNetworkRateOverrides } from "@infrawrench/plugin-base";

import {
  buildClusterNetworkFlows,
  fetchKubernetesNetworkFlows,
  parseNetworkRateOverrides,
  podBytesForDay,
  type ClusterNetworkInput,
} from "../network-flows.js";
import {
  parseHubbleFlows,
  parsePromLabels,
  parseProviderId,
  parseSummaryPods,
  ratePluginForCloud,
  type NetNode,
  type NetPod,
} from "../network-sources.js";

const DAY = "2026-10-03";
const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);
const NOW = DAY_START + 36 * 3_600_000; // noon the following day
const GB = 1e9;

function pod(over: Partial<NetPod> & Pick<NetPod, "name" | "node" | "workload">): NetPod {
  return {
    namespace: "app",
    workloadKind: "Deployment",
    hostNetwork: false,
    startedAt: DAY_START - 2 * 86_400_000,
    labels: {},
    ...over,
  };
}

const nodes: NetNode[] = [
  { name: "a", zone: "use1-az1", region: "us-east-1", cloud: "aws", instanceRef: "i-a" },
  { name: "b", zone: "use1-az2", region: "us-east-1", cloud: "aws", instanceRef: "i-b" },
];

/** A counter whose lifetime-average rate is exactly `perDay` bytes a day. */
function counter(name: string, perDay: number, namespace = "app") {
  const started = DAY_START - 2 * 86_400_000;
  const uptimeDays = (NOW - started) / 86_400_000;
  return {
    namespace,
    name,
    txBytes: perDay * uptimeDays,
    rxBytes: 0,
    measuredAt: NOW,
    startedAt: started,
  };
}

function input(over: Partial<ClusterNetworkInput>): ClusterNetworkInput {
  return {
    day: DAY,
    nodes,
    pods: [],
    counters: [],
    hubble: [],
    nodeEgress: new Map(),
    ...over,
  };
}

describe("parseProviderId", () => {
  it("takes the cloud from the scheme and the machine id from the last segment", () => {
    expect(parseProviderId("aws:///us-east-1a/i-0abc")).toEqual({
      cloud: "aws",
      instanceRef: "i-0abc",
    });
    expect(parseProviderId("gce://proj/us-central1-a/gke-node-1")).toEqual({
      cloud: "gce",
      instanceRef: "gke-node-1",
    });
    expect(parseProviderId("digitalocean://12345")).toEqual({
      cloud: "digitalocean",
      instanceRef: "12345",
    });
    expect(parseProviderId(undefined)).toEqual({ cloud: "", instanceRef: "" });
    expect(parseProviderId("not a provider id")).toEqual({ cloud: "", instanceRef: "" });
  });

  it("maps clouds to the plugin that publishes their rates", () => {
    expect(ratePluginForCloud("gce")).toBe("gcp");
    expect(ratePluginForCloud("aws")).toBe("aws");
    expect(ratePluginForCloud("kind")).toBeUndefined();
  });
});

describe("parseSummaryPods", () => {
  it("sums every interface when the kubelet lists them", () => {
    const pods = parseSummaryPods(
      {
        pods: [
          {
            podRef: { name: "web-1", namespace: "app" },
            startTime: "2026-10-01T00:00:00Z",
            network: {
              time: "2026-10-04T12:00:00Z",
              name: "eth0",
              txBytes: 10,
              rxBytes: 5,
              interfaces: [
                { name: "eth0", txBytes: 10, rxBytes: 5 },
                { name: "net1", txBytes: 7, rxBytes: 1 },
              ],
            },
          },
          { podRef: { name: "no-network", namespace: "app" } },
        ],
      },
      0,
    );
    expect(pods).toHaveLength(1);
    expect(pods[0]).toMatchObject({ txBytes: 17, rxBytes: 6 });
    expect(pods[0]!.measuredAt).toBe(Date.parse("2026-10-04T12:00:00Z"));
  });

  it("falls back to the inline default interface", () => {
    const [p] = parseSummaryPods(
      { pods: [{ podRef: { name: "x", namespace: "y" }, network: { txBytes: 3, rxBytes: 4 } }] },
      42,
    );
    expect(p).toMatchObject({ txBytes: 3, rxBytes: 4, measuredAt: 42, startedAt: null });
  });
});

describe("Hubble parsing", () => {
  it("reads workload-labelled forwarded flows and skips the rest", () => {
    const text = [
      "# HELP hubble_flows_processed_total Total number of flows processed",
      'hubble_flows_processed_total{source_namespace="app",source_workload="web",destination_namespace="app",destination_workload="db",traffic_direction="egress",verdict="FORWARDED"} 30',
      'hubble_flows_processed_total{source_namespace="app",source_workload="web",destination_namespace="",destination_workload="",traffic_direction="egress",verdict="FORWARDED"} 10',
      'hubble_flows_processed_total{source_namespace="app",source_workload="web",destination_namespace="app",destination_workload="db",traffic_direction="egress",verdict="DROPPED"} 99',
      'hubble_flows_processed_total{protocol="TCP",type="Trace",verdict="FORWARDED"} 500',
    ].join("\n");
    const samples = parseHubbleFlows(text);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ destinationWorkload: "db", flows: 30 });
    expect(samples[1]).toMatchObject({ destinationWorkload: "", flows: 10 });
  });

  it("honours escaped quotes in label values", () => {
    expect(parsePromLabels('a="x",b="y\\"z"')).toEqual({ a: "x", b: 'y"z' });
  });
});

describe("podBytesForDay", () => {
  it("is the lifetime-average rate times the part of the day the pod ran", () => {
    expect(podBytesForDay(counter("p", 4 * GB), null, DAY)).toBeCloseTo(4 * GB, 0);
    // Started at noon of the day: half a day at the same rate.
    const halfDay = {
      ...counter("p", 0),
      startedAt: DAY_START + 12 * 3_600_000,
      txBytes: 24 * 3_600_000, // 1 byte/ms over 24h of uptime
    };
    expect(podBytesForDay(halfDay, null, DAY)).toBeCloseTo(12 * 3_600_000, 0);
  });

  it("is zero for a pod that started after the day and for an unknown start", () => {
    expect(podBytesForDay({ ...counter("p", GB), startedAt: NOW - 3_600_000 }, null, DAY)).toBe(0);
    expect(podBytesForDay({ ...counter("p", GB), startedAt: null }, null, DAY)).toBe(0);
  });
});

describe("buildClusterNetworkFlows", () => {
  it("falls back to the counter alone, with no boundary and no peer", () => {
    const out = buildClusterNetworkFlows(
      input({
        pods: [pod({ name: "web-1", node: "a", workload: "web" })],
        counters: [counter("web-1", GB)],
      }),
    );
    expect(out.flows).toHaveLength(1);
    expect(out.flows[0]).toMatchObject({
      scope: "unknown",
      method: "counter_estimate",
      attribution: "unattributed",
      source: { ref: "app/Deployment/web", zone: "use1-az1", region: "us-east-1" },
      destination: { ref: "k8s:unobserved" },
    });
    expect(out.flows[0]!.bytes).toBeCloseTo(GB, 0);
    expect(out.totals).toEqual([
      expect.objectContaining({ scope: "unknown", direction: "egress" }),
    ]);
  });

  it("never attributes a host-network pod's counter, which is the node's", () => {
    const out = buildClusterNetworkFlows(
      input({
        pods: [pod({ name: "agent", node: "a", workload: "agent", hostNetwork: true })],
        counters: [counter("agent", GB)],
      }),
    );
    expect(out.flows).toEqual([]);
  });

  it("splits by where the peer's replicas run when Hubble names the peer", () => {
    const out = buildClusterNetworkFlows(
      input({
        pods: [
          pod({ name: "web-1", node: "a", workload: "web" }),
          pod({ name: "db-1", node: "a", workload: "db", workloadKind: "StatefulSet" }),
          pod({ name: "db-2", node: "b", workload: "db", workloadKind: "StatefulSet" }),
        ],
        counters: [counter("web-1", 4 * GB)],
        hubble: [
          {
            sourceNamespace: "app",
            sourceWorkload: "web",
            destinationNamespace: "app",
            destinationWorkload: "db",
            direction: "egress",
            flows: 3,
          },
          {
            sourceNamespace: "app",
            sourceWorkload: "web",
            destinationNamespace: "",
            destinationWorkload: "",
            direction: "egress",
            flows: 1,
          },
        ],
      }),
    );
    const byScope = Object.fromEntries(
      out.flows.map((f) => [f.scope + ":" + f.destination.ref, f]),
    );
    // 3/4 of 4 GB to db, half its replicas in our zone.
    expect(byScope["intra_zone:app/StatefulSet/db"]!.bytes).toBeCloseTo(1.5 * GB, 0);
    expect(byScope["cross_zone:app/StatefulSet/db"]!.bytes).toBeCloseTo(1.5 * GB, 0);
    // 1/4 left the cluster for somewhere Hubble cannot classify: never priced.
    expect(byScope["unknown:k8s:outside-cluster"]!.bytes).toBeCloseTo(GB, 0);
    expect(out.flows.every((f) => f.method === "in_cluster_flows")).toBe(true);
    expect(out.bytesByMethod.in_cluster_flows).toBeCloseTo(4 * GB, 0);
  });

  it("uses the node's flow-log boundaries and leaves unexplained node bytes on the node", () => {
    const out = buildClusterNetworkFlows(
      input({
        pods: [
          pod({ name: "web-1", node: "a", workload: "web" }),
          pod({ name: "api-1", node: "a", workload: "api" }),
        ],
        counters: [counter("web-1", 3 * GB), counter("api-1", GB)],
        nodeEgress: new Map([["a", { cross_zone: 6 * GB, internet_egress: 2 * GB }]]),
      }),
    );
    const sum = (ref: string, scope: string) =>
      out.flows
        .filter((f) => f.source.ref === ref && f.scope === scope)
        .reduce((a, f) => a + f.bytes, 0);
    // Node moved 8 GB, pods account for 4 GB: web gets 3/8, api 1/8, node 4/8.
    expect(sum("app/Deployment/web", "cross_zone")).toBeCloseTo(6 * GB * (3 / 8), 0);
    expect(sum("app/Deployment/api", "internet_egress")).toBeCloseTo(2 * GB * (1 / 8), 0);
    expect(sum("k8s:node/a", "cross_zone")).toBeCloseTo(3 * GB, 0);
    // Never more than the node moved.
    const total = out.flows.reduce((a, f) => a + f.bytes, 0);
    expect(total).toBeCloseTo(8 * GB, 0);
    expect(out.flows.every((f) => f.method === "flow_log")).toBe(true);
  });

  it("caps pods at their own counters when they sent more than the node log saw", () => {
    const out = buildClusterNetworkFlows(
      input({
        pods: [pod({ name: "web-1", node: "a", workload: "web" })],
        counters: [counter("web-1", 10 * GB)],
        nodeEgress: new Map([["a", { cross_zone: 2 * GB }]]),
      }),
    );
    const total = out.flows.reduce((a, f) => a + f.bytes, 0);
    expect(total).toBeCloseTo(2 * GB, 0);
    expect(out.flows.some((f) => f.source.ref.startsWith("k8s:node/"))).toBe(false);
  });
});

describe("parseNetworkRateOverrides", () => {
  it("reads network/ keys from the human form and ignores everything else", () => {
    expect(
      parseNetworkRateOverrides(
        "m5.large=0.096, network/cross_zone=0.008\nnetwork/internet_egress=0.05, network/bogus=1, network/unknown=3, network/cross_region=-1",
      ),
    ).toEqual({ cross_zone: 0.008, internet_egress: 0.05 });
    expect(parseNetworkRateOverrides("m5.large=0.096")).toBeUndefined();
  });

  it("reads networkPerGb from the JSON form", () => {
    expect(parseNetworkRateOverrides('{"networkPerGb":{"cross_zone":0.02}}')).toEqual({
      cross_zone: 0.02,
    });
  });

  it("produces a card where the override beats regional rates too", () => {
    const card = applyNetworkRateOverrides(
      {
        currency: "USD",
        asOf: "x",
        perGb: { cross_zone: 0.01 },
        perRegion: { "eu-west-1": { cross_zone: 0.02, internet_egress: 0.1 } },
      },
      { cross_zone: 0 },
    );
    expect(card.perGb.cross_zone).toBe(0);
    expect(card.perRegion?.["eu-west-1"]).toEqual({ internet_egress: 0.1 });
  });
});

describe("fetchKubernetesNetworkFlows", () => {
  const nodeList = {
    items: [
      {
        metadata: {
          name: "a",
          labels: {
            "topology.kubernetes.io/zone": "use1-az1",
            "topology.kubernetes.io/region": "us-east-1",
          },
        },
        spec: { providerID: "aws:///us-east-1a/i-a" },
      },
    ],
  };
  const podList = {
    items: [
      {
        metadata: {
          name: "web-1",
          namespace: "app",
          ownerReferences: [{ kind: "ReplicaSet", name: "web-5d8f", controller: true }],
          labels: { "pod-template-hash": "5d8f" },
        },
        spec: { nodeName: "a" },
        status: { phase: "Running", startTime: new Date(DAY_START - 86_400_000).toISOString() },
      },
    ],
  };

  it("names the cloud's rate card, reads overrides, and borrows node flow logs", async () => {
    const fetch = async <T>(path: string): Promise<T> => {
      if (path === "/api/v1/nodes") return nodeList as T;
      if (path === "/api/v1/pods") return podList as T;
      if (path.endsWith("/proxy/stats/summary")) {
        return {
          pods: [
            {
              podRef: { name: "web-1", namespace: "app" },
              startTime: new Date(DAY_START - 86_400_000).toISOString(),
              network: { time: new Date(NOW).toISOString(), txBytes: 5 * GB },
            },
          ],
        } as T;
      }
      throw new Error(`unexpected ${path}`);
    };
    const asked: string[][] = [];
    const result = await fetchKubernetesNetworkFlows(
      { fetch, fetchText: async () => "", ratesField: "network/cross_zone=0.02", now: NOW },
      {
        day: DAY,
        observedEgress: async (refs) => {
          asked.push(refs);
          return [{ ref: "i-a", scope: "cross_zone", bytes: 10 * GB }];
        },
      },
    );
    expect(asked).toEqual([["i-a"]]);
    expect(result.ratesFromPlugin).toBe("aws");
    expect(result.rateOverrides).toEqual({ cross_zone: 0.02 });
    expect(result.flows.length).toBeGreaterThan(0);
    expect(result.flows.every((f) => f.method === "flow_log")).toBe(true);
    expect(result.sources?.find((s) => s.id === "vpc-flow-logs")?.usable).toBe(true);
    expect(result.sources?.find((s) => s.id === "kubelet-stats")?.usable).toBe(true);
  });

  it("throws a setup error naming the RBAC fix when nothing can be read", async () => {
    const fetch = async <T>(path: string): Promise<T> => {
      if (path === "/api/v1/nodes") return nodeList as T;
      if (path === "/api/v1/pods") return podList as T;
      throw new Error("K8s API error 403: forbidden");
    };
    await expect(
      fetchKubernetesNetworkFlows(
        { fetch, fetchText: async () => "", ratesField: undefined, now: NOW },
        { day: DAY },
      ),
    ).rejects.toBeInstanceOf(NetworkFlowSetupError);
  });
});
