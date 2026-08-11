import { describe, it, expect } from "vitest";
import {
  buildDependencyGraph,
  collectDependencies,
  collectDependents,
  collectDependentsWithDepth,
  directDependencies,
  layoutDependencyGraph,
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
  fieldKey = "field",
  outputKey = "output",
): DependencyGraphEdge {
  return {
    consumerResourceId: consumer,
    consumerFieldKey: fieldKey,
    providerResourceId: provider,
    providerOutputKey: outputKey,
  };
}

// db ← api ← web, db ← worker (classic diamond-ish fan)
const nodes = [node("db"), node("api"), node("web"), node("worker")];
const edges = [
  edge("api", "db", "connectionString"),
  edge("web", "api", "apiUrl"),
  edge("worker", "db", "connectionString"),
];

describe("buildDependencyGraph", () => {
  it("indexes edges by consumer and provider", () => {
    const model = buildDependencyGraph(nodes, edges);
    expect(model.edges).toHaveLength(3);
    expect(model.dependsOn.get("api")).toHaveLength(1);
    expect(model.dependedOnBy.get("db")).toHaveLength(2);
    expect(model.dependsOn.get("db")).toBeUndefined();
  });

  it("dedupes edges for the same consumer field", () => {
    // associations row + secret_field_states row describe the same reference
    const model = buildDependencyGraph(nodes, [
      edge("api", "db", "connectionString"),
      edge("api", "db", "connectionString"),
    ]);
    expect(model.edges).toHaveLength(1);
  });

  it("drops edges with unknown endpoints and self references", () => {
    const model = buildDependencyGraph(nodes, [
      edge("api", "ghost"),
      edge("ghost", "db"),
      edge("db", "db"),
    ]);
    expect(model.edges).toHaveLength(0);
  });
});

describe("directDependencies", () => {
  it("lists both directions with field and output keys", () => {
    const model = buildDependencyGraph(nodes, edges);
    const deps = directDependencies(model, "api");
    expect(deps.dependsOn.map((d) => d.node.id)).toEqual(["db"]);
    expect(deps.dependsOn[0]?.fieldKey).toBe("connectionString");
    expect(deps.dependedOnBy.map((d) => d.node.id)).toEqual(["web"]);
    expect(deps.dependedOnBy[0]?.fieldKey).toBe("apiUrl");
  });

  it("is empty for an unreferenced resource", () => {
    const model = buildDependencyGraph(nodes, edges);
    const deps = directDependencies(model, "web");
    expect(deps.dependsOn.map((d) => d.node.id)).toEqual(["api"]);
    expect(deps.dependedOnBy).toHaveLength(0);
  });
});

describe("collectDependents / collectDependencies", () => {
  it("computes the transitive blast radius", () => {
    const model = buildDependencyGraph(nodes, edges);
    expect(collectDependents(model, "db")).toEqual(new Set(["db", "api", "web", "worker"]));
    expect(collectDependents(model, "api")).toEqual(new Set(["api", "web"]));
    expect(collectDependents(model, "web")).toEqual(new Set(["web"]));
  });

  it("computes transitive dependencies", () => {
    const model = buildDependencyGraph(nodes, edges);
    expect(collectDependencies(model, "web")).toEqual(new Set(["web", "api", "db"]));
    expect(collectDependencies(model, "db")).toEqual(new Set(["db"]));
  });

  it("terminates on cycles", () => {
    const model = buildDependencyGraph([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]);
    expect(collectDependents(model, "a")).toEqual(new Set(["a", "b"]));
  });
});

describe("collectDependentsWithDepth", () => {
  it("stamps the start at 0 and each dependant at its hop count", () => {
    const model = buildDependencyGraph(nodes, edges);
    expect(collectDependentsWithDepth(model, "db")).toEqual(
      new Map([
        ["db", 0],
        ["api", 1],
        ["worker", 1],
        ["web", 2],
      ]),
    );
  });

  it("takes the shortest path when a dependant is reachable two ways", () => {
    // web depends on db directly *and* through api — the direct hop wins, so
    // it is reported as a direct dependant rather than a transitive one.
    const model = buildDependencyGraph(nodes, [...edges, edge("web", "db", "dbUrl")]);
    expect(collectDependentsWithDepth(model, "db").get("web")).toBe(1);
  });

  it("keeps a cycle's start at depth 0", () => {
    const model = buildDependencyGraph([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]);
    expect(collectDependentsWithDepth(model, "a")).toEqual(
      new Map([
        ["a", 0],
        ["b", 1],
      ]),
    );
  });
});

describe("layoutDependencyGraph", () => {
  it("puts providers to the left of their consumers", () => {
    const model = buildDependencyGraph(nodes, edges);
    const layout = layoutDependencyGraph(model);
    expect(layout.layers[0]).toContain("db");
    expect(layout.layers[1]).toContain("api");
    expect(layout.layers[1]).toContain("worker");
    expect(layout.layers[2]).toContain("web");
    const db = layout.positions.get("db");
    const api = layout.positions.get("api");
    const web = layout.positions.get("web");
    expect(db && api && web).toBeTruthy();
    expect(db!.x).toBeLessThan(api!.x);
    expect(api!.x).toBeLessThan(web!.x);
  });

  it("positions every node inside the reported bounds", () => {
    const model = buildDependencyGraph(nodes, edges);
    const layout = layoutDependencyGraph(model);
    for (const nodeId of model.nodesById.keys()) {
      const pos = layout.positions.get(nodeId);
      expect(pos).toBeDefined();
      expect(pos!.x).toBeGreaterThanOrEqual(0);
      expect(pos!.y).toBeGreaterThanOrEqual(0);
      expect(pos!.x + layout.nodeWidth).toBeLessThanOrEqual(layout.width);
      expect(pos!.y + layout.nodeHeight).toBeLessThanOrEqual(layout.height);
    }
  });

  it("survives cycles without hanging", () => {
    const model = buildDependencyGraph(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );
    const layout = layoutDependencyGraph(model);
    expect(layout.positions.size).toBe(3);
  });
});

describe("isolated nodes", () => {
  it("drops nodes with no edges from `nodes` but keeps them in `nodesById`", () => {
    const model = buildDependencyGraph(
      [node("db"), node("api"), node("orphan")],
      [edge("api", "db")],
    );
    expect(model.nodes.map((n) => n.id).sort()).toEqual(["api", "db"]);
    // Still resolvable by id — the index is for lookup, not iteration.
    expect(model.nodesById.get("orphan")?.id).toBe("orphan");
  });

  it("keeps a node whose only edge is inbound", () => {
    const model = buildDependencyGraph([node("db"), node("api")], [edge("api", "db")]);
    expect(model.nodes.map((n) => n.id).sort()).toEqual(["api", "db"]);
  });

  it("drops a node whose only edge was invalid", () => {
    // Edge points at an id that isn't a node, so it never validates.
    const model = buildDependencyGraph([node("api")], [edge("api", "missing")]);
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
  });
});

describe("cyclic layouts", () => {
  it("puts a fully cyclic graph in layers starting at 0", () => {
    const model = buildDependencyGraph(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );
    const layout = layoutDependencyGraph(model);
    // Every node placed, and no empty leading layer padding the canvas.
    expect(layout.positions.size).toBe(3);
    expect(layout.layers[0]?.length).toBeGreaterThan(0);
    expect(layout.layers.every((l) => l.length > 0)).toBe(true);
  });

  it("still roots an acyclic graph at layer 0", () => {
    const model = buildDependencyGraph(
      [node("db"), node("api"), node("web")],
      [edge("api", "db"), edge("web", "api")],
    );
    const layout = layoutDependencyGraph(model);
    expect(layout.layers[0]).toEqual(["db"]);
  });
});
