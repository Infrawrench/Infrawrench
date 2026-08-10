/**
 * Sidecar log-stream discovery — the shared half of finding tailable streams
 * that live *behind* a peer integration rather than in the resource table.
 *
 * A managed Kubernetes cluster's pods are never stored rows: they surface
 * through the cluster's `kubernetes` peer integration. The native discovery
 * scan (stored rows × `renderDetail`) therefore can't see them, even though
 * the kubernetes plugin fully supports `getLogs`. This module walks stored
 * parent resources, builds each peer plugin's client through the host's own
 * resolution path, and lists the peer resources whose rendered detail declares
 * the `logs` capability — the same per-instance contract the native scan uses,
 * never a hardcoded provider list.
 *
 * Pure orchestration: data access (stored rows, peer-client construction) is
 * injected, so the web service (server-core clients) and desktop local mode
 * (in-renderer clients) share the walk, the capability cache, and the
 * fail-soft rules.
 */
// Type-only on purpose — client-core keeps zero runtime dependency on
// plugin-base (the mobile bundle never pulls the manifest machinery in).
import type {
  PeerPluginIntegration,
  PluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";

/** A stored parent resource that may expose peer log streams. */
export interface SidecarLogParent {
  accountId: string;
  accountName: string;
  /** Stored row id — becomes `parentResourceId` on emitted streams. */
  resourceId: string;
  displayName: string;
  /** The parent row's stored fields — drive the integrations' visibility gates. */
  fields: Record<string, string | number | boolean>;
  /** The parent resource type's declared peer integrations. */
  integrations: PeerPluginIntegration[];
}

/** One discovered sidecar stream, shaped like the picker's option rows. */
export interface SidecarLogStream {
  resourceId: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  parentResourceId: string;
  parentDisplayName: string;
}

export interface SidecarLogDiscoveryDeps {
  /**
   * Build the peer plugin's client through this parent (resolve outputs, run
   * rewriters where the host has them). Null when the peer plugin isn't
   * registered; throwing is treated the same as unreachable.
   */
  getPeerClient(parent: SidecarLogParent, pluginId: string): Promise<PluginClient | null>;
  /** The peer plugin's resource type ids, from its loaded definition. */
  peerResourceTypeIds(pluginId: string): Promise<string[]>;
  /** Discovery is best-effort but never silent — failures land here. */
  warn(message: string): void;
  /** Stop emitting once this many streams have been collected. */
  maxResults: number;
  /** Per-parent wall-clock budget; a hung provider can't stall the picker. */
  parentTimeoutMs?: number;
  /** Test seam. */
  now?: () => number;
}

/**
 * Apply a peer integration's declarative visibility gates (`requiresFields` /
 * `showWhen`) against a parent's stored fields — the same rules the detail
 * view uses to decide which peer tabs appear.
 */
export function peerIntegrationVisible(
  integration: PeerPluginIntegration,
  fields: Record<string, unknown> | undefined,
): boolean {
  const f = fields ?? {};
  if (integration.requiresFields) {
    for (const key of integration.requiresFields) {
      const v = f[key];
      if (v == null || v === "") return false;
    }
  }
  if (integration.unreachableWhen) {
    // Provider-declared "can't actually connect" (private-IP-only endpoints):
    // the detail view shows a guidance pane instead of spawning the peer, so
    // discovery must not offer streams the fetch path could never serve.
    const allEmpty = integration.unreachableWhen.fieldsEmpty.every((key) => {
      const v = f[key];
      return v == null || v === "";
    });
    if (allEmpty) return false;
  }
  if (!integration.showWhen) return true;
  const v = f[integration.showWhen.fieldKey];
  if (v == null || v === "") return false;
  const s = String(v);
  if (integration.showWhen.equals != null) return s === integration.showWhen.equals;
  if (integration.showWhen.prefix != null) return s.startsWith(integration.showWhen.prefix);
  return Boolean(v);
}

/** How long a probed peer plugin's log-capable type set stays good for. */
const CAPS_TTL_MS = 10 * 60 * 1000;
/** How long to wait after a failed peer build before trying that plugin again. */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
const DEFAULT_PARENT_TIMEOUT_MS = 10_000;

interface PeerLogCapsEntry {
  /**
   * Peer resource type ids whose rendered detail declares `logs`; `[]` means
   * the plugin is known log-incapable (no `getLogs`, or no log-capable types)
   * and its parents are skipped without building a client. Kept once learned —
   * a peer build reaches a live provider, so a later failure says nothing
   * about what the plugin can do (the sidecar-capabilities rule).
   */
  logTypeIds: string[];
  at: number;
}

/**
 * Keyed by peer plugin id alone, deliberately: which of a plugin's types
 * declare logs comes from the DetailViewSchema it renders per type, which
 * depends on neither the account nor the parent. One probe of one cluster
 * describes `kubernetes` everywhere. The practical win: managed-database
 * parents never rebuild a `postgres` client on every picker load just to
 * rediscover it has no `getLogs`.
 */
const peerLogCapsCache = new Map<string, PeerLogCapsEntry>();

/**
 * Build-failure backoff, keyed per (parent, plugin) — NOT per plugin: peer
 * credentials come from the parent's outputs, so one cluster's kubeconfig
 * fetch failing says nothing about the org's other clusters, and a shared
 * backoff would hide their streams for no reason.
 */
const peerBuildFailures = new Map<string, number>();

/** Test seam: forget every memoized log-capability set and failure. */
export function __resetPeerLogCapabilityCache(): void {
  peerLogCapsCache.clear();
  peerBuildFailures.clear();
}

/** `renderDetail` probe on a synthetic instance — does this type declare logs? */
function typeDeclaresLogs(
  client: PluginClient,
  pluginId: string,
  typeId: string,
  accountId: string,
): boolean {
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
  try {
    return Boolean(client.renderDetail(probe).logs);
  } catch {
    return false;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Set when a parent's time budget expires. `discoverParent` keeps running
 * after the timeout rejection (a promise can't be cancelled), so it checks
 * this at every loop boundary to stop mutating the shared result array.
 */
interface AbortFlag {
  aborted: boolean;
}

/** Walk one parent's visible integrations and collect its tailable peer streams. */
async function discoverParent(
  parent: SidecarLogParent,
  deps: SidecarLogDiscoveryDeps,
  out: SidecarLogStream[],
  ctl: AbortFlag,
): Promise<void> {
  const now = deps.now ?? Date.now;
  for (const integration of parent.integrations) {
    if (ctl.aborted || out.length >= deps.maxResults) return;
    if (!peerIntegrationVisible(integration, parent.fields)) continue;

    const cached = peerLogCapsCache.get(integration.pluginId);
    const fresh = cached !== undefined && now() - cached.at <= CAPS_TTL_MS;
    if (fresh && cached.logTypeIds.length === 0) continue; // known log-incapable

    const failureKey = `${parent.resourceId}:${integration.pluginId}`;
    const failedAt = peerBuildFailures.get(failureKey);
    if (failedAt !== undefined && now() - failedAt < RETRY_AFTER_FAILURE_MS) continue;

    let client: PluginClient | null;
    try {
      client = await deps.getPeerClient(parent, integration.pluginId);
      if (ctl.aborted) return;
    } catch (e) {
      peerBuildFailures.set(failureKey, now());
      deps.warn(
        `sidecar discovery: peer ${integration.pluginId} via ${parent.displayName} unreachable: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      continue;
    }
    if (!client) continue;
    peerBuildFailures.delete(failureKey);

    let logTypeIds: string[];
    if (fresh) {
      logTypeIds = cached.logTypeIds;
    } else {
      logTypeIds = !client.getLogs
        ? []
        : (await deps.peerResourceTypeIds(integration.pluginId)).filter((typeId) =>
            typeDeclaresLogs(client, integration.pluginId, typeId, parent.accountId),
          );
      peerLogCapsCache.set(integration.pluginId, { logTypeIds, at: now() });
    }
    if (logTypeIds.length === 0) continue;

    for (const typeId of logTypeIds) {
      if (ctl.aborted || out.length >= deps.maxResults) return;
      let rows: ResourceInstance[];
      try {
        rows = await client.listResources(typeId, parent.accountId);
        if (ctl.aborted) return;
      } catch (e) {
        deps.warn(
          `sidecar discovery: listing ${integration.pluginId}/${typeId} in ${parent.displayName} failed: ` +
            (e instanceof Error ? e.message : String(e)),
        );
        continue;
      }
      for (const row of rows) {
        if (ctl.aborted || out.length >= deps.maxResults) return;
        // Per-instance check, like the native scan: the capability lives on
        // the rendered schema, and a plugin may declare it conditionally.
        let hasLogs = false;
        try {
          hasLogs = Boolean(client.renderDetail(row).logs);
        } catch {
          continue;
        }
        if (!hasLogs) continue;
        out.push({
          resourceId: row.id,
          accountId: parent.accountId,
          accountName: parent.accountName,
          pluginId: integration.pluginId,
          resourceTypeId: typeId,
          displayName: row.displayName,
          parentResourceId: parent.resourceId,
          parentDisplayName: parent.displayName,
        });
      }
    }
  }
}

/**
 * Discover every tailable sidecar stream reachable from the given parents.
 * Best-effort and bounded: each parent gets a wall-clock budget, one broken
 * or slow parent never hides the others' streams, and every skip is reported
 * through `deps.warn`.
 */
export async function discoverSidecarLogStreams(
  parents: SidecarLogParent[],
  deps: SidecarLogDiscoveryDeps,
): Promise<SidecarLogStream[]> {
  const out: SidecarLogStream[] = [];
  const timeoutMs = deps.parentTimeoutMs ?? DEFAULT_PARENT_TIMEOUT_MS;
  for (const parent of parents) {
    if (out.length >= deps.maxResults) break;
    if (parent.integrations.length === 0) continue;
    const ctl: AbortFlag = { aborted: false };
    try {
      await withTimeout(
        discoverParent(parent, deps, out, ctl),
        timeoutMs,
        `sidecar discovery for ${parent.displayName}`,
      );
    } catch (e) {
      ctl.aborted = true;
      deps.warn(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
