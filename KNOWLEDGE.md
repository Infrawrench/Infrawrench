# Infrawrench — Project Knowledge

> Companion to CLAUDE.md. Contains architecture, conventions, gotchas, and decisions accumulated over development. Keep this up to date as the project grows.

---

## What it is

Infrawrench is an infrastructure management platform with both a desktop app and a cloud SaaS web app.

**Desktop app** — Electron + Vite + React, local SQLite, works offline. All 16 provider plugins loaded. SSH terminals, SQL editors, K8s exec, SFTP browsers run locally.

**Web app** — Hono server (Node) + Vite/React frontend with TanStack Router, Neon PostgreSQL via Drizzle ORM, WorkOS auth. All 16 plugins loaded server-side. SSH/SQL/K8s proxied through a custom WebSocket server (`server.ts`).

**Shared UI** — `@infrawrench/ui` React component library used by both apps. Plugins return schema data, both hosts render via SchemaRenderer/DetailView.

**Cloud features** — Desktop syncs to cloud via OAuth PKCE (WorkOS) + bidirectional sync protocol. Stripe billing at $20/seat/month with free tier (1 user, 3 accounts, no audit). API key system for programmatic access. Audit trail, team management, invitations.

---

## Monorepo layout

```
infrawrench/
├── plugin-architecture/packages/
│   ├── plugin-base/          # @infrawrench/plugin-base — zero-runtime-dep interfaces + Zod validators
│   ├── sftp-host/            # @infrawrench/sftp-host — shared ssh2-based SFTP helpers (web + desktop)
│   ├── ssh-tunnel-core/      # @infrawrench/ssh-tunnel-core — shared SSH tunnel manager (web + desktop)
│   ├── digitalocean/         # @infrawrench/plugin-digitalocean
│   ├── gcp/                  # @infrawrench/plugin-gcp
│   ├── hetzner/              # @infrawrench/plugin-hetzner
│   ├── kubernetes/           # @infrawrench/plugin-kubernetes
│   ├── postgres/             # @infrawrench/plugin-postgres
│   ├── mysql/                # @infrawrench/plugin-mysql
│   ├── redis/                # @infrawrench/plugin-redis
│   ├── scaleway/             # @infrawrench/plugin-scaleway
│   ├── memcached/            # @infrawrench/plugin-memcached
│   ├── neon/                 # @infrawrench/plugin-neon
│   ├── docker/               # @infrawrench/plugin-docker
│   ├── azure/                # @infrawrench/plugin-azure
│   ├── databricks/           # @infrawrench/plugin-databricks
│   ├── turso/                # @infrawrench/plugin-turso
│   ├── ssh/                  # @infrawrench/plugin-ssh
│   ├── fly/                  # @infrawrench/plugin-fly
│   ├── vercel/               # @infrawrench/plugin-vercel
│   ├── netlify/              # @infrawrench/plugin-netlify
│   ├── cloudinary/           # @infrawrench/plugin-cloudinary
│   ├── clickhouse/           # @infrawrench/plugin-clickhouse
│   └── kafka/                # @infrawrench/plugin-kafka
├── app/packages/
│   ├── desktop/              # @infrawrench/desktop — Electron app
│   ├── ui/                   # @infrawrench/ui — shared React components (incl. Toast feature)
│   ├── server-core/          # @infrawrench/server-core — db client, schema, plugin loader, sync, host services (shared by web + poller)
│   ├── web/                  # @infrawrench/web — Hono + Vite/React SaaS web app
│   ├── poller/               # @infrawrench/poller — background resource poller microservice
│   ├── telemetry/            # @infrawrench/telemetry — Hono on Cloudflare Workers; anonymous desktop ping endpoint (Hyperdrive + Postgres)
│   └── website/              # @infrawrench/website — Astro on Cloudflare Workers; landing + releases API
├── CLAUDE.md                 # Hard rules (keep short)
└── KNOWLEDGE.md              # This file
```

pnpm workspaces + Turborepo. All package references use `workspace:*`.

---

## Core architectural rule

**Plugins are self-contained. The Electron host is generic.**

- Plugins own all provider-specific logic (API calls, field shapes, SQL strings, Docker ops, GCS paths, etc.)
- The host (Electron main + React renderer) dispatches to plugins via typed interfaces — it never hard-codes provider names or API endpoints
- Plugins return typed _schema_ for rendering (e.g. `DetailViewSchema`, `SidebarItemSchema`) — they never return React components or JSX
- Node.js-heavy work (native DB clients, Docker SDK, storage downloads) lives in plugin `./node-driver` exports, run in Electron main

---

## plugin-base — the contract

**`src/manifest.ts`** — `Plugin`, `PluginClient`, `PluginManifest`, driver declarations, host services

Key manifest fields:

- `credentialFields` — what the host asks the user for when adding an account. Fields can be text, password (`sensitive: true`), multiline (`multiline: true`), region-pickers (`regions: …`), or account references (`accountReference: { pluginId }` — rendered as a dropdown of existing accounts of that plugin; used by the SSH plugin's "Connect through" jumpbox field). Set `optional: true` on fields the user may leave empty.
- `sqlDriver?: SqlDriverDeclaration` — opts in to SQL editor; host routes IPC to the right SQL node driver
- `kvDriver?: KvDriverDeclaration` — opts in to Redis-style KV console
- `dockerDriver?: DockerDriverDeclaration` — opts in to Docker container management
- `peerPlugins?` — plugin IDs this plugin may receive association data from

Key `PluginClient` methods (all optional except the four core ones):

```typescript
// Required
listResources(typeId, accountId): Promise<ResourceInstance[]>
getResource(typeId, resourceId, accountId): Promise<ResourceInstance>
resolveOutput(typeId, resourceId, outputKey, accountId): Promise<string>
renderDetail(resource): DetailViewSchema
renderSidebarItem(resource): SidebarItemSchema

// Optional
introspect?(): Promise<SqlTableMeta[]>        // SQL schema for editor autocomplete
fetchStats?(): Promise<{ version, size, tableCount }>  // dashboard card stats
getCreateConfig?(typeId, parentResourceId?): Promise<CreateResourceConfig>  // live API-driven create form
createResource?(typeId, accountId, fields, parentResourceId?): Promise<ResourceInstance>
updateResource?(typeId, resourceId, accountId, fields): Promise<ResourceInstance>
deleteResource?(typeId, resourceId, accountId): Promise<void>
attachResource?(sourceTypeId, sourceResourceId, targetTypeId, targetResourceId, accountId): Promise<void>
listStorageObjects?(bucket, prefix): Promise<StorageObject[]>
uploadStorageObject?(bucket, key, file, onProgress?): Promise<void>
makeStorageFolder?(bucket, key): Promise<void>
deleteStorageObject?(bucket, key): Promise<void>
getStorageAccessToken?(): Promise<string>
fetchStorageStats?(bucketName): Promise<{ count, size }>
getSshConfig?(): { host, port, username, privateKey }
getManifest?(resourceId, accountId): Promise<string>        // raw manifest text (JSON) for Monaco editor
applyManifest?(resourceId, accountId, manifest): Promise<void>  // apply edited manifest back
exportCredential?(typeId, resourceId, accountId, formatId): Promise<CredentialExport>
listSecretVersions?(typeId, resourceId, accountId): Promise<SecretVersion[]>
accessSecretVersion?(typeId, resourceId, accountId, versionId): Promise<string>  // plaintext value
addSecretVersion?(typeId, resourceId, accountId, value): Promise<SecretVersion>
modifySecretVersion?(typeId, resourceId, accountId, versionId, "enable"|"disable"|"destroy"): Promise<SecretVersion>
```

**Secret versions:** resource types that hold versioned secret material (e.g. GCP Secret Manager Secret) declare `secretVersions: { supportsFileUpload?, helpText? }` on their `DetailViewSchema`. The host then renders a "Versions" tab with a table of versions (id · state · created), per-row Reveal/Enable/Disable/Destroy actions, and an "Add version" form (paste or file upload). Reveal opens a shared reveal-once modal with copy. Destroy is confirmed before dispatch. Web routes: `GET/POST /api/org/:org/resources/:plugin/:type/secret-versions[/access|/add|/modify]`. Desktop IPC: `cloud_list_secret_versions`, `cloud_access_secret_version`, `cloud_add_secret_version`, `cloud_modify_secret_version`.

Implementations by plugin:

- **GCP `secret-manager-secret`** — `listSecretVersions` paginates `GET /v1/{secret}/versions`; `accessSecretVersion` calls `:access` and base64-decodes `payload.data`; `addSecretVersion` calls `:addVersion` with `{payload: {data: btoa(utf8(value))}}`; `modifySecretVersion` calls `:enable`/`:disable`/`:destroy` — destroyed versions cannot be recovered. The create form also takes an optional `initialValue` that adds the first version immediately.

**Child tables (`childTables` on `DetailViewSchema` / `DetailViewTab`):** a plugin can render a resource's child instances as a dashboard-style table instead of the default pill group. Each `ChildTableSchema` names a `typeId` plus `columns` (each column declares a `source` — `field`/`external-id`/`display-name` — and an optional `format`: `type-badge`, `proxy-status`, `ttl`, `mono`, `boolean-yesno`, plus `stripSuffixFromFieldKey` for short DNS names). The host pulls rows from the child resources it already loads for the pill groups and **suppresses the matching pill group**. Rows navigate to the child by default; with `onRowClick: "edit"` a row instead opens an inline `EditResourceModal` on the current page (the host ships the child type's `fields` on the group and `onChildEdit` submits the changed fields through the update path). A trailing Delete button calls `onChildDelete`; the header "+ Create" reuses the existing `onChildCreate` path. To populate cells the host ships each child's non-secret `fields` (only for types that have a `childTables` entry). Component: `app/packages/ui/src/components/detail/ChildResourceTable.tsx`. First consumer: the Cloudflare zone DNS Records table. A `DetailViewTab` can also set `childResourceTypeIds: string[]` to host specific child groups/tables in that tab — the host renders them there (via the shared `renderChildArea`) and Overview only shows the unclaimed types. The Cloudflare zone uses this to split its 11 child types across DNS / Traffic / Rules & WAF / SSL & Hostnames / Email & Logs tabs.

**Live output references on create-form fields:** a create-form `resource-picker` field can set `referenceMode: true`. The `ResourcePicker` then emits an encoded reference (`encodeOutputRef`/`parseOutputRef` in `plugin-base/src/output-ref.ts`, sentinel-prefixed JSON of `{pluginId, resourceTypeId, resourceId, accountId, outputKey, value}`) instead of a flattened literal, and the picker searches **cross-account** (every org account whose plugin matches a source — `crossAccount` flag on the picker-resources loaders). On create, the host (`lifecycle.ts` create route + desktop `CreateResourceModal`/`persistOutputRef`) flattens the ref to its pick-time literal for the plugin, then writes a `secret_field_states` output-ref row (source of truth, with the value cached) plus a best-effort `associations` topology row. The poller's reconciler (`reconcileAccountReferences` in `server-core/sync-resources.ts`, run each cycle) re-resolves each output-ref against its source account, and when the value changed calls the consumer plugin's `updateResource` to push it to the provider, then refreshes the cache. This is what makes a DNS A/AAAA/CNAME record track a server's IP/hostname. Helper `dnsContentField` (`plugin-base/src/dns-helpers.ts`) builds the mode-toggle + per-type pickers + custom-text field; the `transient` flag on the mode toggle keeps it out of the submitted form data, and compound `showWhen` (`allOf`/`anyOf`/`fieldValuesNot`) gates the variants. Wired on Cloudflare/DigitalOcean/AWS Route 53/GCP Cloud DNS; Netlify records are immutable so they capture-at-create only (no `updateResource`).

**SSH over a Cloudflare Tunnel (drag-attach):** a resource type can set `sshTunnelAttachSource: true` (`plugin-base/src/resource.ts`); the Cloudflare `tunnel` type does. The DnD layer then lets that resource be dragged onto any resource with an `sshEndpoint`, **cross-account** (modeled on the existing secret-import cross-account drop). `DraggableResource` carries `isSshHost` / `isTunnelSshSource`, set where sidebar/account draggables are built (web: API metadata `isSshHost`/`sshTunnelAttachSource` on the account-detail resource-types payload; desktop: from local plugin defs). The drop fires `DndShell.onTunnelSshAttach`, which opens `TunnelSshAttachModal` (hostname + zone + SSH user + SSH key). The modal picks the **service** to expose (HTTP/HTTPS/SSH/TCP + local port). On Run the host orchestrator (`web/src/services/tunnel-ssh-attach.ts`; route `POST /api/resources/tunnel-ssh-attach`; desktop IPC `cloud_tunnel_ssh_attach`) does three steps with only generic plugin methods: `updateResource("tunnel", … {ingressHostname, ingressService})` → sets ingress to `<service>://localhost:<port>` via `setTunnelIngress` (PUT `/cfd_tunnel/{id}/configurations`); `createResource("dns-record", … CNAME → {tunnelId}.cfargotunnel.com)`; `exportCredential("tunnel", … "tunnel-token")` for the token; then resolves the host's `sshEndpoint` address + `resolveSshConfig` + `sshExec` to install/run `cloudflared`. The returned connect hint is service-specific (browser URL for HTTP, `cloudflared access ssh/tcp` for SSH/TCP). Cloud-mode only (org SSH keystore); host must be SSH-reachable; Linux+sudo; the tunnel token stays server-side.

**Credential export:** resource types declare `credentialFormats: CredentialFormat[]` listing the kinds of downloadable secrets they can produce. When the set is non-empty and `exportCredential` is implemented, the host shows a "Get credentials…" button on the detail page that opens the shared `CredentialExportModal`. The modal renders a format picker (if >1), then a reveal-once view with copy buttons, a warning banner, a collapsible full-file view, and a download. `CredentialExport` carries `{ content, filename, mimeType, fields?, warning? }`; `content` is plain text for `json`/`text`/`ini` and base64 for `binary-base64`. Web route: `POST /api/org/:org/resources/:plugin/:type/export-credential`; desktop IPC: `cloud_export_credential`.

Implementations by plugin:

- **AWS `iam-user`** — `access-key` format: `iam:CreateAccessKey` (AWS caps 2 keys/user). Also exposed as the `accessKey` output for output-ref consumption.
- **GCP `gcp-service-account`** — `json-key` + `p12-key` formats: `iam.projects.serviceAccounts.keys.create` with `privateKeyType` (`TYPE_GOOGLE_CREDENTIALS_FILE` / `TYPE_PKCS12_FILE`). JSON form also exposed as the `key` output. PKCS#12 password is the GCP-fixed `notasecret`.
- **Azure `azure-storage-account`** — `connection-string` + `access-keys` formats. Reuses existing `listKeys` call; the ARM API has no pre-formatted connection string endpoint, so `DefaultEndpointsProtocol=…;AccountName=…;AccountKey=…` is constructed client-side.
- **Azure `azure-app-registration`** — NEW resource type (parity with AWS IAM user / GCP SA). Dual-audience OAuth2 tokens (`graph.microsoft.com/.default` for Graph + `management.azure.com/.default` for ARM — separate token per audience). Creation flow: POST `/applications` → POST `/servicePrincipals` with `{appId}` (three distinct GUIDs — application object `id`, `appId`, service principal object `id`; role assignments need the SP `id`, OAuth uses `appId`, Graph URLs use the app object `id`). SP creation failure rolls back the app. `exportCredential` calls POST `/applications/{id}/addPassword`; `secretText` is shown only once. Also exposed as the `clientSecret` output (emits a ready-to-source env file with `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`). Least-privilege Graph scope: `Application.ReadWrite.OwnedBy` (admin consent still required, but restricts the SP to apps it owns).
- **Cloudflare `tunnel`** — `tunnel-token` format: `GET /accounts/{id}/cfd_tunnel/{tid}/token` returns the `result` as a plain base64 string (not an object — the existing `resolveOutput` unwrap of `token.token` was a bug; fixed alongside). Only works for remotely-managed tunnels.
- **DigitalOcean `spaces-bucket`** — `bucket-scoped-rw` + `bucket-scoped-ro` formats: `POST /v2/spaces/keys` with `grants: [{bucket, permission}]` — the generated key is scoped to just this bucket (not account-wide). Secret shown once.

Deliberately **not** credential-exportable:

- Azure `managed-identity` — by design: managed identities don't have credentials. Use `azure-app-registration` for exportable secrets.
- Scaleway / Databricks / PlanetScale / Vercel / R2 — require new resource types (IAM application, service principal, service tokens, etc.) not yet modelled. Research collected for future addition.

**`src/resource.ts`** — `ResourceTypeDefinition`

Important flags:

- `dashboardPinnable: boolean` — whether users can pin instances to dashboards
- `supportsCreate?: boolean` — whether the host shows a "+ Create" button
- `supportsUpdate?: boolean` — whether the host shows an "Edit" button on the resource detail page. When true, the plugin must implement `updateResource`; the host opens `EditResourceModal` over the resource type's `fields`, diffs against the current values, and POSTs only the changed keys via `/api/resources/update` (cloud) or directly to the client (local). Mark individual fields with `editable: false` on `FieldDefinition` to lock them (e.g. provider-immutable identity fields); `secret` and `association` field kinds are also always excluded from the edit form. Currently wired: DigitalOcean `project` (PATCH `/v2/projects/{id}`).
- `supportsStorageBrowser?: boolean` — whether the host renders the GCS browser panel
- `supportsTerminal?: boolean` — whether the host renders the SSH terminal panel
- `sshEndpoint?: { hostOutputKey, privateHostOutputKey?, runningWhen?, defaultUsername?, usernameFieldKey? }` — enables "Connect via SSH" right-click in sidebar; `hostOutputKey` names the resolved output to use as the SSH host (e.g. `"ipv4"`); `privateHostOutputKey` (optional) names the private/internal address output, surfaced by the "Connect through jumpbox" flow so the routed connection can target the VM on its private interface; `defaultUsername` is a static default SSH username (e.g. `"root"`); `usernameFieldKey` points to a per-instance field storing the SSH username (e.g. `"sshUsername"`); resolution precedence: `fields[usernameFieldKey]` > `defaultUsername` > `"root"`
- `resourceSqlDriver?: { driver, connectionStringOutputKey }` — per-resource SQL editor; the host resolves the connection string from the resource's outputs via `resolveOutput()` and enables the SQL editor tab (unlike manifest-level `sqlDriver` which uses account credentials)
- `parentTypeId?: string` — child types are shown on their parent's detail page, not on the account page; the host auto-fetches children and renders them as navigable cards with optional create buttons
- `showInSidebar?: boolean` — on a child type (one with `parentTypeId`), also surface its instances in the sidebar/account view as their own top-level section, additive to the parent-detail-page grouping. Default false → child types are sidebar-hidden (the DO Droplets-inside-Projects model: the project is the navigable parent and droplets only appear in its detail page). Set true for child types the user treats as first-class resources (e.g. snapshots, custom images, NFS shares pinned under a project) so they're reachable from the sidebar without first drilling into the parent. Honored by: `getListableResourceTypes` / `getAccountResourceTypes` / `isCreateOnlyType` in `app/packages/ui/src/utils.ts`, the search filter in `AccountResourceSections.tsx`, the `topLevelOnly=true` branch of `GET /api/accounts/:id/resources` (web), and `listableTopLevelTypes` in `server-core/sync-resources.ts` (dashboard account-pin counts). The parent-detail-page child grouping (`buildChildResourceGroups`) is unchanged — instances appear in both places.
- `attachTargets?: AttachTarget[]` — resource types this resource can be dragged onto to trigger `client.attachResource`. `AttachTarget = { pluginId, resourceTypeId, matchField?, verb? }`. Drops are restricted to the _same account_; when `matchField` is set, the named field (e.g. `"zone"`) must match between source and target. Currently wired: GCP `gce-disk` → `gce-instance` (attach persistent disk to VM, zone-matched).

**`src/create.ts`** — `CreateResourceConfig`, `CreateFieldConfig`

Field kinds: `text`, `hostname`, `number`, `datetime`, `select`, `size-picker`, `region-picker`, `disk-slider`, `image-picker`, `disk-picker`, `ssh-key-picker`, `resource-picker`, `policy-picker`

- `hostname` — subdomain input that renders a fixed `.<domain>` suffix (`hostnameSuffix`) and submits the full hostname (`sub.suffix`, or just `suffix` for the apex; blank defaults to apex on mount). When `hostnameSuffix` is empty it degrades to a plain text input. The plugin sets the suffix from the parent zone/domain. Cloudflare uses it (when created under a zone) for the DNS record `name`, waiting-room `host`, load-balancer `name`, and Spectrum `dns` fields, resolved via `client.resolveZoneSuffix(parentResourceId)` against `getZoneOptions`. (CF accepts FQDN names; providers whose APIs want a _relative_ name should not adopt this without stripping the suffix.)

`policy-picker` — multi-select IAM policies/roles. Value is a JSON array of `id`s (empty = empty string). Plugin supplies `policies: PolicyOption[]` fetched live from the provider API (e.g. AWS `iam:ListPolicies` for managed + customer-managed, GCP `iam.roles.list` for predefined + project custom roles). Options carry `category` for grouping and optional `description` / `badge` (e.g. `BETA`, `DEPRECATED`). UI: searchable input with chips for selected items and categorised list below.

`datetime` fields carry an optional `datetimeMode` (`"datetime"` | `"date"` | `"epoch-ms"`, default `"datetime"`) that controls what the picker submits as the field value. Interpreted as UTC; ISO 8601 out for `datetime`, `YYYY-MM-DD` for `date`, ms-since-epoch string for `epoch-ms`.

`showWhen?: { fieldKey, fieldValue }` — conditional visibility (e.g. show disk picker only when `bootSource === "existing-disk"`)

**Child-resource create inheritance** — when a user clicks "Create" from a parent's detail page (for child types that declare `parentTypeId` + `supportsCreate`), the host passes the full parent id as `parentResourceId` to both `getCreateConfig` and `createResource`. Plugins should:

1. In `getCreateConfig(typeId, parentResourceId?)`: omit parent-identifying fields when `parentResourceId` is set (skip the select+options fetch entirely).
2. In `createResource(..., parentResourceId?)`: derive the parent's external id via `parentResourceId.split(":").slice(2).join(":")` and use it as the fallback when the form field is empty. Parse composite externalIds (e.g. Neon's `{projectId}/{branchId}`, Databricks' `{catalog}.{schema}`) accordingly.

Reference implementations: GCP `pubsub-subscription`, `kms-key`, `spanner-database`; Kubernetes `namespaceField()` helper covers all 10 namespaced types in one place.

**`src/node-driver.ts`** — Node.js-side driver interfaces

Each plugin that needs native Node.js capabilities exports from `./node-driver`:

- `SqlNodeDriver` — `query()`, `execute()`
- `KvNodeDriver` — `command()`
- `DockerNodeDriver` — `command()`
- `StorageNodeDriver` — `downloadFile()` (for batch downloads via IPC)

**`src/dns.ts`** — Shared DNS record rendering helpers

Plugins that expose DNS records import these to avoid duplicating badge-color mapping, TTL formatting, and detail-view rendering:

- `dnsRecordBadgeColor(type)` — maps DNS record types (A, AAAA, CNAME, MX, etc.) to badge colors
- `formatDnsTtl(ttl)` — formats TTL seconds to human-readable strings (Auto, 5m, 1h, etc.)
- `dnsZoneStatus(status)` — maps zone statuses to ResourceStatus
- `renderDnsRecordDetail(resource, options?)` — full DNS record detail view with type badges, proxied indicator, and optional extra sections
- `renderDnsRecordSidebar(resource)` — sidebar item with type prefix and optional proxied status dot

Currently used by: Cloudflare (full), DigitalOcean (detail + sidebar), GCP (badge colors + TTL formatting).

---

## Electron host — how it works

### Main process (`electron/main.ts`)

- Loads SQLite via sql.js (WASM), persists to `userData/infrawrench.db` on every write
- Encryption: 32-byte AES-256-GCM key stored in `userData/master.key`; credentials encrypted at rest
- IPC handlers: `db_select`, `db_execute`, `encrypt_value`, `decrypt_value`, `get_or_create_encryption_key`, `show_open_dialog`
- Driver IPC: `plugin_sql_query`, `plugin_sql_execute`, `plugin_kv_command`, `plugin_docker_command`, `plugin_storage_download`
- SSH IPC: `ssh_open_tunnel`, `ssh_close_tunnel`, `ssh_get_active_tunnels`, `ssh_shell_spawn`, `ssh_shell_write`, `ssh_shell_resize`, `ssh_shell_kill`, `ssh_list_system_keys`, `ssh_read_system_key`
- CORS interceptor: `session.defaultSession.webRequest.onHeadersReceived` — injects CORS headers only when the server hasn't sent `Access-Control-Allow-Origin`; for OPTIONS preflights that return non-200, forces `statusLine: "HTTP/1.1 200 OK"` to allow cross-origin DELETE/PUT/PATCH from `file://`

### Driver registration (`electron/drivers.ts`)

```typescript
sqlDrivers     → Map<string, SqlNodeDriver>    (postgres, mysql, libsql, mysql-planetscale)
kvDrivers      → Map<string, KvNodeDriver>     (redis, memcached)
dockerDrivers  → Map<string, DockerNodeDriver> (docker)
storageDrivers → Map<string, StorageNodeDriver> (gcp)
```

### Plugin host (`electron/plugin-host.ts`)

Handles `plugin_*` IPC calls by looking up the right driver from `drivers.ts`.

### SSH layer (`electron/ssh-tunnel.ts`, `electron/ssh-shell.ts`)

- Tunnels: ssh2 `Client` + Node.js `net.Server` on port 0 (OS-assigned); each TCP connection opens an SSH forward channel. `openTunnel()` returns `{ tunnelId, localPort }`.
- Shells: ssh2 `Client.shell()` with `xterm-256color`; data piped to renderer via `webContents.send()`. Binary data encoded with `.toString("binary")`.
- Jumpbox routing: `SshShellConfig.jumpHops?` (outermost-first) lets `spawnSshShell` dial through one or more intermediate ssh2 clients using the shared `forwardOutHop` helper from `@infrawrench/plugin-ssh/chain` (also used by the web ssh-proxy). Each hop's host key is verified independently against the TOFU cache. Agent forwarding applies to the final hop only.
- `closeAllTunnels()` and `killAllSshShells()` called on `app.before-quit`.

---

## SQLite schema (desktop)

Two migrations. Tables:

**v1:**

- `accounts` — `id, plugin_id, display_name, encrypted_credentials, credentials_iv`
- `plugin_installations` — `id, plugin_id, package_name, version, enabled`
- `resources` — `id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json, parent_resource_id`
- `secret_field_states` — resolution state for secret fields (literal or output-ref)
- `associations` — consumer/provider resource links
- `dashboards` — named dashboards, `is_default` flag
- `dashboard_pins` — `dashboard_id, resource_id, grid_x/y/w/h`

**Metrics — ClickHouse Cloud (not Postgres):**

The poller writes time-series data to a ClickHouse Cloud cluster, configured via `CLICKHOUSE_METRICS_*` env vars. Postgres holds no metric history; the `resources.latest_*_json` / `accounts.latest_stats_json` columns were removed in migration `0013_glamorous_sersi`. Tables (in `server-core/src/clickhouse/migrate.ts`, auto-created on web boot):

- `metric_points_raw` — raw `(org, account, resource, plugin, type, series, unit, ts, value)`, TTL 7 days
- `metric_points_1m` / `metric_points_1h` — `AggregatingMergeTree` rollups (TTL 30 d / 365 d) populated by materialized views
- `dashboard_stats` — JSON-encoded `DashboardStat[]` snapshots per resource (TTL 30 d)
- `account_resource_counts` — per-account `{typeLabel,count}[]` for `__account__` pins (TTL 30 d)
- `poll_outcomes` — poller telemetry (duration, success/fail/skip counts, first error) per account per cycle (TTL 30 d)

Writes are best-effort: if `CLICKHOUSE_METRICS_*` is unset, all writers/readers no-op and the poller proceeds. Only **pinned** resources accumulate metric points — `refreshPinnedStats` is the sole writer. Reads are routed through `server-core/clickhouse/readers.ts`; `getMetricRange` auto-selects raw / 1m / 1h based on span (≤2h / ≤7d / >7d). Web exposes `GET /api/org/:orgId/dashboards/pin/:pinId/range?fromMs=&toMs=` for historical zoom, and `POST /api/org/:orgId/resources/:pluginId/:typeId/metrics` (resource-detail metrics tab) now reads from ClickHouse instead of calling the plugin live.

**v2:**

- `ssh_tunnel_configs` — `account_id (UNIQUE), ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv`
- `ssh_keys` — named encrypted private keys saved by the user

**v4:**

- `metric_pings` — desktop-only native notifications when a single metric on a resource leaves a configured `[min_value, max_value]` range. Unique on `(resource_id, metric_label)`. Pings always target one specific metric label, never the full series set. `last_alert_state` (`ok` / `below` / `above`) dedupes notifications across polls.

Resource IDs follow the convention `{accountId}:{resourceTypeId}:{externalId}`. GCP externalIds for instances/disks/clusters are `{projectId}/{zone}/{name}`.

---

## Permissions

Authorization is **permission-string based**. Every org-scoped HTTP handler in `app/packages/web/src/api/routes/` calls `requirePermission(c, "<perm>")` (defined in `app/packages/web/src/auth/permissions.ts`). The check works for both session auth and API-key auth — `permissionsMiddleware` in `app/packages/web/src/api/auth-middleware.ts` populates `c.permissions` for sessions, and `authenticateApiRequest` populates the same key for bearer tokens.

The catalog of permission strings lives in `app/packages/server-core/src/permissions/catalog.ts` (`ALL_PERMISSIONS`) — the single source of truth shared by server, OpenAPI spec, and the frontend permission picker. Wildcards are honored at any segment (`resources:*:read`, `resources:postgres:*`, or `*` for all).

System roles (owner/admin/member) are defined in code (`app/packages/server-core/src/permissions/system-roles.ts`) and seeded lazily per org via `ensureSystemRoles(orgId)` — every membership write triggers it. Custom roles live in the `roles` table with arbitrary permission arrays. `organizationMembers.roleId` (and `invitations.roleId`) point at a `roles` row; the legacy text `role` column is kept in sync for one release as a fallback.

OpenAPI: `app/packages/web/src/api/openapi/index.ts:injectRequiredPermissions` walks the generated paths and stamps `x-required-permission` onto every operation using the `REQUIRED_PERMISSION` table. When you add a new endpoint, add the matching entry there.

Frontend: `app/packages/web/src/auth/permissions-context.tsx` provides `<PermissionsProvider>` (mounted in `org.$orgId.tsx`), the `usePermissions()` hook, and a `<Can permission="...">` component. The provider fetches `/api/org/:orgId/team/me` once per org switch. The pure `hasPermission` matcher is exported via the browser-safe `@infrawrench/server-core/permissions/catalog` subpath (the full `permissions` module pulls in `db/client` and is server-only).

API key scopes use the same permission strings; the `Permission` enum in `app/packages/web/src/api/openapi/common.ts` is the OpenAPI representation. Legacy `sync:read`/`sync:write` scopes are migrated to `resources:read`/`resources:write` on next use by `authenticateApiRequest`.

---

## Plugin registry & loader

`app/packages/web/src/plugins/blessed-plugins.json` is the authoritative blessed list. Both web and desktop import from this path via a Vite alias (`@blessed-plugins`).

The loader (`app/packages/desktop/src/plugins/loader.ts`) validates each plugin's manifest against the Zod schema and checks the manifest `id` matches the registry `id` before mounting. Unknown packages are refused.

Currently blessed: `gcp`, `docker`, `digitalocean`, `hetzner`, `kubernetes`, `memcached`, `mongodb`, `mysql`, `neon`, `postgres`, `redis`, `scaleway`, `ssh`, `cloudflare`, `ovh`, `aws`, `azure`, `databricks`, `turso`, `planetscale`, `fly`, `vercel`, `netlify`, `cloudinary`, `clickhouse`.

---

## React app structure (desktop renderer)

### Routes (`src/routes/`)

- `__root.tsx` — layout: sidebar + main content area
- `index.tsx` — redirect to default dashboard
- `dashboard.$dashboardId.tsx` — renders `DashboardView`
- `accounts.$accountId.tsx` — account detail: resource groups as pill lists, "+ Create" buttons
- `resource.$accountId.$resourceId.tsx` — resource detail: `DetailView` + SQL editor / KV console / Docker panel / storage browser / manifest editor / SSH terminal / delete bar

### Key components (`src/components/`)

- `SidebarAccounts.tsx` — grouped by plugin, lazy-loaded per account on expand, auto-refresh every 30s, right-click SSH context menu
- `SidebarDashboards.tsx` — dashboard list + create; dashboard sidebar pill/drop/drag visuals are canonicalized in shared `@infrawrench/ui` `DroppableDashboardItem` so desktop and web stay in sync
- `DashboardView.tsx` — pinned resource cards, drag-and-drop pin, auto-connect & refresh stats every 30s
- `CreateResourceModal.tsx` — calls `getCreateConfig` on mount, renders region/size/image/disk/ssh-key pickers, navigates to new resource on success
- `AddAccountModal.tsx` — collects credential fields, encrypts, saves to DB
- `SshQuickConnectPanel.tsx` — lists system (`~/.ssh/`) and saved keys, auto-derives username from public key comment, spawns `SshTerminal`
- `SshTerminal.tsx` — xterm.js terminal wired to `ssh_shell_*` IPC; `fitAddon.fit()` deferred to `requestAnimationFrame`
- `SshTunnelModal.tsx` — SSH tunnel config + service preset picker (docker/postgres/mysql/redis/memcached/custom)
- `DockerActionsPanel.tsx` — Start/Stop/Restart container buttons
- `GcsBrowserPanel.tsx` — object storage browser (list, upload, mkdir, delete, batch download)
- `SpotlightSearch.tsx` — ⌘K search across all accounts/resources

### State & data flow

- Credentials are always encrypted in SQLite; decrypted on demand via IPC
- `getSqlSession(accountId)` / `setSqlSession()` — in-memory cache of active SQL connections in the renderer
- `useUIStore` (Zustand) — `dashboardPinsVersion`, `bumpAccounts`, `accountConnected` map
- Custom DOM events for cross-component communication:
  - `iw:resources-changed` — fires when a resource is deleted or created; sidebar + account page listen to re-fetch
  - `iw:refresh-resource` — fires from the "Refresh" action button; resource detail does a background re-fetch
  - `iw:metric-pings-changed` — fires after the user adds/changes a metric ping; the metric-pinger reloads its set and re-syncs the active count to the main process

### Metric pings (desktop-only)

Right-click any resource in the sidebar whose type sets `supportsMetrics` to open `MetricPingModal` and configure a single metric to alert on. The renderer's `metric-pinger` (`src/lib/metric-pinger.ts`) polls every 60s, calls `client.fetchMetricSeries`, and only fires a native OS notification (`show_notification` IPC → `Notification` in main) when `last_alert_state` flips. While `activePingCount > 0` in main, `window.on("close")` hides the window instead of quitting and `window-all-closed` is a no-op so the polling loop stays alive in the background; `before-quit` sets a `quitting` flag that bypasses both. The renderer keeps main in sync via `set_pings_active`.

### Background refresh pattern

All polling is _background_ (no loading flash):

- `backgroundRefreshRef.current = true` is set before bumping the version counter
- The `useEffect` reads the ref, resets it, and skips `setLoading(true)` when true
- Errors during background refresh are silenced (stale data stays visible)
- Intervals: 30s for sidebar, account page, resource detail; 30s for dashboard `connectAll`
- Web dashboard card probing (`POST /api/org/:orgId/dashboards/probe`) runs item probes in parallel and now deduplicates shared account decrypt + plugin load work with in-flight promise caches, so multiple cards from the same account/plugin don't queue behind repeated setup.

---

## Plugin-specific notes

### GCP (`@infrawrench/plugin-gcp`)

- Auth: OAuth2 access token fetched client-side from `oauth2.googleapis.com/token`
- Resource ID format: `{accountId}:gce-instance:{projectId}/{zone}/{instanceName}`
- `externalId` for GCE instances = `{projectId}/{zone}/{instanceName}` — parse with `.split("/").pop()` to get the instance name for API calls
- SSH key injection format: `username:ssh-rsa AAAA...` in metadata; `username` derived from key comment (`comment.split("@")[0]`)
- Delete requires zone from `resource.fields["zone"]`, not from `externalId`
- Storage driver (`./node-driver`) handles GCS batch downloads
- GCP exposes `getCreateSizePricing()` for async per-region VM price hydration from the Cloud Billing Catalog API (Compute SKUs) — supports both `gce-instance` and `gke-cluster`; modal opens with base options first, then prices stream in (default zone first, then others)
- `getCreateCostEstimate()` handles `gce-instance` (VM + pd-balanced boot disk), `gke-cluster` (per-node VM + per-node pd-balanced disk × node count), and `gce-disk` (sizeGb × rate for the selected pd-balanced/pd-ssd/pd-standard type); machine type specs are cached in `machineTypeSpecCache` (populated during `getCreateConfig`) so cost recalculations from slider/field changes don't require API calls. Disk rates for all three PD types are extracted from the same Cloud Billing Catalog fetch that hydrates machine rates.
- Pub/Sub: `pubsub-subscription` has `parentTypeId: "pubsub-topic"`. The subscription lister only sets `parentResourceId` when the topic is in the same project (`projects/{p}/topics/…`); cross-project subscriptions stay top-level so they still appear in the sidebar. Pub/Sub resources have no lifecycle state in the GCP API, so `renderDetail` hardcodes a `healthy`/"Active" status dot (otherwise `gcpStatus("")` returns `"unknown"` and renders grey). Subscription detail adds a "View topic" header action that uses the `navigate-to-resource` host action, reconstructing the topic resource ID from `parentResourceId` when available or from `projects/{this.project}/topics/{fields.topic}` as a fallback.
- **Firestore Enterprise (MongoDB peer)**: `firestore-database` resources set `noSqlBrowser.driver = "mongodb-peer"` when the database has MongoDB compatibility enabled. These databases have the Firestore REST API **disabled** — they are accessible ONLY via the MongoDB wire protocol. The correct Firestore MongoDB API endpoint is **`firestore.googleapis.com:443`** (NOT `{location}.firestore.googleapis.com:27017` — that hostname does not exist). Desktop `FirestoreMongoPeerBrowser` reads a linked MongoDB account from local Tauri SQLite and executes via `invoke("plugin_kv_command", ...)` (native, not web API). Web `FirestoreMongoPeerBrowser` uses the GCP account's own OAuth2 token — `resolveOutput("mongoConnectionString")` on the GCP plugin builds the connection string, and a `POST /nosql-mongo-command` endpoint executes it via the MongoDB KV driver — no separate MongoDB account needed in cloud. `FirestoreDocumentBrowser` (driver `"firestore"`) uses the Firestore REST API via `nosql-command` and does NOT need a MongoDB account.

### DigitalOcean (`@infrawrench/plugin-digitalocean`)

- Resource ID format: `{accountId}:{typeId}:{externalId}`. NFS shares are the exception: `externalId = "{region}/{shareId}"` because the API endpoint takes both.
- Resource types: `project`, `droplet`, `volume`, `snapshot`, `image`, `nfs-share`, `doks-cluster`, `managed-database`, `db-user`, `spaces-bucket`, `domain`, `dns-record`, `gen-ai-agent`, `gen-ai-knowledge-base`, `gen-ai-model-router`, `dedicated-inference`, `inference-batch`, `model-api-key`, `agent-api-key`.
- SSH key upload: `POST /v2/account/keys` — handle 422 (duplicate) by listing existing keys and matching by `public_key`
- `fetch` helper handles `204 No Content` explicitly to avoid JSON parse error on DELETE
- **Droplet actions** live in `src/actions.ts`. Parameterless actions (power_on/off/cycle, reboot, shutdown, enable/disable_backups, enable_ipv6, password_reset, plus auto-named snapshot) flow through `invokeAction` from `plugin-action` host actions with `confirmMessage`. Parameterised actions (named snapshot, rename, resize, rebuild, restore, change_backup_policy, volume resize/snapshot) flow through `executeNoSqlCommand` triggered by `prompt-nosql-command` host actions — the host packs the form values as `args[0] = JSON.stringify(values)`; `decodePromptArgs` in `actions.ts` parses them.
- Volume `detach` action reads `dropletIds` and `region` from the volume's fields populated during `listVolumes` — no extra API call needed.
- Droplet metrics fan out 16 series in parallel against `/v2/monitoring/metrics/droplet/{name}` covering CPU, load_1/5/15, memory total/available/free/cached, disk_read/write, filesystem_size/free, and all four bandwidth (interface × direction) combinations. Memory/disk/load/filesystem need the DO Metrics Agent on the droplet; `fetchPromMetric` swallows 404s for absent metrics.
- Droplet list response carries `backup_ids`, `snapshot_ids`, `volume_ids`, `features`, `vcpus`, `memory`, `disk`, `tags` and the `size.price_monthly` — surfaced as flattened fields during `listDroplets` so the detail tabs can render them without follow-up API calls.
- Snapshots (`/v2/snapshots`) aggregates both droplet and volume snapshots; DO returns `resource_type` and `resource_id` to disambiguate. Delete uses the same `/v2/snapshots/{id}` endpoint regardless of source.
- Images (`/v2/images?private=true`) lists user-owned images only. Distribution and marketplace images stay in the droplet create form's image-picker (already fetched there).
- NFS shares (`/v2/nfs`) — list, create (`name`, `region`, `size_gib`, `vpc_ids`, `performance_tier`), delete (passes `?region=` query param). Sizes 50–16,000 GiB; not all regions host NFS — create returns 422 in unsupported ones.
- **Gradient AI Platform** (`/v2/gen-ai/...`): `gen-ai-agent`, `gen-ai-knowledge-base`, `gen-ai-model-router`, `model-api-key`. All resource lists are top-level (not project-scoped — DO's GenAI plane has its own scoping). Region pickers query `/v2/gen-ai/regions` (not `/v2/regions`, which only covers classic IaaS). Model pickers query `/v2/gen-ai/models?usecases=...` filtered by `MODEL_USECASE_AGENT` / `MODEL_USECASE_KNOWLEDGEBASE` / `MODEL_USECASE_SERVERLESS`. Knowledge bases expose the hybrid retrieval endpoint as `retrievalEndpoint` = `https://kbaas.do-ai.run/v1/{uuid}/retrieve`. Agents expose the deployment URL as both `deploymentUrl` and `agentEndpoint` (the latter doubles as the OpenAI-compatible `baseURL`). `model-api-key` is **list + delete only** — DO retired the create endpoint (`resource retired: Creating model API keys through this endpoint is retired. Go to Model Studio…`), so the resource has no `supportsCreate`/create handler/`secretKey` output; keys are minted in DO Model Studio. (Agent endpoint keys — `agent-api-key` — are a separate endpoint and still creatable.)
- **Knowledge base management (data sources + indexing)**: `gen-ai-knowledge-base` declares `supportsUpdate: true` — `updateResource` PUTs `/v2/gen-ai/knowledge_bases/{uuid}` with only `name`/`tags`/`project_id`/`database_id` (region + embedding model are locked `editable: false` because DO forces a recreate on change; the update payload doesn't even accept them). `enrichGenAiKnowledgeBase` (wired into `enrichDetail`) fans out three best-effort calls — `GET .../knowledge_bases/{uuid}/data_sources`, `GET .../knowledge_bases/{uuid}/indexing_jobs`, and `listSpacesBuckets` (returns `[]` without Spaces keys) — and stashes them as `__dataSources__` / `__indexingJobs__` / `__spacesBuckets__` JSON for the sync `applyGenAiKnowledgeBaseDetail`. The detail page renders a Data Sources table (per-row Reindex/Remove), an Indexing Jobs history table (per-job Cancel when status is `INDEX_JOB_STATUS_IN_PROGRESS`/`_PENDING`), and a copyable retrieval-endpoint row. Header actions (all `prompt-nosql-command` → `executeNoSqlCommand`): **+ Add Spaces source** (`add-spaces-source` → POST `data_sources` with `spaces_data_source:{bucket_name,region,item_path?}`; a `bucketSource` select toggles between **pick** — a `resource-picker` over `spaces-bucket` resources that submits the bucket's `bucketRef` output `name|region` (`listSpacesBuckets` sets `bucketRef` alongside `endpoint`) — and **manual** (`spacesBucketName` text + `spacesRegion` region-picker), gated by `showWhen`. Default is `pick` when enrich discovered buckets, else `manual` (no Spaces keys). Both pick/manual fields are `required:false`; the handler resolves the name+region from whichever path and validates), **+ Add web source** (`add-web-source` → `web_crawler_data_source:{base_url,crawling_option,embed_media}`; crawl options `SCOPED`/`PATH`/`DOMAIN`/`SUBDOMAINS`/`SITEMAP`), and **Reindex all** (`start-indexing` → POST `/gen-ai/indexing_jobs` with `{knowledge_base_uuid}` and **no** `data_source_uuids` — omitting it reindexes everything; per-source reindex sends the one uuid). Remove = `DELETE data_sources/{uuid}`; cancel = `PUT /gen-ai/indexing_jobs/{uuid}/cancel` with `{uuid}` body. File-upload + Dropbox/Drive sources are deliberately not modelled (presigned-upload / OAuth flows).
- **Agents ↔ Inference Routers**: `apiCreateAgentInputPublic` accepts `model_uuid` XOR `model_router_uuid` (mutually exclusive — sending both is a 400). The agent create form exposes a `modelSource` toggle (`"model"` / `"router"`) with `showWhen`-gated pickers. `gen-ai-agent` declares `supportsUpdate: true` and `client.updateResource` maps the editable field set to DO's snake_case keys; if `modelRouterUuid` is touched and non-empty it wins (router supersedes model), if cleared we fall back to whichever side still has a value. `temperature` / `maxTokens` / `k` are coerced from the host's diff strings to numbers before PUT.
- **Model routers are all-region + preset-driven**: `POST /v2/gen-ai/models/routers` rejects any explicit `regions` (`InvalidArgument: regions is deprecated and must be omitted or set to ["all"]`) — omit it; resource `regions` field = `"all"`. It also rejects arbitrary serverless model UUIDs as `fallback_models` (`InvalidArgument: model {uuid} not found`) — only router-eligible identifiers work. So the create form offers a **Routing preset** picker from `GET /v2/gen-ai/models/routers/presets` (each preset's `config` has valid `fallback_models` + `policies`); on create we re-fetch presets, find the chosen slug, and pass its `config.fallback_models`/`config.policies` straight through (DO-issued identifiers, guaranteed valid). "None" creates a bare router to configure later. Do NOT build `fallback_models` from `/gen-ai/models?usecases=MODEL_USECASE_SERVERLESS` UUIDs. The router detail page (`applyGenAiModelRouterDetail`) renders a **Routing Policies** table (Task · Models · Prefers — cheapest/fastest/balanced · Edit · Remove) and a **Fallback Models** table, read from the router's `config.policies` / `config.fallback_models` which `listGenAiModelRouters` normalizes (model entries can be id-strings or `{uuid,name}` objects) and stashes as `__policies__` / `__fallbackModels__`. **Editing policies**: `enrichGenAiModelRouter` fetches `/v2/gen-ai/models/routers/tasks/presets` (valid `task_slug`s + their router-eligible default `models`) and a `/gen-ai/models` uuid→name map, stashing `__taskPresets__` / `__routerModelOptions__`. The detail page's **+ Add policy** header action and per-row **Edit** open a `prompt-nosql-command` (`save-router-policy`) with a task select, a Balanced/Cheapest/Fastest preference select, and a `policy-picker` multi-select of router-eligible models (leave empty → the task preset's default models). **Remove** dispatches `remove-router-policy`. Both handlers GET the router, **normalize all policies to the request shape** (models coerced to id strings — the response can have `{uuid,name}` objects but `apiModelRouterTaskPolicy.models` is `items:string`), mutate the array (replace by `originalTask`/`task` slug on save, filter on remove), and `PUT /v2/gen-ai/models/routers/{uuid}` with `{uuid,name,description?,fallback_models,policies}` — `fallback_models` is passed through verbatim from the GET so it isn't disturbed. Untested against a live router; coded to the OpenAPI spec.
- **Inline router create**: the `modelRouterUuid` picker carries a `FieldAction` (`id: "create-inference-router"`) with a `formFields` mini-form (name, description, optional fallback models). The host's `useCreateResourceForm` calls `client.executeFieldAction`, the DO client POSTs `/gen-ai/models/routers`, and returns `{ value: newUuid, option: { id, label } }` — the host splices the option into the picker and selects it. This is the canonical "inline-create a dependency from another create form" pattern; the primitive is already in plugin-base (`FieldAction.formFields` + `PluginClient.executeFieldAction`) and doesn't need plugin-core changes for new use cases.
- **Workspaces (and why agent create kept 403-ing)**: DO's GenAI plane scopes agents (and other GenAI resources) to a `workspace_uuid`. The REST API surfaces it as "optional" but the platform enforces it — POSTing to `/v2/gen-ai/agents` without a workspace returns `{"id":"forbidden","message":"failed to create agent"}` (the same generic shape as a missing-scope 403, which is misleading). The DO web console transparently auto-creates a workspace on first use; we match that UX: the agent create form has a `workspaceUuid` picker populated from `/v2/gen-ai/workspaces` with a `create-workspace` `FieldAction` for inline-create, and the create handler falls back to listing → auto-creating a "default" workspace when the picker is empty (covers fresh accounts where the user doesn't even know workspaces exist).
- **Agent feature parity with the DO dashboard**:
  - **Endpoint Access Keys** — `agent-api-key` is a child resource type of `gen-ai-agent` (`parentTypeId: "gen-ai-agent"`, `showInSidebar: false`). Composite externalId `{agentUuid}/{keyUuid}` because DO scopes the endpoint to the parent agent (`POST/DELETE /v2/gen-ai/agents/{agent_uuid}/api_keys[/{key_uuid}]`). **Response-shape gotcha**: the create response nests the one-shot secret at `api_key_info.secret_key` (NOT a top-level `secret_key` like the _model_ API key endpoint returns). Reading `data.secret_key` silently captured nothing — the symptom was "DigitalOcean didn't return an endpoint access key" on the Playground and a secret-less key in the list. Both the create handler and `getOrMintPlaygroundKey` now read `api_key_info.secret_key ?? secret_key`. Secret persisted as `PlaintextSecretResolution` on the `secretKey` field. List endpoint never returns secrets, so pre-existing/externally-minted keys are stored without a recoverable value. List path fans out across every agent (no team-wide list endpoint) with `Promise.allSettled`.
  - **Endpoint visibility toggle** — `applyGenAiAgentDetail` adds a Make Public / Make Private header action whose label tracks `deployment.visibility` (values `VISIBILITY_PUBLIC` / `VISIBILITY_PRIVATE`). `invokeAction` PUTs `/gen-ai/agents/{uuid}/deployment_visibility` with `{ visibility }`.
  - **Endpoint + Embed sections** — an "Endpoint" section renders the deployment URL and the OpenAI base URL (`{origin}/api/v1`) as `copyable` KVItems (the host's `KVItemRenderer` shows a copy button whenever `copyable` is set). An "Embed (public chatbot)" section builds DO's widget `<script>` snippet via `buildAgentEmbedScript` — served from `{deploymentOrigin}/static/chatbot/widget.js` with `data-agent-id` / `data-chatbot-id` / colour + starting-message attrs. The chatbot identifier comes from `chatbot_identifiers[0].agent_chatbot_identifier` and the styling from the `chatbot` object, both captured in `enrichGenAiAgent` into `__chatbotId__` / `__chatbot__`. The snippet only renders for public endpoints (the widget can't auth against a private one); private agents get a "make it public first" note instead. The script is one `text` node with `variant: "mono"` + `copyable: true` — `TextNode` gained an optional `copyable` flag, and the host's `TextNodeRenderer` floats a `CopyButton` in the top-right of mono blocks when set (no separate KVItem row).
  - **Observability (metrics)** — `gen-ai-agent` sets `supportsMetrics: true`; `fetchMetricSeries` has a branch that GETs `/gen-ai/agents/{uuid}/usage?start=&stop=` (ISO timestamps), and returns up to 6 series: Input/Output/Total tokens per bucket plus flat one-point series for Throughput (tokens/s), Latency (s), and Time-to-first-token (s). 404/403 collapses to `[]` (legitimate "no traffic yet" empty state). The bucket series come from `usage.usage[].input_tokens` / etc.; the flat metrics come from `usage.throughput_tokens_per_second` and siblings.
  - **Attachments (Resources tab)** — `applyGenAiAgentDetail` uses `enrichDetail` to fan out a `GET /v2/gen-ai/agents/{uuid}` (for the full agent shape with its `knowledge_bases` / `functions` / `child_agents` arrays) plus list calls for the agent-and-KB pickers, and stuffs the result into `resolvedOutputs.__attachedKbs__` / `__functions__` / `__childAgents__` / `__allAgents__` / `__allKbs__` as JSON strings. `renderDetail` reads them back via `parseJsonArray` and renders TableNode sections with per-row Detach `ActionNode` cells (KVItem doesn't support inline actions; TableNode is the right primitive). Attach flows go through `prompt-nosql-command` + `executeNoSqlCommand` for KB attach (picker), function-route add (multi-field form), child-agent attach (picker + route name + if-case). The function-route form's **FaaS namespace** field is a `select` populated from `GET /v2/functions/namespaces` (fetched in `enrichGenAiAgent`, stashed in `__functionNamespaces__`); the value submitted is the `fn-…` namespace id, label shows `{label} ({region})`. Falls back to a free-text field when the account has no namespaces. The FaaS function _name_ stays free-text — the /v2 API can't enumerate the functions inside a namespace (that needs the per-namespace OpenWhisk key). The Input/Output JSON Schema fields use `kind: "json-schema"` — a structured, no-code builder (`JsonSchemaEditor` in `@infrawrench/ui`): each row is one top-level property (name · type · required · description), serialized to a JSON-Schema object string (`{type:"object",properties,required}`), `""` when empty. Deliberately NOT Monaco/raw-text. `kind: "json-schema"` is a generic `CreateFieldKind` rendered by the shared `FieldRenderer`, so any plugin's create or prompt form can use it; it renders inline (not split-pane). Scope: top-level object properties with primitive/array/object types — deep nesting isn't modelled (the type is declared but items/sub-props aren't). Knowledge base drag-attach is also wired via `attachTargets` on `gen-ai-knowledge-base` → `gen-ai-agent`, dispatched to `attachResource` which POSTs `/gen-ai/agents/{agent_uuid}/knowledge_bases/{kb_uuid}`.
  - `prompt-nosql-command` quirks: it has `description`, `descriptionVariant` (`"info"` default / `"error"`), `submitLabel`, `danger`, `fields` — but **no** `successMessage` and **no** `confirmMessage`. Destructive prompts use `danger: true` + a `description` that asks for confirmation; the submit button styling carries the warning. `descriptionVariant: "error"` renders the description as a red warning banner (⚠ icon) instead of muted text — use it for empty-state/blocked prompts (e.g. "no knowledge bases available to attach"). `blocked: true` turns the prompt into an informational dialog — the host hides the form fields and the Submit button, leaving just the title, (error-styled) description, and a single Close button (the Modal also closes on Esc / backdrop click). Use `blocked` + `descriptionVariant: "error"` together when an action can't proceed because there's nothing to pick. Both flags thread schema → both dispatch sites (SchemaRenderer + DetailView) → `PromptNoSqlCommandDetail` → `PromptNoSqlCommandModal` → both host render sites (desktop `-ResourceModals.tsx`, web resource route). `plugin-action` does have `confirmMessage` and `successMessage` for parameterless host-confirmed actions.
  - **Global-event resource scoping (multi-tab bug)**: schema actions dispatch via global `window` CustomEvents (`iw:prompt-nosql-command`, `iw:invoke-plugin-action`, …). The desktop `WorkspaceTabsViewport` keeps _every_ open tab's detail panel mounted simultaneously, so each panel's listener fires on every dispatch — symptom: clicking one prompt action opened N stacked modals (one per open tab), and `invoke-plugin-action` ran N times against possibly-wrong resources. Fix: `SchemaRenderer`'s `useActionDispatch` stamps the originating `resourceId` onto `InvokePluginActionDetail` / `PromptNoSqlCommandDetail`, and each panel's handler early-returns when `detail.resourceId && detail.resourceId !== decodedResourceId`. `resourceId` is optional → unscoped legacy dispatchers (e.g. `dispatchPillAction`) still reach all listeners. The header SchemaRenderer is given `resourceId={decodedResourceId}`, so the match is exact.

## Chat / Playground capability (cross-plugin)

`@infrawrench/plugin-base` exposes a `chatPanel?: ChatPanelCapability` field on `DetailViewSchema` and a matching `streamChatMessage?` method on `PluginClient`. The host renders a tab when the capability is set and `onChatStream` is provided.

- `streamChatMessage` returns an `AsyncIterable<ChatStreamEvent>`. Each event is one of `{kind:"delta",text}` / `{kind:"done",message,usage?}` / `{kind:"error",message}`. Plugins that can't stream natively can yield a single `delta` with the full text then `done` — the host renders the result the same way.
- The shared `ChatPanel` component (`@infrawrench/ui`) drives the UI: auto-grow textarea, Cmd/Ctrl+Enter to send, message bubbles, per-turn usage chip, Stop button (AbortController), New chat reset, scroll-position-aware auto-follow. Capability fields (`tabLabel`, `subtitle`, `greeting`, `inputPlaceholder`, `disabledReason`) shape the wrapper without changing the chat protocol.
- Desktop host: the renderer holds the plugin client in-process, so `onChatStream` forwards the iterable directly. Cloud-synced (Infrawrench-sync) accounts surface an explicit "chat over cloud-synced isn't wired yet" error — local DO accounts work as-is.
- Web host: NDJSON over POST. `POST /api/org/:orgId/resources/chat-stream` writes one JSON-encoded `ChatStreamEvent` per line; the browser parses with `ReadableStream.getReader()` + `TextDecoder`, splitting on `\n`. `Content-Type: application/x-ndjson` + `X-Accel-Buffering: no` keeps proxies from buffering.

### Providers that wire `streamChatMessage`

All reuse the DO SSE-parsing structure; the chat-capable resource sets `detail.chatPanel` in its `renderDetail`/detail-renderer.

- **DigitalOcean** `gen-ai-agent` — see below.
- **Databricks** `databricks-serving-endpoint` (new) — lister `listServingEndpoints` (`GET /api/2.0/serving-endpoints`); chat POSTs `{host}/serving-endpoints/{name}/invocations` with `{messages, stream:true}` (OpenAI-compatible SSE), bearer PAT. `disabledReason` until `state.ready === "READY"`.
- **Cloudflare** `workers-ai-model` (new) — one resource per Text-Generation model from `GET /accounts/{id}/ai/models/search?task=Text Generation`; chat POSTs `/accounts/{id}/ai/v1/chat/completions` with `{model: "@cf/…", messages, stream:true}` (OpenAI-compatible SSE), bearer API token.
- **GCP** `vertex-gemini-model` (new) — curated static catalog of Gemini model ids (`gemini-2.5-pro/flash`, `gemini-2.0-flash[-lite]`, `gemini-1.5-pro/flash`); chat POSTs the Vertex OpenAI-compatible endpoint `…/locations/{loc}/endpoints/openapi/chat/completions` with `{model: "google/{id}", messages, stream:true}`, OAuth2 bearer, project from creds, location `us-central1`.
- **AWS** `bedrock-model` (new) — lister filters `GET bedrock.{region}.amazonaws.com/foundation-models` to `outputModalities⊇TEXT` + `inferenceTypesSupported⊇ON_DEMAND`; chat is **non-streaming** (Bedrock's stream is the binary `vnd.amazon.eventstream` protocol — skipped) via SigV4-signed `POST bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse` (reuses the existing `fetchSigned` helper with `service: "bedrock"`), maps `ChatMessage[]` → Converse `{messages:[{role,content:[{text}]}], system?, inferenceConfig:{maxTokens}}`, yields one `delta` with the full reply then `done` + usage.

### DO agent implementation

- `applyGenAiAgentDetail` sets `detail.chatPanel` with model-name subtitle and a `disabledReason` while the deployment is provisioning (status not yet `STATUS_RUNNING`).
- `streamChatMessage` resolves the deployment URL via `GET /v2/gen-ai/agents/{uuid}` (`deployment.url`) and authenticates with an **endpoint access key**. Account PATs don't authenticate against the `agents.do-ai.run` gateway — they're for the control plane.
- **One key per agent, persisted + reused (not minted-per-session)**: `getOrMintPlaygroundKey(agentUuid, agentResourceId)` resolves in priority order — (1) in-memory session cache, (2) the host's persisted secret store via `services.secrets.getPlaintext(agentResourceId, "__playgroundEndpointKey")`, (3) mint a fresh `infrawrench-playground` key, then `services.secrets.setPlaintext(...)` to persist it. On the cloud (web) host the secret-field store is **org-scoped**, so every team member's Playground reuses the one minted key; the secret stays server-side (the chat stream runs in the NDJSON route) and is never shipped to other users' browsers. On desktop it persists to local SQLite. This stops the old behaviour of minting a new token every session. The list endpoint never returns secrets, so we can't reuse arbitrary pre-existing keys — only the one we minted and stashed.
- **Host write path**: `SecretHostServices` gained an optional `setPlaintext(resourceId, fieldKey, value)`. Wired in `server-core/host-services.ts` (encrypt + `onConflictDoUpdate` upsert into `secretFieldStates`) and `desktop/lib/sql-drivers.ts` (delegates to `persistPlaintextSecret`). It's optional on the interface so older host builds still typecheck; plugins guard with `if (services?.secrets?.setPlaintext)`.
- The request body uses OpenAI-compatible `{messages, stream: true, stream_options: {include_usage: true}}` posted to `${deploymentUrl}/api/v1/chat/completions`. The response is SSE (`data: {json}\n\n` lines, `data: [DONE]` terminator). The plugin parses incrementally and yields a `delta` per `choices[0].delta.content` chunk, then a terminal `done` with the assembled message and `usage` (if the gateway honoured `include_usage`).
- **Inference Engine** — `dedicated-inference` uses `/v2/dedicated-inferences`; `inference-batch` uses `https://inference.do-ai.run/v1/batches` (data-plane host, same bearer token but `this.fetch` targets api.digitalocean.com so the batch list/cancel calls bypass it). Dedicated Inference create payload has a nested `spec` envelope (`{spec: {name, region, vpc.uuid?, enable_public_endpoint, model_deployments:[{model_id, size}]}, access_tokens?: {hugging_face_token?}}`) and returns 202 Accepted with a `pending_deployment_spec` while provisioning; once active the spec moves to top-level `spec` and `endpoints.public_endpoint_fqdn` / `private_endpoint_fqdn` are populated. Sizes catalog from `/v2/dedicated-inferences/sizes`, supported model→accelerator map from `/v2/dedicated-inferences/accelerators`. Batch jobs paginate with `after` cursors (not page/per_page); listing fetches the newest 100 only — older history is left in the DO console. Batch delete is a `POST /v1/batches/{id}/cancel` (not `DELETE`).
- **GenAI early-access tolerance**: `fetchOrEmpty()` collapses 401/403/404 errors on the gen-ai endpoints to an empty list, so accounts that haven't opted into the product don't see error spinners — they just see empty sidebar groups.
- Managed database engine list now includes `weaviate` (PRIVATE PREVIEW; users need to sign up at digitalocean.com — create returns 422 in regions that don't host Weaviate yet).
- **Redis → Valkey**: DO discontinued Managed Redis on 2025-06-30 and fully replaced it with Valkey (drop-in Redis-compatible). The retired `redis` engine can no longer be provisioned — `POST /databases` with `engine=redis` rejects **every** region with `region '<slug>' is not valid` (the dead engine has no valid region set), which looked like a region bug but was the engine. The create form's caching option now sends `engine: "valkey"` (`create-handlers.ts` engine select). The region/size pickers already alias `valkey`↔`redis` (`engineAliases`) so live `/databases/options.valkey` data and the hardcoded fallback both filter correctly. Downstream: the metrics `engineMap` (`client.ts`) maps `valkey→valkey` (DO's monitoring path is `/monitoring/metrics/database/valkey/…`); `managed-database` resource type adds `valkey` to `enumValues`; a second `redis`-plugin peer integration is gated `engine==="valkey"` (tabLabel "Valkey") alongside the legacy `engine==="redis"` one, since pre-migration clusters may still report `redis` and the Redis plugin drives both (wire-compatible, `rediss://`).
- **Managed-DB connection credentials per engine**: DO's `database_user.password` is `readOnly` + requires the `database:view_credentials` scope and is only ever returned at user-**create** time (the `/users` list always shows empty passwords); **Kafka** users authenticate via mTLS `access_cert`/`access_key`, not a password. Split behaviour in `resolveOutput("connectionString")`: for **pg/mysql** (`captureFromDefault`) we still try the cluster's inline password + the default user via `/users`. For **mongodb/redis/valkey/opensearch/kafka** we DON'T poke `/users` (it's noise) — those rely entirely on a user minted through the **"Make connection user"** header action (`applyManagedDatabaseDetail` adds it for those engines when `online`). That action is a `prompt-nosql-command` → `executeNoSqlCommand("make-db-user")` which POSTs `/databases/{id}/users`, then persists the returned credential via `services.secrets.setPlaintext(dbUserId, "password"|"accessCert"|"accessKey", …)` keyed to `{accountId}:db-user:{clusterId}:{name}`. `findMintedDatabaseUser` reads the stored `password` back for the connection string. The DB Users child-section create still works too (pg/mysql path). Errors point users at the button instead of the old generic "no password" message. The same button is surfaced **inside the peer pane** too, via `PeerPluginIntegration.credentialSetupAction` (+ `PeerPaneSchema.guidance.action`): when credential resolution throws, both hosts' peer-pane builders render a guidance pane with a CTA that dispatches the `make-db-user` `prompt-nosql-command` to the parent resource (`PeerPaneView` passes `resourceId: parentResourceId`); on submit the host dispatches a refresh so the pane re-resolves.
  - **Prompt-command refresh parity (desktop)**: the minted credential only shows up after a refresh re-runs the peer pane's `resolveOutput`. Web's prompt-modal `onSubmit` already dispatched `REFRESH_RESOURCE_EVENT`, but the **desktop** route's `onSubmitPromptModal` did not — so after "Make connection user" the Kafka/Mongo/etc. peer tab stayed stuck on the same "no password" guidance even though the credential was stored. Desktop now calls `dispatchRefreshResource()` after a successful `handleNoSqlCommand`, which `bgRefresh` turns into a peer-pane re-hydration (it resets `peerPanesHydratingRef` and re-calls `handlePeerPaneOpen`). Only fires on success — a thrown command leaves the modal open with its error (the `-ResourceModals` wrapper awaits the submit before `onClosePromptModal`).
  - **Kafka user create needs `settings.acl`**: unlike every other engine, `POST /databases/{id}/users` for a **Kafka** cluster rejects a bare `{ name }` body with 422 `"" is an invalid value for settings. Constraints for this param are: settings is required`. Kafka users carry an ACL, so the body must include `settings: { acl: [{ topic, permission }] }` (`permission` ∈ `admin`/`produceconsume`/`produce`/`consume`; `topic` is a name or regex, `*` = all; `id` is auto-assigned). Both create paths now detect the engine via `GET /databases/{id}` and, for Kafka only, attach an ACL — defaulting to `admin` on `*` so the minted user can drive the console. `kafkaAclFields()` (exported from `resources/managed-database.ts`) supplies editable `topic` + `permission` fields, appended to the make-connection-user header action / peer-guidance action (`makeKafkaConnectionUserAction`) and the `db-user` child-create form when the parent is Kafka. Non-Kafka engines keep the bare `{ name }` body.
  - **Kafka connects via SASL/SCRAM, NOT mTLS** (important — we tried mTLS and it didn't work): DO managed Kafka serves **SASL_SSL** and **SSL/mTLS** on **different ports**, and the API's `connection.uri` is the SASL_SSL port. The SSL/mTLS port is NOT exposed via the API (`database_cluster.yml` only has one `connection`/`port` per cluster), so sending an mTLS client-cert handshake to the SASL_SSL port gets the socket closed (`KafkaJSConnectionClosedError`). So `resolveOutput("connectionString")` for Kafka uses SASL. CRITICAL: DO's Kafka `connection` block leaves **`uri` empty** (multi-listener cluster) and only fills `host`/`port`, so we build the bootstrap from `host:port` — NOT from `conn.uri` (using `conn.uri` produced an empty string → "Kafka plugin: missing connectionString credential" in the peer pane). The built string is `kafka://<user>:<password>@<host>:<port>?sasl=scram-sha-256&ssl=true&ssl_ca=<base64 CA PEM>` (that `port` is the SASL_SSL listener). The `ssl_ca` is mandatory: DO signs broker certs with its own CA, so without it kafkajs fails the TLS handshake with "self signed certificate in certificate chain". The kafka driver decodes `ssl_ca` and sets `config.ssl = { ca: [pem], rejectUnauthorized: true }` (alongside `config.sasl`), so it's SASL over verified TLS. The SASL password requires the token to have `database:view_credentials` (NOT in "Full Access" by default). If only the user's mTLS `access_cert`/`access_key` were captured (no password), `resolveOutput` throws a clear error telling the user to re-scope the token — it does **not** try mTLS, since the SSL port is unavailable. `findMintedDatabaseUser` returns `accessCert`/`accessKey` (used only to detect the cert-only case for that message); `resolveCaCertificate` is extracted from the `caCertificate` output. The kafka driver's `buildKafkaConfig` is exported for tests but has no mTLS branch.
  - **`renderPeerPane` lets `listTopics` throw**: an empty cluster returns `[]`, so a thrown error means the connection/auth genuinely failed — surfacing it (instead of the old `.catch(() => [])` that showed a misleading "Connected — nothing to show"). Consumer-group listing stays soft (`.catch(() => [])`) since some clusters scope it separately.
  - **Create topics from the Kafka peer pane**: once connected, a fresh cluster's peer pane is empty. The kafka plugin's `renderPeerPane` Topics group now sets `supportsCreate: true` (consumer groups don't — they form when a consumer subscribes), and the plugin gained a `getCreateConfig("kafka-topic")` (name + partitions + replicationFactor, defaults 3/1) to back the create modal. The desktop peer-create path (`components/PeerPaneView.tsx` → `createClientFactory` → `buildPluginHostServices`) builds a kv-connected kafka client from `pane.credentials.connectionString` (the resolved mTLS URI), so `createResource` → `kv.command("createTopic", …)` runs over the same mTLS connection. Same `supportsCreate` empty-state pattern as the mongodb Databases group.
  - **Kafka driver retries stale pooled connections**: `driver.ts` pools one admin client per connection string (module-level `adminPool`, 60s idle eviction). The peer pane's `listTopics` opens that connection; by the time the user submits "Create Topic" the broker may have closed the idle socket, so reusing the pooled admin throws `KafkaJSConnectionClosedError: Closed connection` (looked like "create is broken" even though listing had just worked). The driver's `command` now retries **once** on a stale-connection error: `isStaleConnectionError` (name `KafkaJSConnectionClosedError` or message matching closed/timeout/ECONNRESET/EPIPE) → `dropAdmin` (delete + disconnect) → reconnect fresh. The switch body was extracted into `runAdminCommand(admin, cmd, args)` so the retry loop wraps every command, not just create.
  - **Host-services gotcha (desktop)**: the desktop detail **loader** (`-loader.ts`) built the parent client's `HostServices` only from driver-specific builders (`buildHostServices`/`buildKvHostServices`/`buildDockerHostServices`) or `undefined` — it omitted the `secrets` service entirely, so `services.secrets.setPlaintext`/`getPlaintext` were missing on HTTP-only plugins like DigitalOcean (symptom: "This host can't persist credentials"). Fixed by always merging `secretHostServices` (now exported from `lib/sql-drivers.ts`) onto the driver services. Web was already fine (it routes through `buildPluginHostServices`, which includes secrets). When adding host-services-dependent plugin features, ensure EVERY client-construction path includes the service — there are several (`createPluginClient`, `buildPluginHostServices`, the loader's inline build, fast-SQL sessions, peer clients).
  - **Empty peer pane + create**: `PeerPaneView` hides empty resource groups (`g.items.length > 0 || g.supportsCreate`); a connected-but-empty peer (e.g. a fresh Mongo cluster with no user databases) previously rendered totally blank. Now there's an empty-state ("Connected — nothing to show here yet." + what's missing). To make it actionable, a group can set `supportsCreate: true` (renders even when empty, with a "Create …" button → host `onCreate` → CreateResourceModal against the PEER plugin client). The **mongodb** plugin uses this: `mongodb-database` is `supportsCreate`, and the peer pane's Databases group sets `supportsCreate: true`. Mongo `getCreateConfig` asks for a database name + first collection (Mongo materialises a DB only when its first collection exists); `createResource` calls `kv.command("createCollection", db, coll)`. Clicking a database pill opens its detail, where `DataPanels` renders `MongoDocumentBrowser` (isKvPlugin + `kvDriverName === "mongodb"`) for collections/documents.

### Neon (`@infrawrench/plugin-neon`)

- Auth: Neon API key (`neon_...`), passed as `Bearer` token to `https://console.neon.tech/api/v2`
- Resource hierarchy: Project → Branch → (Endpoint, Database, Role)
- Resource ID formats: `{accountId}:neon-project:{projectId}`, `{accountId}:neon-branch:{projectId}/{branchId}`, `{accountId}:neon-database:{projectId}/{branchId}/{dbName}`
- Connection string resolved via `GET /projects/{id}/connection_uri?branch_id=...&database_name=...&role_name=...`
- Role password resolved via `GET /projects/{id}/branches/{branchId}/roles/{roleName}/reveal_password`
- No `sqlDriver` declared — Neon is a management plugin. For SQL editing, link a Postgres plugin account to a Neon database's `connectionString` output
- Postgres plugin declares `peerPlugins: ["digitalocean", "neon"]` and `pg-database.connectionString` has a `resolvableFrom` entry for `neon/neon-database/connectionString`
- Supports create for projects (with region/pg-version picker), branches, and databases
- Supports delete for projects, branches, and databases

### Hetzner Cloud (`@infrawrench/plugin-hetzner`)

- Auth: Bearer token against `https://api.hetzner.cloud/v1`
- Resource ID format: `{accountId}:{typeId}:{externalId}` (externalId is the Hetzner numeric ID)
- Resource types: `server`, `volume`, `floating-ip`, `firewall`
- Server create supports SSH key upload (idempotent — catches uniqueness_error and matches by public_key)
- Paginated fetch helper (`fetchAll`) handles Hetzner's `meta.pagination` envelope
- Locations: `fsn1` (Falkenstein), `nbg1` (Nuremberg), `hel1` (Helsinki), `ash` (Ashburn), `hil` (Hillsboro), `sin` (Singapore)
- Server status mapping: running→healthy, initializing/starting/rebuilding→provisioning, stopping/migrating→degraded, off/deleting→error

### Scaleway (`@infrawrench/plugin-scaleway`)

- Auth: `X-Auth-Token` header against `https://api.scaleway.com`
- Credentials: `accessKey` (SCW...), `secretKey` (UUID), `defaultProjectId` (UUID)
- Resource types: `instance`, `kapsule-cluster`, `rdb-instance`, `object-storage-bucket`
- Instance API is zone-scoped (`/instance/v1/zones/{zone}/servers`); all 9 zones (fr-par-1/2/3, nl-ams-1/2/3, pl-waw-1/2/3) are polled in parallel
- Kapsule and RDB APIs are region-scoped (`/k8s/v1/regions/{region}/clusters`, `/rdb/v1/regions/{region}/instances`); all 3 regions polled in parallel
- Resource ID format: `{accountId}:{typeId}:{zone_or_region}/{providerId}`
- Instance delete uses `terminate` action (also releases IP); Kapsule delete passes `with_additional_resources: true`
- Object Storage uses S3-compatible API at `s3.{region}.scw.cloud` with path-style addressing; storage browser + bucket policy editor wired via `plugin-base/s3-storage-helpers.ts`
- Commercial types fetched from `/instance/v1/zones/{zone}/products/servers` for create form
- Instance status mapping: running/ready→healthy, starting/stopping/provisioning/creating→provisioning, stopped/error/locked/deleting→error

### Kubernetes (`@infrawrench/plugin-kubernetes`)

- Manifest editor: all namespaced resource types (Pod, Deployment, Service, StatefulSet, DaemonSet, Job, CronJob, Ingress, ConfigMap, Secret) declare `manifestEditor` on their `DetailViewSchema`. The host renders a Monaco-based JSON editor tab.
- `getManifest(resourceId, accountId)` fetches the full resource JSON from the K8s API; `applyManifest()` PUTs it back.
- Resource ID format: `{accountId}:k8s-{type}:{namespace}:{name}` (namespaced) or `{accountId}:k8s-{type}:{name}` (non-namespaced like namespaces).
- The `k8sApiPath()` helper maps type IDs to K8s API paths (e.g. `k8s-deployment` -> `/apis/apps/v1/namespaces/{ns}/deployments/{name}`).
- **Scratch (ephemeral) pods:** Pod creation form offers OS image presets (Ubuntu 24.04 default, Debian, Alpine, Fedora, Rocky, Amazon Linux, Arch, or custom) and a TTL picker (15m–24h). Pods are created with `activeDeadlineSeconds` + `restartPolicy: Never` + `sleep <ttl>` command. K8s auto-terminates the pod when the TTL expires. Expired ephemeral pods are auto-deleted during the next `listPods()` cycle (sidebar refresh). Pods are tagged with `infrawrench.io/ephemeral: "true"` label and `infrawrench.io/expires-at` / `infrawrench.io/ttl-seconds` annotations.
- `deleteResource()` is implemented for all namespaced K8s resource types via `buildResourcePath()`.
- **Logs tab** supported on pods, deployments, statefulsets, daemonsets, jobs, and services. `resolvePodForLogs()` picks the first Running pod from the workload/service selector (`spec.selector` for Service, `spec.selector.matchLabels` for workloads, `job-name={name}` for jobs). Rendered via the shared `LogsView` tab — no separate logs modal.
- **Import YAML** (kubectl apply -f equivalent): `importYaml(accountId, yaml)` uses server-side apply (PATCH with `Content-Type: application/apply-patch+yaml`, `fieldManager=infrawrench&force=true`). Multi-doc YAML supported via `yaml.loadAll`. `k8sApiForKind()` maps Kind → plural + namespaced. UI: "Import YAML" button in the k8s peer pane header opens `ImportYamlModal` (textarea + file picker). Cloud route: `POST /api/resources/:pluginId/import-yaml`; cloud-api wrapper `importCloudYaml()`; IPC: `cloud_import_yaml`.

### Docker (`@infrawrench/plugin-docker`)

- `dockerHost` credential: `unix:///var/run/docker.sock` (default) or `tcp://host:port`
- Dashboard card label uses `"Running"` instead of `"Tables"` for container count

### SSH (`@infrawrench/plugin-ssh`)

- Generic SSH VM plugin; credential: `host`, `port`, `username`, `privateKeyName` (references a saved key)

### Databricks (`@infrawrench/plugin-databricks`)

- Auth: Personal Access Token (PAT) as `Bearer` token against the workspace URL
- Credentials: `host` (workspace URL, e.g. `https://adb-1234567890.7.azuredatabricks.net`), `token` (PAT starting with `dapi...`)
- Resource types: `databricks-cluster`, `databricks-sql-warehouse`, `databricks-job`, `databricks-pipeline`, `databricks-catalog`, `databricks-schema` (child of catalog), `databricks-table` (child of schema)
- SQL Warehouses expose `executeQuery()` and `introspectResource()` via the Databricks SQL Statement API (`POST /api/2.0/sql/statements`) — REST-based query execution, no native SQL driver needed
- `resourceSqlDriver` declared on `databricks-sql-warehouse` with driver `"databricks"` and `connectionStringOutputKey: "warehouseId"`
- SQL introspection queries `system.information_schema.columns` for autocomplete metadata
- Unity Catalog hierarchy: Catalog → Schema → Table (schema is child of catalog, table is child of schema)
- Cluster state mapping: RUNNING→healthy, PENDING/RESTARTING/RESIZING→provisioning, TERMINATING→degraded, TERMINATED/ERROR→error
- Delete supported for clusters (`permanent-delete`), SQL warehouses, jobs, and pipelines
- Resource ID format: `{accountId}:{typeId}:{externalId}` — externalId is cluster_id, warehouse_id, job_id, pipeline_id, or Unity Catalog full name (`catalog.schema.table`)

### Turso (`@infrawrench/plugin-turso`)

- Auth: Bearer token (Platform API token) against `https://api.turso.tech/v1`
- Credentials: `apiToken` (Platform API token), `organizationName` (org slug)
- Resource types: `turso-group`, `turso-database`
- Groups are placement groups that define where database replicas live; databases belong to a group
- Database connection via libsql protocol: `libsql://dbname-orgname.turso.io`
- Per-database auth tokens generated via `POST /v1/organizations/{org}/databases/{name}/auth/tokens`
- Connection string format for the SQL driver: `libsql://host?authToken=TOKEN` — the libsql driver parses the authToken from the query parameter
- `resourceSqlDriver` declared on `turso-database` with driver `"libsql"` and `connectionStringOutputKey: "connectionString"`
- SQL node driver (`./driver`) uses `@libsql/client` — registered in `drivers.ts` as `libsql`
- Supports create/delete for both groups and databases
- Database status: sleeping→degraded, active→healthy
- Resource ID format: `{accountId}:{typeId}:{dbName}` or `{accountId}:{typeId}:{groupName}`
- 30+ edge locations available for group placement (3-letter IATA codes: iad, fra, nrt, etc.)

### PlanetScale (`@infrawrench/plugin-planetscale`)

- Auth: Service token — `Authorization: {serviceTokenId}:{serviceTokenSecret}` against `https://api.planetscale.com/v1`
- Credentials: `serviceTokenId`, `serviceTokenSecret` (sensitive), `organizationName` (org slug)
- Resource types: `ps-database`, `ps-branch` (child of ps-database)
- PlanetScale is MySQL-compatible (built on Vitess); branches are isolated schema environments with their own connection endpoints
- Branch connection: `POST /v1/organizations/{org}/databases/{db}/branches/{branch}/passwords` creates a password, then builds `mysql://user:pass@host/database`
- SQL node driver (`./driver`) is `mysql-planetscale` — wraps mysql2 with TLS forced on (PlanetScale requires encrypted connections); registered in `drivers.ts`
- `resourceSqlDriver` declared on `ps-branch` with driver `"mysql-planetscale"` and `connectionStringOutputKey: "connectionString"`
- Supports create/delete for both databases and branches
- Database state mapping: ready→healthy, awaiting_import→provisioning, else→error
- Branch status: ready→healthy, else→provisioning
- Resource ID format: `{accountId}:ps-database:{databaseName}` or `{accountId}:ps-branch:{databaseName}/{branchName}`
- Regions: AWS regions (us-east, us-west, eu-west, eu-central, ap-south, ap-southeast, ap-northeast, sa-east, ap-southeast-2)

### Cloudflare (`@infrawrench/plugin-cloudflare`)

- Auth: API Token (scoped, created at dash.cloudflare.com/profile/api-tokens), passed as `Bearer` token to `https://api.cloudflare.com/client/v4`
- Account ID is lazy-resolved from the first zone's `account.id` field and cached for the session
- 31 resource types: `zone`, `dns-record` (child of zone), `worker`, `r2-bucket`, `pages-project`, `pages-deployment` (child of pages-project), `kv-namespace`, `d1-database`, `queue`, `tunnel`, `ssl-certificate` (child of zone), `page-rule` (child of zone), `firewall-rule` (child of zone), `access-application`, `access-policy` (child of access-application), `load-balancer` (child of zone), `worker-route` (child of zone), `custom-hostname` (child of zone), `hyperdrive`, `email-routing-rule` (child of zone), `waiting-room` (child of zone), `spectrum-application` (child of zone), `logpush-job` (child of zone), `workers-ai-model`, `rate-limit-rule` (child of zone), `redirect-rule` (child of zone), `cache-rule` (child of zone), `ip-access-rule` (child of zone), `turnstile-widget` (account), `healthcheck` (child of zone), `notification-policy` (account), `vectorize-index` (account), `durable-object-namespace` (account, list-only)
- **updateResource / edit panels:** 17 types are editable (`supportsUpdate: true`): `dns-record`, `tunnel` (ingress only), and the batch wired through `updateResourceImpl` — `rate-limit-rule`/`redirect-rule`/`cache-rule` (reuse `editPhaseRule` + `RulePhaseSpec.buildBody` with an `enabled` toggle), `firewall-rule` (`editFirewallRule`), `ip-access-rule`, `waiting-room`, `load-balancer`, `hyperdrive` (name + caching only — origin needs the never-returned password), `custom-hostname` (SSL method only), `email-routing-rule` (name+enabled; matchers/actions preserved via a `get`), `spectrum-application`, `logpush-job`, `access-application`, `access-policy` (name/decision/precedence; include/exclude/require preserved via `get`), `page-rule` (status/priority; targets/actions preserved via `get`), `turnstile-widget`, `healthcheck`, `notification-policy`. **Key mechanism:** the host only sends changed keys, so `updateResourceImpl` calls `mergeCurrentFields` (fetch current resource, stringify fields, overlay the changed keys) before dispatching — every builder sees a complete field set, which matters for CF's full-replace PUTs and required-field PATCHes. Read-only/identity fields are marked `editable: false` on the resource type so they don't appear in the edit form.
- **Turnstile / Health Checks / Notifications** (`clients/turnstile-client.ts`, `healthcheck-client.ts`, `notification-policy-client.ts`): `turnstile-widget` (account, `turnstile.widgets.*`; externalId = sitekey; `siteKey` output + sensitive `secretKey` resolved on demand via `getWidgetSecret` → `widgets.get().secret`; `secretExportTemplates` for `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`). `healthcheck` (child of zone, `healthchecks.*`; HTTP/HTTPS build an `http_config`; `edit` is PATCH). `notification-policy` (account, `alerting.policies.*`; create models the email-delivery `mechanisms` case, `summarizeMechanisms` flattens for display, edit is PATCH). `turnstile-widget` and `notification-policy`/`healthcheck`: `turnstile-widget` wires metrics via `fetchTurnstileMetricSeries` (`turnstileAdaptiveGroups`, filter `siteKey`, `count` by `datetimeFifteenMinutes`); healthcheck/notification-policy have no useful time-series dataset so they omit metrics.
- **Vectorize / Durable Objects** (`clients/vectorize-client.ts`, `durable-object-namespace-client.ts`): `vectorize-index` (account, `vectorize.indexes.*` v2; externalId = name; create takes `config:{dimensions,metric}`; `indexName` output + export template; no update — Vectorize indexes are immutable). `durable-object-namespace` (account, `durableObjects.namespaces.list` — **list-only**, declared by deploying a Worker class; `namespaceId` output; wires metrics via `fetchDurableObjectMetricSeries` → `durableObjectsInvocationsAdaptiveGroups`, filter `namespaceId`, sum `{requests, responseBodySize}`). Token scopes added: `vectorize` (edit); DO listing reuses the existing `workers_scripts` scope. Vectorize has no metrics wired — `vectorizeQueriesAdaptiveGroups` exists but its dimensions/metrics couldn't be verified (schema mirror truncates), so it was left off rather than ship an unverified query.
- **Rules engine** (`clients/rules-engine-client.ts`): a generic ruleset-phase client (`listAllPhaseRules`/`createPhaseRule`/`deletePhaseRule`) parameterized by `RulePhaseSpec`, shared by `rate-limit-rule` (phase `http_ratelimit`), `redirect-rule` (`http_request_dynamic_redirect`), and `cache-rule` (`http_request_cache_settings`). Each rule's externalId is `<zoneId>/<rulesetId>/<ruleId>`. `firewall-rule` (WAF custom rules, `http_request_firewall_custom`) predates this and has its own client. `ip-access-rule` uses `firewall.accessRules.*` (externalId `<zoneId>/<ruleId>`). All hang off the zone's "Rules & WAF" customTab; create forms start with a zone picker.
- **invokeAction** (zone header `plugin-action` ActionNodes, returns `Promise<void>`): "Purge Everything" → `cache.purge({purge_everything:true})`; "Enable/Disable DNSSEC" → `zone-client.setDnssec` → `dns.dnssec.edit({status})`.
- DNS records use shared `@infrawrench/plugin-base` DNS helpers (`dnsRecordBadgeColor`, `formatDnsTtl`, `renderDnsRecordDetail`, `renderDnsRecordSidebar`) — same helpers used by DigitalOcean and GCP
- Paginated fetch uses Cloudflare's `page` + `per_page` + `result_info.total_pages` pattern
- Resource ID formats: `{accountId}:zone:{zoneId}`, `{accountId}:dns-record:{zoneId}/{recordId}`, `{accountId}:r2-bucket:{bucketName}`, `{accountId}:pages-project:{projectName}`, `{accountId}:pages-deployment:{projectName}/{deploymentId}`, etc.
- Zone-scoped resources (DNS records, SSL certs, page rules, firewall rules, load balancers, worker routes, custom hostnames, email routing rules, waiting rooms) iterate all zones to list
- Account-scoped resources (Workers, R2, Pages, KV, D1, Queues, Tunnels, Access Apps, Hyperdrive) use the resolved `cfAccountId`
- Create supported for: zones, DNS records, R2 buckets, KV namespaces, D1 databases, queues, hyperdrive configs
- Delete supported for: zones, DNS records, R2 buckets, KV namespaces, D1 databases, queues, hyperdrive configs, workers
- R2 buckets declare `supportsStorageBrowser: true` — host renders the file browser via `listStorageObjects()`, `uploadStorageObject()`, `makeStorageFolder()`, `deleteStorageObject()`, `fetchStorageStats()`
- R2 storage browser uses `GET /accounts/{cfAccountId}/r2/buckets/{bucket}/objects?prefix=...&delimiter=/`; uploads via `PUT .../objects/{key}`
- D1 databases declare `resourceSqlDriver: { driver: "d1", connectionStringOutputKey: "databaseId" }` — REST-based SQL execution via `POST /accounts/{cfAccountId}/d1/database/{dbId}/query`
- D1 `executeQuery()` and `introspectResource()` implemented — introspection uses `sqlite_master` + `PRAGMA table_info` to populate SQL editor autocomplete with tables, columns, and primary keys
- Firewall rules are fetched from WAF custom rulesets (`phase: http_request_firewall_custom`) via the Rulesets API
- `CREATE_TOKEN_SCOPES` (in `plugin.ts`) builds the dash "create token" deep link; includes `cache_purge` (purge), `cache_settings` (edit), `transform_rules` (edit), `health_checks` (edit), `turnstile` (edit), and `notifications` (edit) alongside the originals
- The `detail-renderers.ts` barrel uses explicit named re-export blocks (NOT `export *`) — a new renderer must be added to the matching block or it won't surface (caused a "renderX is not a function" failure during the rules-engine work)
- Tunnels exclude soft-deleted entries (filters out records where `deleted_at` is set)
- Pages deployments are capped at 5 per project to avoid excessive API calls
- Tunnel tokens resolved via `GET /accounts/{cfAccountId}/cfd_tunnel/{tunnelId}/token`
- Access Policies are children of Access Applications — listed by iterating all apps and fetching per-app policies
- Hyperdrive configs include origin connection details (host, port, scheme, database, user) and caching state
- Email Routing Rules parse matchers and actions into human-readable strings
- Workers AND zones both declare `settingsEditor` — a settings _form_ (the generic `SettingsEditorView`), not a raw JSON editor. `getManifest()` returns `{ settings: SettingDescriptor[] }`; the form's Apply sends a JSON array of changed `{id,value}` to `applyManifest`.
- Zone settings (`clients/zone-settings-meta.ts`): descriptors built by `buildZoneSettingDescriptors` (curated label/control/options map + inference fallback) from `GET /zones/{zoneId}/settings`; `applyManifest` coerces per setting via `coerceZoneSettingValue` and PATCHes each.
- Worker settings (`clients/worker-settings-meta.ts`): `getWorkerManifest` gathers from three endpoints — `scriptAndVersionSettings.get` (rich read: usage model, compatibility date/flags, placement, limits, bindings count, tail consumers — surfaced read-only), `subdomain.get` (workers.dev toggle), `schedules.get` (cron) — and `buildWorkerSettingDescriptors` returns the rows. `applyWorkerManifest` routes changes back: editable script fields (logpush, observability enabled+head_sampling_rate, tags) via `settings.edit`; the workers.dev toggle via `subdomain.create`; cron via `schedules.update`. The deploy-time fields are read-only because the simple settings PATCH can't set them.
- **Settings editor capability (generic):** `settingsEditor?: SettingsEditorCapability` on `DetailViewSchema` renders `SettingsEditorView` (toggles/selects/numbers/text + dirty tracking) backed by the existing `getManifest`/`applyManifest` transport — `getManifest` returns `{settings: SettingDescriptor[]}`, Apply posts changed `[{id,value}]`. Reuses the manifest host wiring (web + desktop, cloud + local); the manifest/settings tab gate now also checks `settingsEditor`.
- **Error formatting:** `clients/shared.ts` exports `formatCloudflareError` (pulls `errors[].message` → e.g. "Zone not entitled to this functionality (code 1034)", parsing both the SDK error object and a JSON body embedded in the message) and `withCloudflareErrors(fn)` which rethrows the clean message (original kept as `cause`). `withAuthErrorHint` reuses it on its non-auth path. `createResource`/`updateResource`/`deleteResource`/`publishMessage` are wrapped so create/edit/delete modals show the readable message instead of a raw `403 {…}` blob; auth (401/403/code 10000/9109) still maps to the friendly scope hint.
- R2 buckets declare `secretExportTemplates` with S3 endpoint + bucket name for K8s secret export
- Tunnels declare `secretExportTemplates` with tunnel token + ID for K8s secret export
- Spectrum Applications show protocol badges and origin connection details
- Logpush Jobs show dataset, destination type (parsed from URL scheme), enable/error status, and last error in mono text

### Azure (`@infrawrench/plugin-azure`)

- Auth: Azure AD service principal client credentials flow (tenant_id + client_id + client_secret)
- Credentials: `tenantId`, `clientId`, `clientSecret` (sensitive), `subscriptionId`
- All API calls go through Azure Resource Manager REST API (`management.azure.com`)
- Resource ID format: `{accountId}:{typeId}:{resourceGroup}/{resourceName}` (or `{rg}/{server}/{db}` for SQL Database)
- 26 resource types: `azure-resource-group`, `azure-vm`, `azure-disk`, `azure-vnet`, `azure-aks-cluster`, `azure-sql-database`, `azure-cosmos-db`, `azure-storage-account`, `azure-function-app`, `azure-app-service`, `azure-container-instance`, `azure-key-vault`, `azure-redis-cache`, `azure-service-bus`, `azure-container-registry`, `azure-load-balancer`, `azure-dns-zone`, `azure-nsg`, `azure-public-ip`, `azure-postgres-flexible`, `azure-mysql-flexible`, `azure-event-hub`, `azure-app-gateway`, `azure-log-analytics`, `azure-managed-identity`, `azure-firewall`
- VM create supports B-series (burstable), D-series (general purpose), E-series (memory optimized), F-series (compute optimized) sizes with image picker (Ubuntu, Debian, RHEL, CentOS, SUSE, Windows Server) and SSH key injection
- AKS clusters declare a Kubernetes peer integration (maps `kubeconfig` output to the Kubernetes plugin)
- AKS kubeconfig resolved via `POST .../listClusterUserCredential` (base64-decoded)
- Storage accounts support the storage browser via Azure Blob Storage REST API (separate storage-scoped token)
- Cosmos DB keys/connection strings resolved via `listKeys`/`listConnectionStrings` ARM APIs
- Redis Cache keys resolved via `listKeys` ARM API; connection string built as `host:6380,password=...,ssl=True`
- Service Bus connection strings resolved via `listKeys` on the `RootManageSharedAccessKey` authorization rule
- Storage Account keys resolved via `listKeys` ARM API
- Event Hub connection strings resolved via `listKeys` on `RootManageSharedAccessKey` authorization rule
- PostgreSQL/MySQL Flexible Server connection strings built from FQDN + admin login
- Log Analytics shared keys resolved via `sharedKeys` ARM API
- Secret export templates on: SQL Database, Cosmos DB, Storage Account, Redis Cache, Service Bus, Event Hub, PostgreSQL Flexible, MySQL Flexible, Log Analytics
- Provisioning state mapping: Succeeded→healthy, Creating/Updating/Upgrading→provisioning, Stopped/Paused/Deallocated→degraded, Failed/Deleting→error
- Delete supported for all 26 resource types via ARM DELETE
- VM create auto-provisions VNet, Subnet, Public IP, NSG (with SSH/RDP rule), and NIC before creating the VM
- VM listing resolves public/private IPs by following NIC → IP Configuration → Public IP references
- Create supported for 22 of 26 types: Resource Groups, VMs, Disks, VNets, AKS Clusters, SQL Databases (with auto SQL Server provisioning), Cosmos DB, Storage Accounts, Function Apps, App Services, Container Instances, Key Vaults, Redis Caches, Service Bus, Container Registries, DNS Zones, NSGs, Public IPs, PostgreSQL Flexible, MySQL Flexible, Event Hub, Log Analytics, Managed Identities
- `getCreateCostEstimate` for VM, AKS, Container Instance, Redis Cache, App Service, Function App, SQL Database, Disk — pulls rates from the public Azure Retail Prices API (`prices.azure.com/api/retail/prices`, no auth). Rates are fetched per region in `src/pricing.ts`, cached 6h in `pricingRateCache` with in-flight dedup, and cover VM hourly, managed-disk $/GB/mo (sampled from representative tiers), Redis per-capacity, App Service + Function App per-SKU, SQL DB per-SKU, and Container Instance per-vCPU-second + per-GB-second rates. `getCreateSizePricing` hydrates VM/AKS/Flexible-DB size pickers asynchronously after region selection.
- `fetchStorageStats` for storage account dashboard cards (iterates containers + blobs)
- `getManifest`/`applyManifest` implemented for all resource types — returns/accepts ARM JSON via GET/PUT
- 34 Azure regions configured for create form region picker

### AWS (`@infrawrench/plugin-aws`)

- Auth: AWS Signature Version 4 (pure Web Crypto, no AWS SDK dependency)
- Credentials: `accessKeyId`, `secretAccessKey` (sensitive), `region`
- API calls use direct AWS REST APIs: EC2 Query API (XML), JSON Amz-Target APIs, REST JSON APIs
- Resource ID format: `{accountId}:{typeId}:{externalId}`
- 51 resource types organized by category:
  - **Compute (8):** `ec2-instance` (SSH, create), `lambda-function`, `ecs-service`, `eks-cluster` (K8s peer integration, create), `apprunner-service`, `auto-scaling-group`, `batch-job-queue`, `sagemaker-endpoint`
  - **Storage (3):** `s3-bucket` (storage browser), `ebs-volume`, `efs-file-system`
  - **Database (8):** `rds-instance`, `rds-cluster` (Aurora), `dynamodb-table`, `elasticache-cluster`, `redshift-cluster`, `opensearch-domain`, `neptune-cluster`, `documentdb-cluster`
  - **Networking (10):** `vpc`, `subnet` (child of VPC), `security-group`, `alb` (ALB/NLB/GLB), `target-group` (child of ALB), `nat-gateway`, `elastic-ip`, `internet-gateway`, `route53-hosted-zone`, `route53-record-set` (child of hosted zone), `cloudfront-distribution`, `api-gateway`
  - **Messaging (6):** `sqs-queue`, `sns-topic`, `eventbridge-rule`, `kinesis-stream`, `msk-cluster`, `mq-broker`
  - **Security (5):** `iam-user`, `iam-role`, `secrets-manager-secret`, `ssm-parameter`, `acm-certificate`, `waf-web-acl`
  - **CI/CD (4):** `step-function`, `codebuild-project`, `codepipeline-pipeline`, `cloudformation-stack`
  - **Monitoring (2):** `cloudwatch-alarm`, `cloudwatch-log-group`
  - **Analytics (1):** `glue-database`
  - **Audit (1):** `cloudtrail-trail`
- EKS clusters declare Kubernetes peer integration (maps `kubeconfig` output to K8s plugin)
- Secret export templates on: RDS Instance, Aurora Cluster, Redshift Cluster, OpenSearch Domain, ElastiCache, S3 Bucket, Lambda, SQS, SNS, DynamoDB
- Global services (CloudFront, IAM, Route 53) use region-less endpoints
- EC2 instances support SSH via `publicIp` output
- S3 buckets: full storage browser (listStorageObjects, uploadStorageObject, makeStorageFolder, deleteStorageObject, fetchStorageStats) via ListObjectsV2 XML API + PUT/DELETE
- RDS Instance + Aurora Cluster: `resourceSqlDriver` with `postgres` driver for per-resource SQL editor
- EKS kubeconfig: generated as YAML with aws eks get-token exec credential, enables K8s peer integration
- Route 53: uses shared dns.ts helpers (renderDnsRecordDetail, renderDnsRecordSidebar, dnsZoneStatus) for DNS record rendering
- Create support for 8 resource types: EC2 Instance (AMI picker, instance type picker, disk slider, SSH key), EKS Cluster (K8s version picker), S3 Bucket, VPC, Security Group, SQS Queue, SNS Topic, DynamoDB Table (partition/sort key, billing mode)
- EC2 AMI resolution: image picker submits a family slug (`al2023`, `amzn2`, `ubuntu-2204`, `ubuntu-2404`, `debian-12`, `rhel-9`, `sles-15`) — `ami-lookup.ts` resolves it at create time to a real region+arch-specific AMI ID. Amazon Linux / Ubuntu / Debian go through SSM Public Parameters (`AmazonSSM.GetParameter`); RHEL / SUSE go through `DescribeImages` with vendor owner IDs (`309956199498`, `013907871322`). Architecture is derived from the instance type — Graviton families ending in `g[a-z]*` and `a1.*` map to `arm64`, everything else to `x86_64`. SSH username comes from a per-family table at create time; the legacy AMI→username map in `ssh-username.ts` remains as a fallback for synced/listed instances.
- `getCreateCostEstimate` handles `ec2-instance` (instance + gp3 root volume), `ebs-volume` (sizeGb × per-volumeType rate for gp3/gp2/io2/st1/sc1/standard), and `rds-instance` (instance class + gp2 allocated storage); pricing is approximated for us-east-1
- 27 AWS regions configured for create form region picker
- EC2 instance types: T3 burstable, M6i general purpose, C6i compute-optimized, R6i memory-optimized
- Delete support for 18 resource types: EC2 Instance, EBS Volume, VPC, Subnet, Security Group, NAT Gateway, Elastic IP, Internet Gateway, S3 Bucket, Lambda Function, SQS Queue, SNS Topic, DynamoDB Table, Secrets Manager Secret, ECR Repository, CloudFormation Stack, SSM Parameter, CloudWatch Alarm, CloudWatch Log Group, CloudTrail Trail, SageMaker Endpoint
- Secret export templates on 17 resource types: RDS Instance, Aurora Cluster, Redshift Cluster, OpenSearch Domain, ElastiCache, S3 Bucket, Lambda, SQS, SNS, DynamoDB, EKS Cluster, ECR Repository, MSK Cluster, Neptune Cluster, DocumentDB Cluster, MQ Broker
- `getManifest` for read-only manifest viewer (all resource types)
- Status mapping: running/active/available/issued/ok → healthy; stopped/paused/disabled → degraded; pending/creating/updating → provisioning; terminated/failed/deleted/alarm → error

### Fly.io (`@infrawrench/plugin-fly`)

- Auth: Bearer token against `https://api.machines.dev` (Fly Machines REST API)
- Credentials: `apiToken` (Fly.io API token, generated via `fly tokens create`), `orgSlug` (organization slug, defaults to `"personal"`)
- Resource types: `app`, `machine` (child of app), `volume` (child of app)
- Apps are the top-level grouping; machines and volumes belong to apps and are fetched per-app
- Resource ID format: `{accountId}:app:{appName}`, `{accountId}:machine:{appName}/{machineId}`, `{accountId}:volume:{appName}/{volumeId}`
- Machine states: created/starting/replacing→provisioning, started→healthy, stopping/suspended→degraded, stopped/destroyed→error
- Volume states: created→healthy, destroyed/restoring→error
- Supports create for apps (name only) and machines (app name, region, Docker image)
- Supports delete for apps, machines, and volumes
- 36 regions available (IATA codes: iad, cdg, nrt, lhr, sin, syd, fra, etc.)
- Machine output: `privateIp` (6PN IPv6 address)
- Listing machines/volumes requires iterating all apps — batched in parallel with error isolation per app

### Netlify (`@infrawrench/plugin-netlify`)

- Auth: Personal Access Token (PAT), passed as `Bearer` token to `https://api.netlify.com/api/v1`
- Credentials: `accessToken` (PAT from app.netlify.com → User Settings → Applications)
- 7 resource types: `netlify-site`, `netlify-deploy` (child of site), `netlify-form` (child of site), `netlify-dns-zone`, `netlify-dns-record` (child of DNS zone), `netlify-build-hook` (child of site), `netlify-env-var` (child of site)
- Resource ID format: `{accountId}:{typeId}:{externalId}` — compound IDs use `{siteId}/{itemId}` for child resources, `{zoneId}/{recordId}` for DNS records
- Paginated fetch uses Netlify's `page` + `per_page` query params (100 per page, up to 10 pages)
- DNS records use shared `@infrawrench/plugin-base` DNS helpers (`renderDnsRecordDetail`, `renderDnsRecordSidebar`)
- Site state mapping: current→healthy, building/enqueued→provisioning, error→error
- Deploy state mapping: ready→healthy, building/enqueued/uploading/uploaded/preparing/prepared/processing→provisioning, error→error, skipped→degraded
- Deploys capped at 5 per site to avoid excessive API calls
- Create supported for: sites, DNS zones, DNS records, build hooks
- Delete supported for all 7 resource types
- Secret export templates on: sites (deploy hook URL), build hooks (hook URL)
- Env vars show deployment contexts (production, deploy-preview, branch-deploy, general) and scopes (builds, functions, runtime, post-processing)
- Rate limits: 500 requests/minute general, 3 deploys/minute

### ClickHouse (`@infrawrench/plugin-clickhouse`)

- Two API surfaces: ClickHouse **Cloud API** (service management) + **HTTP Interface** (SQL queries)
- Cloud API auth: HTTP Basic Auth (`apiKeyId:apiKeySecret`) against `https://api.clickhouse.cloud/v1`
- Credentials: `apiKeyId`, `apiKeySecret` (sensitive), `organizationId`, `chHost` (SQL endpoint), `chUser`, `chPassword` (sensitive)
- Resource types: `ch-service` (Cloud service), `ch-database` (child of service — queried from `system.databases`)
- Cloud API endpoints:
  - `GET /v1/organizations/{orgId}/services` — list services
  - `POST /v1/organizations/{orgId}/services` — create service (name, provider, region, replicas, memory scaling)
  - `DELETE /v1/organizations/{orgId}/services/{serviceId}` — delete service
  - `PATCH /v1/organizations/{orgId}/services/{serviceId}/state` — start/stop service
- Service state mapping: running→healthy, idle→degraded, stopped→error, starting/provisioning→provisioning, stopping→degraded
- SQL queries via ClickHouse HTTP Interface: `POST https://{host}:8443/?default_format=JSON` with `X-ClickHouse-User` / `X-ClickHouse-Key` headers
- `executeQuery()` and `introspectResource()` implemented — REST-based query execution (like Databricks), no native SQL driver needed
- `resourceSqlDriver` declared on `ch-service` with driver `"clickhouse"` and `connectionStringOutputKey: "connectionString"`
- SQL introspection queries `system.columns` for autocomplete metadata
- Create supported for services: name, provider (aws/gcp/azure), region, min/max replica memory (8-356 GB), replicas (1-20), idle scaling
- Delete stops the service first if running/idle (Cloud API requires stopped state), then deletes
- Service endpoints: `https` (port 8443) for HTTP interface, `native`/`nativesecure` (port 9440) for native protocol
- Secret export templates: HTTP Connection URL, Host + Port
- Resource ID format: `{accountId}:ch-service:{serviceId}` or `{accountId}:ch-database:{serviceId}/{dbName}`
- Rate limit: 10 requests per 10 seconds per API key; max 100 API keys per org

---

## Publish capability (cross-plugin)

`@infrawrench/plugin-base` exposes a `publishPanel?: PublishPanelCapability` field on `DetailViewSchema` and a matching `publishMessage?` method on `PluginClient`. Mirrors the chat capability shape, but for one-shot request/response sends rather than streaming.

- The capability declares `tabLabel`, `subtitle`, `bodyFormat: "json" | "text"`, `defaultBody`, `helpText`, `submitLabel`, and an `extraFields: PublishPanelField[]` array. Field kinds are `text` / `number` / `select` / `key-value-list`. The `PublishPanel` React component (`@infrawrench/ui`) renders these above a textarea-based body editor, validates JSON locally when `bodyFormat === "json"`, and surfaces provider errors inline. Successful sends accumulate in a "Recent sends" list under the form (per-session, not persisted).
- `publishMessage(typeId, resourceId, accountId, payload)` returns `Promise<PublishMessageResult>` where `payload.body` is the raw text and `payload.extras` is a `Record<string, string | Record<string, string>>` keyed by field id. Plugins throw on validation/provider errors; the host turns those into a red banner under the form.
- Web host: `POST /api/org/:orgId/resources/publish-message` is a single JSON round-trip (no NDJSON — publish isn't streaming). Server bubbles plugin errors back as a 400 with `{ error }`. Apipost throws on non-2xx so the panel sees them as exceptions.
- Desktop host: forwards directly to the in-process plugin client. Cloud-synced accounts aren't bridged yet — the panel throws "not supported yet" the same way chat does.

### Providers that wire `publishMessage`

- **Cloudflare** `queue` — pushes via `api.cf.queues.messages.push(externalId, …)` with `content_type: "json" | "text"`, optional `delay_seconds`. The queue detail page also gained a **Consumers** custom tab (data piped through `resolvedOutputs.__consumers__` as JSON in `getResource("queue", …)` since `renderDetail` is sync), a **Settings** section surfacing `delivery_delay` / `delivery_paused` / `message_retention_period` from `Queue.settings`, and a paused-state status dot.
- **AWS** `sqs-queue` / `sns-topic` / `kinesis-stream` / `eventbridge-rule` — all in `publish-handlers.ts`. SQS uses `jsonCall(creds, "sqs", "AmazonSQS.SendMessage", …)`. SNS uses `queryPostCall(creds, "sns", "Publish", "2010-03-31", …)` with `MessageAttributes.entry.N.…` form-style flattening. Kinesis uses `jsonCall(…, "Kinesis_20131202.PutRecord", { StreamName, Data: base64, PartitionKey })`. EventBridge uses `jsonCall(…, "AWSEvents.PutEvents", { Entries: [{ Source, DetailType, Detail, EventBusName }] })` and surfaces per-entry `ErrorCode`/`ErrorMessage` from `FailedEntryCount`.
- **GCP** `pubsub-topic` — POSTs `pubsub.googleapis.com/v1/projects/{project}/topics/{name}:publish` with `messages: [{ data: base64, attributes?, orderingKey? }]`. `cloud-tasks-queue` POSTs `cloudtasks.googleapis.com/v2/{queueName}/tasks` with `{ task: { httpRequest: { httpMethod, url, headers?, body? } } }`. Both use the management-API bearer token (`https://www.googleapis.com/auth/cloud-platform` scope).
- **Azure** `azure-service-bus` / `azure-event-hub` — both POST to the namespace's data-plane host derived from `serviceBusEndpoint`. The renderer makes the user type the queue/topic/hub name as an `extraField` (namespaces hold many; we don't pre-list). Auth uses a separate AAD token cache scoped to `https://servicebus.azure.net/.default` (`fetchServiceBusAccessToken` in `auth.ts`, fourth token cache alongside ARM/storage/graph).
- **Kafka** `kafka-topic` — adds a `produce` driver command to `driver.ts` that spins up a one-shot `kafka.producer()` per call (not pooled — produce-from-UI is rare and the connect cost is fine). The client calls `kv.command("produce", topic, body, key, headersJson)` and surfaces `{ partition, offset }` in the result summary.

The desktop → cloud bridge for publish isn't wired yet (no Tauri command). Same constraint as the chat panel; add `cloud_publish_message` when needed.

---

## CORS in Electron

Electron's renderer runs from `file://` (or `http://localhost:5173` in dev). External APIs (GCP, DO) block cross-origin requests.

**Solution:** `session.defaultSession.webRequest.onHeadersReceived` interceptor in `electron/main.ts`:

1. For all responses: if no `Access-Control-Allow-Origin` header exists, inject `*` + methods + headers
2. For OPTIONS preflights specifically: also force `statusLine: "HTTP/1.1 200 OK"` because GCP/DO return 403 to OPTIONS, which the browser rejects regardless of CORS headers

**Critical:** Never add a second `Access-Control-Allow-Origin` — duplicate values cause browser rejection. Always check case-insensitively before injecting.

---

## Create VM form

`getCreateConfig(typeId)` returns `CreateResourceConfig` with live data from the provider API. The host renders it generically in `CreateResourceModal`.

The same generic flow also powers managed Kubernetes cluster creation for providers that implement it (currently DOKS and GKE). For account-level views, the desktop now loads all top-level resource types plus child resource types that set `supportsCreate`, so creatable provider resources can show up even when they are nested under a parent type like DigitalOcean `project`.

Field rendering:

- `region-picker` — searchable by zone ID, human-readable location name, or flag. Shows location as primary label, zone ID as secondary monospaced hint.
- `size-picker` — collapsible categories, CPU/RAM bars per option
- `image-picker` — grouped by OS family, searchable, "owned" badge for account images
- `disk-picker` — searchable by name/zone/type
- `ssh-key-picker` — system keys from `~/.ssh/` (private keys only); on selection, reads `.pub` file to auto-populate SSH username from comment

Pricing UX:

- Header can show an "Estimated cost" badge when the selected `size-picker` option includes `priceMonthly`; host reads generic `SizeOption.priceMonthly` metadata and does not hard-code provider pricing logic.
- Host can call optional `getCreateSizePricing()` after initial form load to progressively fill `priceMonthly` for `size-picker` options (used for slow pricing APIs).
- Host can call optional `getCreateCostEstimate()` for full monthly totals from provider logic (e.g. VM + boot disk) so storage is included in the estimate badge.

On success: dispatches `iw:resources-changed`, navigates directly to the new resource's detail view.

### Extra / add-on disks

VM create forms expose an optional "Extra … Disk/Volume" section (a `select` toggle that reveals a disk-slider + disk-type select via `showWhen`). Wiring per provider:

- **GCP** `gce-instance` — extra disk goes into `disks[]` in the instance POST with `boot: false, autoDelete: false` (native inline).
- **AWS** `ec2-instance` — extra EBS goes into `BlockDeviceMapping.2.*` in `RunInstances` with `DeleteOnTermination=false` (native inline).
- **Azure** `azure-vm` — extra disk goes into `storageProfile.dataDisks` as an `Empty` managed disk at LUN 0 in the VM PUT (native inline).
- **Hetzner** `server` — 2-step: create the server, then POST `/volumes` with `server: {id}, automount: true` so the API handles attach.
- **DigitalOcean** `droplet` — 2-step: create the droplet, then POST `/volumes` with `droplet_ids: [id]` (attach happens at volume-create time).

---

## Drag-to-attach (disk → VM)

Resource types can declare `attachTargets` on their `ResourceTypeDefinition`. When the user drags a source pill whose type has `attachTargets` matching a target pill's `{pluginId, resourceTypeId}` **within the same account** (plus optional `matchField` equality, e.g. matching `zone`), the pill becomes a drop target with an "Attach" label. On drop, the host calls `PluginClient.attachResource(sourceTypeId, sourceResourceId, targetTypeId, targetResourceId, accountId)`.

Plumbing:

- `DndShell` exposes `onResourceAttach(source, target)`; target's `DraggableResource` is passed via the droppable's `data.target` so the root handler has both resources without re-fetching.
- Desktop: `__root.tsx` dispatches a `iw:resource-attach` window event; `accounts.$accountId.tsx` listens, builds a `PluginClient` via `createPluginClient(accountId, pluginId)`, calls `attachResource`, then dispatches `iw:resources-changed`.
- Web: `__root.tsx` POSTs to `/api/org/:orgId/resources/attach` (in `resource-detail.ts`), which dispatches to `ctx.client.attachResource`. The account metadata route now exposes `attachTargets` on `ResourceTypeInfo` so the pill can include it in its draggable data.

Currently wired (all validate the declared `matchField` before calling the provider API):

- **GCP** `gce-disk` → `gce-instance` — POST `.../instances/{instance}/attachDisk` with the disk `selfLink` (zone-matched).
- **AWS** `ebs-volume` → `ec2-instance` — `ec2:AttachVolume` on `/dev/sdf` (availabilityZone-matched). Also `elastic-ip` → `ec2-instance` uses the same primitive for IP association.
- **Hetzner** `volume` → `server` — POST `/volumes/{id}/actions/attach` with `{ server, automount: true }` (location-matched).
- **DigitalOcean** `volume` → `droplet` — POST `/volumes/{id}/actions` with `{ type: "attach", droplet_id, region }` (region-matched).
- **OVH** `volume` → `instance` — POST `/cloud/project/{p}/volume/{id}/attach` with `{ instanceId }` (region-matched).
- **Scaleway** `block-volume` → `instance` — PATCH `/instance/v1/zones/{zone}/servers/{id}` with a full `volumes` map (reads the server's existing volumes, appends the new entry at the next free integer-string key, writes back; zone-matched). Volumes are created via `POST /block/v1/zones/{zone}/volumes` and attached via the Instance API — Scaleway deprecated the Instances API for Block Storage management.
- **Fly** `volume` → `machine` — POST `/v1/apps/{app}/machines/{id}` with the existing machine config + a new entry appended to `config.mounts` (region-matched + same-app required); labelled "Mount" since Fly mounts are restart-scoped.
- **Azure** `azure-disk` → `azure-vm` — ARM PATCH on the VM with `storageProfile.dataDisks` appended, picking the next free LUN (location-matched).

---

## Delete resource flow

1. `client.deleteResource(typeId, resourceId, accountId)` — plugin API call
2. `DELETE FROM dashboard_pins WHERE resource_id = ?`
3. `DELETE FROM resources WHERE id = ?`
4. `window.dispatchEvent(new CustomEvent("iw:resources-changed", { detail: { accountId } }))`
5. Navigate to `/accounts/$accountId`

The sidebar and account page both listen for `iw:resources-changed` and re-fetch.

---

## SSH terminal flow

1. User selects key in `SshQuickConnectPanel` → reads private key from `~/.ssh/` or decrypts saved key
2. Username auto-populated from `.pub` file comment (`user@host` → `user`)
3. `connect()` → `setResolvedKey(key)` → renders `SshTerminal`
4. `SshTerminal` defers `fitAddon.fit()` to `requestAnimationFrame` (avoids xterm "dimensions undefined" error). It also calls `attachTerminalClipboard(term)` from `@infrawrench/ui` — same helper is used by every other xterm.js terminal (desktop SSH/k9s/k8s-exec, web equivalents) for copy-on-selection + Cmd/Ctrl+Shift+V paste. The helper is duck-typed against the xterm `Terminal` shape so the `ui` package stays xterm-free.
5. `ssh_shell_spawn` IPC → ssh2 in Electron main → resolves to `shellId`
6. Data events: `ssh_shell_data_{shellId}` → `term.write()`
7. Cleanup: `ro.disconnect()`, kill shell, `term.dispose()`

Resource detail pages now expose SSH as a route-local tab. The bottom-docked SSH panel was replaced with an `Open SSH tab` action that promotes the terminal or quick-connect panel into the main content area.

### External SSH agent support (Pageant, 1Password)

SSH key pickers (`SshKeyPicker.tsx`, `SshQuickConnectPanel.tsx`) surface external SSH agents as additional `KeySource` variants alongside system (`~/.ssh/`) and saved/app keys.

- **Pageant** — Windows-only. Detected by `ssh_check_pageant` IPC → `electron/pageant.ts`, which shells out to `tasklist` with a 5-second cache.
- **1Password** — any platform. Detected by `ssh_check_1password` IPC → `electron/onepassword-agent.ts`, which checks for the agent socket (macOS: `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`; Linux: `~/.1password/agent.sock` or the snap path; Windows: `$SSH_AUTH_SOCK` if set, else `\\.\pipe\openssh-ssh-agent`) with a 5-second cache.

Each external agent has a sentinel "private key" string the renderer emits when its row is selected — `PAGEANT_SENTINEL` (`__pageant__`) and `ONEPASSWORD_SENTINEL` (`__1password__`). Main-process SSH call sites branch on these sentinels:

- `ssh-tunnel.ts` (`openTunnel`, `sshExecCommand`) — `withAgentOverride` strips `privateKey` and sets `agent: "pageant"` for Pageant or `agent: <socket path>` for 1Password before handing to `ssh2.Client.connect()`.
- `ssh-shell.ts` — sets the `connectAgent` for both auth and (optionally) forwarding. When the user enables agent forwarding alongside an external agent, ssh2 routes the forwarded sign-requests through the same agent — so e.g. `git clone git@github.com:…` on the remote authenticates against 1Password and surfaces a biometric prompt on the user's machine. PEM-key auth still uses the in-process `buildInProcessAgent` for forwarding.

The sentinel constants live in `electron/ssh-agent.ts` (main) and `src/lib/ssh-agent.ts` (renderer) — keep them in sync.

Desktop-only feature: the web app's server-side ssh2 has no path to reach a user's local agent.

---

## Common pitfalls

| Symptom                                        | Cause                                                                         | Fix                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Cannot read 'dimensions'` in xterm            | `fitAddon.fit()` called before DOM layout                                     | Defer to `requestAnimationFrame`                                                      |
| Duplicate `Access-Control-Allow-Origin` header | CORS interceptor adding `*` when server already sent its own                  | Check `hasACAO` case-insensitively before injecting                                   |
| OPTIONS preflight blocked with 403             | Server rejects preflight; headers were added to 403 but browser still rejects | Force `statusLine: "HTTP/1.1 200 OK"` on OPTIONS when injecting                       |
| GCP delete 404 with full resource ID in URL    | `externalId` is `project/zone/name`; using it directly as instance name       | Use `resource.fields["name"]` or `.split("/").pop()`                                  |
| `exactOptionalPropertyTypes` TS error          | `field.defaultValue = x                                                       | undefined` not assignable                                                             | Use `...(x ? { defaultValue: x } : {})` spread pattern |
| Plugin-base types missing after change         | Dependent package built before plugin-base                                    | Run `pnpm --filter @infrawrench/plugin-base build` first                              |
| SSH auth fails despite correct key             | Username defaults to `root`; GCP/DO use key comment as username               | Read `.pub` file comment, use `comment.split("@")[0]` as username                     |
| Sidebar shows deleted resource                 | Sidebar caches resource lists; `iw:resources-changed` event not fired         | Dispatch event after delete; sidebar listener calls `loadAccountResources(..., true)` |

---

## Web app architecture

### Auth

WorkOS AuthKit — middleware-enforced on all `(app)/*` routes. Auto-provisions user/org on first login. `requireAuth()` returns `{ userId, organizationId, email }`.

### Database

Drizzle ORM + Neon PostgreSQL. Schema at `web/src/db/schema.ts`. 13 tables total:

- Core: organizations, users, plugin_installations, accounts, resources, secret_field_states, associations, dashboards, dashboard_pins
- SaaS: audit_logs, api_keys, subscriptions, invitations

Sync columns on accounts/resources/dashboards/dashboard_pins/associations: `syncVersion` (monotonic counter), `deletedAt` (soft delete).

Migrations generated via `drizzle-kit generate` — never write SQL directly.

### Server Actions

All mutations in `web/src/actions/`: accounts, resources, dashboard, associations, api-keys, billing, team, audit. Each calls `logAudit()` for the audit trail.

### Server build

`pnpm --filter @infrawrench/web build` produces:

- `dist/client/**` — Vite client bundle (static assets served by Hono in prod)
- `dist/server.mjs` — esbuild-bundled Hono server (ESM, single file, all `node_modules` left external via `--packages=external`)

`pnpm --filter @infrawrench/web start` runs `node dist/server.mjs` with `NODE_ENV=production` + env vars supplied by the caller (dev loads `.env` via `env-loader.mjs`; prod relies on the process environment). The bundler is used instead of a plain `tsc/tsgo` emit because the source imports are extensionless (`moduleResolution: "Bundler"`), which Node's ESM loader rejects.

### WebSocket proxy

`web/server.ts` (Hono + `@hono/node-server` + `ws`) handles WS upgrades at `/api/ws`. Auth via `?token=` query param (API key or OAuth token). Channels:

- `ssh:open` → SSH terminal session via ssh2
- `sql:query` → SQL execution via plugin drivers
- `ssh:data` / `ssh:resize` → bidirectional terminal I/O

### Resource poller (`@infrawrench/poller`)

A standalone Node microservice at `app/packages/poller/` that keeps `resources` rows fresh so the web UI never has to call provider APIs on page load. It imports shared sync logic from `@infrawrench/server-core` (db client/schema, plugin loader, sync-resources, host services, encryption, tunnel resolver) — see "Server-core package" below.

- Tick every 15s (`src/loop.ts`). Selects `accounts WHERE deletedAt IS NULL AND (nextPollAt IS NULL OR nextPollAt <= now())` ordered by `lastPolledAt NULLS FIRST`, limit = concurrency (default 8).
- Per-account work (`src/poll-account.ts`) wraps `syncAccountResources()` from `web/src/services/sync-resources.ts`. Gates each `client.listResources(typeId)` call through an in-memory token bucket keyed by `(pluginId, accountId)`. A type whose bucket is empty that tick is skipped — its existing rows stay put.
- Token bucket config comes from `PluginManifest.rateLimit` (`capacity` / `refillPerSecond`). Default 60/1. Rate-limit errors halve bucket capacity for 5 min.
- On hard failure (429/5xx/timeout): `pollFailureCount++`, `nextPollAt = now() + min(15s * 2^failures, 10min)`. Successful tick resets failure count and schedules `now() + 15s`.
- `upsertResource()` bumps `resources.syncVersion = MAX(sync_version) + 1` on every write, so desktop cloud-sync pull (`cloud-sync.ts`, 60s interval) picks up fresh data without the desktop itself calling provider APIs.
- Manual per-resource refresh: `POST /api/org/:orgId/resources/refresh` (body `{ resourceId, accountId, typeId }`) calls `client.getResource()` for that one row. The web detail page's refresh button (`REFRESH_RESOURCE_EVENT`) hits this endpoint. Account creation still calls `syncAccountResources()` inline so the user sees resources immediately; poller takes over afterwards.
- UI reads `GET /api/org/:orgId/accounts/:id/resources` on mount (no sync fan-out). The 30s client-side interval re-reads the DB.
- `iw:resources-changed` (see `ui/src/utils.ts`) carries `{ accountId?, resourceTypeId? }`. When `resourceTypeId` is set, listeners re-sync just that one type via `POST /sync-type/:typeId` for immediate feedback after create/delete.

### Sync protocol

- `POST /api/v1/sync/pull` — returns entities with `syncVersion > lastSyncVersion`
- `POST /api/v1/sync/push` — upserts entities with last-write-wins by `updatedAt`
- `GET /api/v1/sync/status` — returns max syncVersion

Auth via `Authorization: Bearer <api_key_or_oauth_token>`. Scopes: `sync:read`, `sync:write`, `resources:read/write`, `dashboards:read/write`.

### Server-core package (`@infrawrench/server-core`)

Shared backend code consumed by `@infrawrench/web` and `@infrawrench/poller`. Lives at `app/packages/server-core/` with subpath exports:

- `@infrawrench/server-core/db/client` — Drizzle/postgres client (reads `DATABASE_URL`)
- `@infrawrench/server-core/db/schema` — table definitions
- `@infrawrench/server-core/encryption` — AES-256-GCM helpers
- `@infrawrench/server-core/drivers` — sql/kv/docker/storage driver registries
- `@infrawrench/server-core/host-services` — `HostServices` builders for plugin clients
- `@infrawrench/server-core/tunnel-resolver` — credential rewriting through SSH tunnels
- `@infrawrench/server-core/sync-resources` — `syncAccountResources` + `syncAccountResourceType`
- `@infrawrench/server-core/plugin-loader` — `loadPlugins` / `getPlugin` (blessed-plugins.json registry)

Web's `web/src/db/client.ts`, `web/src/db/schema.ts`, `web/src/services/{encryption,drivers,host-services,tunnel-resolver,sync-resources}.ts`, and `web/src/plugins/loader.ts` are now thin re-exports — no consumer-side import paths changed.

### Plugin response shape: `{ resource, warnings }`

`PluginClient.createResource` may return either a bare `ResourceInstance` (legacy) or a `ResourceCreateResult = { resource, warnings: ResourceWarning[] }` envelope (new). Use `normalizeResourceCreateResult(result)` from `@infrawrench/plugin-base` to flatten before consuming. The host surfaces `warnings` as `toast.warning(...)` via the new shared toast feature in `@infrawrench/ui`. Currently emitted by the DigitalOcean plugin when `assignToProjectIfNeeded` fails (resource created, project assignment lost).

### Stripe billing

$20/month per seat. Free tier: 1 user, 3 accounts, no audit/API keys/team.

- `POST /api/v1/webhooks/stripe` — handles checkout.session.completed, invoice.paid/failed, subscription.updated/deleted
- Server Actions: createCheckoutSession, createBillingPortalSession, getSubscriptionStatus

---

## Desktop cloud sync

### OAuth PKCE

`desktop/electron/cloud-auth.ts` — WorkOS OAuth2 PKCE flow. Custom protocol `infrawrench://callback`. Tokens encrypted in `cloud_sync_state` SQLite table.

### Sync engine

`desktop/electron/cloud-sync.ts` — 60-second interval. Push: modified rows since `lastPushAt`. Pull: entities with `syncVersion > lastSyncVersion`. Credentials decrypted locally, sent plaintext over TLS, re-encrypted on server.

### Desktop SQLite v3 migration

Added `cloud_sync_state` table + `cloud_id`, `sync_version`, `deleted_at` columns to synced tables.

---

## API key system

Format: `iwk_` + 32 random bytes (base64url). Stored as SHA-256 hash. Prefix (first 12 chars) shown for identification. Scopes control access. Revokable, rotatable.

---

## OpenAPI spec

`app/packages/web/src/api/openapi/` builds an OpenAPI 3.1 document from hand-written Zod schemas plus enums sourced live from `loadPlugins()`. So `pluginId` and `typeId` path params are typed as enums of the actually-installed plugin / resource-type IDs — adding a plugin extends the spec automatically.

- `index.ts` — `buildOpenApiDocument()` orchestrates registration; `getOpenApiDocument()` caches the result for runtime serving. Auto-injects `operationId` for every op (method + path → camelCase) so generated SDKs have stable function names.
- `dynamic.ts` — calls `loadPlugins()` and emits `PluginId` / `ResourceTypeId` / `CredentialFormatId` Zod enums.
- `common.ts` — shared schemas (`Uuid`, `Email`, `IsoDateTime`, `Ok`, `ErrorResponse`, `ResourceId`, `JsonObject`). `strict()` helper wraps `z.object().strict()` so `additionalProperties: false` is the default.
- `paths/*.ts` — one file per route module (`auth.ts`, `accounts.ts`, `resources.ts`, `connection-features.ts`, etc.). Each exports a `register*Paths(ctx)` function that registers operations against `ctx.registry`.

Runtime serving: `GET /openapi.json` returns the cached document, `GET /docs` renders the Scalar reference UI. Both are public.

Build artifact: `pnpm --filter @infrawrench/web generate:openapi` writes `app/packages/web/openapi.json`. Commit it so PR diffs show API surface changes.

When you add a new HTTP route, also register it under `paths/`. The spec validates with Redocly (`npx @redocly/cli lint openapi.json`); CI doesn't run this yet but it's a useful local sanity check.

---

## BigQuery plugin

BigQuery has two-level hierarchy exposed as parent/child resources:

- `bigquery-dataset` (parent) — created via POST `/bigquery/v2/projects/{p}/datasets`
- `bigquery-table` (child, `parentTypeId: "bigquery-dataset"`) — created via POST `/datasets/{id}/tables` with optional `schema.fields` JSON

Listing hydrates each dataset/table with its full metadata (the BigQuery list API only returns references) — `listBigQueryDatasets` and `listBigQueryTables` in `resource-listers.ts` do a GET per item to pull `numRows`, `numBytes`, partitioning, clustering, primary keys, etc.

### SQL editor query cost estimation

The SQL editor capability (`SqlEditorCapability` on `DetailViewSchema`) has an optional `supportsQueryCost: boolean`. When true, the host renders an "Estimate" button next to "Run" that calls `PluginClient.estimateQueryCost(resourceId, accountId, sql)`.

For BigQuery this issues a `jobs.insert` with `dryRun: true` and reads `statistics.query.totalBytesProcessed`, returning `QueryCostEstimate { bytesProcessed, estimatedCostUsd, cacheHit, pricingNote }`. Pricing: $6.25/TiB scanned (on-demand). Dry-run requests do not count against BigQuery quotas.

Host plumbing:

- Web: `POST /api/org/:orgId/sql/estimate` in `connection-features.ts`, consumed by `ResourceDetailClient.handleEstimateQueryCost`
- Desktop: `cloud_sql_estimate` IPC → `cloudFetch(/sql/estimate)`, plus direct `client.estimateQueryCost` for local accounts

### Create-form multiline text fields

`CreateFieldConfig` with `kind: "text"` now supports `multiline: true` + `placeholder` — `FieldRenderer` renders a `<textarea rows={8}>` instead of a single-line input. Used by BigQuery table creation for pasting schema JSON, and by Spanner database creation for pasting DDL statements.

## Spanner plugin

Spanner follows the same parent/child pattern as BigQuery:

- `spanner-instance` (parent) — created via POST `/v1/projects/{p}/instances`
- `spanner-database` (child, `parentTypeId: "spanner-instance"`) — created via POST `/v1/projects/{p}/instances/{instance}/databases`
- `spanner-backup` (child, `parentTypeId: "spanner-instance"`) — created via POST `/v1/projects/{p}/instances/{instance}/backups?backupId={name}`

Database creation accepts `dialect` (`GOOGLE_STANDARD_SQL` or `POSTGRESQL`) and an optional multiline DDL field. DDL is split on `;`, trimmed, and sent as the `extraStatements` array; the `createStatement` is auto-generated in the correct quoting style for the chosen dialect. Backup creation takes a source database ID and a required `expireTime` (RFC3339). Resource IDs: `{accountId}:spanner-database:{instance}/{name}`, `{accountId}:spanner-backup:{instance}/{name}`. Both child listers iterate instances in the project and aggregate results with per-instance error isolation.

**Spanner Studio** — `spanner-database` resources expose a SQL editor via `client.executeQuery` and `client.introspectResource` (REST-based, no native SQL driver). Execution goes through the Sessions API: `POST /v1/{dbPath}/sessions` → `POST {sessionName}:executeSql` → `DELETE {sessionName}` (fire-and-forget cleanup). `executeQuery` and `introspectResource` dispatch by typeId extracted from `resourceId.split(":")[1]`, routing between BigQuery and Spanner. Introspection queries `INFORMATION_SCHEMA.TABLES`/`COLUMNS`/`KEY_COLUMN_USAGE` with case-sensitive column names: `TABLE_NAME`/`SPANNER_TYPE` (GoogleSQL, schema `''`) vs. `table_name`/`spanner_type` (PostgreSQL, schema `'public'`). Dialect is detected per-call via GET on the database resource. `renderDetail` injects `base.sqlEditor = { connectionStringOutputKey: "__spanner__", defaultQuery, tables }` — the connection-string-output-key is a placeholder; host-side SQL routing picks up `client.executeQuery` before touching any driver (see `connection-features.ts` POST `/sql/query`).

---

## website package — Astro on Cloudflare Workers

Public landing site + releases proxy for the desktop app. The GH repo `Infrawrench/Infrawrench` is private, but releases need to be downloadable; the worker proxies them with a server-side fine-grained PAT and caches at the edge.

- Adapter: `@astrojs/cloudflare` (Astro v6). Env is read via `import { env } from "cloudflare:workers"` — `Astro.locals.runtime.env` was removed in Astro v6. ExecutionContext is on `Astro.locals.cfContext`.
- `wrangler.jsonc` keeps it minimal — name + compat date + `nodejs_compat` + `vars` (`GITHUB_OWNER`, `GITHUB_REPO`). The adapter's vite plugin generates `main`/`assets` automatically.
- Secret `GITHUB_TOKEN` (fine-grained PAT, Contents: Read) — set with `wrangler secret put`; for local dev use `.dev.vars`.

Endpoints:

- `GET /api/latest` — fetches `releases/latest`, classifies asset filenames (`classifyAsset` in `src/lib/github.ts`) into per-platform keys (`macos-arm64`, `windows-x64`, `linux-x64-appimage`, etc.), returns `{ version, publishedAt, notes, downloads, assets }`. Cached 5 min via Cache API.
- `GET /api/download/:version/:filename` — looks up the asset id via `releases/tags/{tag}`, fetches `releases/assets/{id}` with `Accept: application/octet-stream` (GH 302's to a presigned S3 URL — auth header is dropped on cross-origin redirect by design), streams the body back with `Cache-Control: public, max-age=31536000, immutable` and caches in `caches.default`. Versioned path → safe to cache forever; old URLs keep working after a release flip.

Both endpoints use `withEdgeCache(request, ctx, build)` from `src/lib/cache.ts` — only puts the response in cache if it's `ok` AND has a `Cache-Control` header (so 4xx/5xx aren't cached).

Asset classification matches the rename rules in `.github/workflows/desktop-build.yml` — DMG arch from `arm64`/`x64` substring, `.exe` for Windows (split by arch), AppImage/deb default to x64 unless `arm64`/`aarch64` in name, snap is x64-only.

### Auto-update flow

The packaged desktop app (`startAutoUpdater` in `electron/main.ts`) uses `electron-updater` with a generic feed at `https://infrawrench.com/api/updates`. electron-builder bakes this into `app-update.yml` from the `publish` block in `app/packages/desktop/package.json`, so no `setFeedURL` is needed at runtime.

- `GET /api/updates/:file` (allowed: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`) — fetches the matching asset from the latest GH release, then rewrites every `url:` / `path:` line so the value becomes `../download/{tag}/{filename}`. That relative URL resolves on the same origin to the existing versioned download endpoint, so all binaries served via auto-update get the same long-cache treatment as direct user downloads.
- The CI workflow (`desktop-build.yml`) merges per-arch `latest-mac.yml` / `latest.yml` from the separate runners into single consolidated YMLs via `app/packages/desktop/scripts/merge-update-yml.mjs` (a dependency-free node script that unions the `files:` arrays). This avoids the well-known "last runner overwrites" issue where mac/win arm64 + x64 jobs each upload their own `latest-*.yml`.
- `app/packages/desktop/package.json` overrides `mac.artifactName` / `win.artifactName` / `appImage.artifactName` so electron-builder writes the final filenames natively. The workflow no longer renames after build — the YMLs and the actual artifact filenames stay in sync.

---

## MCP server (`/api/mcp`)

Hosted Model Context Protocol endpoint inside the web app — lets external AI clients (Claude Desktop, Cursor, etc.) drive an Infrawrench organisation: search/list/get resources, fetch metrics + dashboard stats, resolve outputs, and create/edit/delete via plugin clients.

- **Code:** `app/packages/web/src/mcp/` (server, auth, well-known, tools); HTTP entry `app/packages/web/src/mcp/http-handler.ts`; routed in `server.ts` ahead of Hono because the MCP SDK transport speaks raw Node `IncomingMessage`/`ServerResponse`, not Fetch.
- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`). Stateless — fresh `McpServer` and `StreamableHTTPServerTransport` per request, with `enableJsonResponse: true`.
- **Auth:** WorkOS OAuth (AuthKit MCP). Client hits `/api/mcp` with no token → 401 + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`. Metadata points at `WORKOS_AUTHKIT_DOMAIN` (or `WORKOS_ISSUER`); client runs Dynamic Client Registration there, retries with a Bearer JWT. We verify via existing `verifyWorkosAccessToken` (JWKS) and resolve user/org with `ensureUserFromClaims` + `ensureMembership` (now exported from `auth-middleware.ts`).
- **Discovery:** `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (302 to the upstream WorkOS doc). Mounted on the Hono app and reachable at the public origin (`PUBLIC_BASE_URL` env override for prod).
- **Tools (always registered):** `list_plugins`, `list_resource_types`, `list_accounts`, `search_resources`, `list_resources`, `get_resource`, `get_resource_inputs`, `get_resource_outputs`, `get_resource_stats`, `get_resource_metrics`, `describe_resource`, `create_resource`, `delete_resource`, `invoke_action`, `get_manifest`, `apply_manifest`. Mutating tools call `logAudit` with `source: "mcp"`.
- **Per-plugin create tools:** at server build time we walk `loadPlugins()` and register one `<pluginId>_create_<resourceTypeId>` tool per `supportsCreate: true` type, with a Zod schema generated from `FieldDefinition[]`. Same write path as the generic `create_resource` (incl. DB upsert + plaintext-secret encryption) — there to give clients typed, discoverable creates without round-tripping `list_resource_types` first.
- **Auth context per request:** the McpServer is built inside the request handler with `auth: { userId, organizationId, email? }`. Tool handlers close over `auth`, so each connection only sees its own org — no URL-supplied `:orgId`.
- **Shared tool registry:** tool implementations now live in `app/packages/web/src/tools/` (not under `mcp/`). The MCP server adapts them via `buildMcpServer`, and the in-app chat agent (`app/packages/web/src/chat/agent.ts`) consumes the same registry. Tool definitions carry a `risk: "read" | "write" | "destructive"` tag that the chat surface uses to gate destructive calls behind UI approval — MCP exposes everything regardless.

---

## AI chat agent (`/api/org/:orgId/chat`)

Hosted Claude-powered chat with full UI parity — same tool registry as MCP plus connection-layer tools (SQL exec, KV/Docker commands, SSH exec, storage, secret versions, credential export). The agent loop lives entirely server-side; web + desktop both render the same React route.

- **Code:** `app/packages/web/src/chat/agent.ts` (agent loop + suspend/resume), `chat/auth.ts` (session cookie OR WorkOS Bearer OR `iwk_` API key with `chat:write`), `chat/billing.ts` (per-turn `chat_usage` rows + Stripe metered usage), `chat/pricing.ts` (per-Mtok rates × markup, env-overridable). Routes: `api/routes/chat.ts`. UI: `routes/org.$orgId.chat.tsx` + `routes/org.$orgId.chat.$conversationId.tsx`, components in `components/chat/`.
- **Tool registry:** `src/tools/registry.ts` returns plain `ToolDefinition[]` (generic + connections + per-plugin-create). Each handler accepts a `ToolAuthContext` with `source: "mcp" | "chat" | "api"` so audit rows distinguish caller.
- **Destructive-action flow:** when the model emits a `tool_use` for a `risk: "destructive"` tool, the loop inserts a `chat_pending_actions` row (status `pending`), emits an SSE `pending_action` event, and ends the turn. The UI shows Approve/Reject; approve transitions to `approved` and synchronously runs the handler, writing `executed`/`errored` + result. Once every pending action for the latest assistant message is resolved, the UI hits `POST /messages {resume: true}` and the loop continues with `tool_result` blocks.
- **Pricing:** defaults to Sonnet 4.6 rates (input $3 / output $15 / cache-read $0.30 / cache-write $3.75 per Mtok) × 1.5 markup. Override via `INFRAWRENCH_CHAT_PRICE_*_PER_MTOK` and `INFRAWRENCH_CHAT_MARKUP`. Each turn's tokens are persisted as `chat_usage(cost_micros)`; if `INFRAWRENCH_STRIPE_CHAT_METER_EVENT` is set we also push a Stripe meter event keyed by customer.
- **Monthly cap:** `organizations.chat_monthly_cap_micros`. Checked at the start of each turn; cap reached → `spend_blocked` SSE event, user message persisted but no model call.
- **DB tables:** `chat_conversations`, `chat_messages` (content jsonb in Anthropic content-block shape + per-turn token counts), `chat_pending_actions`, `chat_usage`. Migration `0015_chat_tables.sql`.
- **Auth:** sync-style — `authenticateChat(c, orgId, scope)` accepts the session cookie, a WorkOS Bearer access token, or an `iwk_*` API key with `chat:read`/`chat:write`. The scope catalogue in `server-core/permissions/catalog.ts` gained `chat:read` + `chat:write`.

---

## Bastion agents (web app)

Users can register a bastion in **Settings → Bastions** and run a tiny Docker container (`@infrawrench/bastion-agent`) on their own infrastructure. When an account is bound to a bastion, that account's cloud control-plane HTTPS calls (AWS, GCP, Azure, DO, Hetzner, Fly, Vercel, Netlify, PlanetScale, Databricks, Cloudinary…) exit through the user's IP instead of the Infrawrench backend's. Useful for cloud accounts with source-IP allowlists.

### Wire shape

```
Backend (Hono)  ←—— WSS multiplex ——  bastion-agent (docker)  ——→ AWS/GCP/…
```

The agent **dials outbound** to `/api/bastions/agent` with `Authorization: Bearer <token>`. End-to-end TLS terminates between the backend (TLS client) and the cloud API (TLS server) — the agent only forwards opaque bytes.

### Code paths

- **Protocol & registry** — `app/packages/server-core/src/bastion/`
  - `protocol.ts` — JSON envelope (`open` / `data` / `end` / `close` / `opened` / `open-failed` / `ping` / `pong` / `hello` / `agent-info`). Subprotocol `infrawrench-bastion-v1`.
  - `dispatcher.ts` — `BastionAgentConnection` exposes an `undici.Agent` whose `connect()` returns a `Duplex` backed by the WS multiplex (`allowHalfOpen: true`, credit-based backpressure when `ws.bufferedAmount > 1 MiB`). HTTP/1.1 only — undici opens one stream per cloud-API call.
  - `registry.ts` — in-memory `Map<bastionId, AgentConnection>`. `getDispatcherFor(id)` returns the dispatcher or `null`. `allowlistForPlugins(...)` derives the per-plugin destination allowlist (e.g. `*.amazonaws.com`, `*.googleapis.com`, `api.digitalocean.com`).
  - `errors.ts` — `BastionDisconnectedError` / `BastionStreamOpenError`.
- **Host-side HTTP routing** — `app/packages/server-core/src/host-services.ts`. `buildPluginHostServices(manifest, credentials, { accountId, bastionId })` is now **async** — it looks up the account's `bastionId` (if not supplied) and constructs an `HttpHostServices.request` that goes through `undici.fetch(url, { dispatcher })` when the account has a bastion. Bound-but-offline ⇒ `BastionDisconnectedError`, never silent fallback.
- **WS endpoint** — `app/packages/web/src/services/bastion-ws.ts` and the upgrade hook in `app/packages/web/server.ts`. Bearer-token auth via `keyedHash(token, "bastion-agent")`. On connect: register, send `hello` with allowlist + `heartbeatMs`, start app-level pings every 25s.
- **REST + UI** — `app/packages/web/src/api/routes/bastions.ts` (list/create/revoke), `org.$orgId.settings.bastions.tsx`, account add/edit modal "Egress via" dropdown (`AddAccountModal` shared component, new `bastions` prop + `bastionId` argument on `saveAccount`).
- **AWS plugin** — `signed-request.ts:fetchSigned` reads `AwsCredentials.http` (populated by `AWSClient` from `services.http`) and routes through it when set. All previous direct-`fetch` sites in `delete-handlers.ts`, `create-handlers/*.ts`, and `s3-storage.ts` now call `fetchSigned`, so create/delete/storage paths also flow through the bastion.
- **Other plugins on `services.http`** — `jsonRestFetch` in `plugin-base/src/http.ts` now **always** prefers the host's HTTP service when present (previously only when a `caCert` was supplied). DO/Hetzner/Fly/Vercel/Netlify/PlanetScale/Databricks/Cloudinary/Kubernetes get bastion routing for free.

### Schema

`bastion_vms` table: `id, organization_id, created_by_user_id, name, hashed_token (sha256 keyed-hash, unique), token_prefix, agent_version, last_seen_at, status (pending|active|revoked), revoked_at, created_at, updated_at`. `accounts.bastion_id` is a nullable FK with `ON DELETE SET NULL` — revoking a bastion silently reverts its accounts to direct egress rather than breaking them. Permissions: `bastions:read` (default for members) and `bastions:write` (admin/owner).

### Limitations (v1)

- **Single-process backend.** The dispatcher registry lives in `web`'s process memory. The poller is a separate process and does **not** currently route its background syncs through bastions — bound accounts only get bastion routing on user-triggered actions in `web`. Multi-instance via Postgres `LISTEN/NOTIFY` peer discovery is a follow-up.
- **HTTP/1.1 only**, no h2 to cloud APIs.
- **Buffered response bodies** in `HttpHostServices.request` (`{status, headers, body: string}`). Streaming variant is a follow-up; bounded control-plane responses are fine.
- **Plugins that still use raw `fetch`** (GCP / Azure / Mongo / SQL / Redis / etc.) ignore the bastion. They keep working; we surface no UI difference for now. Migration is mechanical: thread the plugin client's `services.http` through its outbound HTTP layer.
- **Token rotation:** revoke + recreate. No in-place rotation in v1.

---

## Resource type "sidecars" (cross-plugin convention)

Each `ResourceTypeDefinition` can declare optional capabilities the host UI surfaces as tabs, secret-export menus, or metrics panels. Loosely "sidecars":

- **`peerIntegrations`** — instantiate another plugin from this resource's outputs and render its panes as extra tabs. Managed-Kubernetes resources declare a `kubernetes` peer via the `kubeconfig` output. Managed-DB resources declare a `postgres` / `mysql` / `mssql` / `redis` / `mongodb` peer via a `connectionString` output, engine-gated with `showWhen: { fieldKey: "engine", equals: "..." }`. Mark big-blob outputs (kubeconfig YAML) `hidden: true` so they don't clutter the outputs panel but remain resolvable.
- **`secretExportTemplates`** — env-var-style secrets the resource can produce when dropped onto a K8s cluster or SSH target. Conventional names: `DATABASE_URL` for DB URIs, `KUBECONFIG_DATA` for kubeconfigs, `AWS_*` for S3-compatible buckets.
- **`resourceSqlDriver`** — enables a SQL editor tab in the detail view, resolving the connection string per-resource. Pair with the matching `peerIntegrations` entry.
- **`sshEndpoint`** + **`supportsTerminal`** + **`supportsSftpBrowser`** — for compute resources; host output key, running-state guard, default username.
- **`supportsStorageBrowser`** — S3-compatible buckets (AWS S3, R2, Spaces, Scaleway Object Storage, GCS, Azure Blob). For S3-compatible vendors (S3 / Spaces / Scaleway), object verbs share `plugin-base/s3-storage-helpers.ts` and only differ in the URL builder: virtual-hosted (`{bucket}.{host}/{key}` — S3, Spaces) vs path-style (`{host}/{bucket}/{key}` — Scaleway). Each client also caches `bucketName → region` to avoid fanning out across regions on every storage call. The plugin's `renderDetail` must explicitly inject `storageBrowser: { bucketName }` into the schema — `supportsStorageBrowser: true` on the resource type only declares the capability for filtering/feature flags, it does not make the host render the panel.
- **`supportsMetrics`** — turn on the Metrics tab; the plugin's `fetchMetricSeries` must return a useful series for this `resourceTypeId`.
- **`unreachableWhen`** — declarative "tab renders but can't connect from here" guidance. Use for resources with private-only endpoints.

## Cloud metric dimension gotchas

The metric-API dimension value is **often a name, not the ARN/id** the resource is keyed by. Verify when adding a new metrics case.

- **DynamoDB:** dim is `TableName` — use `f.tableName ?? resource.externalId` because externalId is the ARN.
- **MQ Broker:** dim is the broker name (`f.brokerName`), not the broker id.
- **MSK:** dim key is `"Cluster Name"` (with the space).
- **WAFv2:** three dims (`WebACL`, `Rule="ALL"`, `Region`). CloudFront-scoped ACLs use `Region: "CloudFront"`.
- **SageMaker:** requires both `EndpointName` AND `VariantName=AllTraffic`.
- **CloudFront:** requires `Region: "Global"`.
- **SQS:** dim is the queue NAME (last URL segment), not the ARN.
- **SNS:** dim is the topic NAME (last segment of ARN).
- **ALB:** dim value is the `app/name/hash` slice of the ARN.
- **S3:** size/object metrics are daily — widen to ≥3 days and pin `StorageType` (`StandardStorage` vs `AllStorageTypes`).
- **Redshift:** dim is the cluster identifier (the name), not the ARN.
- **Step Functions:** dim is the state-machine ARN.

When implementing a new metrics case in `dashboard-metrics.ts` / `monitor-metrics.ts`, drop a one-line comment if the dim shape isn't the obvious resource-id.

## NoSQL document browser

The `noSqlBrowser` capability on a `DetailViewSchema` lets a plugin host an inline document explorer on a resource's detail page. Three drivers are supported:

- **`firestore`** — used by GCP Firestore. The plugin implements `executeNoSqlCommand` with `listCollections` / `find` / `countDocuments` / `getDocument` / `insertDocument` / `updateDocument` / `deleteDocument` / `deleteCollection`. The Firestore-style UI in `app/packages/ui/src/components/FirestoreDocumentBrowser.tsx` is the canonical client.
- **`mongodb-peer`** — used by Firestore Enterprise (MongoDB-compat). The host resolves a user-linked MongoDB account and uses its connection; the host plugin does not implement commands.
- **`dynamodb`** — used by AWS DynamoDB tables. Implemented in `plugin-architecture/packages/aws/src/dynamodb-handlers.ts`. Reuses the Firestore UI by:
  - Returning the table name as the single collection (`listCollections` → `{ collections: [tableName] }`).
  - Encoding each item's composite primary key (`partitionKey` + optional `sortKey`, joined with `::`) into a synthetic `_name` field on every returned document. `getDocument` / `deleteDocument` / `updateDocument` decode `_name` back into a DynamoDB `Key` map.
  - Mapping `find(skip, limit)` to `Scan(Limit = skip + limit + 1)` and slicing client-side. Server-side cursor pagination via `ExclusiveStartKey` isn't wired through the Firestore-style `skip/limit` contract, so large `skip` values are wasteful — direct key access via `getDocument` is the recommended escape hatch.
  - `countDocuments` returns `DescribeTable.ItemCount` (≈ 6h-stale) rather than a `Scan` with `Select=COUNT`, which would cost RCUs proportional to table size.

When a driver renders a single fixed collection (DynamoDB), set `singleCollection: true` on the capability so the Firestore UI hides "+ add collection" / drop affordances.

---

## Workflows

User-authored **TypeScript automations** run in a sandboxed **QuickJS/WASM isolate**, with a global `infra` object whose types are generated from the user's connected accounts. Manual runs everywhere (desktop, web, proxy); automated cron/git triggers run server-side (web/poller) — desktop has no automated triggers except via the proxy.

**Shared runtime — `@infrawrench/workflow-runtime` (`app/packages/workflow-runtime`)**, platform-agnostic, depended on by server-core, web, and desktop main:

- `sandbox.ts` — `runWorkflow({source, host, interactive, limits?, onLog?})`. Uses `loadAsyncQuickJs(@jitl/quickjs-ng-wasmfile-release-asyncify)` (the **async/asyncify** WASM build is required so guest code can `await __host(...)`). Pure WASM → identical in Electron + Node, no native rebuild; hard `memoryLimit` (bytes) + `executionTimeout` (ms) + `maxStackSize` (bytes). **Bundling gotcha:** the `wasmfile` variant's emscripten loader reads `emscripten-module.wasm` from `__dirname` at runtime; Rollup doesn't copy it. The desktop main build (`electron.vite.config.ts` → `copyQuickJsWasm` plugin) emits it to `out/main/chunks/emscripten-module.wasm` (next to the bundled chunk). Without it, runs fail with `Aborted(ENOENT: ... emscripten-module.wasm)`. The guest program is assembled as: `import {__host,__accountsTree} from "env"` + the prelude + the user's transpiled code as a default-exported async IIFE. `runSandboxed(({evalCode})=>evalCode(program), {env, allowFetch:false, allowFs:false, ...limits})` returns `{ok:true,data}|{ok:false,error}`.
- `host.ts` — `WorkflowHost` interface (platform implements: listPlugins, listResources/getResource/resolveOutput, create/update/deleteResource, listStorageObjects/readStorageObject, prompt, getMetric/setMetric) + `dispatch(host, ctx, method, args)` — the single RPC router. `prompt` throws when `ctx.interactive` is false.
- `prelude.ts` — `PRELUDE`: JS injected into the isolate that builds `globalThis.infra` (`infra.accounts[plugin].getByName/getById/list()` → an account handle with **one grouped accessor per resource type** `account.<group>.{list(), get(id), create/update/delete(...)}` where `<group>` = `camel(pluralDisplayName)` (e.g. `droplets`, `r2Buckets`); create/update/delete are present only when the type's `supports*` flag is set (read-only types get list+get) — plus `.resolveOutput`; `infra.prompt`, `infra.metrics`, `infra.output`, `infra.log`). There is no `.resources` map, `.storage` namespace, or generic `.call` — all removed. **Storage** is folded into the resource: storage-capable types (`rt.storage`) return resources mixed with `{ list(prefix?), get(key) }` bound to that bucket (bucket name = `externalId` ⟶ fallback to id's last segment), typed as `StorageResource extends WorkflowResource`. Group/storage names come from `pascal`/`camel(displayName/pluralDisplayName)` which **must stay byte-identical to codegen's `pascalCase`/`camelCase`** so runtime names match the generated `.d.ts`. on top of the single async `__host(method, argsJson)` RPC + `__accountsTree` + `__metrics`. Keeping the object graph in pure JS (not marshalled across the WASM boundary) is what makes it robust + trivially typeable. **Metrics** are a `Proxy` over the `__metrics` snapshot: `infra.metrics.<key>` reads are synchronous (property getters can't await); writes update the snapshot + mark the key dirty, and `globalThis.__flushMetrics` (called by sandbox `buildProgram` after the user task settles, even on failure) persists final values via `metric.set`. The host gained `listMetrics(): Record<key, value>` (in `WorkflowHost`/`buildWorkflowHost` deps, implemented by all runners + the desktop bridge) which `runWorkflow` reads at start to build the snapshot.
- `transpile.ts` — esbuild `transform({loader:"ts"})`, strip-only (no typecheck; editor handles diagnostics).
- `codegen.ts` — `generateInfraDts({plugins, metrics, interactive})` emits the `infra.d.ts` whose shape **mirrors the prelude**, specialized with real account names (string-literal `getByName` union), per-plugin resource handles, and the workflow's declared metrics as **typed properties** on `InfraMetrics` (`runCount: number | null`, etc.; an index signature when none are declared). `prompt` typed `never` for non-interactive.
- `build-host.ts` — `buildWorkflowHost(deps)` maps plugin-base `PluginClient` methods to the host ops; platforms supply `{listPlugins, getClient, readStorageObject, getMetric, setMetric, prompt}`.

**DB** — server-core `src/db/workflow-schema.ts` (re-exported from `db/schema.ts`): `workflows` (organizationId, source, `trigger` jsonb, `metricDefs` jsonb, enabled, `webhookToken`, `nextRunAt`, lastRunAt, syncVersion, deletedAt), `workflowRuns` (status/triggerSource/logs/output/error/timings), `workflowMetrics` (key/label/type/unit/value, unique on (workflowId,key)), and `dashboardWorkflowPins` (organizationId, dashboardId→dashboards, workflowId→workflows, gridX, unique on (dashboardId,workflowId)) — pins a workflow's metrics onto a dashboard. Migrations `web/src/db/migrations/0017_workflows.sql` + `0018_young_wolfpack.sql` (drizzle-kit generated; defined in workflow-schema.ts since it FKs both `dashboards` and `workflows`). Desktop SQLite mirror appended to `desktop/src/db/schema.ts` `MIGRATIONS` (`WORKFLOWS_MIGRATION` + `DASHBOARD_WORKFLOW_PINS_MIGRATION`).

**Web** — routes `web/src/api/routes/workflows.ts` (org-scoped CRUD + `GET /:id/typings` + `POST /:id/run` + runs/metrics; currently reuses `dashboards:read/write` perms — dedicated `workflows:*` is a TODO), public git webhook `routes/workflows-webhook.ts` (`POST /api/workflows/git/:token`, matched by `webhookToken`, branch-filtered on `ref`). `services/workflow-host.ts` (`buildOrgWorkflowHost`, `listOrgPlugins`) + `services/workflow-runner.ts` (delegates non-interactive runs to the shared server-core runner). Browser transport `web/src/lib/workflow-client.ts`.

**Shared server-core runner** — `server-core/src/workflows/runner.ts` (`@infrawrench/server-core/workflows/runner`) `runOrgWorkflow({organizationId, workflowId, triggerSource})`: builds the host via its own account-client factory (decrypt → getPlugin → host services → createClient), runs non-interactive, persists the run. Used by both the web manual route and the poller.

**Poller** — `poller/src/loop.ts` runs a cron pass each tick: due `workflows` (enabled, `nextRunAt <= now`) → `runOrgWorkflow(..., "cron")` → recompute `nextRunAt` via `cron-parser` from `trigger.expression`.

**Desktop local cron** — `desktop/src/lib/cron-runner.ts` (`startCronRunner`, started in `__root` alongside the metric pinger) is the renderer-side equivalent for local workflows: every 30s it finds enabled cron workflows, runs the due ones via `runWorkflowById(id, {interactive:false, triggerSource:"cron"})` (extracted from the desktop workflow client), and reschedules `next_run_at` with `cron-parser`. It reports the enabled-cron count via `set_crons_active`; main's `hasBackgroundWork()` (pings **or** crons) keeps the window hidden-not-quit on close so schedules keep firing in the background (can't fire while fully quit). Workflow create/update/delete dispatch `WORKFLOWS_CHANGED_EVENT` so the runner re-syncs promptly (and a trigger change nulls `next_run_at` to force a reschedule). The cron trigger UI (`WorkflowsPanel` `TriggerEditor`) offers presets + a raw expression with a plain-English `describeCron` summary.

**UI** — `@infrawrench/ui/workflows`: `WorkflowsPanel` (list + Monaco TS editor with the generated `infra.d.ts` injected via `monaco.languages.typescript.typescriptDefaults.addExtraLib`, trigger config, **metrics-definition section**, run + logs/output, runs history), `WorkflowEditorView`, `WorkflowIcon`, and `WorkflowDashboardCard` (a pinned-workflow dashboard card: metric label/value list, last-run line, inline **Run** button). New workspace-tab kind `{kind:"workflows"}` in `ui.store.ts` (URL-routed: desktop `/workflows`, web `/org/$orgId/workflows`); both web (`WebWorkspaceTabsViewport` + `WebSidebar`) and desktop (`WorkspaceTabsViewport` + `Sidebar` + `lib/workflow-client.ts` over `electronAPI`, with `infra.prompt` round-tripped via the `workflow-prompt` event / `workflow_prompt_response` channel) render it.

**Pin a workflow to a dashboard** — sidebars list individual workflows as `DraggableSidebarWorkflow` items (drag data `{ workflow: DraggableWorkflow }`); `DndShell.onPinWorkflowToDashboard` fires when one is dropped on a dashboard (sidebar tab or surface). Web: `POST /api/org/:orgId/dashboards/workflow-pin|workflow-unpin`, and `loadWorkflowPins` enriches the dashboard GET/`/default/full` responses with `workflowPins` (name + declared metrics' current values + last-run status, all DB-only). Desktop: local-only (`pinWorkflow`/`unpinWorkflow` in `lib/pins.ts`, `dashboard_workflow_pins` table); the `WorkflowPinCard` loads its own metrics from SQLite and runs via the local workflow client. Cloud-org desktop mode shows no workflow drag source (local workflows can't pin to cloud dashboards) and the root drop handler toasts a "switch to Local" hint.

**Desktop main** — `electron/workflows.ts` (IPC `workflow_list/create/update/delete/typings/run/runs/metrics` + `workflow_prompt_response`; node:sqlite via small `dbRun/dbAll/dbGet` cast helpers; manual/interactive only).

Docs: `website/src/content/docs/features/workflows.md`.

**Desktop `infra.prompt`** — Electron's `window.prompt` is a no-op, so the desktop host's `prompt` (`askUser` in `lib/workflow-client.ts`) calls `requestWorkflowPrompt` (`lib/workflow-prompt.ts`), which dispatches a `WORKFLOW_PROMPT_EVENT` and awaits a resolver. `WorkflowPromptHost` (mounted once in `__root.tsx`) renders a real modal per prompt — text/password/number/select inputs or Yes/No for `boolean` — and resolves with the typed value (or `null` on cancel). All renderer-side: the main-process sandbox already bridges `prompt` host calls back to the renderer via `workflow_host_call`.

**Still TODO**: dedicated `workflows:*` permissions; desktop↔cloud sync of workflows + workflow_metrics (syncVersion/deletedAt columns already present); desktop storage-object reads inside workflows (currently throws); web manual-run prompts (the panel's HTTP `/run` is non-interactive — interactive prompting needs the websocket path).
