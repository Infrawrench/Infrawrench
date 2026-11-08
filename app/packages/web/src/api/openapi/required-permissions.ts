/**
 * Map of `METHOD /path-suffix` → required permission, mirroring the
 * `requirePermission` calls in route handlers. Path suffixes are matched
 * against the part of the URL after `/api/org/{orgId}/` (or the matching
 * unscoped prefix for sync/webhooks). Add new entries here when adding new
 * routes: `pnpm --filter @infrawrench/web generate:openapi` will pick them up.
 */
export const REQUIRED_PERMISSION: Record<string, string | null> = {
  // cost visibility scopes; PUT/DELETE depend on the principal (an API key's
  // owner may scope their own key with apikeys:write), so the handler owns
  // the check and the map records the common case.
  "GET /cost-visibility": "team:read",
  "PUT /cost-visibility": "team:role:write",
  "DELETE /cost-visibility/{principalKind}/{principalId}": "team:role:write",
  // object sharing; the permission depends on the object type in the path
  // (costs:* for reports and folders, dashboards:* for dashboards).
  "GET /sharing/{objectType}/{objectId}": null,
  "PUT /sharing/{objectType}/{objectId}": null,
  "DELETE /sharing/{objectType}/{objectId}": null,
  // accounts
  "GET /accounts/plugins": "accounts:read",
  "GET /accounts/plugins/{pluginId}/policy-template": "accounts:read",
  "POST /accounts/preflight": "accounts:write",
  "POST /accounts/credential-options": "accounts:write",
  "POST /accounts/{id}/preflight": "accounts:write",
  "GET /accounts": "accounts:read",
  "POST /accounts": "accounts:write",
  "DELETE /accounts/{id}": "accounts:delete",
  "PATCH /accounts/{id}": "accounts:write",
  "GET /accounts/{id}/credentials": "secrets:read",
  "PUT /accounts/{id}/credentials": "secrets:write",
  "GET /accounts/{id}/resources": "resources:read",
  "POST /accounts/{id}/sync": "resources:read",
  "GET /accounts/{id}/export-terraform": "resources:read",
  "GET /accounts/{id}/detail": "accounts:read",
  "POST /accounts/{id}/sync-type/{typeId}": "resources:read",
  // cost per deploy; same rule as the change feed's: deployments:read for the
  // run, costs:read for the spend it moved. Served by the deployments HttpApi
  // domain but still documented by `paths/change-cost-impact.ts`, which owns
  // the impact components, so its documented gate stays here until that moves.
  "GET /deployments/runs/{id}/cost-impact": "costs:read",
  // dashboards
  "GET /dashboards": "dashboards:read",
  "POST /dashboards": "dashboards:write",
  "GET /dashboards/{id}": "dashboards:read",
  "GET /dashboards/default/full": "dashboards:read",
  "GET /dashboards/default": "dashboards:read",
  "PUT /dashboards/default/me": "dashboards:read",
  "DELETE /dashboards/default/me": "dashboards:read",
  "GET /dashboards/role-defaults": "team:read",
  "PUT /dashboards/role-defaults/{roleId}": "org:settings:write",
  "DELETE /dashboards/role-defaults/{roleId}": "org:settings:write",
  "POST /dashboards/{id}/rename": "dashboards:write",
  "DELETE /dashboards/{id}": "dashboards:write",
  "POST /dashboards/pin": "dashboards:write",
  "POST /dashboards/{id}/reorder": "dashboards:write",
  "POST /dashboards/unpin": "dashboards:write",
  "POST /dashboards/validate-tabs": "dashboards:read",
  "GET /dashboards/pin/{pinId}": "dashboards:read",
  "POST /dashboards/probe": "dashboards:read",

  // custom graphs: genuinely dashboard content, so they keep the dashboards
  // permissions the workflows routes have moved off.
  "GET /custom-graphs": "dashboards:read",
  "POST /custom-graphs": "dashboards:write",
  "GET /custom-graphs/typings": "dashboards:read",
  "POST /custom-graphs/check": "dashboards:read",
  "GET /custom-graphs/{id}": "dashboards:read",
  "PUT /custom-graphs/{id}": "dashboards:write",
  "DELETE /custom-graphs/{id}": "dashboards:write",
  "POST /custom-graphs/{id}/render": "dashboards:read",
  "POST /chat/conversations/{conversationId}/pending/{pendingId}/answer": "chat:write",
  // agents
  "GET /agents/accounts": "accounts:read",
  "GET /agents/settings": "accounts:read",
  "GET /agents/link-scopes": "resources:write",
  "PUT /agents/settings": "accounts:write",
  "GET /agents/sessions": "resources:read",
  "POST /agents/sessions": "resources:write",
  "POST /agents/sessions/{id}/open": "resources:execute",
  "POST /agents/sessions/{id}/reconcile": "resources:execute",
  "DELETE /agents/sessions/{id}": "resources:delete",
  // change timeline
  "GET /changes": "resources:read",
  "GET /changes/resource": "resources:read",
  // cost per change: the response is money, so it takes the cost read scope
  // on top of the resource one the feed itself needs.
  "POST /changes/cost-impacts": "costs:read",
  // provider status correlation: reads the same resource set the incidents
  // are matched against, so it rides the resources read scope
  "GET /status-incidents": "resources:read",
  // The moment union spans six read scopes; `resources:read` is the floor:
  // feeds needing more (costs, workflows, deployments, audit, freezes) are
  // omitted per-feed rather than gating the whole endpoint.
  "GET /moment": "resources:read",
  // session recordings; their own permission family rather than `audit:read`
  // or `ssh-keys:*`: watching a colleague's terminal back is a sharper
  // capability than either, and the people who should hold it (compliance,
  // security) are often not the people who administer keys. Deliberately
  // absent from the `member` system role: recording exists to watch
  // operators, so handing every operator the ability to watch defeats it.
  // credit burndown: `costs:read`. A prepaid balance is spend information,
  // and the permission that already governs "what is this costing us" is the
  // one that should govern "how much is left".
  "GET /credits": "costs:read",
  "GET /commitments": "costs:read",
  "GET /session-recordings": "session-recordings:read",
  // shared consoles: deliberately no permission family of their own. A share
  // hands over no capability the guest did not already hold: joining requires
  // the same `resources:execute` a direct terminal to that resource requires,
  // so the invite link is a locator and never an authorisation. Inventing a
  // `shared-consoles:*` family would imply a share is a lesser thing than a
  // shell, and it is not: a guest can be handed the keyboard.
  "GET /shared-consoles": "resources:execute",
  "POST /shared-consoles": "resources:execute",
  "GET /shared-consoles/invites/{token}": "resources:execute",
  "GET /shared-consoles/{consoleId}": "resources:execute",
  "POST /shared-consoles/{consoleId}/join": "resources:execute",
  "POST /shared-consoles/{consoleId}/handover": "resources:execute",
  "POST /shared-consoles/{consoleId}/request-driver": "resources:execute",
  // The routes that *take access away*: leave, revoke, eject, withdraw an
  // invite; carry no permission on purpose. Gating them on still holding
  // `resources:execute` would lock an owner whose role was narrowed
  // mid-incident out of closing the session they opened. They are gated in the
  // handler instead, on being the sharer or holding `org:settings:write`,
  // which the one-permission-per-route map cannot express (the `leases`
  // autoDelete precedent).
  "POST /shared-consoles/{consoleId}/leave": null,
  "DELETE /shared-consoles/{consoleId}": null,
  "POST /shared-consoles/{consoleId}/invites": null,
  "DELETE /shared-consoles/{consoleId}/invites": null,
  "DELETE /shared-consoles/{consoleId}/participants/{participantId}": null,
  "GET /session-recordings/settings": "session-recordings:read",
  "PUT /session-recordings/settings": "session-recordings:write",
  "GET /session-recordings/{recordingId}": "session-recordings:read",
  "GET /session-recordings/{recordingId}/cast": "session-recordings:read",
  "DELETE /session-recordings/{recordingId}": "session-recordings:write",
  // status pages: a page is a view over probes, so it rides the probe stance:
  // whoever may create the monitoring may decide what of it is public.
  // GET /api/status/{slug} is deliberately absent: it is mounted outside the
  // org tree and takes no credentials at all.
  "GET /status-pages": "resources:read",
  "POST /status-pages": "resources:write",
  "PUT /status-pages/{id}": "resources:write",
  "POST /status-pages/{id}/rotate-slug": "resources:write",
  "DELETE /status-pages/{id}": "resources:write",
  // showback and untagged spend ride the cost read scope their data is
  // computed over
  "GET /costs/untagged": "costs:read",
  "GET /costs/showback": "costs:read",
  // managed accounts & invoices: the managed-service-provider surface.
  //
  // Its own family rather than more `costs:*`. Every other cost surface is the
  // organisation looking at its own spend; a managed account holds a customer's
  // contact details and the price that customer was quoted, which is commercial
  // information about a third party, so reads are `invoices:read`, not
  // `costs:read`.
  //
  // Writes split two ways because generating and issuing are different risks.
  // `invoices:write` prepares (add a customer, raise a draft, edit a period,
  // delete a draft) and is entirely revisable. `invoices:issue` is the
  // irreversible half: approving freezes the numbers a customer will be sent,
  // sending states that they have them, voiding withdraws a document already in
  // their hands. The split is what makes maker-checker expressible: a billing
  // clerk prepares the month, a finance lead issues it.
  //
  // Deliberately not `org:settings:write` (where billing rules and exchange
  // rates ride): those restate the org's own figures once, while raising
  // invoices is monthly operational work that must not require handing someone
  // SSO, seats and the org's whole money story.
  "GET /managed-accounts": "invoices:read",
  // The finder and the preview are cost breakdowns of the whole org: the
  // handler checks `invoices:read` too, like `POST /billing-rules/preview`.
  "GET /managed-accounts/unassigned": "costs:read",
  "POST /managed-accounts/assignments/preview": "costs:read",
  "POST /managed-accounts/assignments": "invoices:write",
  "GET /managed-accounts/{id}": "invoices:read",
  "POST /managed-accounts": "invoices:write",
  "PUT /managed-accounts/{id}": "invoices:write",
  "DELETE /managed-accounts/{id}": "invoices:write",
  "GET /invoices": "invoices:read",
  "GET /invoices/{id}": "invoices:read",
  "GET /invoices/{id}/export": "invoices:read",
  "GET /invoices/{id}/pdf": "invoices:read",
  "GET /billing-profiles": "invoices:read",
  "GET /billing-profiles/{id}": "invoices:read",
  "POST /billing-profiles": "invoices:write",
  "PUT /billing-profiles/{id}": "invoices:write",
  "DELETE /billing-profiles/{id}": "invoices:write",
  "POST /invoices": "invoices:write",
  "PUT /invoices/{id}": "invoices:write",
  "DELETE /invoices/{id}": "invoices:write",
  "POST /invoices/{id}/approve": "invoices:issue",
  "POST /invoices/{id}/send": "invoices:issue",
  "POST /invoices/{id}/void": "invoices:issue",
  // resources
  "GET /resources/{pluginId}/{typeId}/detail": "resources:read",
  "GET /resources/{pluginId}/{typeId}/manifest": "resources:read",
  "POST /resources/{pluginId}/{typeId}/manifest": "resources:write",
  "POST /resources/{pluginId}/import-yaml": "resources:write",
  "POST /resources/{pluginId}/{typeId}/describe": "resources:read",
  "POST /resources/{pluginId}/{typeId}/logs": "resources:read",
  "GET /resources/{pluginId}/{typeId}/secret-versions": "secrets:read",
  "POST /resources/{pluginId}/{typeId}/secret-versions/access": "secrets:read",
  "POST /resources/{pluginId}/{typeId}/secret-versions/add": "secrets:write",
  "POST /resources/{pluginId}/{typeId}/secret-versions/modify": "secrets:write",
  "DELETE /resources/{pluginId}/{typeId}": "resources:delete",
  "POST /resources/invoke-action": "resources:write",
  "GET /resources/ssh-install/accounts": "resources:read",
  // Also needs resources:write; the route checks both (see its description).
  "POST /resources/ssh-install": "resources:execute",
  "POST /resources/nosql-command": "resources:execute",
  "POST /resources/attach": "resources:write",
  "POST /resources/{pluginId}/{typeId}/export-credential": "secrets:read",
  "POST /resources/{pluginId}/{typeId}/export-terraform": "resources:read",
  "POST /resources/create": "resources:write",
  "POST /resources/create-config": "resources:write",
  "POST /resources/picker-resources": "resources:read",
  "POST /resources/create-pricing": "resources:read",
  "POST /resources/cost-estimate": "resources:read",
  "POST /resources/{pluginId}/{typeId}/peer-panes": "resources:read",
  "POST /resources/{pluginId}/{typeId}/metrics": "resources:read",
  // costs
  "POST /costs/query": "costs:read",
  "POST /costs/focus-export": "costs:read",
  // background export jobs: the focus-export download's asynchronous sibling,
  // each visible to its creator only.
  "POST /costs/exports/jobs": "costs:read",
  "GET /costs/exports/jobs": "costs:read",
  "GET /costs/exports/jobs/{jobId}": "costs:read",
  "GET /costs/exports/jobs/{jobId}/download": "costs:read",
  "DELETE /costs/exports/jobs/{jobId}": "costs:read",
  // report anomaly alerts: reads ride the report; writes are the report
  // schedules' org:settings:write (destinations include arbitrary email).
  "GET /cost-reports/{id}/anomaly-alert": "costs:read",
  "GET /cost-reports/{id}/anomaly-alert/targets": "org:settings:write",
  "PUT /cost-reports/{id}/anomaly-alert": "org:settings:write",
  "DELETE /cost-reports/{id}/anomaly-alert": "org:settings:write",
  "GET /cost-report-anomaly-alerts": "costs:read",
  "GET /costs/dimensions": "costs:read",
  "GET /costs/status": "costs:read",
  "GET /costs/anomalies": "costs:read",
  "GET /costs/anomaly-settings": "costs:read",
  // Retuning detection changes what the org's whole cost feed alerts on, so it
  // rides the cost write scope rather than the budget one.
  "PUT /costs/anomaly-settings": "costs:write",
  // efficiency alerts: commitment expiry, idle commitments, unit-cost
  // regression. Same split as anomaly settings and for the same reason:
  // reading what fired is cost data, retuning it changes what the org's whole
  // cost feed alerts on.
  "GET /costs/efficiency-alerts": "costs:read",
  "GET /costs/efficiency-alert-settings": "costs:read",
  "PUT /costs/efficiency-alert-settings": "costs:write",
  "POST /costs/rows": "costs:write",
  // cost canvases: the cost report rules, plus chat:write for the routes that open
  // a conversation (checked in the route; the table holds one permission).
  "GET /cost-canvases": "costs:read",
  "POST /cost-canvases": "costs:write",
  "POST /cost-canvases/draft": "costs:write",
  "POST /cost-canvases/preview": "costs:read",
  "GET /cost-canvases/{id}": "costs:read",
  "PUT /cost-canvases/{id}": "costs:write",
  "DELETE /cost-canvases/{id}": "costs:write",
  "POST /cost-canvases/{id}/run": "costs:read",
  "POST /cost-canvases/{id}/conversation": "costs:write",
  "GET /cost-canvases/{id}/pdf": "costs:read",
  "GET /cost-canvases/{id}/notifications": "costs:read",
  "GET /cost-canvases/{id}/notifications/targets": "org:settings:write",
  "POST /cost-canvases/{id}/notifications": "org:settings:write",
  "PUT /cost-canvases/{id}/notifications/{notificationId}": "org:settings:write",
  "DELETE /cost-canvases/{id}/notifications/{notificationId}": "org:settings:write",
  "POST /cost-canvases/{id}/notifications/{notificationId}/send": "org:settings:write",
  // Kubernetes efficiency reports: the cost report rules.
  "GET /k8s-efficiency-reports": "costs:read",
  "POST /k8s-efficiency-reports": "costs:write",
  "GET /k8s-efficiency-reports/options": "costs:read",
  "GET /k8s-efficiency-reports/values": "costs:read",
  "POST /k8s-efficiency-reports/query": "costs:read",
  "GET /k8s-efficiency-reports/{id}": "costs:read",
  "PUT /k8s-efficiency-reports/{id}": "costs:write",
  "DELETE /k8s-efficiency-reports/{id}": "costs:write",
  "POST /k8s-efficiency-reports/{id}/run": "costs:read",
  "GET /k8s-efficiency-reports/{id}/export": "costs:read",
  // report delivery schedules; reads ride costs:read (mobile shows them
  // read-only), but writes and "send now" are org:settings:write, the
  // cost-exports reasoning: a schedule is standing authorisation to ship org
  // spend to destinations the creator picks, and its email list is
  // arbitrary-address egress. One permission for all writes rather than one
  // per transport, so adding an email address can never be a silent
  // escalation of a costs:write schedule.
  "GET /cost-reports/{id}/notifications": "costs:read",
  "GET /cost-reports/{id}/notifications/targets": "org:settings:write",
  "POST /cost-reports/{id}/notifications": "org:settings:write",
  "PUT /cost-reports/{id}/notifications/{notificationId}": "org:settings:write",
  "DELETE /cost-reports/{id}/notifications/{notificationId}": "org:settings:write",
  "POST /cost-reports/{id}/notifications/{notificationId}/send": "org:settings:write",
  "GET /cost-report-notifications": "costs:read",
  "GET /cost-reports/{id}/pdf": "costs:read",
  "GET /dashboards/{id}/pdf": "dashboards:read",
  "GET /dashboards/{id}/notifications": "dashboards:read",
  "GET /dashboards/{id}/notifications/targets": "org:settings:write",
  "POST /dashboards/{id}/notifications": "org:settings:write",
  "PUT /dashboards/{id}/notifications/{notificationId}": "org:settings:write",
  "DELETE /dashboards/{id}/notifications/{notificationId}": "org:settings:write",
  "POST /dashboards/{id}/notifications/{notificationId}/send": "org:settings:write",
  "GET /dashboard-notifications": "dashboards:read",
  // business metrics: the denominators unit costs divide by. Reads are
  // costs:read and writes costs:write, matching saved filters and the cost
  // push endpoint: a metric is a statement about cost data, not dashboard
  // furniture. The unit-cost query is a POST but computes nothing stored,
  // so it reads.
  "GET /business-metrics": "costs:read",
  "POST /business-metrics": "costs:write",
  "GET /business-metrics/{id}": "costs:read",
  "PUT /business-metrics/{id}": "costs:write",
  "DELETE /business-metrics/{id}": "costs:write",
  "GET /business-metrics/{id}/values": "costs:read",
  "POST /business-metrics/{id}/values": "costs:write",
  "GET /business-metrics/{id}/forecast-values": "costs:read",
  "POST /business-metrics/{id}/forecast-values": "costs:write",
  "DELETE /business-metrics/{id}/forecast-values": "costs:write",
  "POST /business-metrics/{id}/unit-costs": "costs:read",
  "POST /business-metrics/{id}/unit-costs/export": "costs:read",
  "POST /business-metrics/usage-unit-costs/export": "costs:read",
  // importers: writes also check costs:write; the map records the stronger
  // permission, since an importer runs a query with an account's credentials.
  "GET /business-metrics/importer-sources": "costs:read",
  "POST /business-metrics/importer-options": "resources:execute",
  "POST /business-metrics/importer-preview": "resources:execute",
  "GET /business-metrics/{id}/importer": "costs:read",
  "PUT /business-metrics/{id}/importer": "resources:execute",
  "DELETE /business-metrics/{id}/importer": "costs:write",
  "POST /business-metrics/{id}/importer/run": "resources:execute",
  "GET /business-metrics/{id}/importer/runs": "costs:read",
  // resource reports; cost and virtual tag cells additionally need costs:read
  // (checked in the service: without it they come back empty, not 403).
  "GET /resource-reports": "resources:read",
  "POST /resource-reports": "resources:write",
  "GET /resource-reports/folders": "resources:read",
  "GET /resource-reports/options": "resources:read",
  "GET /resource-reports/tag-values": "resources:read",
  "POST /resource-reports/query": "resources:read",
  "POST /resource-reports/csv": "resources:read",
  "GET /resource-reports/{id}": "resources:read",
  "PUT /resource-reports/{id}": "resources:write",
  "DELETE /resource-reports/{id}": "resources:write",
  "GET /resource-reports/{id}/rows": "resources:read",
  "GET /resource-reports/{id}/csv": "resources:read",
  // cost exports: reads ride costs:read like every other cost surface, but
  // writes are org:settings:write rather than costs:write. Creating an export
  // is standing authorisation to ship the org's whole billing history to a
  // destination the creator chose, on a schedule, forever; costs:write is the
  // "name a report, define a cost centre" scope, not a data-egress one. Same
  // reasoning as PUT /currency. "Run now" is a write for the same reason: it
  // pushes spend out of the product.
  "GET /cost-exports": "costs:read",
  "POST /cost-exports": "org:settings:write",
  "GET /cost-exports/{id}": "costs:read",
  "GET /cost-exports/warehouse-sinks": "org:settings:write",
  "POST /cost-exports/warehouse-options": "org:settings:write",
  "POST /cost-exports/warehouse-setup": "org:settings:write",
  "PUT /cost-exports/{id}": "org:settings:write",
  "DELETE /cost-exports/{id}": "org:settings:write",
  "POST /cost-exports/{id}/run": "org:settings:write",
  // pages
  "POST /pages": "pages:write",
  "DELETE /pages": "pages:write",
  // connection-features
  "POST /sql/query": "resources:execute",
  "POST /sql/execute": "resources:execute",
  "POST /sql/estimate": "resources:read",
  "POST /kv/command": "resources:execute",
  "POST /docker/command": "resources:execute",
  "POST /storage/list": "storage:read",
  "POST /storage/mkdir": "storage:write",
  "POST /storage/delete": "storage:write",
  "POST /artifacts/list": "storage:read",
  "POST /sftp/list": "storage:read",
  "POST /sftp/mkdir": "storage:write",
  "POST /sftp/delete": "storage:write",
  // connect
  "POST /connect/templates": "resources:read",
  "POST /connect/secret-export": "resources:write",
  "POST /connect/env-deploy": "resources:execute",
  // storage / sftp uploads & downloads
  "POST /v1/storage/upload": "storage:write",
  "GET /v1/storage/download": "storage:read",
  "POST /v1/sftp/upload": "storage:write",
  "GET /v1/sftp/download": "storage:read",
  // search; `resources:read` without `kinds=` (the original contract). With
  // `kinds=` each kind is gated by its own list route's permission and a kind
  // the caller cannot read is skipped, so the handler owns the check.
  "GET /search": "resources:read",
  // starred items: the caller's own, keyed by their user; membership only.
  "GET /starred": null,
  "PUT /starred/{kind}/{objectId}": null,
  "DELETE /starred/{kind}/{objectId}": null,
  // orphans
  "GET /orphans": "resources:read",
  // savings findings workflow: the finders' own permission to read, and
  // resources:write to change a status (archiving silences it for everyone)
  "GET /savings/findings": "resources:read",
  "POST /savings/findings/status": "resources:write",
  "GET /savings-views": "resources:read",
  "POST /savings-views": "resources:write",
  "GET /savings-views/{id}": "resources:read",
  "PUT /savings-views/{id}": "resources:write",
  "DELETE /savings-views/{id}": "resources:write",
  // idle-rule tuning: the overview explains the findings it reads beside;
  // settings and a re-scan decide what the whole org's savings list says
  "GET /idle-findings": "resources:read",
  "GET /idle-findings/settings": "org:settings:write",
  "PUT /idle-findings/settings": "org:settings:write",
  "POST /idle-findings/rescan": "org:settings:write",
  // right-sizing: the list is derived from the org's resource set like
  // orphans; prices are provider catalog rates, not the org's billing data
  "GET /rightsizing": "resources:read",
  "GET /carbon": "costs:read",
  // price catalog: provider list prices, no org billing data in it
  "GET /price-catalog/providers": "resources:read",
  "GET /price-catalog/search": "resources:read",
  "GET /price-catalog/compare": "resources:read",
  // ssh tunnels
  "POST /ssh-tunnels/create-account": "accounts:write",
  // ssh fan-out
  "GET /ssh-fanout/targets": "resources:read",
  "POST /ssh-fanout/run": "resources:execute",
  "GET /ssh-fanout/snippets": "resources:read",
  "POST /ssh-fanout/snippets": "resources:execute",
  "PUT /ssh-fanout/snippets/{id}": "resources:execute",
  "DELETE /ssh-fanout/snippets/{id}": "resources:execute",
  "POST /ssh-tunnels/open": "resources:execute",
  "POST /ssh-tunnels/close": "resources:execute",
  "GET /ssh-tunnels/active": "resources:execute",
  "POST /ssh-tunnels/exec": "resources:execute",
  // ws-token
  "POST /ws-token": "resources:execute",
  // billing
  "GET /billing/status": "billing:read",
  "POST /billing/checkout": "billing:write",
  "POST /billing/measurement-consent": "billing:write",
  "POST /billing/portal": "billing:write",
  // agent registrations and platform links (Settings → Agents)
  "GET /agent-registrations": "team:read",
  "PATCH /agent-registrations/{id}": "team:invite",
  "DELETE /agent-registrations/{id}": "team:invite",
  "GET /agent-links": "team:read",
  "DELETE /agent-links/{id}": "team:invite",
  // config as code (each route additionally checks the per-section permission
  // of every section involved: see api/routes/org-config.ts)
  "GET /config/export": "config:read",
  "POST /config/plan": "config:read",
  "POST /config/apply": "config:write",
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
  // push (device routes are user-scoped; preference/test routes are
  // membership-only self-service: no permission beyond org membership)
  "POST /push/devices": null,
  "GET /push/devices": null,
  "DELETE /push/devices/{id}": null,
  "GET /push/preferences": null,
  "PUT /push/preferences": null,
  "GET /push/recipients": "org:settings:write",
  "POST /push/test": null,
};

/**
 * Strip the org-scoping prefix so the lookup key matches the table above.
 * `/api/org/{orgId}/foo` → `/foo`; `/api/v1/sync/pull` → `/v1/sync/pull`.
 */
export function normalizePathForPermissionLookup(path: string): string {
  return path.replace(/^\/api\/org\/\{orgId\}/, "").replace(/^\/api/, "");
}
