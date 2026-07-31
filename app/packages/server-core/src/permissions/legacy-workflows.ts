/**
 * Backwards compatibility for the `dashboards:*` → `workflows:*` split.
 *
 * Workflows had no permissions of their own until the release that added
 * `workflows:read` / `workflows:write` / `workflows:approve`. Until then the
 * workflow routes, the workflow MCP tools, and the approve/deny endpoints all
 * checked `dashboards:read` / `dashboards:write`, so every grant of a dashboard
 * permission made before the cutover was, in practice, also a grant of workflow
 * access.
 *
 * Two places store such grants verbatim and would silently lose that access:
 * custom role rows (`roles.permissions`) and API-key scopes (`api_keys.scopes`).
 * System roles are resolved from code, so they need nothing here. Wildcards
 * (`*`, `dashboards:*`) need nothing either — they expand against the catalog,
 * which now contains the new entries.
 *
 * The expansion is additive and can never grant more than the pre-cutover
 * behaviour already did, and it is gated on a timestamp so a grant *written*
 * after the cutover means exactly what it says. Delete this module once
 * {@link WORKFLOW_PERMISSION_CUTOVER} is comfortably in the past.
 */

/**
 * Grants written before this instant predate dedicated workflow permissions.
 *
 * Deliberately later than the release date: a generous upper bound costs
 * nothing (the expansion only restores access the grant already implied),
 * whereas a cutover that lands before the deploy would 403 every grant written
 * in the gap.
 */
export const WORKFLOW_PERMISSION_CUTOVER = new Date("2026-10-01T00:00:00Z");

/**
 * Additively expand pre-cutover dashboard grants onto the workflow permissions
 * they used to imply: `dashboards:read` also yields `workflows:read`, and
 * `dashboards:write` also yields `workflows:write` plus `workflows:approve`
 * (deciding an approval request used to take `dashboards:write`).
 *
 * The dashboard entries are kept — this is an expansion, not a rename.
 */
export function grandfatherWorkflowPermissions(granted: readonly string[]): string[] {
  const out = [...granted];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  if (granted.includes("dashboards:read")) add("workflows:read");
  if (granted.includes("dashboards:write")) {
    add("workflows:read");
    add("workflows:write");
    add("workflows:approve");
  }
  return out;
}

/**
 * {@link grandfatherWorkflowPermissions}, applied only when `writtenAt` predates
 * the cutover. `null`/`undefined` means "unknown mint time" and is treated as
 * post-cutover — callers that know the timestamp pass it.
 */
export function grandfatherWorkflowPermissionsIfLegacy(
  granted: readonly string[],
  writtenAt: Date | null | undefined,
): string[] {
  if (!writtenAt || writtenAt >= WORKFLOW_PERMISSION_CUTOVER) return [...granted];
  return grandfatherWorkflowPermissions(granted);
}
