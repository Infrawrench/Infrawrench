/**
 * Response shapes and lookups shared by the agent link routes: the
 * link-authenticated `/api/agent-link` tree a platform drives, and the org
 * tree Settings → Agents reads. One builder per shape so the platform and the
 * settings page can never describe the same link differently.
 */
import { eq } from "drizzle-orm";
import { agentScopeGroups } from "@infrawrench/ui/settings/api-key-scopes";
import {
  linkEffectiveScopes,
  organizationName,
  userEmail,
  type AgentLinkRow,
  type PlatformAgentRow,
} from "@infrawrench/server-core/agent-links/links";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { getPlugin, loadPlugins } from "../plugins/loader";

export interface LinkProvider {
  id: string;
  displayName: string;
}

/**
 * Plugins the org has at least one connected account for, so a platform can
 * offer "only these providers". Display names from the plugin manifests; a
 * plugin no longer bundled still lists, under its id.
 */
export async function connectedProviders(organizationId: string): Promise<LinkProvider[]> {
  const rows = await db
    .selectDistinct({ pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));
  const out: LinkProvider[] = [];
  for (const { pluginId } of rows) {
    const loaded = await getPlugin(pluginId);
    out.push({ id: pluginId, displayName: loaded?.plugin.manifest.displayName ?? pluginId });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Provider ids that name a bundled plugin. Anything else is a 400. */
export async function unknownProviders(providers: readonly string[]): Promise<string[]> {
  if (providers.length === 0) return [];
  const known = new Set((await loadPlugins()).map((p) => p.plugin.manifest.id));
  return providers.filter((p) => !known.has(p));
}

/** The contract's `LinkInfo`. */
export async function buildLinkInfo(link: AgentLinkRow) {
  const [effectiveScopes, name, approverEmail, providers] = await Promise.all([
    linkEffectiveScopes(link),
    organizationName(link.organizationId),
    userEmail(link.approvedByUserId),
    connectedProviders(link.organizationId),
  ]);
  return {
    id: link.id,
    organizationId: link.organizationId,
    organizationName: name ?? "",
    platform: link.platform,
    label: link.label,
    scopes: link.scopes,
    effectiveScopes,
    scopeGroups: agentScopeGroups(effectiveScopes).map((group) => ({
      title: group.title,
      scopes: group.scopes.map((s) => ({ value: s.value, label: s.label })),
    })),
    providers,
    approvedBy: approverEmail ? { email: approverEmail } : null,
    createdAt: link.createdAt.toISOString(),
  };
}

/** The org tree's view of a link: `LinkInfo` plus its own status fields. */
export async function buildOrgLinkSummary(link: AgentLinkRow) {
  return {
    ...(await buildLinkInfo(link)),
    credentialPrefix: link.credentialPrefix,
    lastSeenAt: link.lastSeenAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
  };
}

/** The contract's `Agent`. */
export function serializeAgent(row: PlatformAgentRow) {
  return {
    id: row.id,
    externalId: row.externalId ?? "",
    label: row.label ?? "",
    scopes: row.scopes ?? [],
    providers: row.providers ?? [],
    credentialPrefix: row.credentialPrefix,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
