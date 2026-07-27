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
/** How long to wait after a failed probe before trying the provider again. */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;

interface CacheEntry {
  /**
   * Last capabilities we successfully learned, kept even once stale.
   *
   * A probe reaches a live provider (fetch a cluster's kubeconfig, build the
   * peer client), so it fails for reasons that say nothing about what the
   * plugin can do: a rate limit, a timeout, a cluster mid-upgrade. Dropping the
   * flags on such a failure silently deletes `pod.logs()` from `infra.d.ts`, and
   * the author's already-working workflow stops type-checking with a message
   * that reads like the method never existed. So a failure never erases a
   * success — it only schedules a retry.
   */
  caps: Record<string, WorkflowResourceCapabilities> | null;
  /** When `caps` was learned (drives {@link TTL_MS}). */
  at: number;
  /** When the last probe failed (drives {@link RETRY_AFTER_FAILURE_MS}). */
  failedAt?: number;
}

/**
 * Keyed by peer plugin id alone, deliberately: a plugin's capabilities come
 * from the DetailViewSchema it renders for a type, which depends on neither the
 * account nor the parent. One probe of one cluster describes `kubernetes`
 * everywhere, for every org.
 */
const capsCache = new Map<string, CacheEntry>();

/** Test seam: forget every memoized capability set. */
export function __resetSidecarCapabilityCache(): void {
  capsCache.clear();
}

export interface SidecarCapabilityProbe {
  /** List resources of a parent type in one account, to reach the peer through. */
  listParents(parentTypeId: string, accountId: string): Promise<{ id: string }[]>;
  /** Build the peer plugin's client using that parent's credentials. */
  peerClient(pluginId: string, parentResourceId: string, accountId: string): Promise<PluginClient>;
}

/**
 * Fill in sidecar capability flags across a plugin's parent types, so
 * `infra.d.ts` types `pod.logs()` / `pod.describe()` rather than leaving a
 * workflow to discover them by runtime trial and error.
 *
 * Takes **every** parent type at once rather than one at a time, because a peer
 * plugin is usually reachable through several of them (`kubernetes` hangs off
 * both a GKE and a DOKS cluster) and the answer cannot differ between them. One
 * grouped pass means exactly one provider round-trip per peer plugin, instead
 * of N concurrent ones racing each other into a rate limit — and it means the
 * result no longer depends on which parent type happened to be probed first,
 * which is what made `pod.logs()` appear and disappear between edits.
 *
 * `accountIds` are every account of the plugin, tried in order: the first
 * account is not necessarily the one that owns a cluster.
 *
 * Runs on the typings path only (never per run) and caches per peer plugin.
 * Best-effort — but see {@link CacheEntry.caps} for why "best-effort" must not
 * mean "forget what we already knew".
 */
export async function enrichSidecarCapabilities(
  parents: readonly WorkflowResourceTypeInfo[],
  accountIds: readonly string[],
  probe: SidecarCapabilityProbe,
): Promise<void> {
  if (accountIds.length === 0) return;

  // Every parent type that exposes a given peer plugin, so one probe's result
  // lands on all of them.
  const byPeer = new Map<string, { sidecars: WorkflowSidecarInfo[]; parentTypeIds: string[] }>();
  for (const parent of parents) {
    for (const sc of parent.sidecars ?? []) {
      let group = byPeer.get(sc.pluginId);
      if (!group) byPeer.set(sc.pluginId, (group = { sidecars: [], parentTypeIds: [] }));
      group.sidecars.push(sc);
      group.parentTypeIds.push(parent.id);
    }
  }
  if (byPeer.size === 0) return;

  const now = Date.now();
  const apply = (
    sidecars: WorkflowSidecarInfo[],
    caps: Record<string, WorkflowResourceCapabilities>,
  ) => {
    for (const sc of sidecars) {
      for (const rt of sc.resourceTypes) {
        rt.capabilities = mergeCapabilities(rt.capabilities, caps[rt.id]);
      }
    }
  };

  await Promise.all(
    Array.from(byPeer, async ([pluginId, group]) => {
      const hit = capsCache.get(pluginId);
      // Apply what we already know first. A stale entry still beats nothing, so
      // a probe that then fails degrades to slightly-old flags, not no flags.
      if (hit?.caps) apply(group.sidecars, hit.caps);
      const usable = hit?.caps && now - hit.at <= TTL_MS;
      const backingOff = hit?.failedAt !== undefined && now - hit.failedAt < RETRY_AFTER_FAILURE_MS;
      if (usable || backingOff) return;

      const entry: CacheEntry = hit ?? { caps: null, at: 0 };
      capsCache.set(pluginId, entry);

      try {
        // One live parent is enough, wherever it lives.
        let found: { id: string; accountId: string } | null = null;
        outer: for (const parentTypeId of group.parentTypeIds) {
          for (const accountId of accountIds) {
            const rows = await probe.listParents(parentTypeId, accountId).catch(() => []);
            if (rows[0]) {
              found = { id: rows[0].id, accountId };
              break outer;
            }
          }
        }
        // No cluster/database exists yet. Not a failure worth backing off from —
        // the first one created should get typed capabilities immediately.
        if (!found) return;

        const client = await probe.peerClient(pluginId, found.id, found.accountId);
        const caps: Record<string, WorkflowResourceCapabilities> = {};
        for (const sc of group.sidecars) {
          for (const rt of sc.resourceTypes) {
            caps[rt.id] = detailResourceCapabilities(client, pluginId, rt.id, found.accountId);
          }
        }
        entry.caps = caps;
        entry.at = Date.now();
        delete entry.failedAt;
        apply(group.sidecars, caps);
      } catch {
        // Keep whatever `entry.caps` already held; just don't hammer the
        // provider again for a little while.
        entry.failedAt = Date.now();
      }
    }),
  );
}
