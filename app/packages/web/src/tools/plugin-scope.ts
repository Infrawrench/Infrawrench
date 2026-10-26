/**
 * Which providers a tool call touches, for principals whose permissions are
 * narrowed to some providers (`resources:aws:read` rather than
 * `resources:read`; see `server-core/agent-links/scopes.ts`).
 *
 * Tools declare an unsegmented permission (`resources:read`), mirroring the
 * HTTP route. A narrowed grant can only be honoured once the call is pinned to
 * a provider, so the gate reads every identifier the input carries that names
 * one: a plugin id directly, an account (whose plugin is a column), or a
 * synced resource (likewise). **Every** provider found must be allowed; a sidecar
 * call (a Kubernetes resource inside an EKS cluster) names two and needs both.
 * A call that names none cannot be bound and is refused, which is what keeps a
 * cross-provider tool like `search_resources` from reading everything.
 *
 * Only consulted when the unsegmented check has already failed, so it costs
 * nothing for people, API keys and unnarrowed agents.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import type { ToolDefinition } from "./types";

/** Input keys whose value is a plugin id. */
const PLUGIN_ID_KEYS = ["pluginId", "sourcePluginId", "referencePluginId"] as const;
/** Input keys whose value is an array of plugin ids. */
const PLUGIN_IDS_KEYS = ["pluginIds"] as const;
/** Input keys whose value is one of the org's account ids. */
const ACCOUNT_ID_KEYS = ["accountId", "sourceAccountId"] as const;
/**
 * Input keys whose value may be a synced resource's id. Some tools take a
 * provider's own id here instead; one that matches no synced row simply adds
 * nothing, and the call still has to be pinned by another key.
 */
const RESOURCE_ID_KEYS = [
  "resourceId",
  "parentResourceId",
  "sourceResourceId",
  "targetResourceId",
] as const;

const ALL_KEYS: readonly string[] = [
  ...PLUGIN_ID_KEYS,
  ...PLUGIN_IDS_KEYS,
  ...ACCOUNT_ID_KEYS,
  ...RESOURCE_ID_KEYS,
];

/**
 * Whether calls to this tool can ever be pinned to a provider: it has a fixed
 * plugin, or its input schema carries one of the identifying keys. A tool that
 * cannot is unusable by a narrowed principal, so it is not listed to one.
 */
export function toolCanNamePlugin(tool: Pick<ToolDefinition, "inputSchema" | "pluginId">): boolean {
  if (tool.pluginId) return true;
  return Object.keys(tool.inputSchema).some((key) => ALL_KEYS.includes(key));
}

function strings(value: unknown): string[] {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string" && v !== "");
  return [];
}

export type CallPlugins = { ok: true; plugins: string[] } | { ok: false; reason: string };

/** The providers one call touches, or why it cannot be told. */
export async function pluginsForCall(
  tool: Pick<ToolDefinition, "pluginId">,
  input: Record<string, unknown>,
  organizationId: string,
): Promise<CallPlugins> {
  const plugins = new Set<string>();
  if (tool.pluginId) plugins.add(tool.pluginId);
  for (const key of PLUGIN_ID_KEYS) for (const v of strings(input[key])) plugins.add(v);
  for (const key of PLUGIN_IDS_KEYS) for (const v of strings(input[key])) plugins.add(v);

  const accountIds = [...new Set(ACCOUNT_ID_KEYS.flatMap((key) => strings(input[key])))];
  if (accountIds.length > 0) {
    const rows = await db
      .select({ id: accounts.id, pluginId: accounts.pluginId })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)));
    // An account id that is not this org's cannot be vouched for. The handler
    // would refuse it too, but the gate must not let it pass on the strength
    // of some other key naming an allowed provider.
    if (rows.length !== accountIds.length) {
      return { ok: false, reason: "That account is not in this organization." };
    }
    for (const row of rows) plugins.add(row.pluginId);
  }

  const resourceIds = [...new Set(RESOURCE_ID_KEYS.flatMap((key) => strings(input[key])))];
  if (resourceIds.length > 0) {
    const rows = await db
      .select({ pluginId: resources.pluginId })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds)));
    for (const row of rows) plugins.add(row.pluginId);
  }

  if (plugins.size === 0) {
    return {
      ok: false,
      reason:
        "This credential is limited to some providers, so the call must name one " +
        "(pass pluginId, accountId or a resource id).",
    };
  }
  return { ok: true, plugins: [...plugins] };
}
