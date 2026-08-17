import { describe, expect, it } from "vitest";

import {
  MAINTENANCE_LIMITS,
  buildMaintenancePlan,
  describeMaintenanceOrder,
  plannedResourceCount,
} from "../maintenance-plan";
import type { DependencyGraphEdge, DependencyGraphNode } from "../dependency-graph";

function node(id: string): DependencyGraphNode {
  return {
    id,
    displayName: id,
    pluginId: "aws",
    pluginDisplayName: "AWS",
    pluginLogoSvg: "",
    resourceTypeId: "ec2-instance",
    resourceTypeLabel: "EC2 Instance",
    accountId: "acct",
    accountName: "prod",
  };
}

/** `consumer` depends on `provider`. */
function edge(consumer: string, provider: string): DependencyGraphEdge {
  return {
    consumerResourceId: consumer,
    consumerFieldKey: "db",
    providerResourceId: provider,
    providerOutputKey: "endpoint",
  };
}

// lb → web → db, plus an unrelated worker that also uses the db.
const NODES = ["lb", "web", "db", "worker", "outside"].map(node);
const EDGES = [edge("lb", "web"), edge("web", "db"), edge("worker", "db"), edge("outside", "web")];

describe("buildMaintenancePlan", () => {
  it("stops dependants first", () => {
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["db", "web", "lb"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan.steps.map((s) => s.resourceIds)).toEqual([["lb"], ["web"], ["db"]]);
  });

  it("starts dependencies first — the exact reverse", () => {
    const plan = buildMaintenancePlan({
      intent: "start",
      resourceIds: ["db", "web", "lb"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan.steps.map((s) => s.resourceIds)).toEqual([["db"], ["web"], ["lb"]]);
  });

  it("treats a restart like a stop", () => {
    // A resource being briefly absent hurts in the stop direction; that is the
    // order a restart has to respect.
    const stop = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["db", "web"],
      nodes: NODES,
      edges: EDGES,
    });
    const restart = buildMaintenancePlan({
      intent: "restart",
      resourceIds: ["db", "web"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(restart.steps.map((s) => s.resourceIds)).toEqual(stop.steps.map((s) => s.resourceIds));
  });

  it("puts independent resources in the same wave", () => {
    // Twelve services with three layers should be three steps, not twelve —
    // the difference between a window somebody runs and a list they abandon.
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["web", "worker", "db"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.resourceIds).toEqual(["web", "worker"]);
    expect(plan.steps[1]?.resourceIds).toEqual(["db"]);
  });

  it("ignores an edge that runs through something nobody selected", () => {
    // Restarting a web server and its database is one ordering question
    // whether or not a load balancer sits between them and is left alone.
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["lb", "db"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.resourceIds).toEqual(["db", "lb"]);
  });

  it("names what the step takes down outside the selection", () => {
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["web"],
      nodes: NODES,
      edges: EDGES,
    });
    const impacted = plan.steps[0]!.affectsOutside.map((i) => i.resourceId).sort();
    // `lb` and `outside` both hang off web; `web` itself is in the plan.
    expect(impacted).toEqual(["lb", "outside"]);
  });

  it("reports no outside impact for a start", () => {
    // Listing dependants there would read as a warning about a recovery.
    const plan = buildMaintenancePlan({
      intent: "start",
      resourceIds: ["web"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan.steps[0]?.affectsOutside).toEqual([]);
  });

  it("reports a cycle rather than picking an order", () => {
    // A cycle means the graph disagrees with itself; an arbitrary order
    // presented as a plan would be a guess wearing a plan's clothes.
    const cyclicNodes = ["a", "b"].map(node);
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["a", "b"],
      nodes: cyclicNodes,
      edges: [edge("a", "b"), edge("b", "a")],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.cyclic.map((c) => c.resourceId).sort()).toEqual(["a", "b"]);
  });

  it("still orders the part of the selection outside a cycle", () => {
    const nodes = ["a", "b", "free"].map(node);
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["a", "b", "free"],
      nodes,
      edges: [edge("a", "b"), edge("b", "a")],
    });
    expect(plan.steps[0]?.resourceIds).toEqual(["free"]);
    expect(plan.cyclic).toHaveLength(2);
  });

  it("names a selected resource the graph does not know", () => {
    // A plan for twelve things must never quietly become a plan for ten.
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["web", "deleted-yesterday"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan.unknown).toEqual(["deleted-yesterday"]);
    expect(plannedResourceCount(plan)).toBe(1);
  });

  it("de-duplicates a repeated selection", () => {
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["web", "web", "db"],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plannedResourceCount(plan)).toBe(2);
  });

  it("carries the truncation flag through", () => {
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: ["web"],
      nodes: NODES,
      edges: EDGES,
      truncated: true,
    });
    expect(plan.partialGraph).toBe(true);
  });

  it("caps a selection rather than planning a migration", () => {
    const many = Array.from({ length: MAINTENANCE_LIMITS.maxSelection + 50 }, (_, i) => `n${i}`);
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: many,
      nodes: many.map(node),
      edges: [],
    });
    expect(plannedResourceCount(plan)).toBe(MAINTENANCE_LIMITS.maxSelection);
  });

  it("is empty and honest for an empty selection", () => {
    const plan = buildMaintenancePlan({
      intent: "stop",
      resourceIds: [],
      nodes: NODES,
      edges: EDGES,
    });
    expect(plan).toMatchObject({ steps: [], cyclic: [], unknown: [] });
  });
});

describe("describeMaintenanceOrder", () => {
  it("says which way round it went", () => {
    expect(describeMaintenanceOrder("start")).toContain("Dependencies first");
    expect(describeMaintenanceOrder("stop")).toContain("Dependants first");
  });
});
