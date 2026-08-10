/**
 * Local-mode dependency graph assembly. Mirrors the server's
 * `/dependency-graph` endpoint against the desktop SQLite: explicit output
 * references from the `associations` and `secret_field_states` tables, plus the
 * edges `inferDependencyEdges` reads back out of synced cloud data (parent
 * links and field values that name another resource's identity). Plugin
 * metadata (logo, display names) comes from the renderer plugin loader.
 *
 * Local mode always assembles the whole graph — the detail page's Dependencies
 * tab filters it client-side — so there is no focused-query path to mirror.
 */
import {
  collectDependencyRules,
  inferDependencyEdges,
  type DependencyGraphData,
  type DependencyGraphEdge,
  type DependencyGraphNode,
  type InferenceResource,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";

interface ResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  external_id: string | null;
  parent_resource_id: string | null;
  fields_json: string;
  outputs_json: string;
}

interface EdgeRow {
  consumer_resource_id: string;
  consumer_field_key: string;
  provider_resource_id: string | null;
  provider_output_key: string | null;
}

/** SQLite stores the bags as TEXT; a row written by hand may not parse. */
function parseBag(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function loadLocalDependencyGraph(): Promise<DependencyGraphData> {
  const db = await getDb();

  // Four independent reads — nothing here feeds anything else's query, so
  // they go out together instead of waterfalling over the IPC boundary.
  const [resourceRows, associationRows, refStateRows, accountRows] = await Promise.all([
    db.select<ResourceRow[]>(
      `SELECT id, plugin_id, resource_type_id, account_id, display_name,
              external_id, parent_resource_id, fields_json, outputs_json
       FROM resources WHERE deleted_at IS NULL`,
    ),
    db.select<EdgeRow[]>(
      `SELECT consumer_resource_id, consumer_field_key, provider_resource_id, provider_output_key
       FROM associations WHERE deleted_at IS NULL`,
    ),
    db.select<EdgeRow[]>(
      `SELECT resource_id AS consumer_resource_id, field_key AS consumer_field_key,
              source_resource_id AS provider_resource_id, source_output_key AS provider_output_key
       FROM secret_field_states WHERE resolution_kind = 'output-ref'`,
    ),
    db.select<{ id: string; display_name: string }[]>(
      `SELECT id, display_name FROM accounts WHERE deleted_at IS NULL`,
    ),
  ]);
  const resourceById = new Map(resourceRows.map((r) => [r.id, r]));
  const accountNameById = new Map(accountRows.map((a) => [a.id, a.display_name]));

  // Associations first — canonical topology rows; first edge per (consumer,
  // field, provider) wins, matching the shared model's dedupe rule.
  const edges: DependencyGraphEdge[] = [];
  const seen = new Set<string>();
  for (const row of [...associationRows, ...refStateRows]) {
    if (!row.provider_resource_id || !row.provider_output_key) continue;
    if (!resourceById.has(row.provider_resource_id)) continue;
    if (!resourceById.has(row.consumer_resource_id)) continue;
    if (row.provider_resource_id === row.consumer_resource_id) continue;
    const key = `${row.consumer_resource_id} ${row.consumer_field_key} ${row.provider_resource_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      consumerResourceId: row.consumer_resource_id,
      consumerFieldKey: row.consumer_field_key,
      providerResourceId: row.provider_resource_id,
      providerOutputKey: row.provider_output_key,
      kind: "output-ref",
    });
  }

  // One load, indexed by manifest id — `getPlugin` is a linear scan over the
  // same memoized list, so calling it per node re-scanned it every time.
  // Loaded before inference because the plugins' `dependsOn` declarations
  // feed it.
  const plugins = await loadPlugins();
  const pluginById = new Map(plugins.map((loaded) => [loaded.plugin.manifest.id, loaded]));

  const inferenceResources: InferenceResource[] = resourceRows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    pluginId: r.plugin_id,
    resourceTypeId: r.resource_type_id,
    externalId: r.external_id,
    parentResourceId: r.parent_resource_id,
    fields: parseBag(r.fields_json),
    outputs: parseBag(r.outputs_json),
  }));
  const inferred = inferDependencyEdges(inferenceResources, {
    existingEdges: edges,
    rules: collectDependencyRules(
      plugins.map((loaded) => ({
        id: loaded.plugin.manifest.id,
        resourceTypes: loaded.plugin.resourceTypes,
      })),
    ),
  });
  edges.push(...inferred.edges);

  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.consumerResourceId);
    connectedIds.add(edge.providerResourceId);
  }

  const nodes: DependencyGraphNode[] = [];
  for (const id of connectedIds) {
    const r = resourceById.get(id);
    if (!r) continue;
    const loaded = pluginById.get(r.plugin_id);
    nodes.push({
      id: r.id,
      displayName: r.display_name,
      pluginId: r.plugin_id,
      pluginDisplayName: loaded?.plugin.manifest.displayName ?? r.plugin_id,
      pluginLogoSvg: loaded?.plugin.manifest.logoSvg ?? "",
      resourceTypeId: r.resource_type_id,
      resourceTypeLabel:
        loaded?.plugin.resourceTypes.find((t) => t.id === r.resource_type_id)?.displayName ??
        r.resource_type_id,
      accountId: r.account_id,
      accountName: accountNameById.get(r.account_id) ?? "",
    });
  }

  return { nodes, edges, truncated: inferred.truncated };
}
