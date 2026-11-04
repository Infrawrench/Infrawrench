---
title: MCP server
description: Use Infrawrench from Claude Desktop, Cursor, or any other Model Context Protocol client.
sidebar_order: 11
---

Infrawrench has a hosted [Model Context Protocol](https://modelcontextprotocol.io/) server at `/api/mcp`. Point an MCP client (Claude Desktop, Cursor, the MCP CLI, your own LLM agent) at it and the model can list, search, inspect, create and edit resources in your organization, using your provider credentials. Every change is recorded in the [audit log](../team-and-billing/audit-log.md).

## Endpoint

```
POST https://app.infrawrench.com/api/mcp
```

The transport is **Streamable HTTP**, so you don't need a WebSocket or stdio bridge. The server supports both current protocol generations and answers in whichever one your client uses:

- **2026-07-28** (the current revision): stateless per-request negotiation, `server/discover`, and the per-request `_meta` envelope. New clients need no handshake.
- **2025-11-25 and earlier:** the classic `initialize` handshake, with plain JSON response bodies (`enableJsonResponse: true`). Existing clients keep working unchanged.

## Sign in

Authentication is OAuth via WorkOS AuthKit, following [RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728), so any OAuth-capable MCP client works:

1. The client makes an unauthenticated request to `/api/mcp`.
2. The server replies `401 Unauthorized` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
3. The client fetches the metadata, finds the authorization server, identifies itself (see below) and asks you to sign in.
4. The client retries with `Authorization: Bearer <token>`.

The token is checked on every request, and each MCP connection only sees organizations you're a member of.

### How clients identify themselves

All three client registration methods work. Clients pick whichever the authorization server advertises, preferring the first:

- **Client ID Metadata Documents** (the current standard): the client's `client_id` is an HTTPS URL hosting its own metadata document. No registration step, and the same `client_id` works across servers.
- **Dynamic Client Registration** (deprecated by the 2026-07-28 spec, still fully supported): the client registers itself at the authorization server's `registration_endpoint` before the first sign-in. Older clients keep working unchanged.
- **Manual pre-registration:** register an OAuth client in the WorkOS Dashboard yourself and paste its client ID into your MCP client's connector settings.

### Choosing an organization

MCP clients have no organization picker, so the server picks one:

- If your token includes an `org_id`, that organization is used (after checking you're a member).
- Otherwise, the **oldest organization you belong to** is the default for the connection.

To work in a different organization, pass the optional **`org_id`** that every tool accepts. Call `list_organizations` to see your options:

```json
[
  { "org_id": "org_01H…", "name": "Acme", "role": "owner", "default": true },
  { "org_id": "org_01J…", "name": "Side project", "role": "member", "default": false }
]
```

Then pass it on any call, for example `list_resources { "org_id": "org_01J…" }`. An `org_id` you're not a member of is refused before the tool runs.

`org_id` and `list_organizations` are **MCP only**. The [AI chat](./ai-chat.md) already knows your organization from your session.

<insert [Claude Desktop MCP settings panel showing the infrawrench server configured with the /api/mcp URL] here>

## What the model can do

The MCP server has the same tools as the [AI chat](./ai-chat.md), plus `list_organizations` (see [Choosing an organization](#choosing-an-organization)):

- **Discover:** `list_plugins`, `list_resource_types`, `list_accounts`, `list_resource_sidecars` (which extra integrations a resource offers, for example `kubernetes` on a managed cluster or `postgres` on a managed database).
- **Read:** `search_resources`, `list_resources`, `get_resource`, `get_resource_inputs`, `get_resource_outputs`, `get_resource_stats`, `get_resource_metrics`, `describe_resource`.
- **Impact:** `get_blast_radius` (what breaks if a resource is deleted: dependants, plus the dashboards, custom graphs, probes, status pages, firing metric alerts, leases, schedules, saved log queries and workflows that name it, what measurably talks to it, and its owner). Its `unchecked` field lists what the report couldn't look at. An empty dependant list next to a non-empty `unchecked` isn't a clean bill of health, and a client should say so rather than call the resource safe. See [Blast radius](./blast-radius.md).
- **Change:** `create_resource`, `delete_resource`, `invoke_action`. Use `get_blast_radius` before proposing a deletion.
- **Manifests:** `get_manifest`, `apply_manifest` (see [Manifest editor](./manifest-editor.md)).
- **Connections:** `sql_query`, `sql_execute`, `introspect_sql_schema`, `kv_command`, `docker_command`, `ssh_exec`, and the storage tools (`list_storage_objects`, `make_storage_folder`, `delete_storage_object`). `sql_query` is strictly read-only on PostgreSQL, MySQL and libSQL/Turso (one statement, in a rolled-back read-only transaction). On other engines it runs the SQL as given, and MCP has no approval step of its own, so keep your client's confirmation on for it there.
- **Costs and budgets:**
  - `query_costs`: spend over time with grouping, filters, previous-period comparison and forecasts. `measure` switches it to summed usage quantity in one `usageUnit` or to a count of distinct group values billed per bin, `binning` goes from daily to quarterly, and `cumulative` shows running totals.
  - `list_cost_dimension_values`: tag keys follow your [tag key settings](./tag-keys.md) (preferred first, hidden ones left out unless `includeHidden` is set). `usage-units` lists the usage units.
  - `get_cost_status`, `list_cost_anomalies`, and `acknowledge_cost_anomaly` (record what a spike actually was; the explanation appears as a dated note on every cost chart covering that day; see [Cost anomaly alerts](./cost-anomaly-alerts.md#explaining-an-anomaly)).
  - `give_cost_anomaly_feedback` (mark an anomaly expected or unexpected, optionally suppressing the same pattern; see [feedback](./cost-anomaly-alerts.md#expected-or-unexpected-feedback)), `list_cost_anomaly_suppressions`, `get_cost_anomaly_precision`.
  - `list_budgets`, `get_budget`, `create_budget`, `update_budget`, `delete_budget`. Budgets can limit spend or a usage quantity, use a custom or explicit period, and nest under a parent that rolls them up. `list_cost_dimension_values dimension=usage-units` lists the units.
  - `annotate_budget_alert`: explain a fired budget alert. The note is saved on the alert, shown on cost charts on that day, and posted as a reply in the alert's Slack threads. See [Explaining a budget alert](./cloud-costs.md#explaining-a-budget-alert).
  - [Tag governance](./tag-policy-and-showback.md): `get_tag_compliance`, `query_untagged_spend` and `query_showback`.
  - [AI attribution](./ai-attribution.md): `query_ai_spend_by_caller` (billed AI spend split by a caller dimension, with match rates and the unattributed remainder) and `list_ai_request_sources`.
  - `list_billing_rules`: your organization's adjustments to collected spend, which explain why an adjusted total may not match an invoice. `preview_billing_rule` tries out a rule or a customer's pricing against a month of real spend.
  - `get_currency_settings` and `lookup_exchange_rate`: the display currency, automatic ECB rates and stated rates, and which rate (with its source and date) a day of spend converts at. See [Currency](./cloud-costs.md#currency).
  - `query_costs` and `query_showback` both take `adjusted`. The tools quote collected spend unless asked otherwise, and always give both figures when they report an adjusted one. See [Cloud costs](./cloud-costs.md) and [Billing rules](./billing-rules.md).
- **Virtual tags:** `list_virtual_tags`, `preview_virtual_tag`, `create_virtual_tag`, `update_virtual_tag`, `delete_virtual_tag`. Rule-based computed tags (merged tag keys, filter-assigned values, percentage and business-metric splits). Use one in `query_costs` by grouping or filtering on the `virtual_tag` dimension. Reads need `costs:read`, writes `costs:write`. See [Virtual tags](./virtual-tags.md).
- **Managed accounts and invoices:** `list_managed_accounts`, `get_managed_account`, `list_invoices`, `get_invoice`, `list_billing_profiles`, `find_unassigned_spend`. Customers you bill for infrastructure you run for them, and their invoices. All read-only and need `invoices:read` (separate from `costs:*`, because a managed account holds a customer's contact details and quoted price). `get_invoice` shows how the total was worked out: what was collected, what billing rules added, and the exchange rate and date used, so you can answer "why is this customer being billed this". A draft's totals are `null` in the list, not zero. `list_billing_profiles` shows only the last four characters of account numbers and leaves out the logo. `find_unassigned_spend` lists the period's spend no customer is billed for, and also needs `costs:read`. See [Managed accounts & invoices](./managed-accounts.md).
- **Cost reports:** `list_cost_reports`, `get_cost_report`, `run_cost_report` (takes only an id, plus optional one-off `measure`, `usageUnit`, `binning` and `cumulative` overrides that are never saved), `forecast_cost_report` (projected spend with a low/expected/high band, using the report's default or a named forecast; see [Cost forecasts](./cost-forecasts.md)), `create_cost_report`, `update_cost_report`, `delete_cost_report`, and `bulk_move_cost_reports` / `bulk_delete_cost_reports` (many reports and folders in one all-or-nothing step). So "run the monthly spend report" needs no filters restated. See [Cost reports](./cost-reports.md).
- **Canvases:** `list_cost_canvases`, `get_cost_canvas`, `run_cost_canvas` (re-runs every saved query; `includeChartData` adds full series), `write_cost_canvas` (validated against a strict schema; no query strings), `delete_cost_canvas`. Reports built from a description that refresh without a model. See [Canvases](./ai-canvas.md).
- **Sleep schedules:** `list_schedules` (windows, next transitions, last outcomes, projected savings) and `create_schedule` (add an off-at/on-at weekly window to a stoppable resource; audit-logged). See [Sleep/wake schedules](./sleep-schedules.md).
- **Moment view:** `what_changed` (everything that happened around a timestamp, in order, across the change timeline, provider incidents, cost anomalies, workflow runs, deployments, audit entries, freezes and alert deliveries). Needs `resources:read`. Sources you can't read are reported as **omitted**, and a source that fails is reported as **errored** without losing the rest, so a client can tell a permission gap from a temporary failure. See [Investigate a moment](./moment.md).
- **Ownership:** `list_resource_ownership` (who owns each resource, what it's for, its ticket link; filter by `ownerUserId` or `unownedOnly`). A resource missing from the list is unowned, which is worth checking before proposing a deletion. See [Resource ownership](../core-concepts/resource-ownership.md).
- **Status pages:** `list_status_pages` (what monitoring is published, whether each page is live, and its slug). Treat a `published: true` page as public: anyone with the link can read it without signing in. See [Public status pages](./status-pages.md).
- **Environment diff:** `diff_environments` (compares two accounts of one provider: resource types in one and not the other, per-type count differences, and the fields where matching resources disagree). Takes the accounts by id or exact name. Use it when someone asks why one environment behaves differently from another. See [Environment diff](./environment-diff.md).
- **Right-sizing:** `list_oversized_resources` (machines whose 14-day p95 use is well under their size, with the recommended smaller size, monthly saving and estimated CO2e saving; read-only, apply resizes in the app). See [Right-sizing](./right-sizing.md).
- **Savings findings:** `list_orphaned_resources` (likely-wasted resources with the reason and owner) and `list_efficiency_alerts` (expiring and idle commitments, unit-cost regressions). Every finding from these, `list_oversized_resources` and `list_schedules` includes `remediation`: ready-to-run provider CLI commands, with destructive steps flagged and a Terraform hint for IaC-managed resources. See [Remediation commands](./remediation-commands.md).
- **Savings findings:** `list_savings_findings` (every orphaned, oversized, extended support and unused seat finding with its status, detected date and monthly saving, plus the potential, realized and savings rate summary; `resources:read`). See [Savings findings](./savings-findings.md).
- **Realized savings:** `get_realized_savings` (what resizes, orphan cleanups, sleep schedules, commitments and logged actions actually saved against their pre-action baseline, by month, action type, cost centre and account, with shortfalls flagged) and `log_saving` (record a saving by hand; `costs:write`). See [Realized savings](./realized-savings.md).
- **Carbon:** `get_carbon_estimate` (your organization's estimated CO2e by provider, region and account, with what couldn't be estimated and the assumptions) and `estimate_resource_footprint` (one resource's monthly price and estimated carbon, optionally for a proposed edit). Read-only. The organization estimate needs **Costs: read**. See [Carbon estimate](./carbon.md).
- **Price catalog:** `list_price_catalog_providers`, `search_price_catalog` (provider list prices filtered by provider, specs, GPU and max monthly price, sorted by price) and `compare_instance_prices` (the cheapest instance per provider that meets a vCPU / memory / GPU target, or matches a reference instance's specs). Read-only, **Resources: read**. See [Price catalog](./price-catalog.md).
- **Instance pricing:** `get_instance_pricing_schema` and `query_instance_pricing` (one read-only ClickHouse statement over the public instance price lists and their history: AWS, Azure virtual machines, Google Cloud machine types, Alibaba Cloud ECS and RunPod, plus AWS's public status history). No permission needed, the same as [`POST /api/v1/instance-pricing/query`](../team-and-billing/instance-pricing-api.md). These are published list prices, not your spend, and not the [price catalog](./price-catalog.md).
- **Kubernetes efficiency:** `list_kubernetes_efficiency_reports`, `run_kubernetes_efficiency_report` (a saved report's totals, per-category split and rows, each with used, unused, unmeasured, idle and overhead cost and an efficiency) and `query_kubernetes_efficiency` (the same for an unsaved report). Read-only, **Costs: read**, limited to your cost visibility. See [Kubernetes efficiency reports](./kubernetes-efficiency.md).
- **Kubernetes network costs:** `get_kubernetes_network_costs` (one cluster's traffic by class, namespace and workload, top talkers, and the billed allocation; leave out the account to list clusters; needs **Costs: read**) and `set_kubernetes_network_billed_source` (which billed cost rows are the cluster's data transfer; needs **Costs: write**). See [Kubernetes network costs](./kubernetes-costs.md#network-costs).
- **Workflows:** `list_workflows`, `get_workflow`, `get_workflow_typings` (returned in parts for large organizations: the global scope first, then named interfaces on request), `check_workflow_source`, `write_workflow`, `run_workflow`, `delete_workflow`, plus `list_workflow_secrets`, `write_workflow_secret` and `delete_workflow_secret`. Listing assigned secret metadata or typings needs `secrets:read`. Writing or deleting secret metadata needs `secrets:write`. `write_workflow` assigns reusable secret ids, and typings expose only those names under `infra.secrets`. See [Writing workflows with an AI client](./workflows.md#writing-workflows-with-an-ai-client).
- **Custom graphs:** `list_custom_graphs`, `get_custom_graph`, `get_custom_graph_typings`, `write_custom_graph` (type-checked before saving), `render_custom_graph`, `delete_custom_graph`. Script-defined dashboard charts with their own controls and refresh settings; paid plans only. See [Custom graphs](./custom-graphs.md).
- **Deployments:** `list_deployments`, `get_deployment`, `list_deployable_repos`, `plan_deployment` (runs a repo's `plan()` and renders the Dockerfile without building or shipping anything), `rollback_deployment`. There's no tool that deploys. A person starts that from the app or the CLI. See [Infrafile](./infrafile.md).
- **SSH keys:** `list_ssh_keys`, `create_ssh_key` (generates an Ed25519 keypair; the private key stays encrypted on the server, can be used by id with `ssh_exec` and tunnels, and is never returned through a tool), `import_ssh_key` (public key only), `delete_ssh_key`. See [SSH keys](../team-and-billing/ssh-keys.md).
- **SSH host trust:** `list_trusted_ssh_hosts`, `trust_ssh_host`, `remove_ssh_host_trust`. When `ssh_exec` hits an untrusted host, it fails with the host's fingerprint. Verify it another way, then call `trust_ssh_host { host, port, fingerprint }` and retry. See [Trusted SSH hosts](../team-and-billing/ssh-host-keys.md).
- **Linux applications:** use a graphical application on a resource's host without a browser: `list_apps_on_host`, `launch_app` (returns a `windowId`), `screenshot_app_window` (a PNG the model can see), `read_app_accessibility_tree` (what a screen reader reads: every element's role, name, text, state and on-screen bounds, each with a `center` you can click), `click_app_window`, `type_in_app_window`, `press_keys_in_app_window`, `scroll_app_window`, `list_app_windows` and `close_app_window`. Screenshots, click coordinates and accessibility bounds all use the same coordinates, so read the tree (cheaper and exact) or a screenshot to find a target, then click it. A VM resource needs an `sshKeyId` (see `list_ssh_keys`), the same key the terminal uses. A host whose provider supplies SSH itself (Fly, Hetzner) needs none. All need `resources:execute` and are audit-logged. See [Linux applications](./linux-apps.md).

There are also **typed create tools** for every resource type that supports creation, like `digitalocean_create_droplet` or `aws_create_s3_bucket`, so the model can see what to set without calling `list_resource_types` first.

Create tools for VMs that install an SSH key at creation (DigitalOcean Droplets, Hetzner servers, EC2 instances, GCE instances, Scaleway instances) also accept **`sshKeyId`**: a stored [org SSH key](../team-and-billing/ssh-keys.md) id (see `list_ssh_keys`) whose public key is added to the new machine. The generic `create_resource` accepts it too. Only the public key is used. You can pass a raw OpenSSH public key instead.

Most resource tools take an optional `parentResourceId` to work **inside** a managed resource. For "What's running in my DOKS cluster?", call `list_resource_sidecars` on the cluster, then `list_resources { pluginId: "kubernetes", resourceTypeId: "k8s-deployment", parentResourceId: <cluster id> }`. You don't need to supply a kubeconfig. The same pattern works for `describe_resource`, `invoke_action`, `apply_manifest` and the typed create tools inside a cluster or database.

The cost, budget, workflow, deployment and SSH key tools follow the same [role permissions](../team-and-billing/roles-and-permissions.md) as the web dashboard (`costs:read`, `budgets:read`, `budgets:write`, `dashboards:read`, `dashboards:write`, `workflows:read`, `workflows:write`, `secrets:read`, `secrets:write`, `deployments:read`, `deployments:plan`, `deployments:write`, `ssh-keys:read`, `ssh-keys:write`). A member who can't see spend or secret metadata in the app can't read it through MCP either. Deleting another member's SSH key also needs `team:role:write`, the same as the HTTP API.

## Views in the chat

In clients that support [MCP Apps](https://modelcontextprotocol.io/extensions/apps) (Claude, ChatGPT, VS Code, Nibblets), some tools also show a small interactive view in the chat, next to the text the model reads:

| Tool                                 | View                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `query_costs`                        | The period's total against the previous one, and spend over time stacked by group. Regroup by provider, account, service or region. |
| `get_resource_metrics`               | A chart per metric, with its latest value and peak. Switch between the last hour, day, week and month.                              |
| `list_resources`, `search_resources` | The resources as a table you can filter and sort, refresh, or ask the model about.                                                  |

A view's buttons call the same tools with your permissions, so your client's permission prompts still apply. Views load nothing from outside your MCP client, and clients without MCP Apps support ignore them.

<insert [A query_costs view in Claude, showing spend stacked by provider with the regroup buttons] here>

## Audit and safety

Every tool call that changes something (`create_resource`, `delete_resource`, `invoke_action`, `apply_manifest`, the budget tools, the workflow tools, `plan_deployment` and `rollback_deployment`, the typed create tools) is recorded in the [audit log](../team-and-billing/audit-log.md) with `source: "mcp"`. Filter the audit log by source to see exactly what the model has done in your organization.

Agent credentials (`iwa_`) are limited to their permissions on every tool, and an agent only sees the tools it can use. An agent created by a [connected platform](./agent-links.md) may also be limited to some providers. Its calls must then name a provider (a plugin, account or resource) it's allowed to use.

The protocol has no confirmation step for destructive actions. That's up to your client. Claude Desktop and Cursor ask permission before each tool call by default, and we recommend keeping those prompts on, at least for tools that make changes.

`write_workflow_secret` only handles metadata over MCP. It has no value argument, so a password can't leak into model context or client logs. It creates or updates the named secret. Set its value in Infrawrench's workflow editor or the secure in-chat password prompt, then use the returned id with `write_workflow`.

## Connect from Claude Desktop

Add an entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "infrawrench": {
      "url": "https://app.infrawrench.com/api/mcp"
    }
  }
}
```

Restart Claude Desktop. The first request opens the OAuth sign-in in your browser.

<insert [Claude Desktop authorization prompt for infrawrench MCP] here>

## Tips and limits

- Each request stands alone, with no sessions. Long-running tools should return quickly and report progress through later calls rather than holding a request open.
- Self-hosting: set `PUBLIC_BASE_URL` to your public origin so the OAuth metadata advertises the right URL (it falls back to `APP_URL`), and `WORKOS_AUTHKIT_DOMAIN` (or `WORKOS_ISSUER`) so clients find the right authorization server. `WORKOS_AUTHKIT_DOMAIN` must be your AuthKit domain. `https://api.workos.com/user_management` does **not** serve OAuth authorization server metadata, so discovery fails against it.
- Self-hosting: under **Connect > Configuration** in the WorkOS Dashboard, enable **Client ID Metadata Document** (the current MCP standard for client registration) and, for clients that haven't adopted it yet, **Dynamic Client Registration** (deprecated by the 2026-07-28 spec, still fully supported). With neither enabled, clients without pre-registered credentials can't connect: clients using metadata documents find no `client_id_metadata_document_supported` flag, and Dynamic Client Registration clients get `dynamic_client_registration_disabled` from `/oauth2/register`. The server logs an `[mcp-auth]` warning when neither is advertised, so check the web pod's logs when clients say they couldn't register. Alternatively, register an OAuth client in WorkOS manually and paste its client ID into the MCP client's connector settings.
