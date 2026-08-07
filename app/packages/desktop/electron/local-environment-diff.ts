/**
 * Local-mode environment diff for the CLI.
 *
 * The cloud path (`GET /api/org/:orgId/environment-diff`) compares two
 * accounts' already-synced rows server-side. This is the same computation —
 * client-core's `computeEnvironmentDiff` — run against two of the desktop's
 * local accounts, so `infrawrench diff --local` works signed out.
 *
 * The inventories come from the *provider*, not from a table: the desktop's
 * local `resources` table only holds what the app created or pinned, so a
 * local diff enumerates both accounts through the plugin the way
 * `infrawrench resources` does. A resource type whose list fails is excluded
 * from the comparison rather than reported as absent — "we couldn't ask" and
 * "prod doesn't have one" are opposite answers.
 *
 * The renderer has its own twin (src/lib/local-environment-diff.ts) because
 * the GUI's DB access goes over IPC; this one exists for the CLI, which has no
 * renderer.
 *
 * The `computeEnvironmentDiff` import is dynamic because this module graph is
 * CommonJS and client-core ships ESM (the same CJS→ESM bridge as
 * local-posture.ts); electron-vite bundles it into the main chunk, so it
 * resolves at build time rather than being a runtime hop.
 *
 * No GUI side effects (no `ipcMain` import), per the rule in CLAUDE.md that
 * keeps electron/db.ts and its consumers importable from electron/cli/*.
 */
import type {
  EnvironmentDiffResponse,
  EnvironmentDiffUnavailableType,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { listAccountResourcesLive } from "./plugin-runtime";
import { loadPlugins } from "../src/plugins/loader";

export interface LocalDiffAccount {
  id: string;
  pluginId: string;
  displayName: string;
}

/**
 * Compare two local accounts. Both must belong to the same plugin; the shared
 * computation refuses the pair otherwise, and the caller turns that into a
 * one-line CLI error.
 */
export async function computeLocalEnvironmentDiff(
  accountA: LocalDiffAccount,
  accountB: LocalDiffAccount,
  options: { resourceTypeId?: string | undefined; includeIdentityFields?: boolean } = {},
): Promise<EnvironmentDiffResponse> {
  const [plugins, { computeEnvironmentDiff }] = await Promise.all([
    loadPlugins(),
    import("@infrawrench/client-core"),
  ]);
  const loaded = plugins.find(({ plugin }) => plugin.manifest.id === accountA.pluginId);
  const resourceTypeNames: Record<string, string> = {};
  for (const type of loaded?.plugin.resourceTypes ?? []) {
    resourceTypeNames[type.id] = type.displayName;
  }

  const listOptions = options.resourceTypeId ? { typeId: options.resourceTypeId } : {};
  const [listedA, listedB] = await Promise.all([
    listAccountResourcesLive(accountA, listOptions),
    listAccountResourcesLive(accountB, listOptions),
  ]);

  // A type that failed on *either* side can't be compared on either.
  const unavailableTypes: EnvironmentDiffUnavailableType[] = [];
  const seen = new Set<string>();
  for (const failure of [...listedA.errors, ...listedB.errors]) {
    if (seen.has(failure.typeId)) continue;
    seen.add(failure.typeId);
    unavailableTypes.push({
      resourceTypeId: failure.typeId,
      resourceTypeName: resourceTypeNames[failure.typeId] ?? failure.typeId,
      message: failure.message,
    });
  }

  const side = (
    account: LocalDiffAccount,
    listed: Awaited<ReturnType<typeof listAccountResourcesLive>>,
  ) => ({
    accountId: account.id,
    accountName: account.displayName,
    pluginId: account.pluginId,
    // `listResources` leaves outputs empty by contract, so a local diff
    // compares stored fields only — resolving outputs would mean a call per
    // resource on both sides.
    resources: listed.resources.map((r) => ({
      id: r.id,
      resourceTypeId: r.resourceTypeId,
      displayName: r.displayName,
      externalId: r.externalId ?? null,
      fields: r.fields,
    })),
  });

  return computeEnvironmentDiff({
    a: side(accountA, listedA),
    b: side(accountB, listedB),
    pluginName: loaded?.plugin.manifest.displayName ?? accountA.pluginId,
    resourceTypeNames,
    unavailableTypes,
    ...(options.resourceTypeId ? { resourceTypeId: options.resourceTypeId } : {}),
    ...(options.includeIdentityFields ? { includeIdentityFields: true } : {}),
  });
}
