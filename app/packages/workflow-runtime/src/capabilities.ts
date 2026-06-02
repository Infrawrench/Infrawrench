/**
 * Derives the per-resource-type capability flags that gate the generated
 * `infra.d.ts`, so each resource type only advertises the methods it supports
 * (a droplet doesn't offer `.nosql`/`.logs`, a DNS record doesn't offer `.ssh`).
 *
 * Two sources:
 *  - {@link staticResourceCapabilities} reads the resource type definition
 *    (sshEndpoint/supportsTerminal → ssh) — cheap, no client.
 *  - {@link detailResourceCapabilities} calls the plugin's `renderDetail` on a
 *    synthetic instance of that type and reads which capability tabs the
 *    DetailViewSchema declares (`logs`, `kvBrowser`, `noSqlBrowser`, … — exactly
 *    what the UI shows). This is per-type accurate and needs no API call.
 */
import type {
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";

import type { WorkflowResourceCapabilities } from "./types.js";

/** Capability flags knowable from the resource type definition alone. */
export function staticResourceCapabilities(
  rt: ResourceTypeDefinition,
): WorkflowResourceCapabilities {
  // SFTP runs over SSH, so it's available wherever a resource is SSH-reachable
  // (an sshEndpoint or a terminal), plus any type that declares the SFTP browser.
  const sshable = Boolean(rt.sshEndpoint || rt.supportsTerminal);
  return {
    ssh: sshable,
    sftp: sshable || Boolean(rt.supportsSftpBrowser),
  };
}

/**
 * Per-type capability flags, read from the DetailViewSchema the plugin would
 * render for this resource type. Uses a synthetic (empty) instance — the tab
 * declarations (`sqlEditor`, `kvBrowser`, …) depend on the type, not the field
 * values. Best-effort: if `renderDetail` throws on the probe, returns {}.
 */
export function detailResourceCapabilities(
  client: PluginClient,
  pluginId: string,
  typeId: string,
  accountId: string,
): WorkflowResourceCapabilities {
  const probe: ResourceInstance = {
    id: `${accountId}:${typeId}:__probe__`,
    pluginId,
    resourceTypeId: typeId,
    accountId,
    displayName: "",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "__probe__",
    createdAt: "",
    updatedAt: "",
  };
  let schema;
  try {
    schema = client.renderDetail(probe);
  } catch {
    return {};
  }
  return {
    // `query` is backed by executeQuery (REST engines); only offer it where the
    // plugin can actually run a query, not for driver-based managed DBs.
    sql: Boolean(schema.sqlEditor) && typeof client.executeQuery === "function",
    kv: Boolean(schema.kvBrowser),
    nosql: Boolean(schema.noSqlBrowser),
    logs: Boolean(schema.logs),
    describe: Boolean(schema.describe),
    manifest: Boolean(schema.manifestEditor),
    publish: Boolean(schema.publishPanel),
    metrics: Boolean(schema.metricsCapability),
  };
}

export function clientSupportsImportYaml(client: PluginClient): boolean {
  return typeof client.importYaml === "function";
}

/** OR two capability sets together (true wins). */
export function mergeCapabilities(
  a: WorkflowResourceCapabilities | undefined,
  b: WorkflowResourceCapabilities | undefined,
): WorkflowResourceCapabilities {
  const out: WorkflowResourceCapabilities = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v) out[k as keyof WorkflowResourceCapabilities] = true;
  }
  return out;
}
