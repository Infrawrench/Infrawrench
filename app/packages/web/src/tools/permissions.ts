/**
 * Permission gate for tool handlers. The HTTP API enforces permissions in
 * middleware (`requirePermission`), but MCP and chat callers reach tool
 * handlers with only a user + org — so tools guarding permission-scoped data
 * (costs, budgets, …) resolve the caller's effective role permissions here.
 */
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { err, type ToolAuthContext, type ToolResult } from "./types";

/**
 * Returns an error ToolResult when the caller lacks the permission, or null
 * when the call may proceed.
 */
export async function denyUnlessPermitted(
  auth: ToolAuthContext,
  permission: string,
): Promise<ToolResult | null> {
  const access = await resolveEffectivePermissions(auth.organizationId, {
    kind: "user",
    userId: auth.userId,
  });
  if (!hasPermission(access.permissions, permission)) {
    return err(`Missing permission: ${permission}`);
  }
  return null;
}
