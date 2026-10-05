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
  // deployments
  "GET /deployments/repos": "deployments:read",
  "POST /deployments/envs": "deployments:read",
  "POST /deployments/plan": "deployments:plan",
  "GET /deployments/runs": "deployments:read",
  "GET /deployments/runs/{id}": "deployments:read",
  // cost per deploy; same rule as the change feed's: deployments:read for the
  // run, costs:read for the spend it moved.
  "GET /deployments/runs/{id}/cost-impact": "costs:read",
  "POST /deployments/runs": "deployments:write",
  "POST /deployments/runs/{id}/rollback": "deployments:write",
  "GET /deployments/triggers": "deployments:read",
  "POST /deployments/triggers": "deployments:write",
  "PATCH /deployments/triggers/{id}": "deployments:write",
  "DELETE /deployments/triggers/{id}": "deployments:write",
  // dashboards
  "GET /dashboards": "dashboards:read",
  "POST /dashboards": "dashboards:write",
  "GET /dashboards/{id}": "dashboards:read",
  "GET /dashboards/default/full": "dashboards:read",
  "POST /dashboards/{id}/rename": "dashboards:write",
  "DELETE /dashboards/{id}": "dashboards:write",
  "POST /dashboards/pin": "dashboards:write",
  "POST /dashboards/{id}/reorder": "dashboards:write",
  "POST /dashboards/unpin": "dashboards:write",
  "POST /dashboards/validate-tabs": "dashboards:read",
  "GET /dashboards/pin/{pinId}": "dashboards:read",
  "POST /dashboards/probe": "dashboards:read",

  // workflow approvals: listing rides on the same permission as the Workflows
  // tab; deciding is its own trust level (see routes/workflow-approvals.ts).
  "GET /workflow-approvals": "workflows:read",
  "POST /workflow-approvals/{id}/approve": "workflows:approve",
  "POST /workflow-approvals/{id}/deny": "workflows:approve",
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
  // workflows: typings rides workflows:read (same as the editor/tool path);
  // the schedule sub-resource is a workflow edit (a schedule is what makes a
  // workflow run unattended), so it takes the workflow permissions.
  "GET /workflows/{id}/typings": "workflows:read",
  "GET /workflows/{id}/secrets": "secrets:read",
  "PUT /workflows/{id}/secrets": "workflows:write",
  "GET /workflows/{id}/schedule": "workflows:read",
  "PUT /workflows/{id}/schedule": "workflows:write",
  "DELETE /workflows/{id}/schedule": "workflows:write",
  "GET /workflow-secrets": "secrets:read",
  "POST /workflow-secrets": "secrets:write",
  "PATCH /workflow-secrets/{id}": "secrets:write",
  "PUT /workflow-secrets/{id}/value": "secrets:write",
  "DELETE /workflow-secrets/{id}": "secrets:write",
  "POST /chat/conversations/{conversationId}/pending/{pendingId}/answer": "chat:write",
  // agents
  "GET /agents/accounts": "accounts:read",
  "GET /agents/settings": "accounts:read",
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
  // expiry radar: the feed is a read over the org's resource set; the alert
  // settings decide what the org's channels hear, the same trust level as the
  // drift alert settings
  "GET /expiring": "resources:read",
  // The moment union spans six read scopes; `resources:read` is the floor:
  // feeds needing more (costs, workflows, deployments, audit, freezes) are
  // omitted per-feed rather than gating the whole endpoint.
  "GET /moment": "resources:read",
  "GET /expiring/settings": "org:settings:write",
  "PUT /expiring/settings": "org:settings:write",
  // quota radar: the feed is a read over already-collected readings; the
  // threshold decides what the org's channels hear, the same trust level as
  // the expiry alert settings next door
  "GET /quotas": "resources:read",
  "GET /quotas/settings": "org:settings:write",
  "PUT /quotas/settings": "org:settings:write",
  "GET /extended-support": "resources:read",
  "GET /extended-support/settings": "org:settings:write",
  "PUT /extended-support/settings": "org:settings:write",
  "GET /posture": "resources:read",
  "POST /posture/dismissals": "resources:write",
  "DELETE /posture/dismissals": "resources:write",
  // cross-cloud access review; the posture stance exactly: the review and its
  // export are reads over the org's resource set, and accepting a finding is a
  // statement about one resource at the same trust level as changing it. There
  // is no settings route: the findings ride the posture alert window, so
  // /posture/settings is the one switch.
  "GET /access-review": "resources:read",
  "GET /access-review/export": "resources:read",
  "POST /access-review/dismissals": "resources:write",
  "DELETE /access-review/dismissals": "resources:write",
  "GET /dns": "resources:read",
  // Environment diff: pure read over two accounts' already-synced inventories.
  "GET /environment-diff": "resources:read",
  "GET /posture/settings": "org:settings:write",
  "PUT /posture/settings": "org:settings:write",
  // sleep/wake schedules: reads ride the resource read scope (the list is
  // derived from the org's resource set, like orphans); mutations are a
  // standing instruction to invoke the same actions `resources:write` already
  // gates on /resources/invoke-action
  "GET /schedules": "resources:read",
  "POST /schedules": "resources:write",
  "POST /schedules/preview": "resources:read",
  "PUT /schedules/{scheduleId}": "resources:write",
  "DELETE /schedules/{scheduleId}": "resources:write",
  // resource leases; the schedules stance: reads are a view over the org's
  // resource set; mutations are resources:write. Setting autoDelete: true
  // additionally requires resources:delete (checked in the handler; the
  // lease becomes a standing deletion), which this one-permission-per-route
  // map cannot express.
  // ephemeral environments; the leases stance: reads are a view over the org's
  // own resources, template edits are writes, teardown is a delete, and
  // instantiation needs both (every instance carries a standing auto-delete).
  // The TTL ceiling is org settings, not a resource edit.
  "GET /environments/settings": "resources:read",
  "PUT /environments/settings": "org:settings:write",
  "POST /environments/capture": "resources:read",
  "GET /environments/templates": "resources:read",
  "POST /environments/templates": "resources:write",
  "GET /environments/templates/{templateId}": "resources:read",
  "PUT /environments/templates/{templateId}": "resources:write",
  "DELETE /environments/templates/{templateId}": "resources:write",
  "POST /environments/templates/{templateId}/estimate": "resources:read",
  "POST /environments/templates/{templateId}/instantiate": "resources:write",
  "GET /environments/instances": "resources:read",
  "GET /environments/instances/{instanceId}": "resources:read",
  "POST /environments/instances/{instanceId}/teardown": "resources:delete",
  "DELETE /environments/instances/{instanceId}": "resources:write",
  "GET /leases": "resources:read",
  "GET /leases/resource": "resources:read",
  "POST /leases": "resources:write",
  "PUT /leases/{leaseId}": "resources:write",
  "POST /leases/{leaseId}/cancel": "resources:write",
  "DELETE /leases/{leaseId}": "resources:write",
  // session recordings; their own permission family rather than `audit:read`
  // or `ssh-keys:*`: watching a colleague's terminal back is a sharper
  // capability than either, and the people who should hold it (compliance,
  // security) are often not the people who administer keys. Deliberately
  // absent from the `member` system role: recording exists to watch
  // operators, so handing every operator the ability to watch defeats it.
  // break-glass access: three verbs held by genuinely different people.
  // `access:approve` is deliberately not implied by `team:role:write`: granting
  // a role is a considered change, approving an elevation happens mid-incident.
  // `revoke` has no entry because its permission depends on who is calling
  // (the holder may always end their own grant) which this one-permission-per
  // -route map cannot express; the handler owns it.
  // credential hygiene: `audit:read`, not a family of its own. Every fact in
  // the report is already reachable by anyone who can read the audit log, so a
  // separate permission would only mean granting two things to get one view.
  // credit burndown: `costs:read`. A prepaid balance is spend information,
  // and the permission that already governs "what is this costing us" is the
  // one that should govern "how much is left".
  "GET /credits": "costs:read",
  "GET /commitments": "costs:read",
  "GET /network-flows": "costs:read",
  "GET /network-flows/settings": "costs:read",
  // Not `costs:write`: enabling collection spends the organization's money in
  // its own cloud account every day until somebody turns it off, which is a
  // governance act rather than an edit to a cost object.
  "PUT /network-flows/settings": "org:settings:write",
  // Kubernetes network costs. The per-cluster billed source changes how money
  // is *shown*, never what is collected or spent, so it is a cost-object edit.
  "GET /network-flows/kubernetes/{accountId}": "costs:read",
  "GET /network-flows/kubernetes/{accountId}/settings": "costs:read",
  "PUT /network-flows/kubernetes/{accountId}/settings": "costs:write",
  "GET /credential-hygiene": "audit:read",
  "GET /access-requests": "access:read",
  "GET /access-requests/catalog": "access:read",
  "POST /access-requests": "access:request",
  "POST /access-requests/{requestId}/approve": "access:approve",
  "POST /access-requests/{requestId}/deny": "access:approve",
  "POST /access-requests/{requestId}/withdraw": "access:request",
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
  // synthetic probes; the schedules stance: reads (list, suggestions mined
  // from resource outputs, recorded series) ride the resource read scope;
  // mutations are resources:write
  "GET /probes": "resources:read",
  "GET /probes/suggestions": "resources:read",
  "GET /probes/{probeId}/metrics": "resources:read",
  "POST /probes": "resources:write",
  "PUT /probes/{probeId}": "resources:write",
  "DELETE /probes/{probeId}": "resources:write",
  // incident mode: the declared kind. `incidents:write` is held by members
  // as well as admins on purpose (see the permission catalog); what a
  // declaration may *do* keeps its own gates, so requesting a change freeze
  // still needs freezes:write.
  "GET /incidents": "incidents:read",
  "GET /incidents/{incidentId}": "incidents:read",
  "GET /incidents/{incidentId}/timeline": "incidents:read",
  "GET /incidents/{incidentId}/postmortem": "incidents:read",
  "POST /incidents": "incidents:write",
  "PATCH /incidents/{incidentId}": "incidents:write",
  "DELETE /incidents/{incidentId}": "incidents:write",
  "POST /incidents/{incidentId}/retry-artifacts": "incidents:write",
  "POST /incidents/{incidentId}/notes": "incidents:write",
  "DELETE /incidents/{incidentId}/notes/{noteId}": "incidents:write",
  // status pages: a page is a view over probes, so it rides the probe stance:
  // whoever may create the monitoring may decide what of it is public.
  // GET /api/status/{slug} is deliberately absent: it is mounted outside the
  // org tree and takes no credentials at all.
  "GET /status-pages": "resources:read",
  "POST /status-pages": "resources:write",
  "PUT /status-pages/{id}": "resources:write",
  "POST /status-pages/{id}/rotate-slug": "resources:write",
  "DELETE /status-pages/{id}": "resources:write",
  // resource ownership: the leases stance. Note /ownership/members is
  // resources:read, not team:read: the person who can create a resource must
  // be able to say it is theirs.
  "GET /ownership": "resources:read",
  "GET /ownership/members": "resources:read",
  "GET /ownership/resource": "resources:read",
  "PUT /ownership": "resources:write",
  "DELETE /ownership": "resources:write",
  // log workspace saved queries; the schedules stance: reads are a view over
  // the org's resource logs (which resources:read already gates via
  // /resources/{pluginId}/{typeId}/logs); mutations are resources:write
  "GET /log-workspaces": "resources:read",
  "GET /log-workspaces/resources": "resources:read",
  "POST /log-workspaces": "resources:write",
  "PUT /log-workspaces/{queryId}": "resources:write",
  "DELETE /log-workspaces/{queryId}": "resources:write",
  // tag policy & showback: policy is org settings; compliance/untagged ride
  // the resource/cost read scopes their data is computed over
  "GET /tag-policy": "resources:read",
  "PUT /tag-policy": "org:settings:write",
  "GET /tag-policy/compliance": "resources:read",
  // tag key settings: a display preference over every picker, so reads ride
  // resources:read like the policy; GET /tag-keys adds cost usage only when the
  // caller also holds costs:read
  "GET /tag-keys": "resources:read",
  "GET /tag-keys/settings": "resources:read",
  "PUT /tag-keys/settings": "org:settings:write",
  "GET /costs/untagged": "costs:read",
  "GET /costs/showback": "costs:read",
  // currency: reads ride costs:read because a converted total is unauditable
  // without the rate that produced it; writes are org:settings:write because
  // stating a rate restates every total the org reports, in digests and in the
  // budget alerts that page people. Finance governance, not a user preference.
  "GET /currency": "costs:read",
  "PUT /currency": "org:settings:write",
  "PUT /currency/rates": "org:settings:write",
  "DELETE /currency/rates/{rateId}": "org:settings:write",
  // cost centres & allocation rules
  // billing rules: the org's own adjustments to collected spend.
  //
  // Reads ride `costs:read` like every other cost surface: a rule is part of
  // the explanation for a number, and hiding it from the people who read the
  // number would make every adjusted figure unauditable.
  //
  // Writes are `org:settings:write`, deliberately **not** `costs:write`.
  // `costs:write` is the "name a report, define a cost centre, save a filter"
  // scope: acts that add a view of the org's spend. A billing rule is not a
  // view: a markup changes what every internal figure in the organisation
  // says, including an opted-in budget's thresholds and the chargeback
  // statements finance sends to other departments. Same reasoning as
  // `PUT /currency` (stating a rate restates every total) and
  // `POST /cost-exports` (standing authorisation to ship the billing history),
  // which puts all three "this changes the org's money story" acts behind one
  // scope.
  "GET /billing-rules": "costs:read",
  "GET /billing-rules/{id}": "costs:read",
  "POST /billing-rules": "org:settings:write",
  "POST /billing-rules/preview": "costs:read",
  "POST /billing-rules/reorder": "org:settings:write",
  "PUT /billing-rules/{id}": "org:settings:write",
  "DELETE /billing-rules/{id}": "org:settings:write",
  // virtual tags: a way to slice spend that never changes how much there is
  // (splits are weighted, totals conserved), so the cost-centre scope, not
  // the billing-rule one.
  "GET /virtual-tags": "costs:read",
  "GET /virtual-tags/{id}": "costs:read",
  "POST /virtual-tags/preview": "costs:read",
  "POST /virtual-tags": "costs:write",
  "PUT /virtual-tags/{id}": "costs:write",
  "POST /virtual-tags/{id}/reprocess": "costs:write",
  "DELETE /virtual-tags/{id}": "costs:write",
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
  "GET /managed-accounts/{id}": "invoices:read",
  "POST /managed-accounts": "invoices:write",
  "PUT /managed-accounts/{id}": "invoices:write",
  "DELETE /managed-accounts/{id}": "invoices:write",
  "GET /invoices": "invoices:read",
  "GET /invoices/{id}": "invoices:read",
  "GET /invoices/{id}/export": "invoices:read",
  "POST /invoices": "invoices:write",
  "PUT /invoices/{id}": "invoices:write",
  "DELETE /invoices/{id}": "invoices:write",
  "POST /invoices/{id}/approve": "invoices:issue",
  "POST /invoices/{id}/send": "invoices:issue",
  "POST /invoices/{id}/void": "invoices:issue",
  "GET /cost-centres": "costs:read",
  "POST /cost-centres": "costs:write",
  "PUT /cost-centres/{id}": "costs:write",
  "DELETE /cost-centres/{id}": "costs:write",
  "GET /cost-centres/rules": "costs:read",
  "POST /cost-centres/rules": "costs:write",
  "POST /cost-centres/rules/swap": "costs:write",
  "PUT /cost-centres/rules/{id}": "costs:write",
  "DELETE /cost-centres/rules/{id}": "costs:write",
  // Custom cost sources: an upload is the same act as `POST /costs/rows`, so
  // it rides the same `costs:write`.
  "GET /custom-cost-sources": "costs:read",
  "POST /custom-cost-sources": "costs:write",
  "GET /custom-cost-sources/{id}": "costs:read",
  "PUT /custom-cost-sources/{id}": "costs:write",
  "DELETE /custom-cost-sources/{id}": "costs:write",
  "GET /custom-cost-sources/{id}/uploads": "costs:read",
  "POST /custom-cost-sources/{id}/uploads": "costs:write",
  "POST /custom-cost-sources/{id}/uploads/{uploadId}/rows": "costs:write",
  "POST /custom-cost-sources/{id}/uploads/{uploadId}/complete": "costs:write",
  "DELETE /custom-cost-sources/{id}/uploads/{uploadId}": "costs:write",
  // jira: read covers the redacted connection, the pickers, and the
  // finding→issue links a list view needs; write covers configuring the
  // credential and filing.
  "GET /jira": "jira:read",
  "PUT /jira": "jira:write",
  "DELETE /jira": "jira:write",
  "POST /jira/verify": "jira:write",
  "GET /jira/projects": "jira:read",
  "GET /jira/projects/{key}/issue-types": "jira:read",
  "POST /jira/issues": "jira:write",
  "GET /jira/links": "jira:read",
  // linear; the same split as jira, for the same reasons: read covers the
  // redacted connection, the team picker, and the finding→issue links; write
  // covers configuring the API key and filing.
  "GET /linear": "linear:read",
  "PUT /linear": "linear:write",
  "DELETE /linear": "linear:write",
  "POST /linear/verify": "linear:write",
  "GET /linear/teams": "linear:read",
  "POST /linear/issues": "linear:write",
  "GET /linear/links": "linear:read",
  // github issues; reads take read, filing and pull requests take write, and
  // the settings document (which holds the pull-request switch) takes
  // org:settings:write.
  "GET /github-issues": "github-issues:read",
  "PUT /github-issues/settings": "org:settings:write",
  "GET /github-issues/labels": "github-issues:read",
  "GET /github-issues/assignees": "github-issues:read",
  "GET /github-issues/route": "github-issues:read",
  "GET /github-issues/branches": "github-issues:read",
  "POST /github-issues/issues": "github-issues:write",
  "GET /github-issues/links": "github-issues:read",
  "POST /github-issues/pull-requests/preview": "github-issues:write",
  "POST /github-issues/pull-requests": "github-issues:write",
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
  "GET /costs/dimensions": "costs:read",
  "GET /costs/status": "costs:read",
  "GET /costs/anomalies": "costs:read",
  "GET /costs/anomaly-settings": "costs:read",
  // Retuning detection changes what the org's whole cost feed alerts on, so it
  // rides the cost write scope rather than the budget one.
  "PUT /costs/anomaly-settings": "costs:write",
  // anomaly feedback: verdicts and suppressions change what the cost feed
  // alerts on, so they ride the same write scope as the settings.
  "POST /costs/anomalies/{anomalyId}/feedback": "costs:write",
  "DELETE /costs/anomalies/{anomalyId}/feedback": "costs:write",
  "GET /costs/anomaly-suppressions": "costs:read",
  "POST /costs/anomaly-suppressions": "costs:write",
  "GET /costs/anomaly-suppressions/{suppressionId}": "costs:read",
  "PUT /costs/anomaly-suppressions/{suppressionId}": "costs:write",
  "DELETE /costs/anomaly-suppressions/{suppressionId}": "costs:write",
  "GET /costs/anomaly-sensitivity": "costs:read",
  "GET /costs/anomaly-precision": "costs:read",
  // efficiency alerts: commitment expiry, idle commitments, unit-cost
  // regression. Same split as anomaly settings and for the same reason:
  // reading what fired is cost data, retuning it changes what the org's whole
  // cost feed alerts on.
  "GET /costs/efficiency-alerts": "costs:read",
  "GET /costs/efficiency-alert-settings": "costs:read",
  "PUT /costs/efficiency-alert-settings": "costs:write",
  "POST /costs/rows": "costs:write",
  // cost reports: a report is cost data under a name, so it follows the cost
  // permissions rather than the dashboard ones. Running one is a read.
  // A note on a fired budget alert creates a cost annotation, so it takes the
  // annotation scope (the handler also requires budgets:read).
  "POST /budgets/{id}/events/{eventId}/note": "costs:write",
  "GET /cost-reports": "costs:read",
  "POST /cost-reports": "costs:write",
  "POST /cost-reports/bulk": "costs:write",
  "GET /cost-reports/{id}": "costs:read",
  "PUT /cost-reports/{id}": "costs:write",
  "DELETE /cost-reports/{id}": "costs:write",
  "POST /cost-reports/{id}/run": "costs:read",
  // cost canvases: the report rules, plus chat:write for the routes that open
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
  // cost annotations: dated notes drawn over a chart. Reads ride costs:read
  // and writes costs:write, exactly as reports do: a note about spend is cost
  // data with words on it, not dashboard furniture.
  "GET /cost-annotations": "costs:read",
  "POST /cost-annotations": "costs:write",
  "POST /cost-annotations/change-impact": "costs:write",
  "PUT /cost-annotations/{id}": "costs:write",
  "DELETE /cost-annotations/{id}": "costs:write",
  // change-based cost alerts: a cost-scoped alert config, so it rides the
  // cost scopes the way reports do.
  "GET /cost-alerts": "costs:read",
  "POST /cost-alerts": "costs:write",
  "GET /cost-alerts/events": "costs:read",
  "GET /cost-alerts/{id}": "costs:read",
  "PUT /cost-alerts/{id}": "costs:write",
  "DELETE /cost-alerts/{id}": "costs:write",
  // saved cost filters: a named filter is a statement about cost data, so it
  // rides the cost scopes exactly as reports do. DELETE additionally answers
  // 409 while the filter is referenced; that is policy, not permission.
  "GET /saved-cost-filters": "costs:read",
  "POST /saved-cost-filters": "costs:write",
  "GET /saved-cost-filters/{id}": "costs:read",
  "PUT /saved-cost-filters/{id}": "costs:write",
  "DELETE /saved-cost-filters/{id}": "costs:write",
  "GET /saved-cost-filters/{id}/referents": "costs:read",
  "GET /cost-scenarios": "costs:read",
  "POST /cost-scenarios": "costs:write",
  "GET /cost-scenarios/{id}": "costs:read",
  "PUT /cost-scenarios/{id}": "costs:write",
  "DELETE /cost-scenarios/{id}": "costs:write",
  "GET /cost-scenarios/{id}/referents": "costs:read",
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
  "POST /business-metrics/{id}/unit-costs": "costs:read",
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
  // cost-report folders organize the Reports list and nothing else, so they
  // ride the same scopes the reports do.
  "GET /cost-report-folders": "costs:read",
  "POST /cost-report-folders": "costs:write",
  "PUT /cost-report-folders/{id}": "costs:write",
  "DELETE /cost-report-folders/{id}": "costs:write",
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
  // associations
  "POST /associations": "secrets:write",
  "POST /associations/literal": "secrets:write",
  "GET /dependency-graph": "resources:read",
  "GET /blast-radius": "resources:read",
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
  // search
  "GET /search": "resources:read",
  // orphans
  "GET /orphans": "resources:read",
  // right-sizing: the list is derived from the org's resource set like
  // orphans; prices are provider catalog rates, not the org's billing data
  "GET /rightsizing": "resources:read",
  "GET /carbon": "costs:read",
  // price catalog: provider list prices, no org billing data in it
  "GET /price-catalog/providers": "resources:read",
  "GET /price-catalog/search": "resources:read",
  "GET /price-catalog/compare": "resources:read",
  // ssh keys
  "GET /ssh-keys": "ssh-keys:read",
  "POST /ssh-keys": "ssh-keys:write",
  "POST /ssh-keys/import": "ssh-keys:write",
  "DELETE /ssh-keys/{id}": "ssh-keys:write",
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
  // bastions
  "GET /bastions": "bastions:read",
  "POST /bastions": "bastions:write",
  "DELETE /bastions/{id}": "bastions:write",
  // ws-token
  "POST /ws-token": "resources:execute",
  // team & roles
  "GET /team/me": null,
  "GET /team/permissions": "team:read",
  "GET /team/roles": "team:read",
  "POST /team/roles": "team:role:write",
  "PATCH /team/roles/{id}": "team:role:write",
  "DELETE /team/roles/{id}": "team:role:write",
  "GET /team/members": "team:read",
  "GET /team/invitations": "team:read",
  "POST /team/invitations": "team:invite",
  "DELETE /team/members/{id}": "team:remove",
  "PATCH /team/members/{id}/role": "team:role:write",
  "DELETE /team/invitations/{id}": "team:invite",
  // billing
  "GET /billing/status": "billing:read",
  "POST /billing/checkout": "billing:write",
  "POST /billing/portal": "billing:write",
  // audit
  "GET /audit-logs": "audit:read",
  // change freezes
  "GET /change-freezes": "freezes:read",
  "GET /change-freezes/status": "freezes:read",
  "POST /change-freezes": "freezes:write",
  "PUT /change-freezes/{id}": "freezes:write",
  "POST /change-freezes/{id}/end": "freezes:write",
  "DELETE /change-freezes/{id}": "freezes:write",
  // api keys
  "POST /api-keys": "apikeys:write",
  "GET /api-keys": "apikeys:read",
  "POST /api-keys/{id}/revoke": "apikeys:write",
  "POST /api-keys/{id}/rotate": "apikeys:write",
  // config as code (each route additionally checks the per-section permission
  // of every section involved: see api/routes/org-config.ts)
  "GET /config/export": "config:read",
  "POST /config/plan": "config:read",
  "POST /config/apply": "config:write",
  // sync (bearer-auth, scopes mirror permissions)
  "POST /v1/sync/pull": "resources:read",
  "POST /v1/sync/push": "resources:write",
  "GET /v1/sync/status": "resources:read",
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
