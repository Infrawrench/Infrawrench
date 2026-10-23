/**
 * Provider narrowing for agent permissions.
 *
 * A platform agent can be confined to some providers: "this nibblet may read
 * resources, but only in AWS". The catalog's permissions are written without a
 * plugin segment (`resources:read`), and the narrowed form puts one in the
 * middle (`resources:aws:read`), which is the shape `hasPermission` already
 * matches segment by segment and the one custom roles have always been able to
 * write.
 *
 * What makes this safe is which way the matcher fails. Every HTTP route and
 * every tool asks for the unsegmented string, and `hasPermission` compares
 * segment counts first, so a principal holding only `resources:aws:read` is
 * refused `resources:read` everywhere it is asked without a plugin in hand.
 * The places that *can* name the plugin (the MCP tool gate, see
 * `web/src/tools/permissions.ts`) ask {@link holdsForPlugin} instead, which is
 * the only way a narrowed grant is ever honoured. A surface that forgets to is
 * closed to narrowed agents, never open to them.
 *
 * Pure and dependency-free apart from the catalog, so the web layer and tests
 * can use it without a database.
 */
import { hasPermission } from "../permissions/catalog.js";

/**
 * Permission families whose objects belong to one provider, and so can carry a
 * plugin segment. Everything else (costs, dashboards, workflows, team) is
 * org-wide and is left untouched by narrowing.
 */
export const PROVIDER_SCOPED_FAMILIES: readonly string[] = ["resources", "secrets", "storage"];

/** `resources:read` → `["resources", "read"]`, or null if not provider-scoped. */
function splitScoped(permission: string): [family: string, verb: string] | null {
  const parts = permission.split(":");
  if (parts.length !== 2) return null;
  const [family, verb] = parts as [string, string];
  return PROVIDER_SCOPED_FAMILIES.includes(family) ? [family, verb] : null;
}

/** Whether `permission` is one narrowing rewrites (two segments, scoped family). */
export function isProviderScoped(permission: string): boolean {
  return splitScoped(permission) !== null;
}

/** Plugin ids are slugs; anything else would smuggle a segment into a permission. */
const PLUGIN_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_SHAPE.test(id);
}

/**
 * Rewrite every provider-scoped permission into one per provider.
 *
 * `narrowToProviders(["resources:read", "costs:read"], ["aws", "gcp"])` is
 * `["resources:aws:read", "resources:gcp:read", "costs:read"]`. An empty or
 * absent provider list means "every provider" and returns the input as is.
 *
 * Must run **after** every intersection: `intersectPermissions` expands both
 * sides against the catalog, which has no segmented entries, so a narrowed
 * string passed through it is dropped.
 */
export function narrowToProviders(
  permissions: readonly string[],
  providers: readonly string[] | null | undefined,
): string[] {
  if (!providers || providers.length === 0) return [...permissions];
  const out: string[] = [];
  for (const permission of permissions) {
    const scoped = splitScoped(permission);
    if (!scoped) {
      if (!out.includes(permission)) out.push(permission);
      continue;
    }
    const [family, verb] = scoped;
    for (const provider of providers) {
      // A malformed id is skipped rather than written: `resources:*:read`
      // from a provider named `*` would be every provider, the opposite of
      // what narrowing is for.
      if (!isValidPluginId(provider)) continue;
      const narrowed = `${family}:${provider}:${verb}`;
      if (!out.includes(narrowed)) out.push(narrowed);
    }
  }
  return out;
}

/**
 * Whether `granted` allows `permission` on objects of `pluginId`: either the
 * unsegmented grant (every provider) or the narrowed one for that plugin.
 */
export function holdsForPlugin(
  granted: readonly string[],
  permission: string,
  pluginId: string,
): boolean {
  if (hasPermission(granted, permission)) return true;
  const scoped = splitScoped(permission);
  if (!scoped || !isValidPluginId(pluginId)) return false;
  return hasPermission(granted, `${scoped[0]}:${pluginId}:${scoped[1]}`);
}

/**
 * Whether `granted` holds `permission` for at least one provider, unsegmented
 * or narrowed. Answers "could this principal ever use a tool gated on this",
 * which is what decides whether the tool is listed to it at all.
 */
export function holdsForSomePlugin(granted: readonly string[], permission: string): boolean {
  if (hasPermission(granted, permission)) return true;
  const scoped = splitScoped(permission);
  if (!scoped) return false;
  const [family, verb] = scoped;
  return granted.some((entry) => {
    const parts = entry.split(":");
    return (
      parts.length === 3 &&
      (parts[0] === family || parts[0] === "*") &&
      (parts[2] === verb || parts[2] === "*")
    );
  });
}

/**
 * The plugin ids `granted` is confined to for `permission`, or null when it
 * holds the unsegmented grant (no confinement). Used for error messages that
 * tell an agent what it may touch.
 */
export function pluginsAllowedFor(granted: readonly string[], permission: string): string[] | null {
  if (hasPermission(granted, permission)) return null;
  const scoped = splitScoped(permission);
  if (!scoped) return [];
  const [family, verb] = scoped;
  const plugins: string[] = [];
  for (const entry of granted) {
    const parts = entry.split(":");
    if (parts.length !== 3) continue;
    if ((parts[0] === family || parts[0] === "*") && (parts[2] === verb || parts[2] === "*")) {
      const plugin = parts[1]!;
      if (!plugins.includes(plugin)) plugins.push(plugin);
    }
  }
  return plugins;
}
