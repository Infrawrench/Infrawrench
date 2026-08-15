/**
 * The scopes the Create API Key dialog offers.
 *
 * A key's scopes are permission strings from the same catalog roles are built
 * from (`server-core/permissions/catalog.ts`), and the server enforces them by
 * intersecting the key's scopes with the owner's current role — a scope the key
 * does not hold is a 403, not a warning. That makes this list load-bearing
 * rather than cosmetic: **a permission absent from here is a capability no key
 * minted through the UI can ever hold.**
 *
 * It used to offer eleven strings out of a catalog of sixty-four, which is how
 * `costs:read` and `costs:write` came to be documented (the Terraform provider
 * manages cost centres, budgets and reports and authenticates with an `iwk_`
 * key) and simultaneously impossible to select. The list is now the whole
 * catalog minus {@link API_KEY_UNOFFERED_SCOPES}, and
 * `web/src/api/__tests__/api-key-scope-catalog.test.ts` fails the build if the
 * two ever stop adding up — the drift is the bug, so the guard is a test rather
 * than a comment.
 *
 * Deliberately React-free and exported as its own entry point so the server
 * side can assert against it without loading the component barrel.
 */

/** One selectable scope. `value` is the permission string stored on the key. */
export interface ApiKeyScope {
  value: string;
  /**
   * Shown next to the checkbox. Rendered through `useDataString()`, not
   * `gt()` — these reach the component as data, and the gt CLI rejects
   * non-literal arguments to the names it scans.
   */
  label: string;
}

/** A titled block of scopes, so fifty-five checkboxes read as a form. */
export interface ApiKeyScopeGroup {
  title: string;
  scopes: readonly ApiKeyScope[];
}

export const API_KEY_SCOPE_GROUPS: readonly ApiKeyScopeGroup[] = [
  {
    title: "Infrastructure",
    scopes: [
      { value: "accounts:read", label: "Accounts (read)" },
      { value: "accounts:write", label: "Accounts (connect and edit)" },
      { value: "accounts:delete", label: "Accounts (disconnect)" },
      { value: "resources:read", label: "Resources (read)" },
      { value: "resources:write", label: "Resources (write)" },
      { value: "resources:delete", label: "Resources (delete)" },
      { value: "resources:execute", label: "Resources (run commands, SSH, SQL)" },
      { value: "secrets:read", label: "Secrets (read)" },
      { value: "secrets:write", label: "Secrets (write)" },
      { value: "storage:read", label: "Object storage (read)" },
      { value: "storage:write", label: "Object storage (write)" },
    ],
  },
  {
    title: "Cost and billing",
    scopes: [
      { value: "costs:read", label: "Costs (read)" },
      { value: "costs:write", label: "Costs (write)" },
      { value: "budgets:read", label: "Budgets (read)" },
      { value: "budgets:write", label: "Budgets (write)" },
      { value: "invoices:read", label: "Managed invoices (read)" },
      { value: "invoices:write", label: "Managed invoices (prepare)" },
      { value: "invoices:issue", label: "Managed invoices (approve and send)" },
    ],
  },
  {
    title: "Dashboards and alerting",
    scopes: [
      { value: "dashboards:read", label: "Dashboards (read)" },
      { value: "dashboards:write", label: "Dashboards (write)" },
      { value: "metric-alerts:read", label: "Metric alerts (read)" },
      { value: "metric-alerts:write", label: "Metric alerts (write)" },
      { value: "incidents:read", label: "Incidents (read)" },
      { value: "incidents:write", label: "Incidents (declare and update)" },
      { value: "pages:write", label: "On-call pages (raise)" },
      { value: "audit:read", label: "Audit log (read)" },
    ],
  },
  {
    title: "Automation and deployment",
    scopes: [
      { value: "workflows:read", label: "Workflows (read)" },
      { value: "workflows:write", label: "Workflows (write and run)" },
      { value: "workflows:approve", label: "Workflows (approve a step)" },
      { value: "deployments:read", label: "Deployments (read)" },
      { value: "deployments:plan", label: "Deployments (plan)" },
      { value: "deployments:write", label: "Deployments (apply)" },
      { value: "config:read", label: "Org config as code (export)" },
      { value: "config:write", label: "Org config as code (apply)" },
      { value: "iac:read", label: "Terraform reconciliation (read)" },
      { value: "iac:write", label: "Terraform reconciliation (upload state)" },
      { value: "freezes:read", label: "Change freezes (read)" },
      { value: "freezes:write", label: "Change freezes (write)" },
      { value: "freezes:override", label: "Change freezes (override)" },
      { value: "tag-policy:override", label: "Tag policy (override)" },
    ],
  },
  {
    title: "Access and credentials",
    scopes: [
      { value: "team:read", label: "Team (read)" },
      { value: "ssh-keys:read", label: "SSH keys (read)" },
      { value: "ssh-keys:write", label: "SSH keys (write)" },
      { value: "bastions:read", label: "Bastions (read)" },
      { value: "bastions:write", label: "Bastions (write)" },
      { value: "session-recordings:read", label: "Session recordings (watch)" },
      { value: "session-recordings:write", label: "Session recordings (policy and deletion)" },
      { value: "access:read", label: "Break-glass access (read the queue)" },
    ],
  },
  {
    title: "Integrations",
    scopes: [
      { value: "chat:read", label: "AI chat (read conversations)" },
      { value: "chat:write", label: "AI chat (send messages)" },
      { value: "jira:read", label: "Jira (read)" },
      { value: "jira:write", label: "Jira (configure and file)" },
      { value: "linear:read", label: "Linear (read)" },
      { value: "linear:write", label: "Linear (configure and file)" },
    ],
  },
  {
    title: "Organization",
    scopes: [{ value: "org:settings:write", label: "Organization settings (write)" }],
  },
] as const;

/** Every offered scope, flattened. Order follows the groups. */
export const AVAILABLE_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPE_GROUPS.flatMap(
  (group) => group.scopes,
);

/**
 * Catalog permissions the dialog deliberately does not offer, and why.
 *
 * Every one of them gates only routes that `API_KEY_DENY_RULES`
 * (`web/src/auth/api-key-route-policy.ts`) closes to API keys outright, so a
 * key carrying it would be refused anyway. Offering it would be a promise the
 * server does not keep — the checkbox would look like the difference between a
 * 200 and a 403 when it is not.
 *
 * The reasons are the deny rules' reasons, restated for someone reading the
 * dialog rather than the policy. The parity test in `web` asserts this map and
 * {@link AVAILABLE_SCOPES} partition the catalog exactly, so a permission added
 * to the catalog has to be classified here or offered there.
 */
export const API_KEY_UNOFFERED_SCOPES: Readonly<Record<string, string>> = {
  "apikeys:read": "API keys cannot list or manage API keys.",
  "apikeys:write": "API keys cannot mint or revoke API keys.",
  "billing:read": "API keys cannot reach billing.",
  "billing:write": "API keys cannot change the subscription.",
  "team:invite": "API keys cannot invite people.",
  "team:role:write": "API keys cannot define roles or change who holds them.",
  "team:remove": "API keys cannot remove members.",
  "access:request": "API keys cannot request break-glass access.",
  "access:approve": "API keys cannot approve or deny break-glass access.",
};

/**
 * Deprecated scope strings that must never reappear in the picker.
 *
 * `sync:read` / `sync:write` are renamed to `resources:read` /
 * `resources:write` the next time a key carrying them authenticates
 * (`web/src/auth/api-auth.ts`), so a key minted with them today stores a scope
 * that silently becomes a different one — and the dialog offered them above the
 * `resources:*` pair they turn into.
 */
export const DEPRECATED_API_KEY_SCOPES: readonly string[] = ["sync:read", "sync:write"];
