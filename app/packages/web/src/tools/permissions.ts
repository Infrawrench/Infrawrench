/**
 * Permission gate for tool handlers. The HTTP API enforces permissions in
 * middleware (`requirePermission`), but MCP and chat callers reach tool
 * handlers through their own dispatch loops, so the equivalent check happens
 * here, driven by the `permission` declared on each {@link ToolDefinition}.
 *
 * Enforcement is central ({@link authorizeToolCall}, called by `mcp/server.ts`
 * and `chat/agent.ts`) rather than per-handler, so a newly added tool cannot
 * forget to gate itself.
 */
import { PRODUCT_NAMES, type ProductId } from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { disabledProducts } from "@infrawrench/server-core/products/settings";
import {
  holdsForPlugin,
  holdsForSomePlugin,
  isProviderScoped,
  pluginsAllowedFor,
} from "@infrawrench/server-core/agent-links/scopes";
import { effectivePermissions } from "../auth/effective-permissions";
import { withPrincipalCostVisibility } from "../auth/cost-visibility";
import { pluginsForCall, toolCanNamePlugin } from "./plugin-scope";
import { err, type ToolAuthContext, type ToolDefinition, type ToolResult } from "./types";

/**
 * The permissions a tool caller actually holds: the shared resolver in
 * `auth/effective-permissions.ts`, so the tool layer and the chat endpoint
 * can't drift on how a principal is scored.
 *
 * Deliberately un-memoized. The lookups are primary-key reads, and a chat turn
 * can stay open across an approval round-trip: re-reading is what lets a role
 * change mid-turn actually take effect on the next tool call.
 */
export async function effectiveToolPermissions(auth: ToolAuthContext): Promise<readonly string[]> {
  return await effectivePermissions(auth);
}

/**
 * Returns an error ToolResult when the caller lacks the permission, or null
 * when the call may proceed. Used for the finer-grained checks a handler makes
 * beyond its declared permission (e.g. "may I manage another user's SSH key").
 */
export async function denyUnlessPermitted(
  auth: ToolAuthContext,
  permission: string,
): Promise<ToolResult | null> {
  const granted = await effectiveToolPermissions(auth);
  if (!hasPermission(granted, permission)) {
    return err(`Missing permission: ${permission}`);
  }
  return null;
}

/** What a caller reads when it calls a tool of an app its organization turned off. */
export function productDisabledMessage(product: ProductId): string {
  return `The ${PRODUCT_NAMES[product]} app is turned off for this organization`;
}

/**
 * The tools to offer a caller acting in `organizationId`: the registry minus
 * the tools of apps the organization has turned off. Offering is a
 * convenience, not the gate (a tool it cannot use is noise in a model's
 * context); {@link authorizeToolCall} refuses the call either way. The
 * policy is read only when some tool is tagged, and once per listing.
 */
export async function toolsOfferedTo<T extends Pick<ToolDefinition, "product">>(
  tools: readonly T[],
  organizationId: string,
): Promise<T[]> {
  if (!tools.some((tool) => tool.product)) return [...tools];
  const disabled = await disabledProducts(organizationId);
  if (disabled.length === 0) return [...tools];
  return tools.filter((tool) => !tool.product || !disabled.includes(tool.product));
}

/**
 * Central authorization gate. Every dispatch site MUST call this before
 * invoking `tool.handler`. Returns an error ToolResult for the caller, or null
 * when the call is authorized.
 *
 * The organization's app policy comes first, ahead of the permission: a tool
 * of a turned-off app is refused for everyone, an owner and a `permission:
 * null` tool included, and the refusal says why rather than reading as a
 * missing permission. Re-read per call, like the permissions, so turning an
 * app off takes effect on the next tool call of a turn already running.
 */
export async function authorizeToolCall(
  tool: Pick<ToolDefinition, "permission" | "pluginId" | "spansProviders" | "product">,
  auth: ToolAuthContext,
  input: Record<string, unknown> = {},
): Promise<ToolResult | null> {
  if (tool.product && (await disabledProducts(auth.organizationId)).includes(tool.product)) {
    return err(productDisabledMessage(tool.product));
  }
  if (tool.permission === null) return null;
  const granted = await effectiveToolPermissions(auth);
  if (hasPermission(granted, tool.permission)) return null;

  // Provider-narrowed grants (`resources:aws:read`). The unsegmented check
  // above fails for them by construction, so they are honoured only here,
  // where the call can be pinned to the providers it actually touches. Every
  // one of them must be allowed; a call that cannot be pinned is refused.
  if (
    !tool.spansProviders &&
    isProviderScoped(tool.permission) &&
    holdsForSomePlugin(granted, tool.permission)
  ) {
    const touched = await pluginsForCall(tool, input, auth.organizationId);
    const allowed = pluginsAllowedFor(granted, tool.permission) ?? [];
    if (!touched.ok) {
      return err(
        `${touched.reason} Missing permission: ${tool.permission} ` +
          `(held only for: ${allowed.join(", ")})`,
      );
    }
    const refused = touched.plugins.filter(
      (plugin) => !holdsForPlugin(granted, tool.permission!, plugin),
    );
    if (refused.length === 0) return null;
    return err(
      `Missing permission: ${tool.permission} for ${refused.join(", ")} ` +
        `(held only for: ${allowed.join(", ")})`,
    );
  }
  return err(`Missing permission: ${tool.permission}`);
}

/**
 * Whether a principal holding `granted` could use `tool` at all. Decides
 * which tools an agent is offered: a tool it can never call is noise in its
 * context and a hint at surfaces it was deliberately not given.
 */
export function toolUsableWith(
  tool: Pick<ToolDefinition, "permission" | "pluginId" | "inputSchema" | "spansProviders">,
  granted: readonly string[],
): boolean {
  if (tool.permission === null) return true;
  if (hasPermission(granted, tool.permission)) return true;
  if (tool.spansProviders || !isProviderScoped(tool.permission)) return false;
  if (!holdsForSomePlugin(granted, tool.permission)) return false;
  if (!toolCanNamePlugin(tool)) return false;
  // A fixed-plugin tool (`aws_create_s3-bucket`) is only usable when that
  // very plugin is allowed.
  if (tool.pluginId) return holdsForPlugin(granted, tool.permission, tool.pluginId);
  return true;
}

/**
 * Invoke a tool's handler inside the caller's cost visibility scope.
 *
 * Every dispatch site (MCP and both chat paths) calls this instead of
 * `tool.handler` directly, after {@link authorizeToolCall}: the HTTP tree gets
 * its scope from middleware, and this is the tool layer's equivalent, so a
 * cost tool added later is scoped without knowing scopes exist. Resolved per
 * call for the same reason permissions are: a chat turn can outlive a scope
 * change.
 */
export async function runToolHandler(
  tool: Pick<ToolDefinition, "handler">,
  input: Record<string, unknown>,
  auth: ToolAuthContext,
): Promise<ToolResult> {
  return await withPrincipalCostVisibility(
    auth.organizationId,
    {
      userId: auth.userId,
      apiKeyId: auth.agentRegistrationId ? null : (auth.apiKeyId ?? null),
      agentRegistrationId: auth.agentRegistrationId ?? null,
    },
    () => tool.handler(input, auth),
    await effectiveToolPermissions(auth),
  );
}
