/**
 * "What breaks if I delete this?", answered from data the product already has.
 *
 * Three evidence gatherers run side by side and are folded into one report by
 * the shared pure `summarizeBlastRadius`:
 *
 *  - the **dependency graph**, walked inbound (`loadDependencyGraph` — the
 *    same assembly the Dependencies tab draws, so the warning on the delete
 *    dialog can never disagree with the tab behind it),
 *  - **network flow attribution**, when the org turned collection on,
 *  - **soft references** — the dashboards, graphs, probes, status pages,
 *    alerts, leases, schedules, log queries, workflows and owner record that
 *    name the resource without depending on it.
 *
 * The rule this module is built around: **every gatherer that cannot answer
 * says so.** A failed ClickHouse read, a flow switch that is off, a workflow
 * body that names the resource by a value it computes at runtime — each one
 * lands in `unchecked` with a sentence, and none of them can turn into a quiet
 * "nothing found". A person is about to press Delete on the strength of this
 * report; the difference between "nothing depends on it" and "we could not
 * tell" is the whole product.
 *
 * Nothing here throws for a partial answer. The route is called from a
 * confirmation dialog that must open regardless, and an impact report that
 * 500s because one of eleven queries timed out is worse than one that says
 * which query it was.
 */
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  buildDependencyGraph,
  resolveFlowPeerIdentities,
  summarizeBlastRadius,
  type BlastRadiusFlowPeer,
  type BlastRadiusGap,
  type BlastRadiusReference,
  type BlastRadiusReport,
  type FlowPeerIdentities,
} from "@infrawrench/client-core";
import { isClickHouseConfigured } from "@infrawrench/server-core/clickhouse/client";
import { readTopNetworkFlows } from "@infrawrench/server-core/clickhouse/network-flow-readers";
import { getNetworkFlowSettings } from "@infrawrench/server-core/network-flow/settings";

import { db } from "../db/client";
import { loadDependencyGraph } from "./dependency-graph";
import {
  customGraphs,
  dashboardPins,
  dashboards,
  logWorkspaceQueries,
  metricAlertEvents,
  resourceLeases,
  resourceOwnership,
  resourceSchedules,
  resources,
  statusPageComponents,
  statusPages,
  syntheticProbes,
  users,
  workflows,
} from "../db/schema";

/** How far back traffic is summarized. Matches the network-costs default. */
const FLOW_WINDOW_DAYS = 14;

/** Flow peers kept. Past a handful the list stops informing a yes/no decision. */
const FLOW_PEER_LIMIT = 10;

/**
 * Compute the impact report for one resource.
 *
 * `resourceId` is the composite app id (`plugin:account:external`); the caller
 * has already scoped it to the org.
 */
export async function getBlastRadius(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReport> {
  const unchecked: BlastRadiusGap[] = [];

  const [row] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      externalId: resources.externalId,
      pluginId: resources.pluginId,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.id, resourceId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);

  // The three gatherers are independent, so they run together. Each resolves
  // to its own findings plus whatever it could not check, and none can reject
  // the whole report.
  const [graph, references, flows] = await Promise.all([
    loadGraph(organizationId, unchecked),
    loadReferences(organizationId, resourceId, unchecked),
    loadFlowPeers(organizationId, row ?? null, unchecked),
  ]);

  return summarizeBlastRadius({
    resourceId,
    model: buildDependencyGraph(graph.nodes, graph.edges),
    references,
    flowPeers: flows.peers,
    flowsChecked: flows.checked,
    unchecked,
  });
}

/**
 * The org-wide graph, deliberately — not the endpoint's cheap `?resourceId=`
 * neighbourhood, which is one hop deep and therefore cannot produce a
 * transitive radius at all. The CLI's `graph --resource` and the mobile
 * blast-radius screen already pay the same price for the same reason. This is
 * the report's dominant cost and the reason the delete dialog loads it
 * asynchronously rather than gating on it.
 */
async function loadGraph(organizationId: string, unchecked: BlastRadiusGap[]) {
  try {
    const graph = await loadDependencyGraphSafely(organizationId);
    if (graph.truncated) {
      unchecked.push({
        kind: "dependency-graph",
        reason:
          "The dependency graph hit its edge cap for this organization, so some dependants " +
          "may be missing from this list.",
      });
    }
    return graph;
  } catch {
    unchecked.push({
      kind: "dependency-graph",
      reason:
        "The dependency graph could not be loaded, so nothing is known about what depends " +
        "on this resource.",
    });
    return { nodes: [], edges: [] };
  }
}

async function loadDependencyGraphSafely(organizationId: string) {
  return loadDependencyGraph(organizationId, null);
}

/**
 * Traffic peers, from network flow attribution.
 *
 * Three separate reasons this can decline to answer, and each says which:
 * collection is off for the org, there is no warehouse configured, or the
 * resource has no external id for the flow refs to match on.
 *
 * A fourth kind of gap comes from the peers themselves. Flow refs are the
 * **provider's** id, not the app's composite one, and `external_id` is unique
 * only within one plugin and one account — so identifying a peer is a scoped
 * lookup that is allowed to fail. `resolveFlowPeerIdentities` prefers a match
 * in the collecting account, accepts a single claimant elsewhere, and reports
 * anything contested through `unchecked` instead of linking a guess. A peer
 * that resolves to nothing is just an endpoint outside the estate and is not a
 * gap at all.
 */
async function loadFlowPeers(
  organizationId: string,
  row: { accountId: string; externalId: string | null; pluginId: string } | null,
  unchecked: BlastRadiusGap[],
): Promise<{ peers: BlastRadiusFlowPeer[]; checked: boolean }> {
  const off = (reason: string) => {
    unchecked.push({ kind: "network-flows", reason });
    return { peers: [], checked: false };
  };

  if (!isClickHouseConfigured()) {
    return off(
      "The metrics warehouse is not configured, so nothing is known about what talks to " +
        "this resource over the network.",
    );
  }
  if (!row?.externalId) {
    return off(
      "This resource has no provider id recorded, and network flows are matched on the " +
        "provider's id — its traffic could not be looked up.",
    );
  }

  let enabled = false;
  try {
    enabled = (await getNetworkFlowSettings(organizationId)).enabled;
  } catch {
    return off("The network flow collection setting could not be read, so traffic was skipped.");
  }
  if (!enabled) {
    return off(
      "Network flow collection is off for this organization, so nothing is known about what " +
        "talks to this resource.",
    );
  }

  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - (FLOW_WINDOW_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let pairs;
  try {
    pairs = await readTopNetworkFlows(
      organizationId,
      { from, to },
      { accountId: row.accountId, ref: row.externalId },
      FLOW_PEER_LIMIT,
    );
  } catch {
    return off("The network flow query failed, so this resource's traffic could not be read.");
  }

  // A peer's Infrawrench id, when its flow ref names exactly one resource we
  // sync. Both ends are looked up in one query rather than per row.
  //
  // The candidate query is scoped to the flow row's **plugin**: a flow ref is
  // a provider-native id, so `i-0abc…` from an AWS flow log can only mean an
  // AWS resource, and `external_id` is not unique across plugins (or across
  // accounts — see `resolveFlowPeerIdentities`, which does the rest of the
  // narrowing and refuses to guess when two accounts claim one id).
  const peerRefs = new Set<string>();
  for (const pair of pairs) {
    peerRefs.add(pair.src_ref === row.externalId ? pair.dst_ref : pair.src_ref);
  }
  let identities: FlowPeerIdentities = { idByRef: new Map(), ambiguousRefs: [] };
  if (peerRefs.size > 0) {
    const peerRows = await db
      .select({
        id: resources.id,
        externalId: resources.externalId,
        accountId: resources.accountId,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          eq(resources.pluginId, row.pluginId),
          inArray(resources.externalId, [...peerRefs]),
        ),
      );
    identities = resolveFlowPeerIdentities(
      peerRefs,
      peerRows.flatMap((peer) =>
        peer.externalId
          ? [{ id: peer.id, externalId: peer.externalId, accountId: peer.accountId }]
          : [],
      ),
      row.accountId,
    );
  }

  if (identities.ambiguousRefs.length > 0) {
    const count = identities.ambiguousRefs.length;
    unchecked.push({
      kind: "network-flows",
      reason:
        `${count} network peer${count === 1 ? "" : "s"} could not be identified: the provider ` +
        `id${count === 1 ? "" : "s"} ${identities.ambiguousRefs.join(", ")} ${
          count === 1 ? "is" : "are"
        } used by resources in more than one account, so the traffic is listed without a link ` +
        "rather than attributed to a guess.",
    });
  }

  const peers: BlastRadiusFlowPeer[] = pairs.map((pair) => {
    const weAreSource = pair.src_ref === row.externalId;
    const ref = weAreSource ? pair.dst_ref : pair.src_ref;
    const label = (weAreSource ? pair.dst_label : pair.src_label) || ref;
    return {
      ref,
      label,
      // The stored `direction` is the row's own; relative to this resource,
      // traffic leaving it is egress whichever end the provider captured at.
      direction: weAreSource ? "egress" : "ingress",
      scope: pair.scope,
      bytes: pair.bytes,
      estimatedCost: pair.estimated_cost,
      currency: pair.currency || "USD",
      days: pair.days,
      resourceId: identities.idByRef.get(ref) ?? null,
    };
  });

  return { peers, checked: true };
}

/**
 * Everything that names the resource without depending on it.
 *
 * Each query is separately guarded: one table being unavailable costs its own
 * line in `unchecked`, not the whole report. The two source-text searches
 * (workflows, custom graphs) are `ILIKE` over a program body and can only find
 * a **literal** id — a script that assembles the id from parts, or looks the
 * resource up by name, is invisible to them, which is stated rather than
 * implied.
 */
async function loadReferences(
  organizationId: string,
  resourceId: string,
  unchecked: BlastRadiusGap[],
): Promise<BlastRadiusReference[]> {
  const results = await Promise.allSettled([
    loadDashboardPins(organizationId, resourceId),
    loadProbesAndStatusPages(organizationId, resourceId),
    loadMetricAlerts(organizationId, resourceId),
    loadLeases(organizationId, resourceId),
    loadSchedules(organizationId, resourceId),
    loadLogQueries(organizationId, resourceId),
    loadOwner(organizationId, resourceId),
    loadSourceMatches(organizationId, resourceId),
  ]);

  const references: BlastRadiusReference[] = [];
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") references.push(...result.value);
    else failed += 1;
  }
  if (failed > 0) {
    unchecked.push({
      kind: "references",
      reason: `${failed} of ${results.length} reference checks failed, so this list may be incomplete.`,
    });
  }

  unchecked.push({
    kind: "workflow-source",
    reason:
      "Workflows and custom graphs are matched by searching their source for this resource's " +
      "id verbatim — a script that builds the id at runtime or looks the resource up by name " +
      "will not appear here.",
  });
  unchecked.push({
    kind: "references",
    reason:
      "Metric alert rules select resources by plugin, type and tag rather than by id, so only " +
      "alerts currently firing against this resource can be listed.",
  });

  return references;
}

async function loadDashboardPins(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name })
    .from(dashboardPins)
    .innerJoin(dashboards, eq(dashboardPins.dashboardId, dashboards.id))
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboardPins.resourceId, resourceId),
        isNull(dashboardPins.deletedAt),
        isNull(dashboards.deletedAt),
      ),
    );
  return rows.map((r) => ({
    kind: "dashboard" as const,
    id: r.id,
    name: r.name,
    detail: "pinned card",
  }));
}

/**
 * Probes targeting the resource, and the status pages publishing them.
 *
 * A probe on a *published* page is the one reference in this whole report that
 * somebody outside the organization can see go red, so both it and the page
 * are marked `userFacing` — that flag alone raises the report to high
 * severity, ahead of any count of internal dependants.
 */
async function loadProbesAndStatusPages(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const probes = await db
    .select({
      id: syntheticProbes.id,
      name: syntheticProbes.name,
      url: syntheticProbes.url,
      enabled: syntheticProbes.enabled,
    })
    .from(syntheticProbes)
    .where(
      and(
        eq(syntheticProbes.organizationId, organizationId),
        eq(syntheticProbes.resourceId, resourceId),
      ),
    );
  if (probes.length === 0) return [];

  const components = await db
    .select({
      probeId: statusPageComponents.probeId,
      pageId: statusPages.id,
      title: statusPages.title,
      published: statusPages.published,
    })
    .from(statusPageComponents)
    .innerJoin(statusPages, eq(statusPageComponents.statusPageId, statusPages.id))
    .where(
      and(
        eq(statusPages.organizationId, organizationId),
        inArray(
          statusPageComponents.probeId,
          probes.map((p) => p.id),
        ),
      ),
    );

  const publishedProbeIds = new Set(components.filter((c) => c.published).map((c) => c.probeId));

  const references: BlastRadiusReference[] = probes.map((p) => ({
    kind: "probe" as const,
    id: p.id,
    name: p.name,
    detail: p.enabled ? p.url : `${p.url} (paused)`,
    ...(publishedProbeIds.has(p.id) ? { userFacing: true } : {}),
  }));

  const seenPages = new Set<string>();
  for (const c of components) {
    if (seenPages.has(c.pageId)) continue;
    seenPages.add(c.pageId);
    references.push({
      kind: "status-page",
      id: c.pageId,
      name: c.title,
      detail: c.published ? "published" : "draft",
      ...(c.published ? { userFacing: true } : {}),
    });
  }
  return references;
}

async function loadMetricAlerts(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const rows = await db
    .select({ id: metricAlertEvents.id, ruleName: metricAlertEvents.ruleName })
    .from(metricAlertEvents)
    .where(
      and(
        eq(metricAlertEvents.organizationId, organizationId),
        eq(metricAlertEvents.resourceId, resourceId),
        eq(metricAlertEvents.status, "firing"),
      ),
    );
  return rows.map((r) => ({
    kind: "metric-alert" as const,
    id: r.id,
    name: r.ruleName,
    detail: "firing now",
  }));
}

async function loadLeases(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const rows = await db
    .select({
      id: resourceLeases.id,
      expiresAt: resourceLeases.expiresAt,
      autoDelete: resourceLeases.autoDelete,
    })
    .from(resourceLeases)
    .where(
      and(
        eq(resourceLeases.organizationId, organizationId),
        eq(resourceLeases.resourceId, resourceId),
        eq(resourceLeases.status, "active"),
      ),
    );
  return rows.map((r) => ({
    kind: "lease" as const,
    id: r.id,
    name: `Expires ${r.expiresAt.toISOString().slice(0, 10)}`,
    detail: r.autoDelete ? "auto-deletes at expiry" : "reminder only",
  }));
}

async function loadSchedules(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const rows = await db
    .select({
      id: resourceSchedules.id,
      startTime: resourceSchedules.startTime,
      stopTime: resourceSchedules.stopTime,
      timezone: resourceSchedules.timezone,
      paused: resourceSchedules.paused,
    })
    .from(resourceSchedules)
    .where(
      and(
        eq(resourceSchedules.organizationId, organizationId),
        eq(resourceSchedules.resourceId, resourceId),
      ),
    );
  return rows.map((r) => ({
    kind: "schedule" as const,
    id: r.id,
    name: `${r.startTime}–${r.stopTime} ${r.timezone}`,
    detail: r.paused ? "paused" : "starts and stops this resource",
  }));
}

/**
 * Saved log queries whose stream selector names the resource.
 *
 * `resources` is a jsonb array of selector objects, so the predicate is a
 * containment test — the same shape the log workspace writes.
 */
async function loadLogQueries(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const rows = await db
    .select({
      id: logWorkspaceQueries.id,
      name: logWorkspaceQueries.name,
      alertEnabled: logWorkspaceQueries.alertEnabled,
    })
    .from(logWorkspaceQueries)
    .where(
      and(
        eq(logWorkspaceQueries.organizationId, organizationId),
        sql`${logWorkspaceQueries.resources} @> ${JSON.stringify([{ resourceId }])}::jsonb`,
      ),
    );
  return rows.map((r) => ({
    kind: "log-query" as const,
    id: r.id,
    name: r.name,
    detail: r.alertEnabled ? "alerts on matching lines" : "saved query",
  }));
}

/**
 * The recorded owner — who to tell, which is the question a delete dialog is
 * really asking. A record naming nobody is not a reference: `resource_ownership`
 * can hold a purpose with no owner, and "somebody wrote a note about this" is
 * not an answer to "who do I ask?".
 */
async function loadOwner(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const rows = await db
    .select({
      id: resourceOwnership.id,
      ownerLabel: resourceOwnership.ownerLabel,
      purpose: resourceOwnership.purpose,
      userId: users.id,
      userName: users.displayName,
      userEmail: users.email,
    })
    .from(resourceOwnership)
    .leftJoin(users, eq(resourceOwnership.ownerUserId, users.id))
    .where(
      and(
        eq(resourceOwnership.organizationId, organizationId),
        eq(resourceOwnership.resourceId, resourceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return [];
  // The member wins over the label when both are set, and a deleted user falls
  // back to the label — the same tie-break `toOwnerSummary` applies everywhere.
  const name = row.userName || row.userEmail || row.ownerLabel;
  if (!name) return [];
  return [
    {
      kind: "owner",
      id: row.userId ?? row.id,
      name,
      ...(row.purpose ? { detail: row.purpose } : {}),
    },
  ];
}

/**
 * Workflows and custom graphs whose source mentions the id verbatim.
 *
 * `ILIKE '%id%'` over a program body: no index helps, and the escape below
 * matters because composite resource ids are user-influenced and a literal
 * `%` or `_` in one would silently widen the pattern.
 */
async function loadSourceMatches(
  organizationId: string,
  resourceId: string,
): Promise<BlastRadiusReference[]> {
  const pattern = `%${resourceId.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const [workflowRows, graphRows] = await Promise.all([
    db
      .select({ id: workflows.id, name: workflows.name, enabled: workflows.enabled })
      .from(workflows)
      .where(
        and(
          eq(workflows.organizationId, organizationId),
          isNull(workflows.deletedAt),
          ilike(workflows.source, pattern),
        ),
      ),
    db
      .select({ id: customGraphs.id, name: customGraphs.name })
      .from(customGraphs)
      .where(
        and(
          eq(customGraphs.organizationId, organizationId),
          isNull(customGraphs.deletedAt),
          or(ilike(customGraphs.source, pattern), ilike(customGraphs.description, pattern)),
        ),
      ),
  ]);

  return [
    ...workflowRows.map((r) => ({
      kind: "workflow" as const,
      id: r.id,
      name: r.name,
      detail: r.enabled ? "names this resource in its source" : "disabled",
    })),
    ...graphRows.map((r) => ({
      kind: "custom-graph" as const,
      id: r.id,
      name: r.name,
      detail: "names this resource in its source",
    })),
  ];
}
