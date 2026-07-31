// `infrawrench graph` — the org's cross-provider dependency graph as an ASCII
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
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphModel,
  DependencyGraphNode,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { c, printJson, println } from "../output";
import { renderTree, type TreeChild } from "../format";

export async function cmdGraph(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "The CLI reads the org's dependency graph from Infrawrench Cloud. The desktop app's Graph tile covers the local workspace.",
    );
  }
  const org = await resolveOrg(ctx);

  // Always the org-wide graph, even when focusing. A blast radius is
  // transitive, and the endpoint's `?resourceId=` answer is one hop deep by
  // design — it exists so the resource-detail page doesn't pull the whole
  // topology on every mount, and a one-shot command has no such loop to guard.
  const data = await orgFetch<DependencyGraphData>(org.id, "/dependency-graph");

  const { buildDependencyGraph, directDependencies, collectDependents, collectDependencies } =
    await import("@infrawrench/client-core");
  const model = buildDependencyGraph(data.nodes, data.edges);
  const truncated = data.truncated === true;

  const focusId = range.resource ?? null;
  if (!focusId) {
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, truncated, nodes: model.nodes, edges: model.edges });
      return;
    }
    printWholeGraph(model, org.displayName, truncated);
    return;
  }

  const focus = model.nodesById.get(focusId);
  if (!focus) {
    throw new CliError(
      `${focusId} is not in ${org.displayName}'s dependency graph. Resources with no links in either direction are left out — the graph is about wiring, not inventory.`,
    );
  }
  const dependents = collectDependents(model, focusId);

  if (ctx.flags.output === "json") {
    const keep = new Set([...collectDependencies(model, focusId), ...dependents]);
    printJson({
      org: org.id,
      truncated,
      resource: focus,
      // Direct neighbours, exactly as the Dependencies tab lists them.
      ...directDependencies(model, focusId),
      // Transitive consumers, minus the resource itself — what breaks with it.
      blastRadius: [...dependents].filter((id) => id !== focusId),
      nodes: model.nodes.filter((n) => keep.has(n.id)),
      edges: model.edges.filter(
        (e) => keep.has(e.consumerResourceId) && keep.has(e.providerResourceId),
      ),
    });
    return;
  }

  printFocused(model, focus, dependents.size - 1, truncated);
}

/* ------------------------------------------------------------------ *
 * Text rendering
 * ------------------------------------------------------------------ */

function nodeLabel(node: DependencyGraphNode): string {
  const scope = node.accountName || node.pluginDisplayName;
  return `${c.bold(node.displayName)} ${c.dim(`${node.resourceTypeLabel} · ${scope}`)}`;
}

/** How a link reads: the plugin's own wording, or the field ← output pair. */
function edgeCaption(edge: DependencyGraphEdge): string {
  if (edge.label) return edge.label;
  if (edge.kind === "containment") return "belongs to";
  return `${edge.consumerFieldKey} ← ${edge.providerOutputKey}`;
}

/** What `id` depends on — arrows point at providers. */
function providersOf(model: DependencyGraphModel): (id: string) => TreeChild[] {
  return (id) =>
    (model.dependsOn.get(id) ?? []).map((e) => ({
      id: e.providerResourceId,
      caption: edgeCaption(e),
    }));
}

/** What depends on `id` — the blast-radius direction. */
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

function printTruncationNotice(): void {
  println(
    c.yellow(
      "! Inference hit its edge cap — this is a partial view of the org. Focus one resource with --resource <id> for its complete neighbourhood.",
    ),
  );
  println();
}

/**
 * The whole org as a forest. Roots are the resources nothing depends on — the
 * outermost consumers — so reading down a branch walks toward the things
 * everything else is built on.
 */
function printWholeGraph(model: DependencyGraphModel, orgName: string, truncated: boolean): void {
  if (model.nodes.length === 0) {
    println(
      c.dim(
        "No dependency links yet. Edges come from synced provider data and from output references you wire — connect an account and let it sync.",
      ),
    );
    return;
  }

  println(
    `${c.bold(orgName)} ${c.dim(`· ${model.nodes.length} linked resources, ${model.edges.length} links`)}`,
  );
  println();
  if (truncated) printTruncationNotice();

  const children = providersOf(model);
  const label = labelLookup(model);
  const printed = new Set<string>();

  const printRoot = (node: DependencyGraphNode): void => {
    println(nodeLabel(node));
    const seen = new Set<string>([node.id]);
    for (const line of renderTree(node.id, children, label, { seen })) println(line);
    for (const id of seen) printed.add(id);
    println();
  };

  for (const node of model.nodes) {
    if ((model.dependedOnBy.get(node.id) ?? []).length === 0) printRoot(node);
  }
  // Every node on a cycle has a dependent, so a purely cyclic component has no
  // root and would otherwise never print. Whatever is left over gets one.
  for (const node of model.nodes) {
    if (!printed.has(node.id)) printRoot(node);
  }

  println(
    c.dim(
      "Read downward: each child is something its parent depends on. ↺ marks a link back to a resource already on the branch.",
    ),
  );
}

/** One resource's neighbourhood — the terminal's Dependencies tab. */
function printFocused(
  model: DependencyGraphModel,
  focus: DependencyGraphNode,
  blastRadius: number,
  truncated: boolean,
): void {
  println(nodeLabel(focus));
  println(c.dim(focus.id));
  println();
  if (truncated) printTruncationNotice();

  const label = labelLookup(model);

  println(c.bold("Depends on"));
  const providers = providersOf(model);
  const providerLines = renderTree(focus.id, providers, label);
  if (providerLines.length === 0) {
    println(c.dim("  (nothing — this resource points at no others)"));
  } else {
    for (const line of providerLines) println(line);
  }
  println();

  println(
    `${c.bold("Depended on by")} ${c.dim(
      blastRadius === 0
        ? "· nothing depends on this"
        : `· blast radius ${blastRadius} resource${blastRadius === 1 ? "" : "s"}`,
    )}`,
  );
  const consumerLines = renderTree(focus.id, consumersOf(model), label);
  if (consumerLines.length === 0) {
    println(c.dim("  (nothing)"));
  } else {
    for (const line of consumerLines) println(line);
  }
  println();
  println(
    c.dim(
      "Blast radius counts every resource that transitively depends on this one — if it breaks or rotates its outputs, that is what is affected.",
    ),
  );
}
