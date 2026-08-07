/**
 * Which permission an audit action is evidence of.
 *
 * The credential-hygiene report answers "is this person using what they were
 * given", and the only durable record of what anybody did is `audit_logs`.
 * This is the mapping between the two.
 *
 * **The audit log only witnesses writes.** Reading a resource list, opening a
 * dashboard, querying costs — none of those leave a row, by design. So an
 * absence of evidence says something about `resources:delete` and nothing at
 * all about `resources:read`, and the report must only ever draw conclusions
 * about permissions in {@link WITNESSED_PERMISSIONS}. Concluding "unused" from
 * a permission the log cannot see would be confidently wrong, which is worse
 * than staying quiet.
 *
 * Pure and unit-tested: no database, no clock.
 */

/**
 * Audit action → the permission it demonstrates.
 *
 * Exact matches, not prefixes: `resource.update` is `resources:write` while
 * `resource.delete` is `resources:delete`, and a prefix rule over `resource.`
 * would collapse the two — which is exactly the distinction a reviewer cares
 * about. An action missing from this table simply contributes no evidence.
 */
export const AUDIT_ACTION_PERMISSION: Readonly<Record<string, string>> = {
  // Accounts and their credentials.
  "account.credentials.read": "secrets:read",
  "credential.export": "secrets:read",
  "secret.access": "secrets:read",
  "secret.add_version": "secrets:write",
  "secret_version.destroy": "secrets:write",

  // Resources.
  "resource.create": "resources:write",
  "resource.update": "resources:write",
  "resource.attach": "resources:write",
  "resource.apply_manifest": "resources:write",
  "resource.delete": "resources:delete",
  "resource.invoke_action": "resources:execute",
  "resource_lease.create": "resources:write",
  "resource_lease.update": "resources:write",
  "resource_lease.cancel": "resources:write",
  "resource_lease.delete": "resources:write",
  "resource_schedule.create": "resources:write",
  "resource_schedule.update": "resources:write",
  "resource_schedule.delete": "resources:write",
  "probe.create": "resources:write",
  "probe.update": "resources:write",
  "probe.delete": "resources:write",
  "log_workspace_query.create": "resources:write",
  "log_workspace_query.update": "resources:write",
  "log_workspace_query.delete": "resources:write",

  // Anything that reaches into running infrastructure.
  "ssh.exec": "resources:execute",
  "ssh.fanout.run": "resources:execute",
  "ssh.session.opened": "resources:execute",
  "ssh.session.chain_opened": "resources:execute",
  "ssh.agent.session_opened": "resources:execute",
  "sql.execute": "resources:execute",
  "kv.command": "resources:execute",
  "docker.command": "resources:execute",
  "storage.delete": "storage:write",
  "storage.mkdir": "storage:write",

  // Governance.
  "change_freeze.create": "freezes:write",
  "change_freeze.update": "freezes:write",
  "change_freeze.delete": "freezes:write",
  "change_freeze.end": "freezes:write",
  "change_freeze.override": "freezes:override",
  "tag_policy.update": "org:settings:write",
  "tag_policy.override": "tag-policy:override",

  // Money.
  "budget.create": "budgets:write",
  "budget.update": "budgets:write",
  "budget.delete": "budgets:write",
  "cost_centre.create": "costs:write",
  "cost_centre.update": "costs:write",
  "cost_centre.delete": "costs:write",
  "cost_allocation_rule.create": "costs:write",
  "cost_allocation_rule.update": "costs:write",
  "cost_allocation_rule.delete": "costs:write",
  "cost_allocation_rule.swap": "costs:write",
  "costs.push": "costs:write",

  // People and keys.
  "member.invite": "team:invite",
  "member.remove": "team:remove",
  "member.role_change": "team:role:write",
  "role.create": "team:role:write",
  "role.update": "team:role:write",
  "role.delete": "team:role:write",
  "api_key.create": "apikeys:write",
  "api_key.revoke": "apikeys:write",
  "ssh.snippet.create": "ssh-keys:write",
  "ssh.snippet.update": "ssh-keys:write",
  "ssh.snippet.delete": "ssh-keys:write",
  "ssh_host_key.trusted": "accounts:write",
  "ssh_host_key.replaced": "accounts:write",
  "ssh_host_key.removed": "accounts:write",
  "bastion.create": "bastions:write",
  "bastion.revoke": "bastions:write",

  // Automations and deploys.
  "workflow.run": "workflows:write",
  "workflow.delete": "workflows:write",
  "deployment.plan": "deployments:plan",
  "deployment.rollback": "deployments:write",

  // On-call and elevation.
  "page.raise": "pages:write",
  "page.clear": "pages:write",
  "access_request.approve": "access:approve",
  "access_request.deny": "access:approve",
  "access_request.revoke": "access:approve",
  "access_request.create": "access:request",
  "access_request.withdraw": "access:request",

  // Recorded sessions.
  "session_recording.view": "session-recordings:read",
  "session_recording.delete": "session-recordings:write",
  "session_recording.settings.update": "session-recordings:write",
};

/**
 * The permissions the audit log can actually witness — the values of
 * {@link AUDIT_ACTION_PERMISSION}, deduped.
 *
 * The report's "granted but never exercised" finding is computed **only** over
 * this set. `resources:read` is not in it, and never will be: read paths do
 * not write audit rows, so their absence is not evidence.
 */
export const WITNESSED_PERMISSIONS: readonly string[] = [
  ...new Set(Object.values(AUDIT_ACTION_PERMISSION)),
].sort();

/**
 * The permission an action demonstrates, or null when the action carries no
 * permission signal (sync pushes, blocked-by-freeze records, and anything
 * added since this table was last reviewed).
 */
export function permissionForAuditAction(action: string): string | null {
  return AUDIT_ACTION_PERMISSION[action] ?? null;
}

/** Everything the given actions are evidence of, deduped and sorted. */
export function permissionsExercised(actions: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const action of actions) {
    const permission = permissionForAuditAction(action);
    if (permission) out.add(permission);
  }
  return [...out].sort();
}
