/**
 * "What breaks if I delete this?" — the impact report for one resource.
 *
 * The report is assembled from data the product already has, and it is
 * deliberately three different kinds of evidence kept apart rather than summed
 * into one number:
 *
 *  - **Dependants** — the inbound half of the dependency graph, walked
 *    transitively. Hand-wired output references, plugin-declared `dependsOn`
 *    edges and edges inferred from synced cloud data all arrive as ordinary
 *    graph edges, so this file never learns where an edge came from beyond the
 *    `kind` it carries.
 *  - **Traffic** — who actually talks to the resource, from network flow
 *    attribution. Only meaningful when the org turned collection on, which is
 *    why its absence is reported rather than rendered as zero.
 *  - **Soft references** — the things that *point at* the resource without
 *    depending on it: dashboards, custom graphs, probes, metric alerts,
 *    leases, schedules, workflows, status pages, log queries, and its recorded
 *    owner. Deleting the resource does not break these the way it breaks a
 *    dependant; it silently empties them, which is the failure mode people
 *    discover a fortnight later.
 *
 * The fourth field is the one that makes the other three honest.
 * {@link BlastRadiusReport.unchecked} lists what the report could *not* look
 * at — flow collection off, ClickHouse unreachable, workflow bodies matched
 * only by literal id. A report with an empty `dependants` list and an empty
 * `unchecked` list is a clean bill of health; a report with an empty
 * `dependants` list and three `unchecked` entries is a shrug, and the two must
 * never render the same way.
 *
 * Everything here is pure and host-agnostic: the server assembles the report,
 * web/desktop/mobile render it, and `summarizeBlastRadius` is the single place
 * that turns the parts into counts and a severity. Re-exported from
 * `@infrawrench/ui` per the shared-contract convention.
 */

import {
  collectDependentsWithDepth,
  type DependencyEdgeKind,
  type DependencyGraphModel,
  type DependencyGraphNode,
} from "./dependency-graph";
import type { CloudFetch } from "./fetch";

/**
 * One resource that would be affected, with how far away it is.
 *
 * `depth` is hops through the graph: 1 is a direct dependant (it holds a
 * reference to the resource being deleted), 2+ reached it through something
 * else. The start resource is never in this list.
 */
export interface BlastRadiusDependant {
  node: DependencyGraphNode;
  /** Shortest hop count from the resource being deleted; always >= 1. */
  depth: number;
  /**
   * How a *direct* dependant reaches it — the consumer field, the provider
   * output, and the edge's provenance. Absent for transitive dependants,
   * whose path is several edges and has no single caption.
   */
  via?: {
    fieldKey: string;
    outputKey: string;
    kind?: DependencyEdgeKind;
    label?: string;
  };
}

/**
 * The kinds of object that can point at a resource without depending on it.
 *
 * `probe` and `status-page` are called out from the rest because they are the
 * only two that face someone outside the org: deleting a resource a public
 * status page reports on turns a green page red for customers, which is a
 * different class of consequence from a dashboard card going blank.
 */
export type BlastRadiusReferenceKind =
  | "dashboard"
  | "custom-graph"
  | "probe"
  | "status-page"
  | "metric-alert"
  | "lease"
  | "schedule"
  | "workflow"
  | "log-query"
  | "owner";

/** One object that names the resource. */
export interface BlastRadiusReference {
  kind: BlastRadiusReferenceKind;
  /** The referring object's own id — a dashboard id, a probe id, a user id. */
  id: string;
  /** How the referring object is named to a person. */
  name: string;
  /** One extra clause of context ("every 60s", "auto-deletes on 3 Sep"). */
  detail?: string;
  /**
   * Set when the reference is visible to somebody outside the org — a public
   * status page component, or the probe behind one.
   */
  userFacing?: boolean;
}

/** One flow peer: something that measurably talks to the resource. */
export interface BlastRadiusFlowPeer {
  /** The peer's stable flow ref — a provider resource id, or a class token. */
  ref: string;
  label: string;
  /** Traffic direction relative to the resource being deleted. */
  direction: "egress" | "ingress";
  /** Boundary the traffic crossed (`internet`, `cross-zone`, …). */
  scope: string;
  bytes: number;
  estimatedCost: number;
  currency: string;
  /** Days in the window this peer appeared on — a spike versus a standing flow. */
  days: number;
  /**
   * The peer's Infrawrench resource id when the flow ref resolved to a synced
   * resource. Null when it did not — flow refs are provider-side ids, so a
   * peer outside the org (or in an account we do not sync) stays a label.
   */
  resourceId: string | null;
}

/**
 * Something the report could not check, and why.
 *
 * `reason` is a full sentence written for the person about to press Delete,
 * not a code — it is rendered verbatim, and "Network flow collection is off
 * for this organization, so nothing is known about what talks to this
 * resource" is the entire value of the field over a boolean.
 */
export interface BlastRadiusGap {
  /** Stable machine key, for surfaces that want to group or suppress. */
  kind:
    "network-flows" | "dependency-graph" | "references" | "workflow-source" | "custom-graph-source";
  reason: string;
}

/** How loud the summary line should be. */
export type BlastRadiusSeverity = "none" | "low" | "medium" | "high" | "unknown";

/** The whole report — the wire shape of `GET /blast-radius`. */
export interface BlastRadiusReport {
  resourceId: string;
  /** The resource itself, when it participates in the graph. */
  resource: DependencyGraphNode | null;
  /** Affected resources, direct first, then by depth. Excludes the resource. */
  dependants: BlastRadiusDependant[];
  /** Direct dependants — `dependants` filtered to depth 1. */
  directCount: number;
  /** Dependants at depth 2 or more. */
  transitiveCount: number;
  /** Objects naming the resource, grouped by nothing — surfaces group. */
  references: BlastRadiusReference[];
  /** Measured peers, heaviest first. Empty when collection is off. */
  flowPeers: BlastRadiusFlowPeer[];
  /** Totals over `flowPeers`, or null when traffic could not be measured. */
  flowTotals: { bytes: number; estimatedCost: number; currency: string } | null;
  /** What could not be checked. Empty means the report is complete. */
  unchecked: BlastRadiusGap[];
  severity: BlastRadiusSeverity;
  /** One sentence, ready to render. */
  headline: string;
}

/** Everything an assembled report needs that isn't derivable from the graph. */
export interface BlastRadiusInput {
  resourceId: string;
  model: DependencyGraphModel;
  references: BlastRadiusReference[];
  flowPeers: BlastRadiusFlowPeer[];
  /**
   * False when flow attribution was not consulted at all (collection off, no
   * warehouse). Distinct from consulting it and finding nothing.
   */
  flowsChecked: boolean;
  unchecked: BlastRadiusGap[];
}

/** A dependant count of this or more reads as "high" on its own. */
const HIGH_DIRECT_DEPENDANTS = 5;

/**
 * Assemble the report.
 *
 * Pure, and the only place counts and severity are computed — the server
 * returns this shape, so no surface recomputes it and no two surfaces can put
 * a different number next to the same list.
 */
export function summarizeBlastRadius(input: BlastRadiusInput): BlastRadiusReport {
  const { model, resourceId } = input;
  const depths = collectDependentsWithDepth(model, resourceId);

  // Direct edges keyed by dependant, so depth-1 rows can carry the field/output
  // caption. A dependant reaching the resource through several fields keeps the
  // first edge — the panel links the resource, not the field.
  const directEdge = new Map<string, BlastRadiusDependant["via"]>();
  for (const edge of model.dependedOnBy.get(resourceId) ?? []) {
    if (directEdge.has(edge.consumerResourceId)) continue;
    directEdge.set(edge.consumerResourceId, {
      fieldKey: edge.consumerFieldKey,
      outputKey: edge.providerOutputKey,
      ...(edge.kind ? { kind: edge.kind } : {}),
      ...(edge.label ? { label: edge.label } : {}),
    });
  }

  const dependants: BlastRadiusDependant[] = [];
  for (const [id, depth] of depths) {
    // depth 0 is the resource itself: it is what is being deleted, not
    // something the deletion breaks.
    if (depth === 0) continue;
    const node = model.nodesById.get(id);
    if (!node) continue;
    const via = depth === 1 ? directEdge.get(id) : undefined;
    dependants.push({ node, depth, ...(via ? { via } : {}) });
  }
  dependants.sort(
    (a, b) => a.depth - b.depth || a.node.displayName.localeCompare(b.node.displayName),
  );

  const directCount = dependants.filter((d) => d.depth === 1).length;
  const transitiveCount = dependants.length - directCount;

  const flowPeers = [...input.flowPeers].sort((a, b) => b.bytes - a.bytes);
  const flowTotals = input.flowsChecked
    ? {
        bytes: flowPeers.reduce((sum, p) => sum + p.bytes, 0),
        estimatedCost: flowPeers.reduce((sum, p) => sum + p.estimatedCost, 0),
        currency: flowPeers[0]?.currency ?? "USD",
      }
    : null;

  const references = [...input.references].sort(
    (a, b) =>
      Number(!!b.userFacing) - Number(!!a.userFacing) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );

  const severity = blastRadiusSeverity({
    directCount,
    transitiveCount,
    references,
    unchecked: input.unchecked,
  });

  return {
    resourceId,
    resource: model.nodesById.get(resourceId) ?? null,
    dependants,
    directCount,
    transitiveCount,
    references,
    flowPeers,
    flowTotals,
    unchecked: input.unchecked,
    severity,
    headline: blastRadiusHeadline({
      directCount,
      transitiveCount,
      references,
      unchecked: input.unchecked,
    }),
  };
}

interface SeverityInput {
  directCount: number;
  transitiveCount: number;
  references: BlastRadiusReference[];
  unchecked: BlastRadiusGap[];
}

/**
 * Severity, in the order a person would reason about it.
 *
 * Anything user-facing outranks a count: one public status page component is
 * worse news than four internal dashboards. And **nothing found plus something
 * unchecked is `unknown`, never `none`** — the whole point of tracking gaps is
 * that a report which could not look is not a report that found nothing.
 */
export function blastRadiusSeverity(input: SeverityInput): BlastRadiusSeverity {
  const userFacing = input.references.some((r) => r.userFacing);
  if (userFacing || input.directCount >= HIGH_DIRECT_DEPENDANTS) return "high";
  if (input.directCount > 0) return "medium";
  if (input.transitiveCount > 0 || input.references.length > 0) return "low";
  return input.unchecked.length > 0 ? "unknown" : "none";
}

/** The one-sentence version, phrased for the moment before a delete. */
export function blastRadiusHeadline(input: SeverityInput): string {
  const parts: string[] = [];
  if (input.directCount > 0) {
    parts.push(`${plural(input.directCount, "resource")} depend directly on this`);
  }
  if (input.transitiveCount > 0) {
    parts.push(`${input.transitiveCount} more further down the chain`);
  }
  if (input.references.length > 0) {
    parts.push(`${plural(input.references.length, "other reference")} to it`);
  }
  if (parts.length === 0) {
    return input.unchecked.length > 0
      ? "Nothing found that depends on this — but the check was incomplete."
      : "Nothing in Infrawrench depends on this resource.";
  }
  const sentence = `${capitalize(joinList(parts))}.`;
  return input.unchecked.length > 0 ? `${sentence} The check was also incomplete.` : sentence;
}

/** "1 resource" / "3 resources" — the plural is the caller's noun plus s. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Human label for a reference kind, singular. */
export function blastRadiusReferenceLabel(kind: BlastRadiusReferenceKind): string {
  switch (kind) {
    case "dashboard":
      return "Dashboard";
    case "custom-graph":
      return "Custom graph";
    case "probe":
      return "Probe";
    case "status-page":
      return "Status page";
    case "metric-alert":
      return "Metric alert";
    case "lease":
      return "Lease";
    case "schedule":
      return "Schedule";
    case "workflow":
      return "Workflow";
    case "log-query":
      return "Log query";
    case "owner":
      return "Owner";
  }
}

/**
 * Read `GET /api/org/{orgId}/blast-radius?resourceId=…`.
 *
 * `resourceId` is a query parameter rather than a path segment because
 * composite resource ids contain slashes and colons — the same reason the
 * ownership and lease routes take it that way.
 */
export async function fetchBlastRadius(
  api: CloudFetch,
  orgId: string,
  resourceId: string,
): Promise<BlastRadiusReport> {
  const path = `/blast-radius?resourceId=${encodeURIComponent(resourceId)}`;
  const data = await api.org<BlastRadiusReport>(orgId, path);
  if (!data) throw new Error("Blast radius unavailable");
  return data;
}
