import { describe, it, expect } from "vitest";
import { collapseIdenticalNodes } from "../dependency-collapse";
import type { DependencyGraphEdge, DependencyGraphNode } from "../dependency-graph";

function node(id: string, overrides: Partial<DependencyGraphNode> = {}): DependencyGraphNode {
  return {
    id,
    displayName: id,
    pluginId: "gcp",
    pluginDisplayName: "GCP",
    pluginLogoSvg: "",
    resourceTypeId: "subnet",
    resourceTypeLabel: "Subnet",
    accountId: "acct",
    accountName: "Infrawrench GCP",
    ...overrides,
  };
}

function edge(consumer: string, provider: string, fieldKey = "network"): DependencyGraphEdge {
  return {
    consumerResourceId: consumer,
    consumerFieldKey: fieldKey,
    providerResourceId: provider,
    providerOutputKey: "name",
    kind: "declared",
  };
}

/** GCP auto-mode: one `default` subnet per region, all on the same network. */
function autoModeVpc(subnetCount: number) {
  const nodes = [node("vpc", { resourceTypeId: "vpc-network", displayName: "default" })];
  const edges: DependencyGraphEdge[] = [];
  for (let i = 0; i < subnetCount; i++) {
    nodes.push(node(`subnet-${i}`, { displayName: "default" }));
    edges.push(edge(`subnet-${i}`, "vpc"));
  }
  return { nodes, edges };
}

describe("collapseIdenticalNodes", () => {
  it("merges identically named and identically wired siblings", () => {
    const { nodes, edges, groups, collapsedCount } = collapseIdenticalNodes(autoModeVpc(12));

    expect(nodes.map((n) => n.id)).toEqual(["vpc", "subnet-0"]);
    expect(collapsedCount).toBe(11);
    expect(groups.get("subnet-0")).toHaveLength(12);
    // Twelve edges to the same VPC become one.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ consumerResourceId: "subnet-0", providerResourceId: "vpc" });
  });

  it("keeps a sibling that is wired differently", () => {
    const { nodes, edges } = autoModeVpc(5);
    // One subnet has a VM in it — it is no longer interchangeable.
    nodes.push(node("vm", { resourceTypeId: "gce-instance", displayName: "web-1" }));
    edges.push(edge("vm", "subnet-3", "subnetwork"));

    const collapsed = collapseIdenticalNodes({ nodes, edges });
    expect(collapsed.nodes.map((n) => n.id).sort()).toEqual(["subnet-0", "subnet-3", "vm", "vpc"]);
    expect(collapsed.groups.get("subnet-0")).toHaveLength(4);
    expect(collapsed.groups.has("subnet-3")).toBe(false);
  });

  it("keeps same-named resources of different types apart", () => {
    const nodes = [
      node("a", { displayName: "default" }),
      node("b", { displayName: "default", resourceTypeId: "firewall-rule" }),
      node("vpc", { resourceTypeId: "vpc-network", displayName: "default" }),
    ];
    const edges = [edge("a", "vpc"), edge("b", "vpc")];
    const collapsed = collapseIdenticalNodes({ nodes, edges });
    expect(collapsed.collapsedCount).toBe(0);
  });

  it("keeps same-named resources in different accounts apart", () => {
    const nodes = [
      node("a", { displayName: "default" }),
      node("b", { displayName: "default", accountId: "other", accountName: "Other" }),
      node("vpc", { resourceTypeId: "vpc-network", displayName: "default" }),
    ];
    const collapsed = collapseIdenticalNodes({
      nodes,
      edges: [edge("a", "vpc"), edge("b", "vpc")],
    });
    expect(collapsed.collapsedCount).toBe(0);
  });

  it("leaves an expanded group alone", () => {
    const collapsed = collapseIdenticalNodes(autoModeVpc(4), { expandedIds: ["subnet-0"] });
    expect(collapsed.collapsedCount).toBe(0);
    expect(collapsed.groups.size).toBe(0);
  });

  it("respects a larger minimum group size", () => {
    const collapsed = collapseIdenticalNodes(autoModeVpc(2), { minGroupSize: 3 });
    expect(collapsed.collapsedCount).toBe(0);
  });

  it("is a no-op on a graph with nothing to merge", () => {
    const nodes = [node("vpc", { resourceTypeId: "vpc-network" }), node("subnet-0")];
    const edges = [edge("subnet-0", "vpc")];
    const collapsed = collapseIdenticalNodes({ nodes, edges });
    expect(collapsed.nodes).toBe(nodes);
    expect(collapsed.edges).toBe(edges);
    expect(collapsed.collapsedCount).toBe(0);
  });

  it("drops an edge that becomes a self-link after merging", () => {
    // Two identical peers that reference each other collapse into one node;
    // the surviving edge would point at itself and is dropped.
    const nodes = [node("a", { displayName: "peer" }), node("b", { displayName: "peer" })];
    const collapsed = collapseIdenticalNodes({ nodes, edges: [] });
    expect(collapsed.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(collapsed.edges).toEqual([]);
  });
});
