/**
 * The command palette's index: one loader per searchable kind, shared by
 * `GET /search` (rank by a query) and `GET /starred` (resolve stored refs).
 *
 * **Every loader answers only what the caller could open**, by applying the
 * same narrowing its own list route applies, never a looser one:
 *
 * - cost reports, report folders, dashboards and canvases go through
 *   `filterVisibleObjects` (per-object sharing, with the same `ObjectMeta`
 *   their list services pass, so creator ownership and folder inheritance
 *   count the same way);
 * - budgets go through `visibilityOwnerCondition` (a cost-scoped member sees
 *   only their own, the `loadVisibleBudgets` rule);
 * - every other kind is gated by its list route's role permission alone,
 *   which is all its list route checks.
 *
 * A kind whose permission the caller lacks is skipped, not an error: the
 * palette searches everything the caller can see in one request. The
 * permission per kind is {@link SEARCH_KIND_PERMISSION}; a test pins it to the
 * list routes.
 *
 * Loaders select only the columns a hit needs. The list services compute
 * placements, statuses and spend that a search result never shows, so calling
 * them per keystroke would cost a ClickHouse round trip for nothing.
 */
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  SEARCH_KIND_LABELS,
  SEARCH_OBJECT_PLUGIN_ID,
  SEARCH_WORKFLOW_PLUGIN_ID,
  fuzzyScore,
  type SearchObjectKind,
  type SearchResult,
  type SearchResultKind,
  type StarRef,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { db } from "../db/client";
import {
  accounts,
  budgets,
  businessMetrics,
  costCanvases,
  costReportFolders,
  costReports,
  costScenarioModels,
  dashboards,
  logWorkspaceQueries,
  queryMonitors,
  resources,
  runbooks,
  savedCostFilters,
  services,
  slos,
  statusPages,
  syntheticProbes,
  virtualTags,
  workflows,
} from "../db/schema";
import { getPlugin } from "../plugins/loader";
import { filterVisibleObjects } from "./object-sharing";
import { visibilityOwnerCondition } from "./cost-visibility-filter";

/** Inline workflow glyph for the spotlight group header (matches WorkflowIcon). */
const WORKFLOW_LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>`;

/**
 * The role permission each kind's own list route requires. Searching or
 * resolving a star of that kind requires the same.
 */
export const SEARCH_KIND_PERMISSION: Record<SearchResultKind, string> = {
  resource: "resources:read",
  workflow: "workflows:read",
  cost_report: "costs:read",
  cost_report_folder: "costs:read",
  dashboard: "dashboards:read",
  budget: "budgets:read",
  cost_canvas: "costs:read",
  saved_cost_filter: "costs:read",
  virtual_tag: "costs:read",
  business_metric: "costs:read",
  scenario_model: "costs:read",
  slo: "resources:read",
  service: "resources:read",
  runbook: "resources:read",
  status_page: "resources:read",
  probe: "resources:read",
  log_query: "resources:read",
  query_monitor: "resources:read",
};

const SUBTITLE_MAX = 140;

function clip(text: string | null | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > SUBTITLE_MAX ? `${t.slice(0, SUBTITLE_MAX - 1)}…` : t;
}

function joinParts(...parts: (string | null | undefined)[]): string | undefined {
  return clip(parts.filter((p) => p && p.trim()).join(" · "));
}

/** A hit for a saved object: the kind rides as `resourceTypeId` for old readers. */
export function objectHit(
  kind: SearchObjectKind,
  id: string,
  name: string,
  subtitle?: string | null,
): SearchResult {
  const sub = clip(subtitle);
  return {
    id,
    kind,
    pluginId: SEARCH_OBJECT_PLUGIN_ID,
    pluginDisplayName: SEARCH_KIND_LABELS[kind].plural,
    pluginLogoSvg: "",
    resourceTypeId: kind,
    resourceTypeLabel: SEARCH_KIND_LABELS[kind].singular,
    accountId: "",
    accountName: "",
    displayName: name,
    ...(sub ? { subtitle: sub } : {}),
  };
}

/** `AND id IN (…)` when resolving specific refs, nothing when searching. */
function idFilter(column: Parameters<typeof inArray>[0], ids?: readonly string[]): SQL | undefined {
  return ids ? inArray(column, [...ids]) : undefined;
}

type Loader = (organizationId: string, ids?: readonly string[]) => Promise<SearchResult[]>;

async function loadResources(organizationId: string, ids?: readonly string[]) {
  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        idFilter(resources.id, ids),
      ),
    );
  const accountRows = await db
    .select({ id: accounts.id, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const accountNames = new Map(accountRows.map((a) => [a.id, a.displayName]));

  const pluginCache = new Map<
    string,
    { logoSvg: string; displayName: string; resourceTypes: Map<string, string> }
  >();
  const out: SearchResult[] = [];
  for (const r of rows) {
    let meta = pluginCache.get(r.pluginId);
    if (!meta) {
      const loaded = await getPlugin(r.pluginId);
      meta = loaded
        ? {
            logoSvg: loaded.plugin.manifest.logoSvg,
            displayName: loaded.plugin.manifest.displayName,
            resourceTypes: new Map(loaded.plugin.resourceTypes.map((t) => [t.id, t.displayName])),
          }
        : { logoSvg: "", displayName: r.pluginId, resourceTypes: new Map() };
      pluginCache.set(r.pluginId, meta);
    }
    out.push({
      id: r.id,
      kind: "resource",
      pluginId: r.pluginId,
      pluginDisplayName: meta.displayName,
      pluginLogoSvg: meta.logoSvg,
      resourceTypeId: r.resourceTypeId,
      resourceTypeLabel: meta.resourceTypes.get(r.resourceTypeId) ?? r.resourceTypeId,
      accountId: r.accountId,
      accountName: accountNames.get(r.accountId) ?? "",
      displayName: r.displayName,
    });
  }
  return out;
}

async function loadWorkflows(organizationId: string, ids?: readonly string[]) {
  const rows = await db
    .select({ id: workflows.id, name: workflows.name, trigger: workflows.trigger })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        isNull(workflows.deletedAt),
        idFilter(workflows.id, ids),
      ),
    );
  return rows.map((w): SearchResult => ({
    id: w.id,
    kind: "workflow",
    pluginId: SEARCH_WORKFLOW_PLUGIN_ID,
    pluginDisplayName: "Workflows",
    pluginLogoSvg: WORKFLOW_LOGO_SVG,
    resourceTypeId: "__workflow__",
    resourceTypeLabel: "Workflow",
    accountId: "",
    accountName: "",
    displayName: w.name,
    subtitle: `${(w.trigger as { kind?: string } | null)?.kind ?? "manual"} trigger`,
  }));
}

const LOADERS: Record<SearchResultKind, Loader> = {
  resource: loadResources,
  workflow: loadWorkflows,

  async cost_report(organizationId, ids) {
    const rows = await db
      .select({
        id: costReports.id,
        name: costReports.name,
        description: costReports.description,
        folderId: costReports.folderId,
        createdByUserId: costReports.createdByUserId,
      })
      .from(costReports)
      .where(
        and(
          eq(costReports.organizationId, organizationId),
          isNull(costReports.deletedAt),
          idFilter(costReports.id, ids),
        ),
      )
      .orderBy(asc(costReports.name));
    const visible = await filterVisibleObjects(
      organizationId,
      "cost_report",
      rows,
      (r) => r.id,
      (r) => ({ createdByUserId: r.createdByUserId, folderId: r.folderId }),
    );
    // The folder name is the subtitle; folders are few, one query covers them.
    const folderIds = [...new Set(visible.map((r) => r.folderId).filter((f): f is string => !!f))];
    const folderNames = new Map<string, string>();
    if (folderIds.length > 0) {
      const folders = await db
        .select({ id: costReportFolders.id, name: costReportFolders.name })
        .from(costReportFolders)
        .where(
          and(
            eq(costReportFolders.organizationId, organizationId),
            inArray(costReportFolders.id, folderIds),
          ),
        );
      for (const f of folders) folderNames.set(f.id, f.name);
    }
    return visible.map((r) =>
      objectHit(
        "cost_report",
        r.id,
        r.name,
        joinParts(r.folderId ? folderNames.get(r.folderId) : null, r.description),
      ),
    );
  },

  async cost_report_folder(organizationId, ids) {
    const rows = await db
      .select({
        id: costReportFolders.id,
        name: costReportFolders.name,
        parentFolderId: costReportFolders.parentFolderId,
      })
      .from(costReportFolders)
      .where(
        and(
          eq(costReportFolders.organizationId, organizationId),
          idFilter(costReportFolders.id, ids),
        ),
      )
      .orderBy(asc(costReportFolders.name));
    // Only folders the caller can open, not the ancestors-as-path the list
    // adds back: a path segment is not something to jump to.
    const visible = await filterVisibleObjects(
      organizationId,
      "cost_report_folder",
      rows,
      (f) => f.id,
      (f) => ({ folderId: f.parentFolderId }),
    );
    return visible.map((f) => objectHit("cost_report_folder", f.id, f.name));
  },

  async dashboard(organizationId, ids) {
    const rows = await db
      .select({ id: dashboards.id, name: dashboards.name, isDefault: dashboards.isDefault })
      .from(dashboards)
      .where(
        and(
          eq(dashboards.organizationId, organizationId),
          isNull(dashboards.deletedAt),
          idFilter(dashboards.id, ids),
        ),
      )
      .orderBy(asc(dashboards.name));
    const visible = await filterVisibleObjects(organizationId, "dashboard", rows, (d) => d.id);
    return visible.map((d) =>
      objectHit("dashboard", d.id, d.name, d.isDefault ? "Default dashboard" : null),
    );
  },

  async budget(organizationId, ids) {
    const rows = await db
      .select({
        id: budgets.id,
        name: budgets.name,
        amountCents: budgets.amountCents,
        currency: budgets.currency,
      })
      .from(budgets)
      .where(
        and(
          eq(budgets.organizationId, organizationId),
          visibilityOwnerCondition(budgets.visibilityUserId, organizationId),
          isNull(budgets.deletedAt),
          idFilter(budgets.id, ids),
        ),
      )
      .orderBy(asc(budgets.name));
    return rows.map((b) =>
      objectHit(
        "budget",
        b.id,
        b.name,
        `${(b.amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${b.currency}`,
      ),
    );
  },

  async cost_canvas(organizationId, ids) {
    const rows = await db
      .select({
        id: costCanvases.id,
        name: costCanvases.name,
        description: costCanvases.description,
        createdByUserId: costCanvases.createdByUserId,
      })
      .from(costCanvases)
      .where(
        and(
          eq(costCanvases.organizationId, organizationId),
          isNull(costCanvases.deletedAt),
          idFilter(costCanvases.id, ids),
        ),
      )
      .orderBy(asc(costCanvases.name));
    const visible = await filterVisibleObjects(
      organizationId,
      "cost_canvas",
      rows,
      (r) => r.id,
      (r) => ({ createdByUserId: r.createdByUserId }),
    );
    return visible.map((r) => objectHit("cost_canvas", r.id, r.name, r.description));
  },

  async saved_cost_filter(organizationId, ids) {
    const rows = await db
      .select({
        id: savedCostFilters.id,
        name: savedCostFilters.name,
        description: savedCostFilters.description,
      })
      .from(savedCostFilters)
      .where(
        and(
          eq(savedCostFilters.organizationId, organizationId),
          isNull(savedCostFilters.deletedAt),
          idFilter(savedCostFilters.id, ids),
        ),
      )
      .orderBy(asc(savedCostFilters.name));
    return rows.map((r) => objectHit("saved_cost_filter", r.id, r.name, r.description));
  },

  async virtual_tag(organizationId, ids) {
    const rows = await db
      .select({
        id: virtualTags.id,
        name: virtualTags.name,
        key: virtualTags.key,
        description: virtualTags.description,
      })
      .from(virtualTags)
      .where(and(eq(virtualTags.organizationId, organizationId), idFilter(virtualTags.id, ids)))
      .orderBy(asc(virtualTags.name));
    return rows.map((r) => objectHit("virtual_tag", r.id, r.name, joinParts(r.key, r.description)));
  },

  async business_metric(organizationId, ids) {
    const rows = await db
      .select({
        id: businessMetrics.id,
        name: businessMetrics.name,
        key: businessMetrics.key,
        unit: businessMetrics.unit,
      })
      .from(businessMetrics)
      .where(
        and(
          eq(businessMetrics.organizationId, organizationId),
          isNull(businessMetrics.deletedAt),
          idFilter(businessMetrics.id, ids),
        ),
      )
      .orderBy(asc(businessMetrics.name));
    return rows.map((r) => objectHit("business_metric", r.id, r.name, joinParts(r.key, r.unit)));
  },

  async scenario_model(organizationId, ids) {
    const rows = await db
      .select({
        id: costScenarioModels.id,
        name: costScenarioModels.name,
        description: costScenarioModels.description,
      })
      .from(costScenarioModels)
      .where(
        and(
          eq(costScenarioModels.organizationId, organizationId),
          isNull(costScenarioModels.deletedAt),
          idFilter(costScenarioModels.id, ids),
        ),
      )
      .orderBy(asc(costScenarioModels.name));
    return rows.map((r) => objectHit("scenario_model", r.id, r.name, r.description));
  },

  async slo(organizationId, ids) {
    const rows = await db
      .select({
        id: slos.id,
        name: slos.name,
        description: slos.description,
        targetPercent: slos.targetPercent,
      })
      .from(slos)
      .where(and(eq(slos.organizationId, organizationId), idFilter(slos.id, ids)))
      .orderBy(asc(slos.name));
    return rows.map((r) =>
      objectHit("slo", r.id, r.name, joinParts(`${r.targetPercent}% target`, r.description)),
    );
  },

  async service(organizationId, ids) {
    const rows = await db
      .select({
        id: services.id,
        name: services.name,
        slug: services.slug,
        ownerTeam: services.ownerTeam,
      })
      .from(services)
      .where(and(eq(services.organizationId, organizationId), idFilter(services.id, ids)))
      .orderBy(asc(services.name));
    return rows.map((r) => objectHit("service", r.id, r.name, joinParts(r.slug, r.ownerTeam)));
  },

  async runbook(organizationId, ids) {
    const rows = await db
      .select({ id: runbooks.id, name: runbooks.name, description: runbooks.description })
      .from(runbooks)
      .where(and(eq(runbooks.organizationId, organizationId), idFilter(runbooks.id, ids)))
      .orderBy(asc(runbooks.name));
    return rows.map((r) => objectHit("runbook", r.id, r.name, r.description));
  },

  async status_page(organizationId, ids) {
    const rows = await db
      .select({ id: statusPages.id, title: statusPages.title, slug: statusPages.slug })
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), idFilter(statusPages.id, ids)))
      .orderBy(asc(statusPages.title));
    return rows.map((r) => objectHit("status_page", r.id, r.title, r.slug));
  },

  async probe(organizationId, ids) {
    const rows = await db
      .select({ id: syntheticProbes.id, name: syntheticProbes.name, url: syntheticProbes.url })
      .from(syntheticProbes)
      .where(
        and(eq(syntheticProbes.organizationId, organizationId), idFilter(syntheticProbes.id, ids)),
      )
      .orderBy(asc(syntheticProbes.name));
    return rows.map((r) => objectHit("probe", r.id, r.name, r.url));
  },

  async log_query(organizationId, ids) {
    const rows = await db
      .select({
        id: logWorkspaceQueries.id,
        name: logWorkspaceQueries.name,
        search: logWorkspaceQueries.search,
      })
      .from(logWorkspaceQueries)
      .where(
        and(
          eq(logWorkspaceQueries.organizationId, organizationId),
          idFilter(logWorkspaceQueries.id, ids),
        ),
      )
      .orderBy(asc(logWorkspaceQueries.name));
    return rows.map((r) => objectHit("log_query", r.id, r.name, r.search));
  },

  async query_monitor(organizationId, ids) {
    const rows = await db
      .select({
        id: queryMonitors.id,
        name: queryMonitors.name,
        description: queryMonitors.description,
      })
      .from(queryMonitors)
      .where(and(eq(queryMonitors.organizationId, organizationId), idFilter(queryMonitors.id, ids)))
      .orderBy(asc(queryMonitors.name));
    return rows.map((r) => objectHit("query_monitor", r.id, r.name, r.description));
  },
};

/** The kinds in `kinds` the caller's permissions let them search. */
export function searchableKinds(
  permissions: readonly string[],
  kinds: readonly SearchResultKind[],
): SearchResultKind[] {
  return kinds.filter((k) => hasPermission(permissions, SEARCH_KIND_PERMISSION[k]));
}

function rankHits(hits: SearchResult[], query: string): { hit: SearchResult; score: number }[] {
  const scored: { hit: SearchResult; score: number; index: number }[] = [];
  hits.forEach((hit, index) => {
    const score = fuzzyScore(query, hit.displayName, [
      hit.subtitle,
      hit.resourceTypeLabel,
      hit.accountName,
      hit.kind === "resource" ? hit.pluginDisplayName : undefined,
    ]);
    if (score !== null) scored.push({ hit, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored;
}

export interface PaletteSearchOptions {
  /** Hits per object kind (resources use {@link resourceLimit}). */
  perKindLimit?: number;
  resourceLimit?: number;
}

/**
 * Search the given kinds for `query`, best first within each kind, kinds
 * ordered by their best hit. An empty query lists the first hits of each
 * kind alphabetically, the original route's empty-query behaviour.
 *
 * `kinds` must already be narrowed to what the caller may read
 * ({@link searchableKinds}); this function does not check permissions.
 */
export async function searchPalette(
  organizationId: string,
  query: string,
  kinds: readonly SearchResultKind[],
  options: PaletteSearchOptions = {},
): Promise<SearchResult[]> {
  const perKind = options.perKindLimit ?? 8;
  const resourceLimit = options.resourceLimit ?? 50;
  const q = query.trim();
  const groups = await Promise.all(
    kinds.map(async (kind) => {
      const hits = await LOADERS[kind](organizationId);
      const limit = kind === "resource" ? resourceLimit : perKind;
      const ranked = rankHits(hits, q).slice(0, limit);
      return { best: ranked[0]?.score ?? -1, hits: ranked.map((r) => r.hit) };
    }),
  );
  // Stable: with an empty query every score is 0 and the request's order holds.
  return groups
    .map((g, i) => ({ ...g, i }))
    .filter((g) => g.hits.length > 0)
    .sort((a, b) => b.best - a.best || a.i - b.i)
    .flatMap((g) => g.hits);
}

/**
 * The original `/search` contract, for requests without `kinds=`: resources
 * whose name, account, provider or type label contains the query (first 50
 * in table order), then every matching workflow. Kept byte-for-byte in
 * behaviour so the editor extensions and mobile, which call it without
 * `kinds`, see exactly what they always did (plus the additive `kind`).
 */
export async function legacySearch(organizationId: string, query: string): Promise<SearchResult[]> {
  const q = query.toLowerCase().trim();
  const out: SearchResult[] = [];
  for (const r of await loadResources(organizationId)) {
    if (q) {
      const searchable =
        `${r.displayName} ${r.accountName} ${r.pluginDisplayName} ${r.resourceTypeLabel}`.toLowerCase();
      if (!searchable.includes(q)) continue;
    }
    out.push(r);
    if (out.length >= 50) break;
  }
  for (const w of await loadWorkflows(organizationId)) {
    if (q && !w.displayName.toLowerCase().includes(q)) continue;
    out.push(w);
  }
  return out;
}

/**
 * Resolve stored refs to fresh hits, dropping any the caller can no longer
 * open (deleted, unshared, outside their cost scope, or of a kind their role
 * cannot read). Keyed by `starKey`.
 */
export async function resolvePaletteRefs(
  organizationId: string,
  permissions: readonly string[],
  refs: readonly StarRef[],
): Promise<Map<string, SearchResult>> {
  const byKind = new Map<SearchResultKind, string[]>();
  for (const ref of refs) {
    if (!hasPermission(permissions, SEARCH_KIND_PERMISSION[ref.kind])) continue;
    const list = byKind.get(ref.kind) ?? [];
    list.push(ref.id);
    byKind.set(ref.kind, list);
  }
  const out = new Map<string, SearchResult>();
  await Promise.all(
    [...byKind].map(async ([kind, ids]) => {
      const hits = await LOADERS[kind](organizationId, ids);
      for (const hit of hits) out.set(`${kind}:${hit.id}`, hit);
    }),
  );
  return out;
}
