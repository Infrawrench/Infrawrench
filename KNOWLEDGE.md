# Infrawrench — Project Knowledge

> Companion to CLAUDE.md. Contains architecture, conventions, gotchas, and decisions accumulated over development. Keep this up to date as the project grows.

---

## What it is

Infrawrench is an infrastructure management platform with both a desktop app and a cloud SaaS web app.

**Desktop app** — Electron + Vite + React, local SQLite, works offline. All 16 provider plugins loaded. SSH terminals, SQL editors, K8s exec, SFTP browsers run locally.

**Web app** — Next.js 15 App Router, Neon PostgreSQL via Drizzle ORM, WorkOS auth. All 16 plugins loaded server-side. SSH/SQL/K8s proxied through a custom WebSocket server (`server.ts`).

**Shared UI** — `@infrawrench/ui` React component library used by both apps. Plugins return schema data, both hosts render via SchemaRenderer/DetailView.

**Cloud features** — Desktop syncs to cloud via OAuth PKCE (WorkOS) + bidirectional sync protocol. Stripe billing at $20/seat/month with free tier (1 user, 3 accounts, no audit). API key system for programmatic access. Audit trail, team management, invitations.

---

## Monorepo layout

```
infrawrench/
├── plugin-architecture/packages/
│   ├── plugin-base/          # @infrawrench/plugin-base — zero-runtime-dep interfaces + Zod validators
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
│   ├── databricks/           # @infrawrench/plugin-databricks
│   ├── turso/                # @infrawrench/plugin-turso
│   └── ssh/                  # @infrawrench/plugin-ssh
├── app/packages/
│   ├── desktop/              # @infrawrench/desktop — Electron app
│   ├── ui/                   # @infrawrench/ui — shared React components
│   └── web/                  # @infrawrench/web — Next.js SaaS web app
├── CLAUDE.md                 # Hard rules (keep short)
└── KNOWLEDGE.md              # This file
```

pnpm workspaces + Turborepo. All package references use `workspace:*`.

---

## Core architectural rule

**Plugins are self-contained. The Electron host is generic.**

- Plugins own all provider-specific logic (API calls, field shapes, SQL strings, Docker ops, GCS paths, etc.)
- The host (Electron main + React renderer) dispatches to plugins via typed interfaces — it never hard-codes provider names or API endpoints
- Plugins return typed *schema* for rendering (e.g. `DetailViewSchema`, `SidebarItemSchema`) — they never return React components or JSX
- Node.js-heavy work (native DB clients, Docker SDK, storage downloads) lives in plugin `./node-driver` exports, run in Electron main

---

## plugin-base — the contract

**`src/manifest.ts`** — `Plugin`, `PluginClient`, `PluginManifest`, driver declarations, host services

Key manifest fields:
- `credentialFields` — what the host asks the user for when adding an account
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
getCreateConfig?(typeId): Promise<CreateResourceConfig>  // live API-driven create form
createResource?(typeId, accountId, fields): Promise<ResourceInstance>
deleteResource?(typeId, resourceId, accountId): Promise<void>
listStorageObjects?(bucket, prefix): Promise<StorageObject[]>
uploadStorageObject?(bucket, key, file, onProgress?): Promise<void>
makeStorageFolder?(bucket, key): Promise<void>
deleteStorageObject?(bucket, key): Promise<void>
getStorageAccessToken?(): Promise<string>
fetchStorageStats?(bucketName): Promise<{ count, size }>
getSshConfig?(): { host, port, username, privateKey }
getManifest?(resourceId, accountId): Promise<string>        // raw manifest text (JSON) for Monaco editor
applyManifest?(resourceId, accountId, manifest): Promise<void>  // apply edited manifest back
```

**`src/resource.ts`** — `ResourceTypeDefinition`

Important flags:
- `dashboardPinnable: boolean` — whether users can pin instances to dashboards
- `supportsCreate?: boolean` — whether the host shows a "+ Create" button
- `supportsStorageBrowser?: boolean` — whether the host renders the GCS browser panel
- `supportsTerminal?: boolean` — whether the host renders the SSH terminal panel
- `sshEndpoint?: { hostOutputKey: string }` — enables "Connect via SSH" right-click in sidebar; `hostOutputKey` names the resolved output to use as the SSH host (e.g. `"ipv4"`)
- `resourceSqlDriver?: { driver, connectionStringOutputKey }` — per-resource SQL editor; the host resolves the connection string from the resource's outputs via `resolveOutput()` and enables the SQL editor tab (unlike manifest-level `sqlDriver` which uses account credentials)
- `parentTypeId?: string` — child types are shown on their parent's detail page, not on the account page; the host auto-fetches children and renders them as navigable cards with optional create buttons

**`src/create.ts`** — `CreateResourceConfig`, `CreateFieldConfig`

Field kinds: `text`, `select`, `size-picker`, `region-picker`, `disk-slider`, `image-picker`, `disk-picker`, `ssh-key-picker`

`showWhen?: { fieldKey, fieldValue }` — conditional visibility (e.g. show disk picker only when `bootSource === "existing-disk"`)

**`src/node-driver.ts`** — Node.js-side driver interfaces

Each plugin that needs native Node.js capabilities exports from `./node-driver`:
- `SqlNodeDriver` — `query()`, `execute()`
- `KvNodeDriver` — `command()`
- `DockerNodeDriver` — `command()`
- `StorageNodeDriver` — `downloadFile()` (for batch downloads via IPC)

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
sqlDrivers     → Map<string, SqlNodeDriver>    (postgres, mysql, libsql)
kvDrivers      → Map<string, KvNodeDriver>     (redis, memcached)
dockerDrivers  → Map<string, DockerNodeDriver> (docker)
storageDrivers → Map<string, StorageNodeDriver> (gcp)
```

### Plugin host (`electron/plugin-host.ts`)
Handles `plugin_*` IPC calls by looking up the right driver from `drivers.ts`.

### SSH layer (`electron/ssh-tunnel.ts`, `electron/ssh-shell.ts`)
- Tunnels: ssh2 `Client` + Node.js `net.Server` on port 0 (OS-assigned); each TCP connection opens an SSH forward channel. `openTunnel()` returns `{ tunnelId, localPort }`.
- Shells: ssh2 `Client.shell()` with `xterm-256color`; data piped to renderer via `webContents.send()`. Binary data encoded with `.toString("binary")`.
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

**v2:**
- `ssh_tunnel_configs` — `account_id (UNIQUE), ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv`
- `ssh_keys` — named encrypted private keys saved by the user

Resource IDs follow the convention `{accountId}:{resourceTypeId}:{externalId}`. GCP externalIds for instances/disks/clusters are `{projectId}/{zone}/{name}`.

---

## Plugin registry & loader

`app/packages/web/src/plugins/blessed-plugins.json` is the authoritative blessed list. Both web and desktop import from this path via a Vite alias (`@blessed-plugins`).

The loader (`app/packages/desktop/src/plugins/loader.ts`) validates each plugin's manifest against the Zod schema and checks the manifest `id` matches the registry `id` before mounting. Unknown packages are refused.

Currently blessed: `gcp`, `docker`, `digitalocean`, `hetzner`, `kubernetes`, `memcached`, `mongodb`, `mysql`, `neon`, `postgres`, `redis`, `scaleway`, `ssh`, `cloudflare`, `ovh`, `aws`, `databricks`, `turso`.

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
- `SidebarDashboards.tsx` — dashboard list + create
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

### Background refresh pattern
All polling is *background* (no loading flash):
- `backgroundRefreshRef.current = true` is set before bumping the version counter
- The `useEffect` reads the ref, resets it, and skips `setLoading(true)` when true
- Errors during background refresh are silenced (stale data stays visible)
- Intervals: 30s for sidebar, account page, resource detail; 30s for dashboard `connectAll`

---

## Plugin-specific notes

### GCP (`@infrawrench/plugin-gcp`)
- Auth: OAuth2 access token fetched client-side from `oauth2.googleapis.com/token`
- Resource ID format: `{accountId}:gce-instance:{projectId}/{zone}/{instanceName}`
- `externalId` for GCE instances = `{projectId}/{zone}/{instanceName}` — parse with `.split("/").pop()` to get the instance name for API calls
- SSH key injection format: `username:ssh-rsa AAAA...` in metadata; `username` derived from key comment (`comment.split("@")[0]`)
- Delete requires zone from `resource.fields["zone"]`, not from `externalId`
- Storage driver (`./node-driver`) handles GCS batch downloads
- GCP exposes `getCreateSizePricing()` for async per-region VM price hydration from the Cloud Billing Catalog API (Compute SKUs); modal opens with base options first, then prices stream in (default zone first, then others)

### DigitalOcean (`@infrawrench/plugin-digitalocean`)
- Resource ID format: `{accountId}:{typeId}:{externalId}`
- SSH key upload: `POST /v2/account/keys` — handle 422 (duplicate) by listing existing keys and matching by `public_key`
- `fetch` helper handles `204 No Content` explicitly to avoid JSON parse error on DELETE

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
- Object Storage uses S3-compatible API at `s3.{region}.scw.cloud`; bucket listing via Scaleway REST API
- Commercial types fetched from `/instance/v1/zones/{zone}/products/servers` for create form
- Instance status mapping: running/ready→healthy, starting/stopping/provisioning/creating→provisioning, stopped/error/locked/deleting→error

### Kubernetes (`@infrawrench/plugin-kubernetes`)
- Manifest editor: all namespaced resource types (Pod, Deployment, Service, StatefulSet, DaemonSet, Job, CronJob, Ingress, ConfigMap, Secret) declare `manifestEditor` on their `DetailViewSchema`. The host renders a Monaco-based JSON editor tab.
- `getManifest(resourceId, accountId)` fetches the full resource JSON from the K8s API; `applyManifest()` PUTs it back.
- Resource ID format: `{accountId}:k8s-{type}:{namespace}:{name}` (namespaced) or `{accountId}:k8s-{type}:{name}` (non-namespaced like namespaces).
- The `k8sApiPath()` helper maps type IDs to K8s API paths (e.g. `k8s-deployment` -> `/apis/apps/v1/namespaces/{ns}/deployments/{name}`).
- **Scratch (ephemeral) pods:** Pod creation form offers OS image presets (Ubuntu 24.04 default, Debian, Alpine, Fedora, Rocky, Amazon Linux, Arch, or custom) and a TTL picker (15m–24h). Pods are created with `activeDeadlineSeconds` + `restartPolicy: Never` + `sleep <ttl>` command. K8s auto-terminates the pod when the TTL expires. Expired ephemeral pods are auto-deleted during the next `listPods()` cycle (sidebar refresh). Pods are tagged with `infrawrench.io/ephemeral: "true"` label and `infrawrench.io/expires-at` / `infrawrench.io/ttl-seconds` annotations.
- `deleteResource()` is implemented for all namespaced K8s resource types via `buildResourcePath()`.

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
4. `SshTerminal` defers `fitAddon.fit()` to `requestAnimationFrame` (avoids xterm "dimensions undefined" error)
5. `ssh_shell_spawn` IPC → ssh2 in Electron main → resolves to `shellId`
6. Data events: `ssh_shell_data_{shellId}` → `term.write()`
7. Cleanup: `ro.disconnect()`, kill shell, `term.dispose()`

Resource detail pages now expose SSH as a route-local tab. The bottom-docked SSH panel was replaced with an `Open SSH tab` action that promotes the terminal or quick-connect panel into the main content area.

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot read 'dimensions'` in xterm | `fitAddon.fit()` called before DOM layout | Defer to `requestAnimationFrame` |
| Duplicate `Access-Control-Allow-Origin` header | CORS interceptor adding `*` when server already sent its own | Check `hasACAO` case-insensitively before injecting |
| OPTIONS preflight blocked with 403 | Server rejects preflight; headers were added to 403 but browser still rejects | Force `statusLine: "HTTP/1.1 200 OK"` on OPTIONS when injecting |
| GCP delete 404 with full resource ID in URL | `externalId` is `project/zone/name`; using it directly as instance name | Use `resource.fields["name"]` or `.split("/").pop()` |
| `exactOptionalPropertyTypes` TS error | `field.defaultValue = x | undefined` not assignable | Use `...(x ? { defaultValue: x } : {})` spread pattern |
| Plugin-base types missing after change | Dependent package built before plugin-base | Run `pnpm --filter @infrawrench/plugin-base build` first |
| SSH auth fails despite correct key | Username defaults to `root`; GCP/DO use key comment as username | Read `.pub` file comment, use `comment.split("@")[0]` as username |
| Sidebar shows deleted resource | Sidebar caches resource lists; `iw:resources-changed` event not fired | Dispatch event after delete; sidebar listener calls `loadAccountResources(..., true)` |

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

### WebSocket proxy
Custom Next.js server (`web/server.ts`) handles WS upgrades at `/api/ws`. Auth via `?token=` query param (API key or OAuth token). Channels:
- `ssh:open` → SSH terminal session via ssh2
- `sql:query` → SQL execution via plugin drivers
- `ssh:data` / `ssh:resize` → bidirectional terminal I/O

### Sync protocol
- `POST /api/v1/sync/pull` — returns entities with `syncVersion > lastSyncVersion`
- `POST /api/v1/sync/push` — upserts entities with last-write-wins by `updatedAt`
- `GET /api/v1/sync/status` — returns max syncVersion

Auth via `Authorization: Bearer <api_key_or_oauth_token>`. Scopes: `sync:read`, `sync:write`, `resources:read/write`, `dashboards:read/write`.

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
