---
title: MCP server
description: Drive infrawrench from Claude Desktop, Cursor, or any other Model Context Protocol client.
sidebar_order: 11
---

Infrawrench exposes a hosted [Model Context Protocol](https://modelcontextprotocol.io/) server at `/api/mcp`. Point an MCP client (Claude Desktop, Cursor, the MCP CLI, your own LLM agent) at it and the model can list, search, inspect, create, and edit resources in your organization — using your provider credentials, with every mutation written to the [audit log](../team-and-billing/audit-log.md).

## Endpoint

```
POST https://app.infrawrench.com/api/mcp
```

The transport is **Streamable HTTP** with JSON responses (`enableJsonResponse: true`) — no WebSocket or stdio bridge required.

## Authentication

Authentication is OAuth via WorkOS AuthKit. The flow is standards-compliant ([RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)) so any MCP client that supports OAuth dynamic client registration just works:

1. Client makes an unauthenticated request to `/api/mcp`.
2. Server replies `401 Unauthorized` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
3. Client fetches the metadata, discovers the WorkOS authorization server, runs Dynamic Client Registration, and prompts the user to sign in.
4. Client retries with `Authorization: Bearer <token>`.

The bearer token is verified against WorkOS JWKS on every request, then mapped to a user + organization — so each MCP connection only ever sees the org the signed-in user is currently scoped to.

<insert [Claude Desktop MCP settings panel showing the infrawrench server configured with the /api/mcp URL] here>

## What the model can do

The MCP server registers the full shared tool registry — the same tools the [AI chat](./ai-chat.md) uses:

- **Discover** — `list_plugins`, `list_resource_types`, `list_accounts`, `list_resource_sidecars` (which peer plugins a resource exposes — e.g. `kubernetes` on a managed cluster, `postgres` on a managed database).
- **Read** — `search_resources`, `list_resources`, `get_resource`, `get_resource_inputs`, `get_resource_outputs`, `get_resource_stats`, `get_resource_metrics`, `describe_resource`.

Most resource tools take an optional `parentResourceId` to target a **sidecar** — the peer plugin a managed resource exposes through its outputs. "What's running in my DOKS cluster?" is `list_resource_sidecars` on the cluster, then `list_resources { pluginId: "kubernetes", resourceTypeId: "k8s-deployment", parentResourceId: <cluster id> }` — the kubeconfig is resolved server-side from the cluster's outputs, and the same pattern drives `describe_resource`, `invoke_action`, `apply_manifest`, and the per-plugin create tools inside the cluster or database.

- **Mutate** — `create_resource`, `delete_resource`, `invoke_action`.
- **Manifests** — `get_manifest`, `apply_manifest` (see [Manifest editor](./manifest-editor.md)).
- **Connections** — `sql_query`, `sql_execute`, `introspect_sql_schema`, `kv_command`, `docker_command`, `ssh_exec`, and the storage tools (`list_storage_objects`, `make_storage_folder`, `delete_storage_object`).
- **Costs & budgets** — `query_costs` (aggregate spend series with grouping, filters, previous-period comparison, and forecasts), `list_cost_dimension_values`, `get_cost_status`, `list_budgets`, `get_budget`, `create_budget`, `update_budget`, `delete_budget`. See [Cloud costs](./cloud-costs.md).
- **SSH keys** — `list_ssh_keys`, `create_ssh_key` (generates an Ed25519 keypair; the private key stays encrypted server-side and is usable by id with `ssh_exec` and tunnels — it is never returned through a tool), `import_ssh_key` (public key only), `delete_ssh_key`. See [SSH keys](../team-and-billing/ssh-keys.md).

It also registers **per-plugin create tools** at server build time. For every resource type that supports creation, you get a typed tool like `digitalocean_create_droplet` or `aws_create_s3_bucket` with a Zod schema generated from the plugin's field definitions — so the model can discover what to set without first round-tripping `list_resource_types`.

The cost, budget, and SSH-key tools enforce the same [role permissions](../team-and-billing/roles-and-permissions.md) as the web dashboard (`costs:read`, `budgets:read`, `budgets:write`, `ssh-keys:read`, `ssh-keys:write`) — a member whose role can't see spend in the UI can't read it through MCP either. Deleting another member's SSH key additionally requires `team:role:write`, matching the HTTP API.

## Audit and safety

Every mutating tool call (`create_resource`, `delete_resource`, `invoke_action`, `apply_manifest`, the budget tools, the per-plugin create tools) writes a row to the [audit log](../team-and-billing/audit-log.md) with `source: "mcp"`. You can filter the audit log by source to see exactly what the model has done in your org.

There is no destructive-action confirmation step inside the protocol — that responsibility lives in the client. Claude Desktop and Cursor surface a permission prompt before each tool call by default; we recommend leaving those prompts on for the mutating tools at a minimum.

## Connecting from Claude Desktop

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

Restart Claude Desktop. The first request will trigger the OAuth browser flow.

<insert [Claude Desktop authorization prompt for infrawrench MCP] here>

## Tips & limits

- Each request is stateless — a fresh `McpServer` and `StreamableHTTPServerTransport` per call. Long-running tools should return quickly and stream progress via subsequent calls rather than holding a request open.
- Self-hosted infrawrench: set `PUBLIC_BASE_URL` to your public origin so the OAuth resource metadata advertises the correct URL, and `WORKOS_AUTHKIT_DOMAIN` (or `WORKOS_ISSUER`) so clients discover the right authorization server.
