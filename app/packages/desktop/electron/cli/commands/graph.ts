// `infrawrench graph`: the org's cross-provider dependency graph as an ASCII
// tree, backed by the same /dependency-graph endpoint the web and desktop
// Graph tabs draw.
//
// The traversal is not reimplemented here: `buildDependencyGraph`,
// `directDependencies`, `collectDependents` and `collectDependencies` come from
// `@infrawrench/client-core`, so the CLI's answer to "what breaks if this goes
// down" is the same answer the canvas highlights. The import is dynamic
// because the CLI's module graph is CommonJS and client-core ships ESM;
// electron-vite bundles it into the main chunk (see the `exclude` list in
// electron.vite.config.ts), so this resolves at build time rather than being a
// runtime hop.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphModel,
  DependencyGraphNode,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { resource } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe } from "../output";
import { renderTree, type TreeChild } from "../format";

const PATH = "/dependency-graph";

// The whole node and edge: the model is built from them and every field is
// read by something client-core exports. `kind` is the one enum, and only
// compared against "containment", but the model is typed over it.
const Node = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String,
  pluginDisplayName: Schema.String,
  pluginLogoSvg: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeLabel: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
});

const Edge = Schema.Struct({
  consumerResourceId: Schema.String,
  consumerFieldKey: Schema.String,
  providerResourceId: Schema.String,
  providerOutputKey: Schema.String,
  kind: Schema.optionalKey(
    Schema.Literals(["output-ref", "declared", "containment", "field-match"]),
  ),
  label: Schema.optionalKey(Schema.String),
});

const Graph = wire<DependencyGraphData>()(
  Schema.Struct({
    nodes: Schema.mutable(Schema.Array(Node)),
    edges: Schema.mutable(Schema.Array(Edge)),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
);

/** The graph as the server sent it, for `--json`. */
const RawGraph = Schema.Struct({
  nodes: Schema.Array(Schema.Unknown),
  edges: Schema.Array(Schema.Unknown),
});

/**
 * `--json` prints nodes and edges as the server sent them. The model keeps the
 * decoded objects it was built from, so each maps back to its raw element.
 */
function rawLookup<T>(
  decoded: ReadonlyArray<T>,
  raw: ReadonlyArray<unknown>,
): (value: T) => unknown {
  const byValue = new Map<T, unknown>(decoded.map((value, i) => [value, raw[i]]));
  return (value) => byValue.get(value);
}

export const graph = Command.make(
  "graph",
  {
    resourceId: Argument.String("resource-id").pipe(
      Argument.withDescription("The resource to focus (same as --resource)"),
      Argument.optional,
    ),
    resource: resource.pipe(
      Flag.withDescription("Focus one resource: what it needs and its blast radius"),
    ),
  },
  Effect.fn("graph")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "The CLI reads the org's dependency graph from Infrawrench Cloud. The desktop app's Graph tile covers the local workspace.",
      });
    }
    const org = yield* currentOrg;

    // Always the org-wide graph, even when focusing. A blast radius is
    // transitive, and the endpoint's `?resourceId=` answer is one hop deep by
    // design: it exists so the resource-detail page doesn't pull the whole
    // topology on every mount, and a one-shot command has no such loop to guard.
    const body = yield* api.json(org.id, PATH);
    const data = yield* decodeBody(Graph, PATH)(body);
    const raw = yield* decodeBody(RawGraph, PATH)(body);
    const rawNode = rawLookup<DependencyGraphNode>(data.nodes, raw.nodes);
    const rawEdge = rawLookup<DependencyGraphEdge>(data.edges, raw.edges);

    const { buildDependencyGraph, directDependencies, collectDependents, collectDependencies } =
      yield* Effect.promise(() => import("@infrawrench/client-core"));
    const model = buildDependencyGraph(data.nodes, data.edges);
    const truncated = data.truncated === true;

    // `graph <resource-id>` is the same as --resource; the positional wins.
    const focusId = Option.getOrNull(Option.orElse(input.resourceId, () => input.resource));
    if (!focusId) {
      if (session.output === "json") {
        return yield* Print.json({
          org: org.id,
          truncated,
          nodes: model.nodes.map(rawNode),
          edges: model.edges.map(rawEdge),
        });
      }
      return yield* printWholeGraph(model, safe(org.displayName), truncated);
    }

    const focus = model.nodesById.get(focusId);
    if (!focus) {
      return yield* new CliFailure({
        message: `${focusId} is not in ${org.displayName}'s dependency graph. Resources with no links in either direction are left out. The graph is about wiring, not inventory.`,
      });
    }
    const dependents = collectDependents(model, focusId);

    if (session.output === "json") {
      const keep = new Set([...collectDependencies(model, focusId), ...dependents]);
      const direct = directDependencies(model, focusId);
      const neighbours = (list: typeof direct.dependsOn) =>
        list.map((n) => ({ ...n, node: rawNode(n.node) }));
      return yield* Print.json({
        org: org.id,
        truncated,
        resource: rawNode(focus),
        // Direct neighbours, exactly as the Dependencies tab lists them.
        dependsOn: neighbours(direct.dependsOn),
        dependedOnBy: neighbours(direct.dependedOnBy),
        // Transitive consumers, minus the resource itself: what breaks with it.
        blastRadius: [...dependents].filter((id) => id !== focusId),
        nodes: model.nodes.filter((n) => keep.has(n.id)).map(rawNode),
        edges: model.edges
          .filter((e) => keep.has(e.consumerResourceId) && keep.has(e.providerResourceId))
          .map(rawEdge),
      });
    }

    return yield* printFocused(model, focus, dependents.size - 1, truncated);
  }),
).pipe(Command.withDescription("The resource dependency tree, or one resource's neighbourhood"));

/* ------------------------------------------------------------------ *
 * Text rendering
 * ------------------------------------------------------------------ */

function nodeLabel(node: DependencyGraphNode): string {
  const scope = node.accountName || node.pluginDisplayName;
  return `${c.bold(safe(node.displayName))} ${c.dim(safe(`${node.resourceTypeLabel} · ${scope}`))}`;
}

/** How a link reads: the plugin's own wording, or the field ← output pair. */
function edgeCaption(edge: DependencyGraphEdge): string {
  if (edge.label) return safe(edge.label);
  if (edge.kind === "containment") return "belongs to";
  return safe(`${edge.consumerFieldKey} ← ${edge.providerOutputKey}`);
}

/** What `id` depends on: arrows point at providers. */
function providersOf(model: DependencyGraphModel): (id: string) => TreeChild[] {
  return (id) =>
    (model.dependsOn.get(id) ?? []).map((e) => ({
      id: e.providerResourceId,
      caption: edgeCaption(e),
    }));
}

/** What depends on `id`: the blast-radius direction. */
function consumersOf(model: DependencyGraphModel): (id: string) => TreeChild[] {
  return (id) =>
    (model.dependedOnBy.get(id) ?? []).map((e) => ({
      id: e.consumerResourceId,
      caption: edgeCaption(e),
    }));
}

function labelLookup(model: DependencyGraphModel): (id: string) => string | null {
  return (id) => {
    const node = model.nodesById.get(id);
    return node ? nodeLabel(node) : null;
  };
}

const printTruncationNotice = Effect.gen(function* () {
  yield* Print.line(
    c.yellow(
      "! Inference hit its edge cap. This is a partial view of the org. Focus one resource with --resource <id> for its complete neighbourhood.",
    ),
  );
  yield* Print.line();
});

/**
 * The whole org as a forest. Roots are the resources nothing depends on (the
 * outermost consumers) so reading down a branch walks toward the things
 * everything else is built on.
 */
const printWholeGraph = Effect.fnUntraced(function* (
  model: DependencyGraphModel,
  orgName: string,
  truncated: boolean,
) {
  if (model.nodes.length === 0) {
    return yield* Print.line(
      c.dim(
        "No dependency links yet. Edges come from synced provider data and from output references you wire. Connect an account and let it sync.",
      ),
    );
  }

  yield* Print.line(
    `${c.bold(orgName)} ${c.dim(`· ${model.nodes.length} linked resources, ${model.edges.length} links`)}`,
  );
  yield* Print.line();
  if (truncated) yield* printTruncationNotice;

  const children = providersOf(model);
  const label = labelLookup(model);
  const printed = new Set<string>();

  const printRoot = Effect.fnUntraced(function* (node: DependencyGraphNode) {
    yield* Print.line(nodeLabel(node));
    const seen = new Set<string>([node.id]);
    for (const line of renderTree(node.id, children, label, { seen })) yield* Print.line(line);
    for (const id of seen) printed.add(id);
    yield* Print.line();
  });

  for (const node of model.nodes) {
    if ((model.dependedOnBy.get(node.id) ?? []).length === 0) yield* printRoot(node);
  }
  // Every node on a cycle has a dependent, so a purely cyclic component has no
  // root and would otherwise never print. Whatever is left over gets one.
  for (const node of model.nodes) {
    if (!printed.has(node.id)) yield* printRoot(node);
  }

  yield* Print.line(
    c.dim(
      "Read downward: each child is something its parent depends on. ↺ marks a link back to a resource already on the branch.",
    ),
  );
});

/** One resource's neighbourhood: the terminal's Dependencies tab. */
const printFocused = Effect.fnUntraced(function* (
  model: DependencyGraphModel,
  focus: DependencyGraphNode,
  blastRadius: number,
  truncated: boolean,
) {
  yield* Print.line(nodeLabel(focus));
  yield* Print.line(c.dim(safe(focus.id)));
  yield* Print.line();
  if (truncated) yield* printTruncationNotice;

  const label = labelLookup(model);

  yield* Print.line(c.bold("Depends on"));
  const providerLines = renderTree(focus.id, providersOf(model), label);
  if (providerLines.length === 0) {
    yield* Print.line(c.dim("  (nothing: this resource points at no others)"));
  } else {
    for (const line of providerLines) yield* Print.line(line);
  }
  yield* Print.line();

  yield* Print.line(
    `${c.bold("Depended on by")} ${c.dim(
      blastRadius === 0
        ? "· nothing depends on this"
        : `· blast radius ${blastRadius} resource${blastRadius === 1 ? "" : "s"}`,
    )}`,
  );
  const consumerLines = renderTree(focus.id, consumersOf(model), label);
  if (consumerLines.length === 0) {
    yield* Print.line(c.dim("  (nothing)"));
  } else {
    for (const line of consumerLines) yield* Print.line(line);
  }
  yield* Print.line();
  yield* Print.line(c.dim("Blast radius is every resource that transitively depends on this one."));
});
