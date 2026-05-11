import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

/**
 * Throws 403 if the principal on the request context lacks the required
 * permission. Permissions are populated by `permissionsMiddleware` for
 * session-authed routes, and by `authenticateApiRequest` for bearer-token
 * routes (which assigns the API key's stored scopes).
 */
export function requirePermission(c: Context, permission: string): void {
  const granted = c.get("permissions") ?? [];
  if (!hasPermission(granted, permission)) {
    throw new HTTPException(403, { message: `Missing permission: ${permission}` });
  }
}
