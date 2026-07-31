/**
 * Local-mode dependency graph assembly. The reference data lives in the same
 * tables the cloud uses — `associations` topology rows plus
 * `secret_field_states` output-ref rows — just in the desktop SQLite, so this
 * mirrors the server's `/dependency-graph` endpoint against the local DB.
 * Plugin metadata (logo, display names) comes from the renderer plugin loader.
 */
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";

interface ResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
}

interface EdgeRow {
  consumer_resource_id: string;
  consumer_field_key: string;
  provider_resource_id: string | null;
  provider_output_key: string | null;
}

export async function loadLocalDependencyGraph(): Promise<DependencyGraphData> {
  const db = await getDb();

  // Four independent reads — nothing here feeds anything else's query, so
  // they go out together instead of waterfalling over the IPC boundary.
  const [resourceRows, associationRows, refStateRows, accountRows] = await Promise.all([
    db.select<ResourceRow[]>(
      `SELECT id, plugin_id, resource_type_id, account_id, display_name
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
  // field) wins, matching the shared model's dedupe rule.
  const edges: DependencyGraphEdge[] = [];
  const seen = new Set<string>();
  for (const row of [...associationRows, ...refStateRows]) {
    if (!row.provider_resource_id || !row.provider_output_key) continue;
    if (!resourceById.has(row.provider_resource_id)) continue;
    if (!resourceById.has(row.consumer_resource_id)) continue;
    if (row.provider_resource_id === row.consumer_resource_id) continue;
    const key = `${row.consumer_resource_id} ${row.consumer_field_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      consumerResourceId: row.consumer_resource_id,
      consumerFieldKey: row.consumer_field_key,
      providerResourceId: row.provider_resource_id,
      providerOutputKey: row.provider_output_key,
    });
  }

  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.consumerResourceId);
    connectedIds.add(edge.providerResourceId);
  }

  // One load, indexed by manifest id — `getPlugin` is a linear scan over the
  // same memoized list, so calling it per node re-scanned it every time.
  const pluginById = new Map(
    (await loadPlugins()).map((loaded) => [loaded.plugin.manifest.id, loaded]),
  );

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

  return { nodes, edges };
}
