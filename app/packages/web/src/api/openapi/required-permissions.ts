/**
 * Map of `METHOD /path-suffix` → required permission, mirroring the
 * `requirePermission` calls in route handlers. Path suffixes are matched
 * against the part of the URL after `/api/org/{orgId}/` (or the matching
 * unscoped prefix for sync/webhooks). Add new entries here when adding new
 * routes: `pnpm --filter @infrawrench/web generate:openapi` will pick them up.
 */
export const REQUIRED_PERMISSION: Record<string, string | null> = {
  // billing
  "GET /billing/status": "billing:read",
  "POST /billing/checkout": "billing:write",
  "POST /billing/measurement-consent": "billing:write",
  "POST /billing/portal": "billing:write",
  // sync (bearer-auth, scopes mirror permissions)
  "POST /v1/sync/pull": "resources:read",
  "POST /v1/sync/push": "resources:write",
  "GET /v1/sync/status": "resources:read",
  // identity check for any bearer credential; reveals only its own owner
  "GET /v1/whoami": null,
  // the providers' public price lists, readable by any bearer credential
  // (`aws-pricing` is the deprecated alias of `instance-pricing`)
  "GET /v1/instance-pricing/schema": null,
  "POST /v1/instance-pricing/query": null,
  "GET /v1/aws-pricing/schema": null,
  "POST /v1/aws-pricing/query": null,
};

/**
 * Strip the org-scoping prefix so the lookup key matches the table above.
 * `/api/org/{orgId}/foo` → `/foo`; `/api/v1/sync/pull` → `/v1/sync/pull`.
 */
export function normalizePathForPermissionLookup(path: string): string {
  return path.replace(/^\/api\/org\/\{orgId\}/, "").replace(/^\/api/, "");
}
