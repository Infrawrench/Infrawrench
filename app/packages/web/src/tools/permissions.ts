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
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { effectivePermissions } from "../auth/effective-permissions";
import { withPrincipalCostVisibility } from "../auth/cost-visibility";
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

/**
 * Central authorization gate. Every dispatch site MUST call this before
 * invoking `tool.handler`. Returns an error ToolResult for the caller, or null
 * when the call is authorized.
 */
export async function authorizeToolCall(
  tool: Pick<ToolDefinition, "permission">,
  auth: ToolAuthContext,
): Promise<ToolResult | null> {
  if (tool.permission === null) return null;
  return await denyUnlessPermitted(auth, tool.permission);
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
