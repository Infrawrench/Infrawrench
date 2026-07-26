/**
 * Sidecars: the peer plugins a resource exposes rather than the ones an account
 * connects. A managed Kubernetes cluster (DOKS, EKS, GKE, AKS, Kapsule, …)
 * exposes the `kubernetes` plugin through its kubeconfig; a managed database
 * exposes `postgres` / `mysql` / `redis` / `mongodb` through its connection
 * string. Both live in the resource type's `peerIntegrations`.
 *
 * The resource-detail UI has always rendered these as tabs and the MCP tools
 * have always reached them via `parentResourceId`, but workflows could not:
 * nothing in `infra.d.ts` mentioned them, so the only way to discover the gap
 * was to guess an accessor, watch it come back `undefined`, and guess again.
 * {@link attachSidecarInfo} puts them in the accounts tree, from which codegen
 * types them and the prelude builds them.
 */
import type { Plugin, PluginClient, ResourceTypeDefinition } from "@infrawrench/plugin-base";

import { detailResourceCapabilities, mergeCapabilities } from "./capabilities.js";
import type {
  WorkflowResourceCapabilities,
  WorkflowResourceTypeInfo,
  WorkflowSidecarInfo,
} from "./types.js";

/**
 * Fill in `sidecars` on each resource-type info from its plugin definition's
 * `peerIntegrations`, resolving each peer plugin for its resource types.
 * Mutates `infos` in place; types with no peer integrations are left untouched.
 *
 * `infos` and `defs` are matched by type id, so the caller can pass its already
 * mapped infos alongside the plugin's raw definitions in any order.
 */
export async function attachSidecarInfo(
  infos: WorkflowResourceTypeInfo[],
  defs: readonly ResourceTypeDefinition[],
  resolvePlugin: (pluginId: string) => Promise<Plugin | undefined>,
): Promise<void> {
  const defById = new Map(defs.map((d) => [d.id, d]));
  await Promise.all(
    infos.map(async (info) => {
      const integrations = defById.get(info.id)?.peerIntegrations ?? [];
      if (integrations.length === 0) return;
      const sidecars: WorkflowSidecarInfo[] = [];
      for (const integration of integrations) {
        const peer = await resolvePlugin(integration.pluginId).catch(() => undefined);
        if (!peer || peer.resourceTypes.length === 0) continue;
        sidecars.push({
          pluginId: integration.pluginId,
          displayName: peer.manifest.displayName,
          tabLabel: integration.tabLabel,
          resourceTypes: peer.resourceTypes.map(peerResourceTypeInfo),
        });
      }
      if (sidecars.length > 0) info.sidecars = sidecars;
    }),
  );
}

/**
 * One peer resource type, as reached through a parent.
 *
 * Deliberately starts with no capabilities rather than
 * `staticResourceCapabilities`: the static flags are `ssh`/`sftp`, and both
 * resolve against the account's own plugin (an SSH endpoint on the resource
 * type, a key on the account), which nothing inside somebody else's cluster
 * has. Storage is left off for the same reason — a bucket name comes from the
 * account's plugin. The real flags (logs, describe, manifest, …) arrive from
 * {@link enrichSidecarCapabilities} on the typings path.
 */
function peerResourceTypeInfo(rt: ResourceTypeDefinition): WorkflowResourceTypeInfo {
  return {
    id: rt.id,
    displayName: rt.displayName,
    pluralDisplayName: rt.pluralDisplayName,
    outputs: (rt.outputs ?? []).map((o) => ({ key: o.key, label: o.label })),
    supportsCreate: Boolean(rt.supportsCreate),
    supportsUpdate: Boolean(rt.supportsUpdate),
    // supportsDelete defaults to true (only `false` disables deletion).
    supportsDelete: rt.supportsDelete !== false,
    capabilities: {},
  };
}

/** How long a probed peer plugin's capabilities stay good for. */
const TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  at: number;
  /** null = the probe failed; don't retype and don't keep retrying hard. */
  caps: Record<string, WorkflowResourceCapabilities> | null;
}

/**
 * Keyed by peer plugin id alone, deliberately: a plugin's capabilities come
 * from the DetailViewSchema it renders for a type, which depends on neither the
 * account nor the parent. One probe of one cluster describes `kubernetes`
 * everywhere, for every org.
 */
const capsCache = new Map<string, CacheEntry>();

export interface SidecarCapabilityProbe {
  /** List resources of the parent type, to find one to reach the peer through. */
  listParents(parentTypeId: string): Promise<{ id: string }[]>;
  /** Build the peer plugin's client using that parent's credentials. */
  peerClient(pluginId: string, parentResourceId: string): Promise<PluginClient>;
}

/**
 * Fill in a parent type's sidecar capability flags, so `infra.d.ts` types
 * `pod.logs()` / `pod.describe()` rather than leaving a workflow to discover
 * them by runtime trial and error.
 *
 * This costs one `listResources` on the parent type plus one peer-client build,
 * so it runs on the typings path only (never per run) and caches per peer
 * plugin. Strictly best-effort: an unreachable cluster or a provider hiccup
 * leaves the static flags in place rather than failing the typings.
 */
export async function enrichSidecarCapabilities(
  parent: WorkflowResourceTypeInfo,
  accountId: string,
  probe: SidecarCapabilityProbe,
): Promise<void> {
  const sidecars = parent.sidecars ?? [];
  if (sidecars.length === 0) return;

  const now = Date.now();
  const fresh = (pluginId: string): CacheEntry | undefined => {
    const hit = capsCache.get(pluginId);
    return hit && now - hit.at <= TTL_MS ? hit : undefined;
  };

  const apply = (sc: WorkflowSidecarInfo, caps: Record<string, WorkflowResourceCapabilities>) => {
    for (const rt of sc.resourceTypes) {
      rt.capabilities = mergeCapabilities(rt.capabilities, caps[rt.id]);
    }
  };

  // Serve what's cached (including cached failures) before touching a provider.
  const unknown: WorkflowSidecarInfo[] = [];
  for (const sc of sidecars) {
    const hit = fresh(sc.pluginId);
    if (!hit) unknown.push(sc);
    else if (hit.caps) apply(sc, hit.caps);
  }
  if (unknown.length === 0) return;

  let parentResourceId: string | undefined;
  try {
    parentResourceId = (await probe.listParents(parent.id))[0]?.id;
  } catch {
    return;
  }
  // No cluster/database of this type exists yet. Not a failure worth caching —
  // the first one created should get typed capabilities immediately.
  if (!parentResourceId) return;

  for (const sc of unknown) {
    let caps: Record<string, WorkflowResourceCapabilities> | null = null;
    try {
      const client = await probe.peerClient(sc.pluginId, parentResourceId);
      caps = {};
      for (const rt of sc.resourceTypes) {
        caps[rt.id] = detailResourceCapabilities(client, sc.pluginId, rt.id, accountId);
      }
    } catch {
      caps = null;
    }
    capsCache.set(sc.pluginId, { at: now, caps });
    if (caps) apply(sc, caps);
  }
}
