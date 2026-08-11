import { describe, it, expect } from "vitest";
import {
  blastRadiusHeadline,
  blastRadiusSeverity,
  resolveFlowPeerIdentities,
  summarizeBlastRadius,
  type BlastRadiusFlowPeer,
  type BlastRadiusReference,
} from "../blast-radius";
import {
  buildDependencyGraph,
  type DependencyGraphEdge,
  type DependencyGraphNode,
} from "../dependency-graph";

function node(id: string, overrides?: Partial<DependencyGraphNode>): DependencyGraphNode {
  return {
    id,
    displayName: id,
    pluginId: "test",
    pluginDisplayName: "Test",
    pluginLogoSvg: "",
    resourceTypeId: "thing",
    resourceTypeLabel: "Thing",
    accountId: "acct",
    accountName: "Account",
    ...overrides,
  };
}

function edge(
  consumer: string,
  provider: string,
  overrides?: Partial<DependencyGraphEdge>,
): DependencyGraphEdge {
  return {
    consumerResourceId: consumer,
    consumerFieldKey: "field",
    providerResourceId: provider,
    providerOutputKey: "output",
    ...overrides,
  };
}

// db ← api ← web, db ← worker
const nodes = [node("db"), node("api"), node("web"), node("worker")];
const edges = [
  edge("api", "db", { consumerFieldKey: "connectionString" }),
  edge("web", "api", { consumerFieldKey: "apiUrl" }),
  edge("worker", "db", { consumerFieldKey: "connectionString" }),
];

function input(overrides?: Partial<Parameters<typeof summarizeBlastRadius>[0]>) {
  return {
    resourceId: "db",
    model: buildDependencyGraph(nodes, edges),
    references: [] as BlastRadiusReference[],
    flowPeers: [] as BlastRadiusFlowPeer[],
    flowsChecked: false,
    unchecked: [],
    ...overrides,
  };
}

describe("summarizeBlastRadius — dependants", () => {
  it("separates direct from transitive and never includes the resource itself", () => {
    const report = summarizeBlastRadius(input());
    expect(report.dependants.map((d) => `${d.node.id}@${d.depth}`)).toEqual([
      "api@1",
      "worker@1",
      "web@2",
    ]);
    expect(report.directCount).toBe(2);
    expect(report.transitiveCount).toBe(1);
    expect(report.dependants.some((d) => d.node.id === "db")).toBe(false);
  });

  it("captions direct dependants with the edge and leaves transitive ones bare", () => {
    const report = summarizeBlastRadius(input());
    expect(report.dependants[0]?.via).toEqual({
      fieldKey: "connectionString",
      outputKey: "output",
    });
    expect(report.dependants.find((d) => d.node.id === "web")?.via).toBeUndefined();
  });

  it("carries edge provenance and a plugin label through to the caption", () => {
    const report = summarizeBlastRadius(
      input({
        model: buildDependencyGraph(nodes, [
          edge("api", "db", { kind: "declared", label: "runs in" }),
        ]),
      }),
    );
    expect(report.dependants[0]?.via?.kind).toBe("declared");
    expect(report.dependants[0]?.via?.label).toBe("runs in");
  });

  it("resolves the resource node when it participates in the graph", () => {
    expect(summarizeBlastRadius(input()).resource?.id).toBe("db");
  });

  it("reports nothing for a resource nothing depends on", () => {
    const report = summarizeBlastRadius(input({ resourceId: "web" }));
    expect(report.dependants).toEqual([]);
    expect(report.directCount).toBe(0);
    expect(report.transitiveCount).toBe(0);
    expect(report.severity).toBe("none");
    expect(report.headline).toBe("Nothing in Infrawrench depends on this resource.");
  });

  it("handles a resource that is not in the graph at all", () => {
    const report = summarizeBlastRadius(input({ resourceId: "ghost" }));
    expect(report.resource).toBeNull();
    expect(report.dependants).toEqual([]);
    expect(report.severity).toBe("none");
  });

  it("terminates on a cycle and keeps the start out of its own radius", () => {
    const model = buildDependencyGraph(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );
    const report = summarizeBlastRadius(input({ resourceId: "a", model }));
    expect(report.dependants.map((d) => `${d.node.id}@${d.depth}`)).toEqual(["c@1", "b@2"]);
    expect(report.dependants.some((d) => d.node.id === "a")).toBe(false);
  });

  it("ignores a self reference — the model drops it before the walk", () => {
    const model = buildDependencyGraph([node("a")], [edge("a", "a")]);
    const report = summarizeBlastRadius(input({ resourceId: "a", model }));
    expect(report.dependants).toEqual([]);
    expect(report.resource).not.toBeNull();
  });
});

describe("summarizeBlastRadius — references and traffic", () => {
  const probe: BlastRadiusReference = {
    kind: "probe",
    id: "p1",
    name: "checkout",
    userFacing: true,
  };
  const dash: BlastRadiusReference = { kind: "dashboard", id: "d1", name: "Ops" };

  it("sorts user-facing references first", () => {
    const report = summarizeBlastRadius(input({ resourceId: "web", references: [dash, probe] }));
    expect(report.references.map((r) => r.id)).toEqual(["p1", "d1"]);
  });

  it("makes anything user-facing high severity on its own", () => {
    expect(summarizeBlastRadius(input({ resourceId: "web", references: [probe] })).severity).toBe(
      "high",
    );
    expect(summarizeBlastRadius(input({ resourceId: "web", references: [dash] })).severity).toBe(
      "low",
    );
  });

  it("totals traffic only when flows were actually checked", () => {
    const peer: BlastRadiusFlowPeer = {
      ref: "i-1",
      label: "api",
      direction: "egress",
      scope: "internet",
      bytes: 10,
      estimatedCost: 1,
      currency: "USD",
      days: 3,
      resourceId: null,
    };
    expect(
      summarizeBlastRadius(input({ flowPeers: [peer], flowsChecked: false })).flowTotals,
    ).toBeNull();
    expect(
      summarizeBlastRadius(input({ flowPeers: [peer], flowsChecked: true })).flowTotals,
    ).toEqual({ bytes: 10, estimatedCost: 1, currency: "USD" });
  });

  it("returns zeroed totals rather than null when collection is on and quiet", () => {
    const report = summarizeBlastRadius(input({ flowPeers: [], flowsChecked: true }));
    expect(report.flowTotals).toEqual({ bytes: 0, estimatedCost: 0, currency: "USD" });
  });

  it("orders flow peers heaviest first", () => {
    const peer = (ref: string, bytes: number): BlastRadiusFlowPeer => ({
      ref,
      label: ref,
      direction: "egress",
      scope: "internet",
      bytes,
      estimatedCost: 0,
      currency: "USD",
      days: 1,
      resourceId: null,
    });
    const report = summarizeBlastRadius(
      input({ flowPeers: [peer("a", 1), peer("b", 9)], flowsChecked: true }),
    );
    expect(report.flowPeers.map((p) => p.ref)).toEqual(["b", "a"]);
  });
});

describe("resolveFlowPeerIdentities", () => {
  // `resources.external_id` has no uniqueness constraint — its index is
  // (plugin_id, external_id), deliberately non-unique — so two accounts
  // legitimately hold a VPC whose provider id is "default". Keeping the first
  // row a lookup happened to return attributes measured traffic to an
  // arbitrary resource, in a report read seconds before somebody deletes
  // something.
  const inProd = { id: "aws:prod:default", externalId: "default" };
  const inStaging = { id: "aws:staging:default", externalId: "default" };

  it("never links a ref two resources claim — it reports it as ambiguous", () => {
    const result = resolveFlowPeerIdentities(["default"], [inStaging, inProd]);
    expect(result.idByRef.has("default")).toBe(false);
    expect(result.ambiguousRefs).toEqual(["default"]);
  });

  it("is not decided by candidate order", () => {
    const forward = resolveFlowPeerIdentities(["default"], [inProd, inStaging]);
    const reversed = resolveFlowPeerIdentities(["default"], [inStaging, inProd]);
    expect(forward).toEqual(reversed);
  });

  // The regression that matters most: a cross-account peer sharing its
  // provider id with a resource in the account the flow was collected from.
  // Nothing in a flow row says which account the peer is in, so preferring the
  // local one links the wrong resource — it just does it plausibly.
  it("refuses to break a local-vs-remote tie, because the row does not name the peer's account", () => {
    // `inProd` sits in the collecting account; `inStaging` does not.
    const result = resolveFlowPeerIdentities(["default"], [inProd, inStaging]);
    expect(result.idByRef.has("default")).toBe(false);
    expect(result.ambiguousRefs).toEqual(["default"]);
  });

  it("accepts a lone claimant wherever it lives — cross-account flows are real", () => {
    expect(resolveFlowPeerIdentities(["default"], [inStaging]).idByRef.get("default")).toBe(
      "aws:staging:default",
    );
    expect(resolveFlowPeerIdentities(["default"], [inProd]).idByRef.get("default")).toBe(
      "aws:prod:default",
    );
  });

  it("treats an unmatched ref as an ordinary external endpoint, not a gap", () => {
    const result = resolveFlowPeerIdentities(["internet", "s3.us-east-1"], [inProd]);
    expect(result.idByRef.size).toBe(0);
    expect(result.ambiguousRefs).toEqual([]);
  });

  it("refuses to pick between two rows that are both in one account", () => {
    const duplicate = { id: "aws:prod:default-2", externalId: "default" };
    const result = resolveFlowPeerIdentities(["default"], [inProd, duplicate]);
    expect(result.idByRef.has("default")).toBe(false);
    expect(result.ambiguousRefs).toEqual(["default"]);
  });

  it("resolves each ref independently and sorts the ambiguous ones", () => {
    const result = resolveFlowPeerIdentities(
      ["zeta", "alpha", "unique"],
      [
        { id: "a", externalId: "zeta" },
        { id: "b", externalId: "zeta" },
        { id: "c", externalId: "alpha" },
        { id: "d", externalId: "alpha" },
        { id: "e", externalId: "unique" },
      ],
    );
    expect(result.idByRef.get("unique")).toBe("e");
    expect(result.ambiguousRefs).toEqual(["alpha", "zeta"]);
  });
});

describe("blastRadiusSeverity", () => {
  const base = { directCount: 0, transitiveCount: 0, references: [], unchecked: [] };

  it("is unknown, not none, when nothing was found but something was unchecked", () => {
    expect(
      blastRadiusSeverity({
        ...base,
        unchecked: [{ kind: "network-flows", reason: "off" }],
      }),
    ).toBe("unknown");
    expect(blastRadiusSeverity(base)).toBe("none");
  });

  it("climbs with the direct dependant count", () => {
    expect(blastRadiusSeverity({ ...base, transitiveCount: 3 })).toBe("low");
    expect(blastRadiusSeverity({ ...base, directCount: 1 })).toBe("medium");
    expect(blastRadiusSeverity({ ...base, directCount: 5 })).toBe("high");
  });
});

describe("blastRadiusHeadline", () => {
  const base = { directCount: 0, transitiveCount: 0, references: [], unchecked: [] };

  it("singularizes one dependant", () => {
    expect(blastRadiusHeadline({ ...base, directCount: 1 })).toBe(
      "1 resource depend directly on this.",
    );
  });

  it("joins every clause it has", () => {
    expect(
      blastRadiusHeadline({
        ...base,
        directCount: 2,
        transitiveCount: 3,
        references: [{ kind: "dashboard", id: "d", name: "Ops" }],
      }),
    ).toBe(
      "2 resources depend directly on this, 3 more further down the chain and 1 other reference to it.",
    );
  });

  it("never claims a clean bill of health when the check was incomplete", () => {
    expect(
      blastRadiusHeadline({ ...base, unchecked: [{ kind: "network-flows", reason: "off" }] }),
    ).toBe("Nothing found that depends on this — but the check was incomplete.");
    expect(
      blastRadiusHeadline({
        ...base,
        directCount: 1,
        unchecked: [{ kind: "network-flows", reason: "off" }],
      }),
    ).toContain("The check was also incomplete.");
  });
});
