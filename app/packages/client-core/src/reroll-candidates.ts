/**
 * The resources a secret field's Reroll dialog offers on its "From resource"
 * tab: every stored resource with an output that can fill that field.
 *
 * "Can fill" is read off the plugins, never a list here, from two
 * declarations:
 *
 * - A resource type that hands one of its outputs to another plugin declares
 *   it as a peer integration (`credentialMappings: [{ outputKey,
 *   credentialKey }]`): a DigitalOcean managed database maps its
 *   `connectionString` output onto the Postgres plugin's `connectionString`.
 *   That mapping is what makes the output a source for a Postgres resource's
 *   `connectionString` field, gated by the integration's own `showWhen` and
 *   friends, exactly as the detail view decides whether the peer tab appears
 *   (a DigitalOcean MySQL database is no source for a Postgres field).
 * - The consumer's field can name its sources itself (`resolvableFrom` on the
 *   field definition). Those count too, unless a peer integration of the same
 *   type already speaks for it, whose gates then decide.
 *
 * Pure: the web route feeds it the org's stored rows and loaded plugins, the
 * desktop's local mode its own database and registry.
 */
// Type-only: client-core keeps zero runtime dependency on plugin-base.
import type {
  FieldDefinition,
  PeerPluginIntegration,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { peerIntegrationVisible } from "./log-discovery";

/**
 * One resource type output that can fill the field, and the integration that
 * says so (absent for a source the field names itself, which has no gates).
 */
export interface RerollSource {
  pluginId: string;
  resourceTypeId: string;
  outputKey: string;
  integration?: PeerPluginIntegration;
}

/** What `rerollSources` reads from each loaded plugin. */
export interface RerollSourcePlugin {
  pluginId: string;
  resourceTypes: readonly {
    id: string;
    peerIntegrations?: ResourceTypeDefinition["peerIntegrations"];
    fields?: readonly Pick<FieldDefinition, "key" | "resolvableFrom">[];
  }[];
}

const typeKey = (pluginId: string, resourceTypeId: string) => `${pluginId}\u0000${resourceTypeId}`;

/** Every resource type output that can fill `fieldKey` of a `consumer` resource. */
export function rerollSources(
  plugins: Iterable<RerollSourcePlugin>,
  consumer: { pluginId: string; resourceTypeId: string },
  fieldKey: string,
): RerollSource[] {
  const all = [...plugins];
  const sources: RerollSource[] = [];
  const known = new Set<string>();
  for (const plugin of all) {
    for (const type of plugin.resourceTypes) {
      known.add(typeKey(plugin.pluginId, type.id));
      for (const integration of type.peerIntegrations ?? []) {
        if (integration.pluginId !== consumer.pluginId) continue;
        for (const mapping of integration.credentialMappings) {
          if (mapping.credentialKey !== fieldKey) continue;
          sources.push({
            pluginId: plugin.pluginId,
            resourceTypeId: type.id,
            outputKey: mapping.outputKey,
            integration,
          });
        }
      }
    }
  }
  const integrated = new Set(sources.map((s) => typeKey(s.pluginId, s.resourceTypeId)));
  const field = all
    .find((p) => p.pluginId === consumer.pluginId)
    ?.resourceTypes.find((t) => t.id === consumer.resourceTypeId)
    ?.fields?.find((f) => f.key === fieldKey);
  for (const declared of field?.resolvableFrom ?? []) {
    const key = typeKey(declared.pluginId, declared.resourceTypeId);
    // A type no loaded plugin has (renamed, or its plugin disabled) has no rows to offer.
    if (integrated.has(key) || !known.has(key)) continue;
    integrated.add(key);
    sources.push({
      pluginId: declared.pluginId,
      resourceTypeId: declared.resourceTypeId,
      outputKey: declared.outputKey,
    });
  }
  return sources;
}

/** A stored resource row, as either host reads it. */
export interface RerollCandidateRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  /** The row's stored fields: drive the integrations' visibility gates. */
  fields: Record<string, unknown> | undefined;
}

/** One entry of the "From resource" list. */
export interface RerollCandidate {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  outputKey: string;
}

/**
 * The rows that can fill the field, one entry per resource (the first source
 * whose gates it passes), sorted by name. The consumer itself is never offered.
 */
export function rerollCandidates(
  sources: readonly RerollSource[],
  rows: Iterable<RerollCandidateRow>,
  consumerResourceId: string,
): RerollCandidate[] {
  const byType = new Map<string, RerollSource[]>();
  for (const source of sources) {
    const key = typeKey(source.pluginId, source.resourceTypeId);
    const list = byType.get(key) ?? [];
    list.push(source);
    byType.set(key, list);
  }
  const seen = new Set<string>();
  const out: RerollCandidate[] = [];
  for (const row of rows) {
    if (row.id === consumerResourceId || seen.has(row.id)) continue;
    const typeSources = byType.get(typeKey(row.pluginId, row.resourceTypeId));
    const source = typeSources?.find(
      (s) => !s.integration || peerIntegrationVisible(s.integration, row.fields),
    );
    if (!source) continue;
    seen.add(row.id);
    out.push({
      resourceId: row.id,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      accountId: row.accountId,
      displayName: row.displayName,
      outputKey: source.outputKey,
    });
  }
  return out.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) || a.resourceId.localeCompare(b.resourceId),
  );
}

/** What the user confirmed in the Reroll dialog. */
export type RerollChoice =
  | { kind: "literal"; value: string }
  | {
      kind: "output-ref";
      providerResourceId: string;
      providerPluginId: string;
      providerResourceTypeId: string;
      providerAccountId: string;
      providerOutputKey: string;
    };

/**
 * The associations call a confirmed reroll makes, named by its endpoint in the
 * API contract (`associations.literal`, `associations.create`), so web's fetch
 * and the desktop's cloud client send the same body.
 */
export type RerollRequest =
  | {
      endpoint: "literal";
      payload: { resourceId: string; fieldKey: string; plaintextValue: string };
    }
  | {
      endpoint: "create";
      payload: {
        consumerResourceId: string;
        consumerFieldKey: string;
        providerResourceId: string;
        providerOutputKey: string;
        providerPluginId: string;
        providerResourceTypeId: string;
        providerAccountId: string;
      };
    };

export function rerollRequest(
  resourceId: string,
  fieldKey: string,
  choice: RerollChoice,
): RerollRequest {
  if (choice.kind === "literal") {
    return {
      endpoint: "literal",
      payload: { resourceId, fieldKey, plaintextValue: choice.value },
    };
  }
  return {
    endpoint: "create",
    payload: {
      consumerResourceId: resourceId,
      consumerFieldKey: fieldKey,
      providerResourceId: choice.providerResourceId,
      providerOutputKey: choice.providerOutputKey,
      providerPluginId: choice.providerPluginId,
      providerResourceTypeId: choice.providerResourceTypeId,
      providerAccountId: choice.providerAccountId,
    },
  };
}
