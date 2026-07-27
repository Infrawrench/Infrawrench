/**
 * Chat auth — session cookie, WorkOS Bearer token, or `iwk_` API key, pinned to
 * the org in the URL and gated on `chat:read` / `chat:write`.
 *
 * The mechanism is shared with every other route that has to serve both the UI
 * and unattended servers (cost ingest, paging); it lives in
 * `auth/org-request-auth.ts`. This module only narrows the scope parameter, so
 * a typo in a chat route is a type error rather than a permission that silently
 * never matches.
 */
import type { Context } from "hono";
import { authenticateOrgRequest, type OrgAuthResult } from "../auth/org-request-auth";

export type ChatAuthResult = OrgAuthResult;

/**
 * Authenticate the request and verify membership in `:orgId`. On failure
 * returns a Response that the caller should return directly.
 */
export async function authenticateChat(
  c: Context,
  pathOrgId: string,
  requiredScope: "chat:read" | "chat:write",
): Promise<ChatAuthResult | Response> {
  return authenticateOrgRequest(c, pathOrgId, requiredScope);
}
