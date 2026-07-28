# Infrawrench — Project Knowledge

> Companion to CLAUDE.md. Contains architecture, conventions, gotchas, and decisions accumulated over development. Keep this up to date as the project grows.

---

## What it is

Infrawrench is an infrastructure management platform with both a desktop app and a cloud SaaS web app.

**Desktop app** — Electron + Vite + React, local SQLite, works offline. All 28 provider plugins loaded. SSH terminals, SQL editors, K8s exec, SFTP browsers run locally.

**Web app** — Hono server (Node) + Vite/React frontend with TanStack Router, Neon PostgreSQL via Drizzle ORM, WorkOS auth. All 28 plugins loaded server-side. SSH/SQL/K8s proxied through a custom WebSocket server (`server.ts`).

**Mobile app** — Expo SDK 54 + expo-router (iOS/Android), `@infrawrench/mobile`. Signs into the cloud via WorkOS OAuth PKCE (tokens in SecureStore) and talks Bearer to the existing cloud API. Org switcher, a **Dashboards** tab (route `org/[orgId]/index.tsx`) listing every dashboard, each opening on its own screen (the web home route's content: pinned resources, workflow tiles, cost graphs, budgets — see the dashboard-parity note below), account + resource browser with a native SchemaRenderer for plugin `DetailViewSchema` (actions, logs, metrics), global search, AI chat (SSE), SSH terminal via a WebView-hosted xterm.js on the existing `/api/ws` protocol, SFTP browser (cloud-proxied), read-only workflows/agents, settings incl. push preferences and personal account settings (name, password reset, TOTP two-factor, active sessions). The per-resource tools web renders as tabs and bottom panels are separate screens here, all under `mobile/src/app/org/[orgId]/tools/[tool].tsx` → `mobile/src/features/tools/*` (logs with the full LogsFetchParams controls, KV console, Mongo document browser, KV namespace browser, peer panes) plus an inline Docker actions card; `kubectl exec` shares the terminal route (`PtyTerminal`, `protocol: "ssh" | "k8s:exec"`, since both speak `:data`/`:connected`/`:closed`/`:error` under their own prefix) and is reached from a Kubernetes peer pane's pod rows. Host-key trust prompts natively on all three surfaces now: the payload/guard/body live in `client-core/src/ssh-host-keys.ts` (`trustPayloadFromFrame` is the one place that knows the WS frame marks itself with `code` while the HTTP 409 uses `error`), `mobile/src/components/HostKeyTrustHost.tsx` is mounted once at the root, and `mobile/src/lib/ssh/host-key-trust.ts` is the module-level registry the prompt registers into — **it has to be module-level**, because the `CloudFetch` `on409` interceptor that catches the SFTP/tunnel 409s is constructed inside `AuthProvider`, above any component that could hold it in context. The trust POST sets an in-flight flag that makes `on409` stand down: that request can 409 on its own when a concurrent connect saw a different key, and retrying it would replay the fingerprint the server just rejected, forever — the sheet re-prompts with the new payload instead. Accepting in the terminal bumps an `attempt` counter rather than reusing the socket (ws tokens are single-use and the proxy tears the session down when the verifier rejects). Deliberate demotions: billing read-only, no Monaco editors, no secret-reroll wizard, no k9s or port-forward; dashboards are fully editable (see the dashboard-authoring note below) except for drag-to-reorder and custom absolute cost ranges. Chrome icons (tab bar, header) are drawn in `mobile/src/components/icons.tsx` with `react-native-svg` on the same 24×24 stroke grid as the web app's `WorkflowIcon` — **never a Unicode glyph in a `<Text>`**: the OS picks the font, so weights differ between glyphs and some (⚙ especially) resolve to a colour emoji that ignores the `color` the tab bar passes for active/inactive state.

**Shared UI** — `@infrawrench/ui` React component library used by both apps. Plugins return schema data, both hosts render via SchemaRenderer/DetailView. `@infrawrench/client-core` holds the host-agnostic cloud client pieces (TokenManager, `cloudFetch` 401-retry wrapper, SSE parser, bearer ChatClient, WS frame types, push registration) shared by mobile and future hosts; the chat types moved there and `@infrawrench/ui` re-exports them. The same rule now covers anything three surfaces have to agree on that isn't a React component: the **cost contract** (`client-core/src/costs.ts` — widget config, `/costs/query` request/response, `BudgetWithStatus`, plus `resolveCostDateRange`, `costQueryForConfig`, `totalPerBucket`, `binForecast`, `formatMoney`, `formatBucketLabel`, `formatBudgetMonth`), the **dashboard card ordering** (`client-core/src/dashboard-cards.ts`), and the **axis maths** (`client-core/src/chart-axis.ts` `niceAxis`). The same move happened for every pure fragment mobile needed when it grew the per-resource tools: **SSH quick-connect** key/username selection (`ssh-quick-connect.ts`), **KV console** tokenizing/formatting/driver copy (`kv-console.ts`), the **Mongo command builders and value formatters** (`mongo-browser.ts`), and **create-form field logic** — `evaluateShowWhen`, `buildDefaultFields` (`create-fields.ts`). Each is re-exported from `@infrawrench/ui` at its old name, so web and desktop imports never changed; the rule is that the second host to need a pure helper moves it rather than copying it. `ui/src/cost/config.ts` keeps the zod schemas — the web API validates against them — and a set of `Exact<z.infer<...>, T>` assertions at the bottom of that file turns any drift between a schema and the shared type into a build error.

**Account pages list every resource type** — an account page is that account's full inventory, so each of the plugin's types gets its own section, child types (DNS records, DB users) included. `getVisibleAccountCategories` in `client-core/src/account-sections.ts` is the single rule, re-exported by `@infrawrench/ui` and imported directly by mobile; a section survives when it has resources after filtering, or the query matches its name/id, or it supports create. Searching therefore only ever removes sections. **Do not reintroduce a `parentTypeId`/`showInSidebar` check here** — that pair scopes the _sidebar_ (`getListableResourceTypes`, `?topLevelOnly=true`), and using it for sections once meant the empty-query and search paths disagreed: web dropped every child type until you typed a letter, which then made more tabs appear rather than fewer. It was worse on web than desktop because `GET /accounts/:id/detail` never serialized `showInSidebar`, so even opt-in types (Droplets, Volumes, Managed Databases) read as `undefined` there. The account resources fetch deliberately omits `topLevelOnly` on all three surfaces.

**Cloud features** — Desktop syncs to cloud via OAuth PKCE (WorkOS) + bidirectional sync protocol. Stripe billing at $20/seat/month with free tier (1 user, 3 accounts, no audit). API key system for programmatic access. Audit trail, team management, invitations. Mobile push notification pipeline: `server-core/src/push/` dispatches via the Expo Push Service to user-scoped devices (`push_devices`) filtered by per-user+org trigger toggles (`push_preferences`), fanned out from the Twilio pager's sync-failure incidents (Twilio creds now optional — push-only orgs work) and budget threshold breaches. Every message goes out `priority: "high"` + `interruptionLevel: "time-sensitive"` (see the EAS entitlement note below) — everything we push is an alert, so nothing wants the batched tier. Slack (`server-core/src/slack.ts`) is a third transport on the same three triggers, connected per-org with "Add to Slack" OAuth and routed per-channel. Microsoft Teams (`server-core/src/msteams.ts`) is a fourth, routed per-channel by webhook URL rather than OAuth (Teams has no app-only send path — see below).

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
│   ├── kafka/                # @infrawrench/plugin-kafka
│   ├── aws/                  # @infrawrench/plugin-aws
│   ├── cloudflare/           # @infrawrench/plugin-cloudflare
│   ├── mongodb/              # @infrawrench/plugin-mongodb
│   ├── mssql/                # @infrawrench/plugin-mssql
│   ├── opensearch/           # @infrawrench/plugin-opensearch
│   ├── ovh/                  # @infrawrench/plugin-ovh
│   └── planetscale/          # @infrawrench/plugin-planetscale
├── app/packages/
│   ├── desktop/              # @infrawrench/desktop — Electron app (and the `infrawrench` CLI)
│   ├── mobile/               # @infrawrench/mobile — Expo (SDK 54) iOS/Android app against the cloud API
│   ├── ui/                   # @infrawrench/ui — shared React components (incl. Toast feature)
│   ├── client-core/          # @infrawrench/client-core — host-agnostic cloud client (tokens, cloudFetch, SSE, chat, WS types, push registration, account-page sections)
│   ├── server-core/          # @infrawrench/server-core — db client, schema, plugin loader, sync, host services (shared by web + poller)
│   ├── workflow-runtime/     # @infrawrench/workflow-runtime — QuickJS-WASM sandbox, host bridge, infra.d.ts codegen
│   ├── web/                  # @infrawrench/web — Hono + Vite/React SaaS web app
│   ├── poller/               # @infrawrench/poller — background resource poller microservice
│   ├── github-watcher/       # @infrawrench/github-watcher — polls GitHub App installs, fires git-triggered workflows
│   ├── bastion-agent/        # @infrawrench/bastion-agent — self-hosted Docker agent; dials out over WSS so calls exit the user's IP
│   ├── telemetry/            # @infrawrench/telemetry — Hono on Cloudflare Workers; anonymous desktop ping endpoint (Hyperdrive + Postgres)
│   ├── egress-proxy/         # @infrawrench/egress-proxy — Cloudflare Worker that performs workflow `fetch()` from OUTSIDE the k8s cluster
│   └── website/              # @infrawrench/website — Astro on Cloudflare Workers; landing + releases API
├── infra/                    # Terraform (GKE), k8s manifests, service Dockerfile, container registry
├── patches/                  # pnpm patchedDependencies (app-builder-lib, desktop-only)
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

**Agents mode:** resource types that can host coding-agent VMs declare `agentVm` on `ResourceTypeDefinition`. The host lists accounts by scanning plugin metadata (`supportsCreate` + `sshEndpoint` + `agentVm`) instead of hard-coding AWS/GCP/DO/Hetzner/Scaleway in Electron or web code. `agentVm` names the SSH key create-field, default setup username, default VM fields, optional human labels for those defaults, preferred Linux image fields, and fields hidden from the Agents defaults form. Agents defaults use the plugin's real `getCreateConfig` field metadata for those default keys when available, so controls like size pickers, image pickers, and disk sliders stay provider-owned and match the create page. Agent settings and sessions are stored in desktop SQLite (`agent_settings`, `agent_sessions`) and web Postgres (`agent_settings`, `agent_sessions`). Desktop sessions also store `setup_plan_json`, which records the pre-provision workspace/runtime/config plan used by VM bootstrap, including a local folder's cloneable `origin` URL when present. Sessions store a user-visible `project_name` and a separate `workspace_name`; creation sets the visible name from the Agent name field and the workspace name from the repo basename, so `/Users/astrid/infrawrench` maps to `~/infrawrench` even when the session is called `test`. Desktop local-folder creation first asks Electron main to inspect the selected folder: it must exist, Git must be available locally, and the folder must be a Git work tree or creation fails before provider provisioning. The preflight detects Node/PHP/Ruby/Go from project files (`package.json`, `.nvmrc`, `.node-version`, `composer.json`, `.php-version`, `Gemfile`, `.ruby-version`, `go.mod`, `.tool-versions`, `.mise.toml`), keeps exact project versions, resolves missing/range versions from the runtime's public release feed before creating the VM, and records package managers from `packageManager`, lockfiles, and language manifests (`pnpm`, `yarn`, `bun`, Composer, Bundler, npm, Go). Creating an agent session calls the selected plugin's `createResource` with the saved default fields plus a provider-safe `name`, persists the created VM in `resources`, stores its id in `agent_sessions.vm_resource_id`, and starts an idempotent VM bootstrap; failed provider creates leave a failed session row with the error log. Desktop bootstrap uses the managed `infrawrench-agent` private key with the non-interactive workflow SSH IPC, waits for the generic `sshEndpoint`, retries a real SSH command until the VM accepts connections, installs OS prerequisites plus `screen`, installs planned runtimes through `mise`, installs detected package managers, installs the selected tool (`@openai/codex` or `@anthropic-ai/claude-code`), persists the mise/CLI PATH for later SSH shells, prepares `~/<workspace name>`, clones or pulls the initial workspace from Git when possible, checks out `infrawrench/agent-*`, and only marks the session `up` after the `Agent VM setup complete.` log marker is present. Desktop bootstrap/sync copies selected tool credential/settings material (Codex `auth.json`, `config.toml`, state files, and skills from `~/.codex`; Claude Code settings/plugins from `~/.claude` plus `~/.claude.json`) while skipping local sessions, logs, caches, temp files, downloads, and package stores. For local-folder sessions, the first bootstrap uses the origin remote when possible; Agent Open forces a refresh sync that replaces the remote workspace by building one local `.tar.gz` from Git-tracked/unignored files plus normal `.git` metadata, uploads the archive over SFTP, extracts it on the VM, and deletes the temp archives, so ignored files stay ignored and the VM workspace remains a Git repo. Agent Open opens a single SSH workspace tab for the backing VM and runs or resumes a named `screen` session containing `codex --yolo` or `claude --dangerously-skip-permissions` in the workspace directory. If Open is clicked while initial setup is still running, it waits for that setup and then performs the forced local refresh before launching. Session branches are named `infrawrench/agent-*`, setup is conservative, and reconciliation fetches the branch for the user to manage with normal Git tools.

**Agents repo picker (web):** the shared `AgentsPanel` takes an optional `gitIntegration` prop (the same `GitIntegration`/`GitRepoOption` shape as the Workflows git-trigger picker; `GitRepoOption` gained `private?`). `WebAgentsPanel` supplies it from `/api/org/:orgId/github/{status,repos,install-url}`; desktop renders `AgentsPanel` without it, keeping the free-text Git URL + local folder. Picking a repo just sets the session `repo` string to `https://github.com/<fullName>.git`, so everything downstream (create route, setup plan, bootstrap) is unchanged. Private-repo clones: the web setup pipeline (`resolveAgentCloneUrl` in `services/agent-setup.ts`) matches the session repo against the org's GitHub App installations on every setup run, mints a fresh installation token (they expire after 1h), and passes it as `cloneUrl` to `buildAgentBootstrapCommand`, which clones/fetches with `CLONE_URL` and then resets `origin` to the canonical `REPO_URL` — the token never persists on the VM. `appendAgentSessionLog` redacts URL-embedded credentials (git repeats the clone URL in error messages) before persisting org-visible logs.

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
- `supportsUpdate?: boolean` — whether the host shows an "Edit" button on the resource detail page. When true, the plugin must implement `updateResource`; the host opens `EditResourceModal` over the resource type's `fields`, diffs against the current values, and POSTs only the changed keys via `/api/resources/update` (cloud) or directly to the client (local). Mark individual fields with `editable: false` on `FieldDefinition` to lock them (e.g. provider-immutable identity fields); `secret` and `association` field kinds are also always excluded from the edit form. The `password` field kind is editable but write-only: it renders masked, is never seeded from stored field values (providers must not return secrets), and is only submitted when the user types a new value — leaving it blank means "keep the current secret" (used for rotating Cloudflare Hyperdrive origin passwords). Currently wired: DigitalOcean `project` (PATCH `/v2/projects/{id}`), Cloudflare `hyperdrive` (editable origin connection + password rotation).
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

## CLI (`infrawrench …`)

The desktop app doubles as a terminal tool: a shell shim (VS Code's `code` model) execs the app binary with `--cli`, and the bootstrap entry (`electron/index.ts`, now the electron-vite main input) dynamically imports either `electron/main.ts` (GUI) or `electron/cli/main.ts` (headless runner). The dynamic-import split means a CLI invocation never runs GUI import-time side effects (protocol registration, single-instance lock, ipcMain handlers) and vice versa.

**Why full Electron and not `ELECTRON_RUN_AS_NODE`:** the master key is `safeStorage`-encrypted (`master.key.enc`, Keychain/DPAPI-backed) and `safeStorage` only exists inside a real Electron app. The CLI therefore boots the whole app object headlessly (`app.dock.hide()` on macOS, `disable-gpu`, no windows) and reads the same `userData` dir: same SQLite DB, same master key, same cloud session.

**Refactors that enable it** (keep these boundaries intact):

- `electron/cloud-tokens.ts` — side-effect-free token store (storage/refresh/PKCE helpers/orgs fetch). `cloud-auth.ts` keeps only GUI wiring (protocol, single-instance lock, IPC) and re-exports `getAccessToken`/`forceRefreshAccessToken` for its existing importers.
- `electron/db.ts` — shared sql.js open/persist (`getSqlite`/`persist`/`normalizeSql`/`wireDbGetter`) with a read-only mode.
- `electron/plugin-runtime.ts` — main-process plugin runtime: loads a plugin through the renderer's `src/plugins/loader.ts` (no DOM deps), decrypts an account's credentials in-process, and builds `HostServices` by calling `electron/drivers.ts` **directly** rather than over IPC. This is the third copy of that wiring — renderer `src/lib/sql-drivers.ts`, web `server-core/host-services.ts`, main this file — so a `HostServices` change means editing three places. Its `http` service is plain `fetch` (`node:https` only when a per-request CA is needed) and deliberately does **not** go through `k8s_api_request`: that channel's SSRF allowlist exists to contain a compromised renderer, and main-process callers are already trusted. Importing `src/plugins/loader.ts` from `electron/` is what forced `@infrawrench/plugin-base` to publish conditional `types` (`dist/index.d.cts` under `require`) — without it the CJS-typechecked main project can't statically import an ESM-typed package.

**Master key: the CLI never mints one.** `getEncryptionKey()` generates + writes a fresh key when none can be read, which is right on first run and catastrophic every other time — a locked keychain or a differently-signed build silently orphans every encrypted row (accounts, secret fields, cloud tokens) behind a key that no longer matches. The GUI owns first-run setup, so `cli/main.ts` calls `setRequireExistingEncryptionKey(true)` and an unreadable key becomes an error instead of a rewrite. Corollary for anyone testing the CLI: **never point a differently-built Electron at a real `userData` dir** (`--user-data-dir`, or `npx electron` resolving a different Electron version) — pre-guard, that overwrote `master.key.enc` and made the profile's credentials unrecoverable.

**Concurrent-process safety:** sql.js persists by rewriting the whole DB file, so GUI + CLI must never both write. The CLI probes `app.requestSingleInstanceLock()` **after `await app.whenReady()`, and the order is load-bearing** — losing the lock before the ready event leaves the app permanently un-ready (Electron gates startup for a second instance because it expects the loser to `app.quit()`), so `whenReady()` never resolves and every CLI command hangs with no output whenever the desktop app is open. Probing after ready returns the same answer. The probe releases the lock immediately if acquired; if the GUI holds it, the CLI sets `setDatabaseReadOnly(true)` + `setTokenStoreReadOnly(true)`. Read-only token mode also refuses to refresh — WorkOS rotates refresh tokens, so a CLI refresh it couldn't persist would sign the desktop out. It just uses the stored access token (the GUI refreshes ~60s before expiry, so it's almost always fresh) and `login`/`logout` redirect the user to the app. The GUI's `second-instance` handler ignores argv containing `--cli` so the probe doesn't yank the window forward.

**Commands** (`electron/cli/`): `login`/`logout`/`whoami` (login is loopback PKCE on `http://127.0.0.1:43117/callback` — that redirect URI must be whitelisted on the WorkOS app), `orgs`, `accounts` (local + all orgs by default), `resources`/`resource` (cloud via HTTP API; **local live through the plugin** via `electron/plugin-runtime.ts` — the local `resources` table only holds rows desktop itself created or pinned, never discovered ones, so reading it made every local account look empty; `fieldsJson`/`outputsJson` on the cloud response are **jsonb objects, not strings** despite the name — a `JSON.parse`-style reader silently yields `{}` for every field and output), `metrics` (ClickHouse-backed org metrics), `costs` (`POST /costs/query` + `/costs/status` collection warnings), `cli install|uninstall|status`, `tui`. Output: `--json` or text (default); charts in `cli/charts.ts` are hand-rolled ANSI (sparkline / block area chart / bar chart) — deliberately zero new runtime deps (no ink/blessed/commander; flags via `node:util` parseArgs). The TUI (`cli/tui.ts`) is a hand-rolled alternate-screen renderer.

**Shell shim install** (`electron/shell-command.ts`, shared by `infrawrench cli install` and the sidebar-footer button via `cli_install_shell_command`/`cli_uninstall_shell_command`/`cli_shell_command_status` IPC): POSIX writes an `exec "<app binary>" --cli "$@"` script to `/usr/local/bin` or `~/.local/bin` (no privilege escalation; refuses to overwrite a file it didn't write — marker comment "Installed by Infrawrench"); Windows writes `userData\bin\infrawrench.cmd` and appends the dir to the user PATH via PowerShell. In dev the shim includes the app path after the electron binary. Windows caveat: Electron is a GUI-subsystem exe, so stdout in a console can be unreliable — documented as best-effort.

---

## Workflows runtime (`@infrawrench/workflow-runtime`)

Sandboxed TypeScript automations over `infra.accounts.*`. User source runs in a QuickJS/WASM isolate; the only powers crossing the boundary are a single async RPC `__host(method, argsJson)` and a read-only accounts tree. The ergonomic `infra` object is built in pure JS by `prelude.ts`, and `codegen.ts` generates an `infra.d.ts` whose shape mirrors the prelude exactly (Monaco autocomplete). Each platform supplies a `WorkflowHost` via `buildWorkflowHost` (`ClientHostDeps`): web `services/workflow-host.ts`, poller/cloud `server-core/workflows/runner.ts` (shared `runOrgWorkflow`), desktop builds the host in the **renderer** and runs the isolate in **electron main** (`electron/workflow-host.ts` bridges every host method back over IPC).

- **Desktop workflows follow the org switcher** — the Workflows tab is NOT local-only. `DesktopWorkflowsPanel` (`desktop/src/components/DesktopWorkflowsPanel.tsx`) picks the client from `useUIStore.activeCloudOrgId`: local mode → `createDesktopWorkflowClient` (SQLite + in-renderer host, above), an org → `createCloudWorkflowClient` (`desktop/src/lib/cloud-workflows.ts`), which is pure transport over new `cloud_*_workflow*` IPC (`electron/cloud-data/workflows.ts` → `/api/org/:orgId/workflows`) — the isolate runs server-side, so there is no host to bridge. Debug runs open the cloud websocket and drive the same `workflow:*` frames the browser client does, with the one desktop difference that `infra.prompt` goes through the renderer modal (Electron's `window.prompt` is a no-op). **Clients are cached per org and keyed into `useMemo`** — `WorkflowsPanel` re-lists whenever its `client` identity changes, which is what makes an org switch swap the list. Cloud mode also enables the two server-backed triggers (git via `cloud_github_*`, budget via `cloud_list_budgets`), so the desktop offers all four. Dashboard workflow pins are org-aware too: cloud dashboards return `workflowPins` fully joined inline (no enrich call, unlike resource pins), so `WorkflowPinCard` takes `initialData` + `orgId` instead of always reading SQLite. The local cron runner stays local-table-driven — an org's crons fire in the poller, so nothing double-runs.
- **Typed `create()` fields** — `listOrgPlugins`/`listLocalPlugins` take `{ enrichCreateFields }` (typings path only, NOT every run — it hits provider APIs). When set, they call `client.getCreateConfig(typeId)` and distill it via `createFieldsFromConfig` (`workflow-runtime/create-fields.ts`) into `WorkflowResourceTypeInfo.createFields`, cached per `pluginId:typeId` (10-min TTL; server-core `create-fields-cache.ts`, desktop inline). Codegen then emits a typed object literal (`region?: "nyc3" | … | (string & {})`) instead of `Record<string, string>`. Option lists come from `select`/`region`/`size`/`image`/`disk`/`policy` kinds.
- **`resource.ssh(cmd, opts)`** — one combined call on every resource: resolves a `Promise<string>` (or `Uint8Array` with `encoding:"binary"`), or an `AsyncIterable` of chunks with `{ stream: true }`. Every resource also has `delete()` (deletes itself via the group's delete handle, by `r.id`). `waitUntilReachable()` re-resolves the host **and** TCP-probes in a loop (so a just-created VM with no IP yet keeps retrying instead of failing instantly) — `sshProbe` resolves the host with no key needed (native `getSshConfig` or `sshEndpoint.hostOutputKey`). Host deps: `sshExec` / `sshStream{Start,Read,Close}` / `sshProbe` (streaming is host-buffered + polled across the RPC bridge; prelude has tiny base64/utf8 decoders since QuickJS lacks `atob`/`TextDecoder`). Config resolution mirrors interactive SSH: native `getSshConfig()` first, else `sshEndpoint.hostOutputKey` + an org SSH key's private half. Web/poller: `server-core/workflows/ssh-host.ts` (ssh2, TOFU host-key pinning). Desktop: renderer resolves config (app/system key via `ssh_key_get_private_key`/`ssh_read_system_key`), electron main runs ssh2 (`workflow_ssh_*` IPC in `electron/ssh-tunnel.ts`). NOTE: the isolate's `executionTimeout` would be a **wall-clock** deadline (`shouldInterruptAfterDeadline`) including host-RPC time. `sandbox.ts` omits that option and installs its own **pause-aware** interrupt handler: time spent in `PAUSED_METHODS` host calls (`prompt`, `ssh.exec/streamStart/streamRead/probe`) is excluded from the budget, so a desktop host-key pin dialog or a `waitUntilReachable()` poll doesn't consume run time (a runaway pure-JS loop still counts and is bounded by `DEFAULT_RUN_LIMITS.timeoutMs`, now 5 min). `resource.ssh(cmd, { skipHostKeyCheck: true })` bypasses host-key verification (server-core + desktop use a `verify(true)` verifier instead of the TOFU/interactive one).
- **Live step-debugger** (editor manual runs) — `transpile.ts` (option `instrumentLines`) injects `await __line(n)` before each top-level statement (a TS transformer that skips function/arrow/method bodies, so every injected await stays in the async `__task`). `sandbox.ts` defines `__line = (n) => __host("line", …)` when `opts.debug`, adds `"line"` to `PAUSED_METHODS`, and aborts on `opts.signal` (Stop). `host.line(n)` (platform-supplied) highlights + blocks at a breakpoint. **Client owns breakpoints/step**; `host.line` just blocks until the client says continue. UI: `DebugSession` in `ui/src/workflows/types.ts`, `WorkflowEditorView` glyph-margin breakpoints + current/paused-line decorations, `WorkflowsPanel` Resume/Step/Stop. Desktop: live via the existing host bridge (`electron/workflow-host.ts` adds `line` + a `workflow_stop` IPC → per-runToken AbortController; renderer `runWorkflowById` runs the pause loop). Web: new `workflow:*` channel on `/api/ws` (`services/workflow-ws.ts` `handleWorkflowSession`; `server.ts` switch; browser `lib/workflow-client.ts` `runDebug` opens the socket, drives breakpoints/step client-side, `window.prompt` for `infra.prompt`).
- **Created resources remember their SSH key** — `transformCreateFields` (build-host hook) returns `{ fields, sshKeyRef? }`; build-host stamps `sshKeyRef` (the org key NAME attached at create) onto the returned `ResourceInstanceLite`, and the prelude's `makeSshOps` uses it as the default `sshKey`. So `(await droplets.create({ sshPublicKey: "k" })).ssh(cmd)` authenticates without re-passing the key; `get()`/`list()` resources carry no ref and still require an explicit `{ sshKey }`.
- **Extended resource capabilities (plugin-client passthroughs)** — beyond CRUD/resolveOutput/storage/ssh, a workflow resource handle exposes: `query(sql)` (REST query engines via `executeQuery`), `kv.{list,get,set,delete}` (Redis/KV), `nosql(cmd,args)` (Firestore/Mongo/DynamoDB), `logs(opts)`/`describe()` (k8s-style), `getManifest()`/`applyManifest(m)`, `publish(msg)` (pub/sub), `metrics(range)` (`fetchMetricSeries`); plus account-level `importYaml(yaml)`. **Runtime** is permissive — the prelude adds them to every resource (`makeResourceCaps`) and `build-host.ts` implements each via `getClient` → the typed `PluginClient` method (throwing a clear error when absent), so NO per-platform wiring (web/poller/desktop all run `buildWorkflowHost`). **The dts is gated per resource type**: codegen emits a per-type interface `Resource_<plugin>_<type>` extending `WorkflowResourceBase` that includes only the supported capability methods (so a DNS record doesn't advertise `.ssh`/`.kv`). Capability flags live on `WorkflowResourceTypeInfo.capabilities` (+ plugin-level `supportsImportYaml`), computed in `workflow-runtime/capabilities.ts`: `staticResourceCapabilities(rt)` (sshEndpoint/supportsTerminal → ssh; set in each platform's base mapping) merged on the typings path (`enrichPlugin`) with `detailResourceCapabilities(client, pluginId, typeId, accountId)` — which calls the plugin's `renderDetail` on a **synthetic empty instance** of that type and reads the `DetailViewSchema` tab declarations (`logs`/`kvBrowser`/`noSqlBrowser`/`manifestEditor`/`metricsCapability`/`sqlEditor`/`publishPanel`). This is **per-type accurate** (no API call): e.g. a DO droplet → only `metrics`, a managed-database → `logs`. `query` additionally requires `client.executeQuery` (REST engines; driver-based managed-DB SQL stays out). If `renderDetail` throws on the probe, caps fall back to `{}` (under-show, which is safe since the runtime is permissive). Also fixed: `supportsDelete` defaults to `true` (read as `rt.supportsDelete !== false`, not `Boolean(...)`).
- **Sidecars in workflows (`cluster.kubernetes.pods.list()`)** — a resource type's `peerIntegrations` (managed cluster → `kubernetes` via kubeconfig; managed DB → `postgres`/`mysql`/`redis`/`mongodb` via connection string) are now reachable from workflow source as a property on the parent resource named after the **peer plugin id**. Previously they existed in the detail UI (peer tabs) and the MCP tools (`parentResourceId`) but nowhere in `infra.d.ts` — so the only way to discover the gap was to guess an accessor, get `undefined`, and guess again. Worse, `(cluster as any).pods?.() ?? []` silently yields `[]`, so a workflow built that way _runs green and does nothing_; that failure mode is what motivated this. Wiring: `WorkflowResourceTypeInfo.sidecars` (`WorkflowSidecarInfo[]`) is filled by `attachSidecarInfo` (`workflow-runtime/sidecars.ts`) on **both** paths (runtime too, not just typings — the prelude builds the accessors from it; it only reads loaded plugin defs, no API calls). Every resource RPC gained an optional trailing `SidecarRef { pluginId, parentResourceId }`, marshalled once in `host.ts` `dispatch` (a half-specified ref is treated as absent) and threaded to `ClientHostDeps.getClient(accountId, sidecar?)`, which returns the **peer** client. Cloud: `getClientForResource` moved from web's `services/plugin-clients.ts` into `server-core/src/peer-clients.ts` (the runner is shared with the poller and can't import web; web re-exports it, `buildPeerPanes` stays web-side). Desktop: `createPeerPluginClient` in `lib/plugin-client.ts` (no credential rewriters — those exist for cloud-only network paths). **Gotcha:** `electron/workflow-host.ts` bridges each host method with an explicit positional arg list, so every one of them had to grow `sidecar` — TS won't catch a dropped trailing optional (fewer params is assignable), it just silently targets the account's own client. Codegen emits `Sidecar_<pluginId>` interfaces and de-dupes `Resource_*` by interface name, since the same peer is reachable from many parents and may also have an account of its own (a duplicate `interface` is a hard error in _every_ workflow the org writes). Sidecar resources deliberately get **no** ssh/sftp/storage — all three resolve against the account's own plugin — and don't nest. Capabilities (`pod.logs()`, `pod.describe()`) come from `enrichSidecarCapabilities`, typings-path only: it lists one parent, builds the peer client, runs the same `renderDetail` probe as `enrichPlugin`, and caches **per peer plugin id** (capabilities depend on neither account nor parent, so one probe describes `kubernetes` everywhere). **It takes ALL of a plugin's parent types and ALL of its accounts in one call, and a failed probe never erases a cached success** — both properties are load-bearing, not tidiness. The probe hits a live provider (fetch the kubeconfig, build the peer client), so it fails for reasons unrelated to the plugin: rate limit, timeout, cluster mid-upgrade. The old shape called it once per parent type with `accounts[0]`, raced N concurrent probes for the same peer, and cached a failure as `caps: null` for 10 min — so `pod.logs()` vanished from `infra.d.ts` and an already-working workflow stopped type-checking with "Property 'logs' does not exist", intermittently, differing per web replica (the cache is per-process in-memory). Now: stale-but-known caps are applied before any probe, a failure only sets a 30s `failedAt` backoff, "no parent exists yet" is not cached at all (so the first cluster you create types immediately), and the grouped call means one round-trip per peer plugin regardless of how many parent types expose it. `__resetSidecarCapabilityCache()` is the test seam.
- **SFTP** (`resource.sftp.{list,get,put,mkdir,delete}`) — runs over the resource's SSH endpoint (same config resolution + key defaulting as `resource.ssh`), so it's gated wherever SSH is (`sshEndpoint`/`supportsTerminal`, plus `supportsSftpBrowser`). NOT a plugin-client passthrough — it's a platform dep (like ssh): server-core `ssh-host.ts` uses `@infrawrench/sftp-host` (`sftpList/Upload/DownloadToBuffer/Mkdir/Delete`) + `resolveResourceSshConfig` + TOFU verifier; desktop resolves config in the renderer and runs in electron main via new `workflow_sftp_*` IPC (electron `sftp.ts` gained `sftpDownloadToBuffer`). Bytes cross as base64 (prelude `b64enc`/`toBytes` encode `Uint8Array`/string for upload). Web gets it for free via the spread `buildWorkflowSshDeps`. NOT yet exposed (need SSH-style platform plumbing): SFTP file transfer, driver-based managed-DB SQL (managed Postgres/MySQL route through output-ref virtual accounts, not a direct client method), interactive k8s pod exec, and storage object writes (`uploadStorageObject` takes a browser `File`).
- **Streaming ssh + log tailing** — `resource.ssh(cmd, { stream: true })` returns an `SshStreams` object: `{ stdout, stderr }` byte streams (async-iterable + `getReader()`), and the object itself iterates stdout (back-compat). The host stream registry buffers stdout/stderr separately (`SshStreamChunkLite.stdoutBase64`/`stderrBase64`); the prelude demuxes them via a single shared pump. `infra.log(streams)` detects the `__sshStream` marker and line-buffers both channels to the run log live — stdout at level `info`, stderr at `error` (rendered red by the log panel's level→colour). Logs stream live to the editor: desktop forwards entries main→renderer via a `workflow_log` IPC event (logs are handled by the run context in main, not the bridged host); web sends `workflow:log` over the debug socket. `WorkflowsPanel` renders a `LiveLogPanel` from `DebugSession.onLog` while running.
- **SSH-key fields reference Infrawrench keys** — `generateInfraDts({ sshKeyNames })` (fetched fresh per typings request, so it reloads dynamically) types `ssh-key-picker` create fields and `SshExecOptions.sshKey` as an open union of the caller's SSH key names (`listOrgSshKeyNames` web/poller, local `ssh_keys` query desktop). At create time the host's `transformCreateFields` (build-host hook) rewrites an `ssh-key-picker` field whose value is a key name/id into the key's **public key** (providers want the raw key); a value that already looks like a public key passes through. Web/poller: `server-core/workflows/ssh-key-fields.ts` (org `sshKeys` public key). Desktop: renderer resolver derives the public key from the stored private key via the new `ssh_key_get_public_key` IPC (ssh2 `utils.parseKey`).
- **`infra.page(...)` — alerting from a workflow** — a monitoring cron needs a way to wake a human, so `page(message | spec, opts?)` + `page.clear(key)` sit on `infra` alongside `costs`. Defaults (`key: "default"`, `cooldownMinutes: 60`) are normalized in `host.ts` `dispatch` (not the prelude), so every host sees the same spec and a blank message is rejected there. Throttling is **host-side and keyed** so it survives across runs: cloud = `workflow_pages` row per (workflow, key), claimed by a single conditional upsert (`onConflictDoUpdate` + `setWhere last_paged_at <= now() - cooldown`) — that statement is what stops two poller replicas double-paging; desktop = the same table in SQLite with a plain read-then-write (single process). Cloud delivery (`server-core/workflows/paging.ts`) reuses the existing transports: `sendOneShotPage` (generalized out of `sendBudgetAlertPage`; voice is opt-in per call) + `sendPushToOrg(org, "workflowPages", …)` + `sendSlackToOrg(org, "workflowPages", …)` + `sendMsTeamsToOrg(org, "workflowPages", …)`; desktop delivery is the `show_notification` IPC the metric pinger already uses. As in twilio-pager, a claim whose transports **all** failed is rolled back so the next run retries instead of going quiet. `page` is emitted into the dts for every trigger kind (unlike `prompt`, which a cron must not have) — the whole point is unattended alerting. New push trigger `workflowPages` (+ `push_preferences.workflow_pages` column, `PushData` variant `workflow_page` deep-linking to the workflow), so web/mobile settings both grew a third toggle.
- **Global `fetch()` in a workflow — proxied from outside the cluster** — workflow code gets a WHATWG-ish `fetch(url, init)` global (NOT `infra.fetch`; a workflow that talks to an API should read like any other JS). Built in `prelude.ts` (`fetchImpl` + a small case-insensitive headers view); bodies cross the bridge base64 (`b64enc`/`b64`), so `text()`/`json()`/`bytes()`/`arrayBuffer()` are promise-returning but re-readable. A non-string/non-bytes `body` is JSON-encoded with a default `content-type`. Non-standard `timeoutMs` (30s default, 120s max) + `maxBytes` (5 MiB default, 10 MiB max) — an over-large response **fails** rather than truncating. Normalization/validation lives once in `host.ts` `dispatch` (`fetchRequest`): http/https only, method allowlist, hop-by-hop headers refused, newline-in-value refused (request splitting), 50-header cap, 2 MiB request-body cap. **Why the proxy:** the isolate runs in the `web`/`poller` pods on GKE, so an in-pod fetch would put pod-to-pod traffic and the metadata server (`169.254.169.254` → node SA credentials) one call away from any workflow, and in-pod URL validation can't close that (check and socket in the same place; DNS/redirect defeats it). Cloud host (`server-core/workflows/fetch.ts`) therefore POSTs the validated request to `@infrawrench/egress-proxy` — a Cloudflare Worker on `egress.infrawrench.com`, off-cluster and off-GCP, which re-validates (private/loopback/ULA/CGNAT literals, `.svc`/`.cluster.local`/`.internal`/bare single-label hosts) and **re-validates every redirect hop** (`redirect: "manual"` + a manual follow loop, max 5). Config is `WORKFLOW_FETCH_PROXY_URL` + `WORKFLOW_FETCH_PROXY_TOKEN`; **missing config throws instead of falling back to an in-pod fetch** — that non-fallback is the whole security property. Per-run cap `MAX_FETCHES_PER_RUN = 250` (closure in `buildWorkflowFetch`, like the cost-row cap). Desktop has no cluster to protect and blocks nothing (the LAN is the point): `electron/workflow-fetch.ts` runs Node fetch in **main** — the one host capability NOT bridged back to the renderer, since it needs nothing the renderer owns and main's fetch has no CORS.
- **`fetch` is deliberately NOT in `PAUSED_METHODS`** — and that exposed a real hole in the run budget: QuickJS consults `setInterruptHandler` on an **instruction count**, so a loop that spends its time suspended in host calls executes almost no instructions and overruns wildly (measured: `while(true) await fetch()` ran ~12s against a 300ms budget, stopping after ~235 calls regardless of the deadline). Fixed in `sandbox.ts` by refusing to _serve_ a host call once the budget is spent or the run is stopped (`env.__host` checks `opts.signal.aborted` + `elapsed() > timeoutMs` for non-paused methods before dispatching). Same loop now ends at ~340ms. This also makes Stop responsive during host waits. Covered by `fetch-sandbox.test.ts`, which runs real isolates.
- **Slack is the third transport, and the only org-wide one** — `server-core/src/slack.ts` posts alerts with `chat.postMessage` for all three triggers (`sendSlackToOrg(org, trigger, alert)`, wired into `twilio-pager.notePollOutcome`, `cost/budget-eval.ts`, and `workflows/paging.ts`; `PageResult` gained a `slack` count). Install is a real "Add to Slack" OAuth round-trip: `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` on the server, an HMAC-signed `state` (key derived from the client secret, verified with `timingSafeEqual`) binding the install to an org, and a public callback at `/api/slack/oauth/callback` — the same shape as the GitHub App setup callback, and the reason this is **cloud-only**: the desktop app has nowhere to keep a client secret, so a desktop page stays a native OS notification. Scopes are `chat:write`, `chat:write.public` (post to public channels with no invite — private ones still need `/invite`), `channels:read`, `groups:read` (the channel picker, via `conversations.list`). Storage is `slack_installations` (encrypted bot token, AAD `slack:<orgId>:botToken`, unique per (org, team), soft-deleted on disconnect so a re-install restores routing) + `slack_channels` (one row per channel with `sync_incidents`/`budget_alerts`/`workflow_pages` booleans mirroring `push_preferences`). Unlike push toggles, which are per-user, channel routing is org-wide and gated on `org:settings:write`. Alert text is escaped for mrkdwn before it reaches Slack — bodies carry raw provider error strings, and a stray `<` would otherwise eat the rest of the message.
- **Microsoft Teams is the fourth transport, and it is webhook-based on purpose** — `server-core/src/msteams.ts`, `sendMsTeamsToOrg(org, trigger, alert)`, wired into the same three call sites as Slack (`twilio-pager.notePollOutcome`, `cost/budget-eval.ts`, `workflows/paging.ts`; `PageResult` gained an `msTeams` count). **There is no "Add to Teams" OAuth flow and that is not laziness.** Posting a channel message via Graph (`POST /teams/{id}/channels/{id}/messages`) needs the _delegated_ `ChannelMessage.Send` scope — a signed-in user at send time — and the only application permission Graph accepts on that route is `Teamwork.Migrate.All`, which Microsoft restricts to data migration. Every sender here is a daemon, so the Slack shape is simply unavailable; the supported app-only path is the webhook a user creates via the channel's **Workflows** automation. Consequences worth remembering: the UI is a paste-a-URL form rather than a picker (no channel list exists to enumerate without a user token), messages arrive from the Workflows flow bot, and **there are no env vars at all** — unlike Slack, which no-ops without `SLACK_CLIENT_ID`, Teams works on every deployment including self-hosted. Storage is one flat table `msteams_webhooks` (no installations parent, since each URL stands alone): encrypted URL (AAD `msteams:<orgId>:webhookUrl`), a keyed-HMAC `url_digest` unique per (org, digest) so re-pasting a URL updates the row instead of double-delivering, plus non-secret `url_host`/`url_hint` for display, and the same `sync_incidents`/`budget_alerts`/`workflow_pages` booleans. **The URL is a bearer credential** (it carries its own `sig=`), so it is never returned by the API — the client only ever sees the hint. Because the server POSTs to a user-supplied URL, `parseWebhookUrl` enforces https + a Microsoft host allowlist (`*.api.powerautomate.com`, `*.api.powerplatform.com`, `*.logic.azure.com`, `*.flow.microsoft.com`, legacy `*.webhook.office.com`); without that this endpoint is an org-member-triggerable SSRF into the cluster. Payload is an Adaptive Card 1.4 in a `type: "message"` envelope, with alert text backslash-escaped for the card's markdown subset (same reasoning as Slack's mrkdwn escaping). One honoured retry on HTTP 429 — Microsoft throttles a webhook above 4 req/s. Route prefix is `/api/org/:orgId/msteams` (**not** `/teams` — `/team` already means org members). Legacy `*.webhook.office.com` connectors still work but Microsoft disables them May 2026; the docs steer new setups to Workflows.
- **Agent VMs use a dedicated managed SSH key** — agent provisioning fills the provider-declared `agentVm.sshKeyFieldKey` even when that field is hidden from the agent settings UI. Web creates/reuses an org SSH key named `infrawrench-agent` in `ssh_keys`; desktop creates/reuses a local app key with the same name via `ssh_key_ensure_agent_key`. The provider create call receives the raw OpenSSH public key, so VM plugins attach the key at create time instead of falling back to password access. Agent `Open` returns that key id/name, the workspace SSH tab stores only the key hint (not private key material), and the platform resource pane auto-connects with it before running the screen-backed tool command. If the direct handoff fails, the SSH quick-connect picker receives the same preferred app-key id/name so it selects `infrawrench-agent` instead of falling back to a system `~/.ssh` key.

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

**HTTP is not the only surface.** Four non-route paths reach the same capabilities and each enforces permissions its own way — when you add a capability, check all five:

1. **Chat endpoint** (`app/packages/web/src/chat/auth.ts`) — `authenticateChat` enforces `chat:read`/`chat:write` on **all three** auth paths (session cookie, WorkOS bearer, API key). It previously applied `requireScope` only to keys, so session callers reached chat on membership alone and the permission was unenforceable for the UI. `chat:read`/`chat:write` are in the member system role to preserve that behaviour; a custom role that omits them now actually blocks chat.
2. **Tool registry** (`app/packages/web/src/tools/`) — consumed by both MCP and the chat agent. Every `ToolDefinition` declares `permission: Permission | null` mirroring the equivalent HTTP route's `requirePermission`. It is enforced centrally by `authorizeToolCall` (`tools/permissions.ts`) at each dispatch site — `mcp/server.ts` and both call sites in `chat/agent.ts` — never inside a handler, so a new tool cannot forget to gate itself. `null` means "exposes no org data" (static plugin catalogs only). `src/tools/__tests__/permissions.test.ts` asserts every tool declares one and that no write/destructive tool is ungated.
3. **WebSocket gateway** (`app/packages/web/server.ts`) — `resources:execute` for every channel. The browser path gets it from `POST /ws-token`; the API-key fallback calls `requireScope` directly.
4. **Step-up routes** (`app/packages/web/src/auth/step-up.ts`) — account-takeover-adjacent `/api/profile` operations additionally require a sign-in newer than `STEP_UP_MAX_AGE_MS`, returning a 403 with `code: "reauthentication_required"`.

**API keys are bounded by their owner.** `auth/effective-permissions.ts` is the single resolver behind both the chat endpoint and the tool layer: it intersects a key's scopes with the owning user's current role permissions via `intersectPermissions` (catalog.ts). A `chat:write`-only key therefore cannot reach the tools its owner could. `authenticateApiRequest` also re-checks org membership on every call, and removing a member revokes the keys they minted in that org (`api/routes/team.ts`).

**Tables without an `organization_id`.** `dashboard_pins` and `associations` are scoped transitively through `dashboards`/`resources`. Any query against them MUST join the parent and filter on it — `/api/v1/sync/pull` previously did not, and returned every tenant's rows. `src/api/routes/__tests__/sync.test.ts` guards the joins.

Their `sync_version` bumps live in `services/sync-versions.ts` (`nextPinSyncVersion`, `nextAssociationSyncVersion`) because the usual inline `MAX(sync_version) WHERE organization_id = …` subquery can't work without that column. **Every write to either table must stamp one** — nothing did, so both sat at the default 0 and `syncVersion > lastSyncVersion` was false for any watermark a client could hold, making them invisible to `/pull` regardless of scoping.

**Deletes on both tables are hard deletes**, and both keep an unused `deletedAt` column. That is a deliberate trade, not an oversight: sync is push-only (see [Desktop cloud sync](#desktop-cloud-sync)), so no client would ever read a tombstone and one would only accumulate rows. The cost is that **deletions are invisible to a puller** — anything that adds a downward apply has to reintroduce tombstones on unpin and on association delete, and at that point the pin insert must become an upsert clearing `deletedAt`, because the unique `(dashboard_id, resource_id)` row would then survive an unpin and a re-pin would otherwise silently no-op.

Associations have a second, independent reason to stay hard-deleted: `provider_resource_id` is an FK with `ON DELETE RESTRICT`, so a tombstoned row would keep blocking a hard delete of the provider resource (`api/routes/agents.ts` does one on agent-VM teardown).

`/pull` returns `hasCredentials: boolean`, never credential ciphertext. The blob was sealed with the server's master key and unreadable by any client, so it was pure credential-shaped material on the wire — under `resources:read`, when reading an actual credential requires `secrets:read`. The one supported way to obtain a credential is `GET /accounts/:id/credentials` (org-scoped, `secrets:read`, audit-logged as `account.credentials.read`).

Desktop sync is push-only by design — see [Desktop cloud sync](#desktop-cloud-sync) for why a downward apply is neither needed nor expressible against the local schema.

`GET /api/v1/sync/status` must consider **every** table `/pull` returns. It previously reported `max(accounts, resources)` only; a client advancing its watermark to that number steps over changes in any omitted table permanently, because the counter only moves forward.

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
- **Disabled APIs are the default state, not an error condition.** GCP ships every service switched off per project, so listing a type the project has never used answers 403 (`details[].reason === "SERVICE_DISABLED"`) rather than an empty list — a Compute-only project fails ~20 of the plugin's types on every sync. `api-error.ts` rewrites those into one actionable sentence naming the API and its console link; `gcpApiError` (listing paths) and `formatGcpError` (create/action paths, 20 call sites) both route through it. **`gcpApiError` also attaches the numeric `status` to the Error object** — hosts classify failures for backoff, and reading a status back out of prose is unreliable: a bare `/5\d\d/` over the message matched `503` inside the project id `consummate-atom-503516-h4`, so every permanent 403 read as a transient 5xx and pinned the account at maximum backoff with `poll_failure_count` climbing into the hundreds while resources kept syncing fine. New plugins should attach `status` the same way; the poller's `error-classification.ts` prefers it and only falls back to word-boundary matching on the text.
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

**Beta / Private Beta services** (added on `@neondatabase/api-client` 2.7.3; 2.7.1 had none of these endpoints):

- Resource types: `neon-snapshot`, `neon-bucket`, `neon-credential`, `neon-function`, `neon-ai-gateway`, `neon-auth`, `neon-auth-oauth-provider`, `neon-auth-domain`. All live in `src/services/` (storage, snapshots, functions, auth) rather than `client.ts`, following the DigitalOcean split.
- **Access stages differ and this matters**: snapshots / Data API / Neon Auth are open Beta (any API key). Object Storage, Functions, and AI Gateway are **Private Beta gated per-org** behind a `PlatformBranchableStorage` entitlement and limited regions — non-entitled orgs get **404**. `isServiceUnavailable()` (`services/common.ts`) treats 403/404/501 as "not available on this branch" and skips it; anything else propagates. Don't "fix" a silent empty list by swallowing all errors.
- **The SDK's generated types lie for three endpoints.** `listSnapshots` and `createSnapshot` are typed `OperationsResponse`, and `listProjectBranchFunctions` is typed as the single `{function}` response. The published OpenAPI spec (`https://neon.com/api_spec/release/v2.json`) documents them as `{snapshots}`, `{snapshot, operations}`, and `{functions}`. The services re-assert the documented shapes via local interfaces + `as unknown as`. Recheck on the next SDK bump.
- **Bucket names are unique per branch, not per account.** The host's storage browser passes only a bucket name (`listStorageObjects(bucket, prefix)`), so `BucketLocator` caches bucketName → branch and re-lists to warm a cold cache. Two branches with the same bucket name is a known ambiguity (same flaw as Scaleway's region cache).
- Buckets use the **management API**, not `s3-storage-helpers.ts` — listing/delete go through `console.neon.tech`, and uploads through a presigned URL, so no SigV4 signing or credential minting is needed for the browser. Neon's S3 endpoint is always `force_path_style: true`.
- **Credential secrets (`api_token`, `s3_secret_access_key`) are returned only by the create call** — there is no read-back endpoint. They're attached to `resolvedOutputs` in `createResource`; `resolveOutput` throws an explanatory error instead of returning empty.
- **Functions have no JSON create** (creation is an implicit multipart zip deploy driven by `neon.ts`), so `neon-function` is list/rename/delete only. **AI Gateway has no management API at all** — one read-only GET returning `{enabled, base_url}` — hence read-only. **Neon Auth has no list-users endpoint** (only create/delete/set-role), so there's no auth-user resource type.
- `deleteBranchNeonAuthTrustedDomain` requires the owning `auth_provider`, so `neon-auth-domain` carries an `authProvider` field captured at list time purely to make delete possible.
- **SDK 2.7.1 → 2.7.3 was a breaking change**: `deleteProjectBranch(projectId, branchId)` became `deleteProjectBranch({projectId, branchId})`. Only `plugin-neon` depends on this SDK.

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

`sessionMiddleware` also puts the WorkOS `sid` on the context as `session.sessionId` (from `authenticate()`/`refresh()` on the cookie path, from the `sid` claim on the bearer path). That's what lets the account settings UI flag — and refuse to revoke — the session making the request.

**Do not add `audience` or `issuer` options to `verifyWorkosAccessToken`.** It looks like missing hardening and it is not:

- AuthKit access tokens carry **no `aud` claim** (`sub`, `sid`, `iss`, `org_id`, `role`, `permissions`, `exp`, `iat`). Passing `audience` to `jwtVerify` rejects every token — a total outage for MCP, mobile, desktop sync, and chat bearer auth.
- `iss` is not stable across configuration or SDK version (`https://api.workos.com/`, the same without the trailing slash, or the custom AuthKit domain when set), so pinning it is a lockout waiting to happen.
- Neither buys anything: `getJwksUrl(clientId)` resolves to `/sso/jwks/<clientId>`, a **per-client** key set, so a token minted for any other WorkOS client fails the signature check. That is the tenant isolation an `iss`/`aud` pin would be standing in for.

`WORKOS_AUTHKIT_DOMAIN` is for MCP OAuth **discovery** only — it is not a token-verification input.

`src/auth/__tests__/api-auth.test.ts` asserts both options stay absent.

### Personal account settings (`api/routes/profile.ts`)

`/api/profile/*` is user-scoped, deliberately outside the org tree: one WorkOS identity is shared across every org a user belongs to. It wraps WorkOS user management for name, password reset, TOTP factors, and active sessions, and backs **Settings → General** on web plus **Settings → Account** on mobile.

Things worth knowing before touching it:

- **Ownership is re-checked on every mutation.** `mfa.deleteFactor` and `revokeSession` take a bare id with no user binding, so each handler first lists the caller's own factors/sessions and 404s ids that aren't in that list.
- **Enrolment creates the factor immediately.** WorkOS returns the TOTP secret and a first challenge up front; the factor only becomes usable once a code verifies. `listAuthFactors` exposes no verified flag, so an abandoned enrolment is indistinguishable from a live one — the client DELETEs the factor on cancel to compensate.
- **Password changes go through a hosted reset link**, not a current-password form. `authenticateWithPassword` would fail for exactly the users who enabled MFA, and it's also how an SSO/OAuth-only account sets a first password.
- **Email changes use WorkOS's two-step flow** (`POST /user_management/users/{id}/email_change/send` then `.../confirm`): the code goes to the _new_ address and the account only moves when it comes back, so an abandoned or mistyped change can't strand anyone. These are called via `workos.post` because they postdate @workos-inc/node 8.11, which is what we pin — swap them for SDK helpers on the v10 bump (latest is 10.x; the major carries breaking session/auth changes, so it's its own piece of work).
- **`/api/auth/me` reads the email from our `users` row, not `session.email`.** The sealed cookie caches the user WorkOS returned at sign-in, so it reports the pre-change address until the session refreshes.
- Client contract (types, formatters, and `CloudFetch` helpers) lives in `client-core/src/profile.ts` so mobile shares it; `@infrawrench/ui` re-exports the types for web and desktop.

#### Account deletion (`DELETE /api/profile`, `services/account-deletion.ts`)

Exists because **App Store guideline 5.1.1(v)** requires any app that can create an account to delete one from inside the app — sign-in goes through AuthKit, whose hosted page offers sign-up, so the rule applies and a first iOS submission fails without it. Step-up guarded like the other takeover-adjacent routes.

The user row is the easy half. The hazard is the organizations hanging off it: `organization_members.user_id` **cascades**, so a naive delete walks straight past the `countOwners() <= 1` guards in `routes/team.ts` and can leave an ownerless — or memberless — org with a live Stripe subscription still charging. Nothing in the schema forbids that; there is no partial unique index requiring an owner, and no org-delete route existed before this. So every membership is classified first, by `classifyMemberships` in **`services/account-deletion-plan.ts`** — deliberately a pure function in its own module, importing nothing that touches the database, because that is the part that must not be wrong and the DB-touching module can't be imported in a unit test (`db/client.ts` throws without `DATABASE_URL` at import time). Only member → delete the org and cancel its subscription. Only owner but others present → **409 `transfer_ownership_required`** naming them; promoting another owner is already possible in Settings → Team, so it's a detour, not a dead end. Anything else → just leave.

**The step order in `deleteAccount` is load-bearing, top to bottom:** plan and refuse early → audit the orgs being _left_ (the row is org-scoped and FK-cascades, so it has to be written while the membership still exists; orgs being deleted take their audit log with them) → cancel Stripe (a failure aborts everything: deleting an org while its subscription keeps charging is the one outcome the user can't recover from, and they can cancel in Billing and retry) → **revoke every WorkOS session** → delete local rows in a transaction → delete the WorkOS user last. Two of those deserve their own line:

- **Revoking sessions before the DB delete is not politeness, it's correctness.** `sessionMiddleware` calls `provisionUser` on every authenticated request — an `insert(users).onConflictDoNothing()` (`auth-middleware.ts:196`) — so any request in flight after the delete silently re-creates the row. Cutting the sessions closes the window; deleting the WorkOS user closes it for good.
- **WorkOS last, not first.** If WorkOS deletion is what fails, the data is already gone and the user can sign in again (getting a fresh empty account) and retry. The reverse order fails into "can't sign in, data still here", which needs an operator. The `deleteUser` call is therefore logged-and-swallowed rather than fatal.

This is also **the first `db.transaction` in the codebase** — `grep db.transaction` had zero hits before it. `chat_conversations.user_id` became **nullable + `set null`** (migration `0037`) in the same change: it used to cascade, which took unreported `chat_usage` rows with it, so an account deleted inside the Stripe reporting window silently cost the org its charge. Every read scopes conversations by `userId === auth.userId`, so a null-owned row matches nobody and the history stops being reachable — which is the intent — while the usage rows underneath survive to be billed. The dual-source owner rule (`roles.systemKey` wins, legacy `organization_members.role` text column is the fallback) moved to `services/org-roles.ts` as `isOwnerRole`; `team.ts` had it inline twice and now calls it.

**Desktop has no account surface at all** — no settings route, no `/api/profile` call, and no sign-out — so deletion lives on web and mobile only. Adding it there means building a settings surface and a token-clearing IPC first.

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

- **Multi-instance safe (competing consumers)** — run any number of replicas against the same DB; no shard config. Each tick atomically **claims** work via a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` (`src/claim.ts`): concurrent instances skip each other's locked rows, so a due row is only ever handed to one claimer. The claim writes a **lease** into the row's own due column — `next_poll_at = now() + 5min` for accounts, `next_run_at = now() + 10min` for workflows — so **no schema change** was needed; the normal completion path overwrites the lease with the real schedule, and if an instance dies mid-work the row simply comes due again at lease expiry. Two intentional consequences: an account whose poll _throws_ retries at lease expiry (~5 min) instead of hot-looping every tick, and a workflow whose true-next reschedule write fails re-fires at lease expiry instead of duplicating on the next tick (both were pre-existing failure modes).
- Tick every 15s (`src/loop.ts`), claiming due accounts (`deletedAt IS NULL AND (next_poll_at IS NULL OR next_poll_at <= now())`, ordered `last_polled_at NULLS FIRST`), limit = concurrency (default 8). Env overrides per replica: `POLLER_TICK_MS`, `POLLER_CONCURRENCY`.
- Token buckets stay in-process-memory and that's still correct: they're keyed `(pluginId, accountId)` and the lease guarantees an account is polled by at most one instance at a time. (A rate-limit _penalty_ learned on one instance isn't visible to another, but hard failures also persist backoff via `next_poll_at`.)
- **`github-watcher` is multi-instance safe via CAS, not leases** — it has no due-time column to lease (every tick checks every repo), so the claim is a compare-and-swap on `git_last_sha` itself: `UPDATE … SET git_last_sha = $new WHERE id = $id AND git_last_sha = $observed (or IS NULL) RETURNING id`. Zero rows back = another instance recorded the transition = skip the run, so a commit fires exactly once even with overlapping instances (e.g. rolling deploys). Caveat: N replicas still each poll GitHub every 30s per repo — safe but redundant API reads — so one replica remains the sensible steady-state; the CAS is protection, not a scale-out mechanism.
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

### Complimentary orgs (platform admin)

`organizations.complimentary` (migration `0024`) marks an org as never-billed with every paid perk: `getMonthlySpend` in `web/src/chat/billing.ts` counts it as paid (uncapped chat unless the org set its own `chat_monthly_cap_micros`), `reportUsageToStripe` skips the meter event (usage rows still recorded for internal cost tracking), `POST /billing/checkout` returns 400, and `GET /billing/status` returns `{ complimentary, subscription }`. Toggled by platform admins — emails in the `INFRAWRENCH_PLATFORM_ADMIN_EMAILS` env allowlist (`web/src/auth/platform-admin.ts`) — via `/api/admin/organizations[/{orgId}/complimentary]` and the standalone `/admin` web page. Platform admin is a deployment-operator concept, entirely separate from org roles.

---

## Desktop cloud sync

### OAuth PKCE

`desktop/electron/cloud-auth.ts` — WorkOS OAuth2 PKCE flow. Custom protocol `infrawrench://callback`. Tokens encrypted in `cloud_sync_state` SQLite table.

### Sync engine

`desktop/electron/cloud-sync.ts` — 60-second interval, **push-only by design**. Push sends rows modified since `lastPushAt`; credentials are decrypted locally, sent plaintext over TLS, and re-encrypted on the server.

There is no downward apply, and adding one is not a matter of writing upserts:

- **Cloud mode is a thin client.** `electron/cloud-data/*` proxies every read to the web API and `src/lib/ssh-dispatch.ts` routes cloud-key SSH through the WS proxy, so private keys never leave the server. There is no local mirror to refresh.
- **The local schema forbids a credential-free mirror.** `accounts.encrypted_credentials` is `NOT NULL` and `resources.account_id` is `NOT NULL REFERENCES accounts(id)`, with associations and pins hanging off resources — no account row means no resource row means nothing downstream.
- **A credential-bearing mirror has a second cost**: it would make the desktop an independent caller of provider APIs, outside the poller's per-plugin token buckets (`packages/poller/src/poll-account.ts`), which nothing coordinates.

The server's `/api/v1/sync/pull` still exists and is correct; it simply has no first-party consumer. `status: "synced", pushOnly: true` is the permanent shape of the sync-status event, not a temporary caveat.

### Desktop SQLite v3 migration

Added `cloud_sync_state` table + `cloud_id`, `sync_version`, `deleted_at` columns to synced tables.

---

## API key system

Format: `iwk_` + 32 random bytes (base64url). Stored as an HMAC digest keyed off `ENCRYPTION_MASTER_KEY` (`keyedHash`), with a plain-SHA-256 fallback for pre-migration rows that rehashes on hit and dies at `legacyHashSunsetAt`. Prefix (first 12 chars) shown for identification. Revokable, rotatable.

Authorization is scopes ∩ the owner's current role permissions, and authentication additionally requires the owner to still be a member of the key's org — see [Permissions](#permissions).

---

## OpenAPI spec

`app/packages/web/src/api/openapi/` builds an OpenAPI 3.1 document from hand-written Zod schemas plus enums sourced live from `loadPlugins()`. So `pluginId` and `typeId` path params are typed as enums of the actually-installed plugin / resource-type IDs — adding a plugin extends the spec automatically.

- `index.ts` — `buildOpenApiDocument()` orchestrates registration; `getOpenApiDocument()` caches the result for runtime serving. Auto-injects `operationId` for every op (method + path → camelCase) so generated SDKs have stable function names.
- `dynamic.ts` — calls `loadPlugins()` and emits `PluginId` / `ResourceTypeId` / `CredentialFormatId` Zod enums.
- `common.ts` — shared schemas (`Uuid`, `Email`, `IsoDateTime`, `Ok`, `ErrorResponse`, `ResourceId`, `JsonObject`). `strict()` helper wraps `z.object().strict()` so `additionalProperties: false` is the default.
- `paths/*.ts` — one file per route module (`auth.ts`, `accounts.ts`, `resources.ts`, `connection-features.ts`, etc.). Each exports a `register*Paths(ctx)` function that registers operations against `ctx.registry`.
- `public-spec.ts` — the difference between what the spec knows and what we publish. `injectInternalMarkers()` stamps `x-internal: true` on operations whose path matches `INTERNAL_PATHS` / `INTERNAL_PATH_PREFIXES`; `toPublicDocument()` returns a copy with those ops removed, the `sessionCookie` scheme removed (`UNPUBLISHED_SECURITY_SCHEMES`), and the fallout cleaned up (paths with no ops left, tags nothing references any more, component schemas no longer reachable via `$ref`). Currently internal: `/api/admin/*`, `/api/v1/webhooks/*`, `/api/v1/sync/*`, `/api/push/*`, the browser auth redirects (`/api/auth/sign-in`, `/api/auth/sign-out`, `/callback`), `ws-token`, and the org-scoped `push/*` routes.

The cookie still authenticates — dropping `sessionCookie` from the published spec is presentational: the only way to obtain one is the (internal) browser redirect flow, and while it was advertised Scalar defaulted to it and generated `Cookie:` snippets instead of `Authorization: Bearer`.

Servers: `defaultServers()` advertises `PUBLIC_BASE_URL`/`APP_URL` alone when set (prod does), else just `http://localhost:3000` — a deployment should never tell readers to call localhost. `generate:openapi` overrides with production-first + local dev, since generators take the first server as the SDK's base URL.

Runtime serving: `GET /openapi.json` returns `getPublicOpenApiDocument()` (cached), and `GET /docs` renders the Scalar reference UI over it, with `hiddenClients`/`defaultHttpClient` narrowing ~35 snippet clients to curl (default), js/fetch, node/fetch, python/requests and go/native. Both are public. `getOpenApiDocument()` is the unfiltered document; only `generate:openapi` uses it, so the committed `openapi.json` keeps internal routes (marked `x-internal`) and `sessionCookie` while the published site shows neither. When you add an internal-only route, add it to `public-spec.ts`.

Build artifact: `pnpm --filter @infrawrench/web generate:openapi` writes `app/packages/web/openapi.json`. Commit it so PR diffs show API surface changes.

When you add a new HTTP route, also register it under `paths/`. The spec validates with Redocly (`npx @redocly/cli lint openapi.json`); CI doesn't run this yet but it's a useful local sanity check.

---

## Generated client SDKs

Nine targets: `typescript`, `csharp`, `go`, `java`, `php`, `python`, `ruby`, `rust`, `swift`. All MIT, all dependency-free except Rust (no stdlib HTTP, so `reqwest` + `serde`). `app/packages/web/scripts/sdk/` turns the OpenAPI document into standalone client packages. Output goes to `<repo>/sdk/<target-id>/` — **outside** the `pnpm-workspace.yaml` globs (`app/packages/*`, `plugin-architecture/packages/*`) and gitignored, so the emitted package is never a workspace member and never resolves `workspace:*`. `/sdk` is also in `.prettierignore`. Entry points: `generate:sdk` (reads the committed `openapi.json`; `--rebuild` builds from the live plugin registry instead), and `generate:openapi`, which chains into it.

Pipeline is IR-then-target so more languages can be added without touching the front half:

- `ir.ts` — runs the doc through `toPublicDocument()` (so internal ops are gone by construction, not by a second filter that could drift), normalizes JSON Schema into the closed `TypeRef` union in `types.ts`, and derives the dotted call tree. **Names come from the URL path, not `operationId`**: static segments are namespaces and the last one names the call (`POST /accounts/{id}/sync` → `accounts.sync()`); when the path ends in a parameter there's no segment to use, so the whole static run becomes the namespace and a verb names the call (`DELETE /accounts/{id}` → `accounts.delete()`). One repair pass then handles a name two operations both want (`GET`+`PUT /accounts/{id}/credentials`) or a name that's already a child namespace (`GET /team/roles` next to `/team/roles/{id}`) — both push the op down into a namespace of that name and let a verb name it, which is why `team.roles` gets the full `list`/`create`/`update`/`delete` set. `GET` picks `list` vs `get` off the response being an array, not off pluralization. Last resort is `camelCase(operationId)`, and it warns when it fires. `orgId` is detected as the scope param and marked `defaultable` — optional at the call site, filled in from client config.
- `target.ts` / `targets/index.ts` — the `SdkTarget` contract and the registry. Adding a language = one file plus one array entry.
- `targets/typescript/runtime.ts` — the hand-written request plumbing (`APIV1Client`, `ApiTransport`, `ApiError`, `ClientOptions`). **Not imported by anything**: the generator reads it off disk and inlines it, so it's still typechecked by `pnpm typecheck` and formatted by `pnpm format`. Two tokens (`"@@BASE_URL@@"`, `"@@SCOPE_PARAM@@"`) are substituted at generation time; keep them quoted string literals so the file typechecks standalone. Everything below the `// --8<--` sentinel is what gets inlined.
- `targets/typescript/index.ts` — emits `index.ts`, compiles it with the **TypeScript compiler API** to `index.js` + `index.js.map` + `index.d.ts`, then **deletes `index.ts`**. Compiling rather than printing `.js` and `.d.ts` separately is what stops them drifting, and it typechecks the generated code as a side effect — an emitter bug fails the run instead of shipping. Compile uses `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, `declarationMap: false`, and `inlineSources` — that last one is what makes deleting the `.ts` safe, since the map then carries the source itself. Schema names that collide with globals get a `Model` suffix (`components.schemas.Error` → `ErrorModel`, since `class ApiError extends Error` needs the real one) — `TypeRef` refs carry the _spec_ name and the remap lives entirely in the target's `NameTable`.
- `package-metadata.ts` — author (Infrawrench LLC / astrid@infrawrench.com), contributors (Astrid Gealer), license, repo, homepage, keywords. Deliberately outside the targets: a future Python target's `pyproject.toml` wants the same values and they must not disagree. The npm manifest omits `repository.directory` on purpose — that field points at a package's home inside the repo, and this one is never committed.

**The generated clients are MIT, not BUSL-1.1.** A client library gets linked into other people's software, so shipping it under a source-available license with a production-use restriction would make calling the API a legal question before it's a technical one; the BUSL terms protect the service, not the wire format. This is the one place in the tree where the emitted license differs from the repository's — the generator itself stays BUSL-1.1. MIT obliges us to distribute the notice, so `LICENSE_TEXT` is written as a real `LICENSE` file (listed in both `files` and the target's `artifacts`, so a deleted one forces regeneration) and the module banner is a `/*!` block, which minifiers preserve — the whole client is one file someone may well inline.

Multipart bodies emit `form: { ...params.body }`, not `form: params.body` — an `interface` has no implicit index signature so it isn't assignable to `Record<string, unknown>`, but a fresh object literal is.

Cross-target conventions, arrived at independently by several targets and worth preserving: **enums stay open** (a `PluginId` the server adds later must decode, not throw — hence constant tables in Java/C#/PHP, an `unrecognized(String)` case in Swift, `#[serde(untagged)] Other(String)` in Rust); **`allOf` is flattened**, never expressed as inheritance/embedding (Go promotes embedded fields so a name clash marshals neither; Java records and C# records can't extend); and **optionality must survive the wire** (Go uses pointers rather than bare `omitempty`, which would silently drop `false`/`0`/`""`).

Two traps that cost real debugging: **XML manifests cannot contain `--`** anywhere in a comment, and the shared banner's `pnpm --filter …` hint trips it — both `pom.xml` and `Infrawrench.Sdk.csproj` failed to load until each grew an `xmlComment()` helper that rewrites `--filter` to pnpm's `-F` alias. And **filenames must derive from type names, not path segments**: Swift's `Profile` is both a model and a namespace, and two `Profile.swift` in one target collide at the object-file level.

Staleness: each output dir carries `.sdk-stamp.json` (`apiVersion`, `specHash`, `generator`). The trigger is the API version changing; the spec hash and a `GENERATOR_REVISION` constant are safety nets so an unbumped route or an emitter change still refreshes. **Bump `GENERATOR_REVISION` in `scripts/sdk/generate.ts` when you change any emitter**, otherwise existing outputs stay stale. The reason for each rebuild is printed. Regeneration empties the output dir but **preserves toolchain build caches** (`TOOLCHAIN_BUILD_DIRS` — `target/`, `.build/`, `bin/`, `obj/`, …): wiping `sdk/rust/target` turned every spec bump into a ~90s cold `cargo build` and raced `ENOTEMPTY` against a running cargo.

Tests: `scripts/sdk/__tests__/ir.test.ts` (vitest `include` covers `scripts/**/*.test.ts`) runs a miniature spec through the naming rules, generates a real TypeScript package into a temp dir (since `generate()` throws on a compile error, that is the guard against the emitter producing plausible-looking garbage), and then a `describe.each` over `SDK_TARGETS` asserts the cross-language contract every target owes: declared `artifacts` all exist, `LICENSE` carries the MIT text, `APIV1Client` appears, and no internal operation leaks. Assert artifact _existence_, not truthiness — Python's `py.typed` is a PEP 561 marker whose job is to be empty.

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

## Production deployment (GCP, `infra/`)

Prod web runs on a regional **GKE** cluster in `us-east4`: `web` (2 replicas, HTTP+WS behind ingress-nginx + cert-manager/LE), `poller` (2 replicas — safe via atomic claiming), `github-watcher` (1 replica — CAS makes overlap safe; more replicas just multiply GitHub API reads). Postgres is Neon, metrics ClickHouse Cloud; website/telemetry stay on CF Workers. Migrated off DOKS to spend GCP credit; the DigitalOcean stack was destroyed on 2026-07-25 and nothing remains there.

- **Ownership split**: `infra/terraform` (manually applied) owns network/cluster/Artifact Registry/namespace/secrets/helm(ingress-nginx, cert-manager); `infra/k8s` (kustomize, applied by CI) owns Deployments/Service/Ingress/ClusterIssuer; `.github/workflows/web-deploy.yml` builds all three images from `infra/docker/service.Dockerfile` (ARG-parametrized, turbo-prune based), tags them `:<commit sha>`, pushes to Artifact Registry, runs drizzle migrations against Neon from CI, then `kustomize edit set image` + `kubectl apply -k` + rollout status. Runtime env lives in one k8s secret `infrawrench-env` fed from the terraform `app_env` var (rotate: edit tfvars → apply → `rollout restart`).
- **GCP-specific bits that differ from the old DOKS stack**: node-pool autoscaling bounds are `total_min/max_node_count` (region-wide — per-zone bounds would triple the floor on a 3-zone regional cluster); nodes are private with egress through a Cloud NAT pinned to a reserved IP (**that's the address to allowlist in ClickHouse Cloud / Neon**); there is **no image pull secret** because the node service account holds `artifactregistry.reader`; CI auth is keyless Workload Identity Federation (repo variables `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `AR_REGISTRY`, `GKE_CLUSTER`, `GKE_REGION` — no GCP JSON key anywhere).
- **`app.infrawrench.com` is proxied through Cloudflare** (zone `infrawrench.com`), so visitors terminate TLS at CF's edge cert and the origin cert is not user-visible. This creates a cutover deadlock: cert-manager's HTTP-01 challenge can't be satisfied before DNS moves (LE resolves the public name to the _old_ origin), and if the zone is on Full (strict), flipping the proxied record to a cluster holding only ingress-nginx's self-signed cert yields 526s while _still_ failing the challenge. Cut over with the proxy **off**, let LE issue directly against the ingress IP, then re-enable the proxy.
- **`infra/k8s` image names are unresolvable placeholders** (`REGION-docker.pkg.dev/PROJECT_ID/infrawrench/<svc>`): the real Artifact Registry host embeds region + project id, which stay in CI variables rather than git. CI rewrites name _and_ tag via `kustomize edit set image <placeholder>=<real>:<sha>`, so `kubectl apply -k` without that rewrite fails loudly instead of silently pulling something wrong.
- **Web's server bundle previously couldn't run in prod at all**: `--packages=external` externalized `@infrawrench/server-core`, whose exports point at `.ts` source (no build). Fixed by bundling workspace deps like the poller does, keeping only native/dev-only deps external (`ssh2 cpu-features dockerode @kubernetes/client-node cloudflare @libsql/client libsql vite bufferutil utf-8-validate`).
- **esbuild externals must be direct deps** of web/poller/github-watcher (pnpm isolated resolution resolves them from the importing package's node_modules) — that's why `ssh2`/`dockerode`/`@kubernetes/client-node`/`cloudflare`/`@libsql/client` appear in all three package.jsons.
- **ssh2 is CJS with lazy getter exports**: `import { Client } from "ssh2"` fails under real node ESM when ssh2 is external (works in dev only because tsx interops). All server-side runtime imports use default-import + destructure (`import ssh2 from "ssh2"; const { Client } = ssh2`), with `type X = InstanceType<typeof X>` re-establishing the class type half. ssh2 test mocks must expose the module under `default` too. Don't reintroduce named value-imports of ssh2 in server code (desktop/electron is bundled differently and unaffected).
- The esbuild banner on all three services defines `require`, `__filename`, and `__dirname` (aliased imports to dodge bundle collisions) — bundled CJS deps probe them.
- `turbo prune --docker` does NOT copy root `tsconfig.base.json` (Dockerfile copies it explicitly) but DOES rewrite `pnpm.patchedDependencies` to drop patches outside the subtree (the app-builder-lib patch is desktop-only, so backend images are unaffected).
- Web exposes unauthenticated `GET /healthz` (raw HTTP level, dev+prod) for k8s probes and the ingress LB.
- The full Docker pipeline (prune → frozen install → turbo build → prod install → boot) is reproducible on a host without docker; all three services were boot-smoke-tested this way (web answered /healthz + SPA + API 401; poller loaded 28 plugins and issued the claim SQL).
- **Container registry `registry.infrawrench.com`**: Infrawrench/serverless-registry — our fork of cloudflare/serverless-registry adding an `ANONYMOUS_PULL` env var — deployed as Worker `infrawrench-registry-production` + R2 bucket `infrawrench-registry` on the Infrawrench Production CF account. Config + deploy/rotation instructions in `infra/registry/`. Pulls are public (GET/HEAD unauthenticated, including `/v2/_catalog` and tag lists — never push anything secret); pushes/deletes require basic auth (repo secrets `REGISTRY_USERNAME/REGISTRY_PASSWORD` = Worker secrets `USERNAME/PASSWORD`). `.github/workflows/bastion-deploy.yml` pushes `bastion-agent:<sha>` + `:latest` (linux/amd64+arm64, per-arch runners + manifest merge) on main pushes touching `app/packages/bastion-agent/**`. User-facing docs/UI pull `registry.infrawrench.com/bastion-agent:latest`.

## Mobile CI (EAS)

`.github/workflows/mobile-build.yml` runs `eas build --platform all --profile preview` on pushes to main that touch `app/packages/mobile/**`, `app/packages/client-core/**`, `plugin-architecture/packages/plugin-base/**`, `pnpm-lock.yaml`, or the workflow itself. The path filter includes the workflow file, so editing it triggers a build.

- **The `preview` profile is `distribution: internal`, which on iOS means an ad-hoc build** — it needs an Apple distribution cert and a provisioning profile listing registered device UDIDs. `EXPO_TOKEN` alone is not enough: with no iOS credentials, `--non-interactive` fails at "EAS CLI couldn't find any credentials suitable for internal distribution" _after_ the Android build has already been queued, so a red run does not mean Android didn't build.
- **`--refresh-ad-hoc-provisioning-profile` (EAS CLI ≥ 19.1.0) is what makes this work unattended.** It re-registers missing UDIDs and rebuilds the profile before each build, so a device added via `eas device:create` since the last run can still install the artifact. Without it, non-interactive builds silently ship a profile that excludes newer devices. `eas.json` pins `cli.version >= 19.1.0` so a stale local CLI fails loudly instead of ignoring the flag.
- **Secrets/variables it expects**: `EXPO_TOKEN`; `EXPO_ASC_API_KEY_BASE64` (base64 of the ASC API key `.p8` — decoded to `$RUNNER_TEMP/asc-api-key.p8` at 0600, since `EXPO_ASC_API_KEY_PATH` takes a filesystem path, not the key material); `EXPO_ASC_KEY_ID`; `EXPO_ASC_ISSUER_ID`; `APPLE_TEAM_ID` (shared with `desktop-build.yml`); and repo **variable** `APPLE_TEAM_TYPE` (`INDIVIDUAL`, `COMPANY_OR_ORGANIZATION`, or `IN_HOUSE` — not secret).
- One-time interactive setup on a workstation before CI can pass: `eas device:create` for at least one device, then `eas credentials` to let EAS generate and store the iOS distribution cert + ad-hoc profile. `--refresh-ad-hoc-provisioning-profile` refreshes an existing managed profile — it cannot mint the first one, so skipping this step fails with the same "couldn't find any credentials" message even with a valid ASC key.
- **iOS Time Sensitive notifications are an entitlement, and the failure mode is silent.** `push/dispatch.ts` sends every notification at `interruptionLevel: "time-sensitive"` so alerts break through Focus/Do Not Disturb. iOS only honours that if the app carries `com.apple.developer.usernotifications.time-sensitive`; without it the payload is still accepted and quietly downgraded to `active` — the push arrives, it just never breaks through, and nothing anywhere reports an error. It is declared in `mobile/app.config.ts` under `ios.entitlements`, and **must stay a static literal**: eas-cli syncs capabilities onto the App ID from the introspected config, so a value computed in a config modifier is invisible to it (`EXPO_NO_CAPABILITY_SYNC=1` disables the sync entirely). An app whose entitlements declare a capability its provisioning profile lacks fails the Xcode build outright, which is the loud half of this.
- **`--non-interactive` skips capability syncing entirely, so a new entitlement has to be enabled on the App ID by hand.** This is not a config error and reads like one: `SetUpTargetBuildCredentials` only syncs capabilities `if (ctx.appStore.authCtx)`, and `bestEffortAppStoreAuthenticateAsync` returns early on `if (this.nonInteractive)` — _before_ the branch that would authenticate silently with the ASC API key. Apple auth then happens further down inside `SetUpAdhocProvisioningProfile`, so CI has enough access to mint a profile but never registered the capability the profile was supposed to carry. Adding the time-sensitive entitlement failed the iOS build exactly this way ("Provisioning profile … doesn't support the Time Sensitive Notifications capability"). Dropping `--non-interactive` is not the fix — the interactive ad-hoc path prompts for device selection. **After adding any entitlement, enable the matching capability once at developer.apple.com → Identifiers → `com.infrawrench.mobile`, or run an interactive `eas build` from a workstation (there the ASC env vars authenticate without a prompt and the sync runs).** `--refresh-ad-hoc-provisioning-profile` then rebuilds the profile against the updated App ID on the next CI run.
- **Critical Alerts is wired but deliberately dark, and turning it on is a four-step rollout in a fixed order.** `critical` is the one iOS level above time-sensitive (it also overrides the ringer switch, and the user cannot silence it per app), and `push/dispatch.ts` sends it for the `workflowPages` trigger only — pages are the one trigger that means "act now". It is gated on `PUSH_CRITICAL_ALERTS=1` because shipping it early is a **regression, not a no-op**: Apple documents only the entitled behaviour, so an unentitled `critical` plausibly degrades to `active` — i.e. quieter than the time-sensitive pages get today — and, as with time-sensitive above, nothing reports an error either way. Unlike time-sensitive, `com.apple.developer.usernotifications.critical-alerts` is **not ours to grant**: it comes from a case-by-case Apple request (developer.apple.com/contact/request/notifications-critical-alerts-entitlement). Order matters because **iOS only grants the options present in an app's first authorization prompt and never re-asks** — flipping the client flag after users have answered reaches fresh installs only. So: (1) Apple approves, (2) declare the entitlement in `mobile/app.config.ts` and enable the capability on the App ID by hand (the `--non-interactive` trap above), (3) flip `CRITICAL_ALERTS` in `mobile/env.ts` so `registerForPush` asks for `allowCriticalAlerts`, (4) set `PUSH_CRITICAL_ALERTS=1` server-side. Also note Expo's push `sound` field is typed `string | null`, so the APNs critical-sound dictionary (with its volume) is not reachable through the Expo transport — the level alone is what we get.
- **`eas-build-post-install` must build mobile's workspace deps, not just `terminal.html`.** `@infrawrench/client-core` and `@infrawrench/plugin-base` resolve through `dist/`, which is gitignored, and EAS uploads a git-based archive — so those packages arrive on the build server with no built output and Metro fails in the Bundle JavaScript phase. It builds locally only because your `dist/` already exists. The hook runs `pnpm -w exec turbo build --filter='@infrawrench/mobile^...'` first, the same `^...` idiom `desktop-build.yml` uses for plugin deps.

### Releasing to the stores (`mobile-release.yml`)

**The release ritual is one number.** Bump `version` in `mobile/app.config.ts`, push to main, done. `mobile-release.yml` reads it back with `expo config --json` (evaluating the config the way eas-cli does, rather than parsing the source), skips everything if the tag `mobile-v<version>` already exists, and otherwise runs `eas build --platform all --profile production --auto-submit` and tags on success. Same idiom as `desktop-build.yml`'s `check-if-release` and `publish-sdks.yml`'s `sdk-v*` gate: the version file is the trigger, the tag is the ledger, re-runs are no-ops, and a failed run resumes rather than double-publishing. The tag is written **last** for that reason.

Notes on the shape:

- **`version` in `app.config.ts` is authoritative, not `mobile/package.json`.** It is the one that becomes `CFBundleShortVersionString` / `versionName`. The package.json version is inert, as it is for every private package in this workspace.
- **Build numbers are not part of the ritual.** `appVersionSource: "remote"` + `autoIncrement` on the production profile means EAS owns `buildNumber` and `versionCode`, so there is no release commit and two builds of one version string can't collide.
- **`--auto-submit` stops at internal testing.** It reuses the submit profile named after the build profile (`production` → `submit.production`) and lands iOS in TestFlight and Android in the Play **internal** track. Neither store's public review is triggered from CI — promoting is a human decision in the consoles. `mobile-build.yml`'s per-push `preview` builds are untouched and still the internal-distribution path.
- **eas.json submit profiles have no environment-variable interpolation** — the fields are static strings (verified against the docs; `$VAR` does not expand). So `android.serviceAccountKeyPath` names a fixed path and CI writes the key there from `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (gitignored, removed in an `if: always()` step). iOS credentials go the other way, through the `EXPO_ASC_*` / `EXPO_APPLE_TEAM_ID` env vars the preview workflow already uses.
- **Prerequisites are checked in seconds, not after a 40-minute build.** A step fails fast if `ascAppId` is still the placeholder or the Play secret is missing, because both are one-time store setup that CI cannot do for itself.
- A version bump also re-triggers `mobile-build.yml` (its path filter covers all of `mobile/**`), so a release commit costs one redundant preview build. Left as-is: the preview is cheap next to the coupling that suppressing it would add.

**What has to be done by hand, once, before the first run can succeed:**

1. ~~Create the App Store Connect app record.~~ **Done** — `com.infrawrench.mobile`, Apple ID `6795309207`, already in `submit.production.ios.ascAppId`. (That number is the app's public App Store id, not a secret; the SKU is a separate private field and is not used by EAS.) The workflow's placeholder check stays in place for a fork setting this up from scratch.
2. **Create the Play Console app and upload the first AAB manually.** Google's Publishing API refuses to touch an app that has never had a manual upload — this is the usual first-release surprise, and no amount of CI fixes it.
3. **Create a Play Console service account**, grant it release permissions, and add its JSON key as the repo secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. This is the only credential gap; the Apple side is already covered by `EXPO_ASC_API_KEY_BASE64` / `EXPO_ASC_KEY_ID` / `EXPO_ASC_ISSUER_ID` / `APPLE_TEAM_ID`.
4. **Run `eas build --profile production` once interactively per platform** from a workstation. Non-interactive CI can use credentials but cannot create them, and the same `--non-interactive` capability-sync trap documented above applies to production builds too.
5. **Store listing metadata** — screenshots, description, age rating, Apple privacy labels, Play Data Safety. The privacy policy URL exists (`website/src/pages/privacy.astro`); there is no terms page, which the Play listing usually wants.

**App Store review will also check that the app can delete an account** (guideline 5.1.1(v)) — that is what `DELETE /api/profile` and the delete-account cards on web and mobile are for; see the account-deletion note under `api/routes/profile.ts`.

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
- **Discovery:** `/.well-known/oauth-protected-resource` (RFC 9728), also served at the path-suffixed `/.well-known/oauth-protected-resource/api/mcp` (RFC 9728 §3.1 — clients derive it from the resource URL instead of reading the challenge header), and `/.well-known/oauth-authorization-server` (302 to the upstream AuthKit doc). Mounted on the Hono app and reachable at the public origin (`PUBLIC_BASE_URL`, falling back to `APP_URL`, then `x-forwarded-proto` — the raw Hono request URL is http behind the ingress, and an http `resource` gets rejected by clients).
- **AuthKit domain is mandatory:** `WORKOS_AUTHKIT_DOMAIN` must be the AuthKit origin (prod: `https://auth.infrawrench.com`). `https://api.workos.com/user_management` does **not** serve `/.well-known/oauth-authorization-server` (404), so there is no fallback — an unset value now returns 500 rather than advertising a dead server. `scopes_supported` must stay within what AuthKit grants (`openid`, `profile`, `email`, `offline_access`); advertising a made-up `mcp` scope fails the authorize call with `invalid_scope`.
- **DCR is a Dashboard toggle:** Dynamic Client Registration must be enabled in the WorkOS Dashboard under **Connect → Configuration**. When off, `POST https://auth.infrawrench.com/oauth2/register` returns `dynamic_client_registration_disabled` and the AuthKit metadata omits `registration_endpoint` entirely — clients then report "couldn't register with the sign-in service". Probe with `curl -s https://auth.infrawrench.com/.well-known/oauth-authorization-server | jq .registration_endpoint`.
- **Tools (always registered):** `list_plugins`, `list_resource_types`, `list_accounts`, `search_resources`, `list_resources`, `get_resource`, `get_resource_inputs`, `get_resource_outputs`, `get_resource_stats`, `get_resource_metrics`, `describe_resource`, `create_resource`, `delete_resource`, `invoke_action`, `get_manifest`, `apply_manifest`, the connection tools (`tools/connections.ts`), the cost/budget tools (`tools/costs.ts`: `query_costs`, `list_cost_dimension_values`, `get_cost_status`, `list_budgets`, `get_budget`, `create_budget`, `update_budget`, `delete_budget`), and the workflow tools (`tools/workflows.ts` — see the Workflows section). Mutating tools call `logAudit` with `source: "mcp"`.
- **Per-plugin create tools:** at server build time we walk `loadPlugins()` and register one `<pluginId>_create_<resourceTypeId>` tool per `supportsCreate: true` type, with a Zod schema generated from `FieldDefinition[]`. Same write path as the generic `create_resource` (incl. DB upsert + plaintext-secret encryption) — there to give clients typed, discoverable creates without round-tripping `list_resource_types` first.
- **Auth context per request:** the McpServer is built inside the request handler with `auth: { userId, organizationId, email? }`. Tool handlers close over `auth`, so each connection only sees its own org — no URL-supplied `:orgId`.
- **Org resolution (MCP-specific):** AuthKit OAuth tokens for MCP clients are not guaranteed to carry an `org_id` claim, so requiring one 401s every call. `mcp/auth.ts` uses the claim when present (still membership-checked) and otherwise falls back to `listUserOrganizations()` — the caller's own memberships, oldest first. Every rejection path logs a `[mcp-auth] rejected: …` reason; a bare 401 here is very hard to diagnose from the outside.
- **`org_id` is injected in `mcp/server.ts`, not the shared registry.** Each registry tool gets an optional `org_id` param, and `list_organizations` is registered MCP-only. This is deliberate: `tools/registry.ts` is shared with the chat agent, which knows its org from the session and must not gain a cross-org switch. Explicit `org_id` is `hasMembership`-checked before the tool runs, and is stripped from the input the tool handler sees.
- **Shared tool registry:** tool implementations now live in `app/packages/web/src/tools/` (not under `mcp/`). The MCP server adapts them via `buildMcpServer`, and the in-app chat agent (`app/packages/web/src/chat/agent.ts`) consumes the same registry. Tool definitions carry a `risk: "read" | "write" | "destructive"` tag that the chat surface uses to gate destructive calls behind UI approval — MCP exposes everything regardless.
- **Tool-layer permissions:** MCP/chat auth only proves org membership — tool handlers run without the HTTP `requirePermission` middleware. Tools guarding permission-scoped data resolve the caller's effective role permissions via `tools/permissions.ts` (`denyUnlessPermitted`, backed by `resolveEffectivePermissions`). The cost/budget tools enforce `costs:read` / `budgets:read` / `budgets:write`; the older resource/connection tools intentionally predate this and run at member level.

---

## AI chat agent (`/api/org/:orgId/chat`)

Hosted multi-provider chat (Gemini via Vertex AI, or Claude) — same tool registry as MCP (resource lifecycle, connection-layer tools, cost/budget tools). The agent loop lives entirely server-side in the web backend. **Both apps render it**: web via cookie-authenticated routes, desktop via the cloud proxy (Bearer token, cloud mode only — hidden in local-only mode). The per-resource `ChatPanel` in `@infrawrench/ui` is a separate feature.

- **Server code:** `app/packages/web/src/chat/agent.ts` (agent loop + suspend/resume), `chat/auth.ts` (session cookie OR WorkOS Bearer OR `iwk_` API key with `chat:write`), `chat/billing.ts` (per-turn `chat_usage` rows + Stripe metered usage), `chat/pricing.ts` (per-Mtok rates × markup, env-overridable). Routes: `api/routes/chat.ts`.
- **Shared UI:** `app/packages/ui/src/chat/` — `types.ts` (`ChatClient` interface, event/DTO types, `CHAT_CONVERSATIONS_CHANGED_EVENT`), `ConversationView.tsx`, `ChatListView.tsx`. Both hosts inject a `ChatClient`; the turn stream is an `AsyncIterable<ChatTurnEvent>`.
- **Web host:** `web/src/lib/chat-client.ts` (cookie fetches + SSE parse). Chat is a workspace tab on web too (`components/WebChatPanel.tsx`, same `{kind:"chat", conversationId?}` target as desktop): `syncWorkspaceRouteFromPath` maps `/chat` → list tab and `/chat/{id}` → conversation tab, and `WorkspaceTabsViewport` renders the panel, so a streaming turn survives switching tabs. The route files (`org.$orgId.chat.tsx` layout with `Outlet`, `chat.index.tsx`, `chat.$conversationId.tsx`) are `component: () => null` — they exist for URL matching only. `WebSidebar.tsx` lists recent sessions under a "Chat" section and navigates via `navigateToWorkspaceTarget`; archiving drops the matching tab (after navigating away, or the root effect re-adds it). `POST /dashboards/validate-tabs` must keep chat tabs alive across reloads — it treats the list tab as always valid and checks conversation tabs against the caller's own unarchived `chat_conversations` row.
- **Desktop host (cloud mode):** renderer `desktop/src/lib/cloud-chat.ts` (IPC-backed `ChatClient`) + `components/CloudChatPanel.tsx` (workspace tab, `{kind:"chat", conversationId?}` target) + sidebar section in `SidebarDashboards.tsx`; main `electron/cloud-data/chat.ts` (CRUD via `cloudFetch`, plus the SSE→IPC bridge: Bearer fetch of the turn stream, frames parsed in main and forwarded on `cloud_chat_stream_<streamId>` channels; abort via `cloud_chat_stream_abort`). Channels allowlisted in `preload.ts` (`INVOKE_CHANNELS` + `cloud_chat_stream_` event prefix).
- **Tool registry:** `src/tools/registry.ts` returns plain `ToolDefinition[]` (generic + connections + costs + ssh-keys + ssh-host-keys + per-plugin-create). The ssh-host-key tools (`list_trusted_ssh_hosts`/`trust_ssh_host`/`remove_ssh_host_trust`) wrap `services/ssh-host-keys.ts`; trust/remove are destructive-tier (chat approval) and `ssh_exec` appends a trust_ssh_host call template to `HostKeyTrustRequiredError` messages. The ssh-key tools (`list/create/import/delete_ssh_key`) enforce `ssh-keys:read`/`ssh-keys:write` (+`team:role:write` to delete others' keys) and never return private keys — generated keys are stored encrypted and used by id via `ssh_exec`/tunnels. Create tools for types with `agentVm.sshKeyFieldKey` (VM types) plus generic `create_resource` accept `sshKeyId`: `tools/ssh-key-lookup.ts` resolves the stored key to its public key and injects it into the type's SSH-key field (mutually exclusive with passing the raw key). Each handler accepts a `ToolAuthContext` with `source: "mcp" | "chat" | "api"` so audit rows distinguish caller. The cost/budget tools reuse `services/cost-query.ts` and `services/budgets.ts`, which are also the implementation behind the `/costs` and `/budgets` HTTP routes.
- **Destructive-action flow:** when the model emits a `tool_use` for a `risk: "destructive"` tool, the loop inserts a `chat_pending_actions` row (status `pending`), emits an SSE `pending_action` event, and ends the turn. The UI shows Approve/Reject; approve transitions to `approved` and synchronously runs the handler, writing `executed`/`errored` + result. Once every pending action for the latest assistant message is resolved, the UI hits `POST /messages {resume: true}` and the loop continues with `tool_result` blocks.
- **Sleep tool (chat-only):** `SLEEP_TOOL` in `chat/agent.ts` is appended to the provider tools list but NOT to the shared registry, so MCP never sees it. On a `sleep` tool_use the server inserts a pre-`executed` pending row ("Slept N seconds.", max 300s), emits an SSE `sleep {toolUseId, seconds}` event, and suspends the turn; the CLIENT counts down ("Sleeping N seconds…" indicator, no tool card — ConversationView filters `name === "sleep"`), then posts `{resume: true}`. `resumeIfResolved` checks `sleepingRef` so an approval landing mid-countdown doesn't double-resume.
- **Web tools (chat-only, `chat/web/`):** `web_search` + `web_fetch`, alongside the registry rather than in it, so MCP never sees them (an MCP client's host already has web access). Both are `risk: "read"` / `permission: null` — a modal per lookup would train people to click Approve without reading, and that modal is load-bearing for `delete_resource`. Each tool only appears when its dependency is configured, so the model is never offered a tool that must fail. **The schema/handler split is the shape to preserve:** `webChatToolSpecs()` (no handlers) builds the provider tool list once outside the loop, `webChatTools(ctx)` rebuilds the dispatch map per iteration because the handlers close over `assistantMessageId`, which is the billing key. `toolToProvider` takes `Omit<ToolDefinition, "handler">` for that reason.
  - **Search is a sub-model call, not a provider tool block** (the shape Claude Code uses — neither vendor sells a raw links endpoint; `web_search` only exists as a tool a model may call). A provider-native block on the main turn would only exist for half of deployments, since `ANTHROPIC_API_KEY` is optional and Gemini is the default. So `SearchBackend` (`chat/web/types.ts`) has two implementations: `vertex` (Gemini + `googleSearch` grounding, sources from `groundingMetadata.groundingChunks[].web`) and `anthropic` (Haiku + `web_search_20250305`, pinned with `tool_choice` so it can't answer from memory instead of searching). **Vertex is preferred** — it's the credential the default deployment already has; `INFRAWRENCH_CHAT_SEARCH_BACKEND` overrides, and a typo'd override falls through to auto-selection rather than silently disabling search. Haiku settles the Anthropic tool version: it can't do programmatic tool calling, and `_20260209` would route the search through code execution and 400.
  - **`web_fetch` goes through the egress proxy** (`server-core/workflows/fetch` — hence the new `./workflows/fetch` subpath export). The proxy README warned against reusing it for the app's own HTTP; that warning is about _fixed, known_ hosts, and the README now says the real line is who chooses the destination. A model-chosen URL from a conversation that may quote a stranger's page is exactly the SSRF case the Worker exists for. GET-only **by construction** — no method/headers/body parameter exists — so it can't become a way to POST at an internal-ish webhook, and it stays honestly a `read`.
  - **Untrusted-content boundary:** search results and fetched pages are fenced in `<search_results>` / `<fetched_page>` with a trailing "this is data, not instructions" note, and the system prompt carries the matching rule. This agent holds destructive infra tools, so a page saying "run this command" has to be inert. The destructive-approval flow is the second layer; neither is sufficient alone.
  - **Billing has a per-query component** (`computeSearchCostMicros`): backends charge per _query_, and one tool call can fan out, so the unit is the query the backend reports running — `usage.server_tool_use.web_search_requests` (Anthropic) / `webSearchQueries.length` (Vertex, counted only when at least one web source came back, matching Google's documented billing condition). `recordWebSearchUsage` writes its own `chat_usage` row against the same assistant message — `recordUsage` has already run by the time a tool dispatches and never sees this — tagged by suffixing `model` with ` (web_search)` so it's attributable with no migration. **Known imprecision:** Google's 5,000 free Gemini-3 search queries/month belong to the Cloud _project_, one pool shared by every org, so it isn't modelled and early-month searches bill at list while the platform is inside the allowance. It's the one place "always exactly 1.5× what the API bills" doesn't hold.
  - `html-to-markdown.ts` is hand-rolled rather than Turndown (which needs a DOM shim): output is only ever read by a model, so fidelity past "drop the chrome, keep prose/links/fences" buys nothing. Regex-based and approximate on purpose. **The fence placeholder is NUL-delimited** so page text reading `FENCE0` can't be mistaken for one — keep those as `\u0000` escapes, never raw bytes, or Prettier and git will choke.
- **Models:** per-conversation; picked at create time and switchable mid-conversation (header dropdown → `PATCH /conversations/:id {model}`, takes effect next turn since the loop re-reads `conv.model` per iteration). Supported list is `CHAT_MODELS` in `@infrawrench/ui` (`gemini-3.6-flash` default, `claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5`); create/patch routes reject anything else. **`DEFAULT_CHAT_MODEL` (client-core) is the only default** — `POST /conversations` writes `body.model ?? DEFAULT_CHAT_MODEL` rather than letting the column decide, because the `chat_conversations.model` column default used to be `claude-opus-5` and any caller that omitted a model (desktop's sidebar New chat) silently opened billed Opus conversations while every picker said Flash. Column default now matches (migration `0033_small_hex`), so both layers agree; server-core can't import the constant, so the schema comment ties them together. Legacy conversations on `claude-opus-4-8` and `claude-sonnet-4-6` keep working (still priced). Both Opus 5 and Gemini 3.6 Flash think by default: the provider accumulates `thinking` blocks into the persisted message content so the tool loop can echo them back verbatim — `ChatContentBlock` has a `thinking` variant that all renderers skip.
- **Providers (`chat/providers/`):** the agent loop is model-agnostic. `providerForModel(model)` picks by id prefix (`gemini-` → Vertex, else Anthropic); each provider implements `assertConfigured()` + `streamTurn()`, yielding delta events and one terminal `done` with `{blocks, stopReason, usage}`. **The persisted content-block shape stays Anthropic's for every provider** — Gemini converts to/from `Content[]` at its boundary — so `chat_messages.content`, the SSE contract, and all renderers stay single-shape. Adding a model = an id prefix here + a rate row in `pricing.ts`.
- **Gemini runs on Vertex AI, not the AI Studio developer API.** Vertex is a normal Cloud SKU, so Google Cloud credits and CUDs apply to it; Gemini Developer API usage is explicitly excluded from Cloud welcome/free-trial credits. Auth is ADC — no API key exists. In GKE the web pods use the `web` k8s ServiceAccount bound to the `infrawrench-prod-vertex` Google SA via Workload Identity (`infra/terraform/vertex.tf`, `roles/aiplatform.user`); locally it's `gcloud auth application-default login`. Config is `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` (default `global`), injected into `infrawrench-env` from terraform vars rather than hand-set in tfvars. Tool schemas go over as `parametersJsonSchema` (raw JSON Schema), so the same zod-derived schemas feed both providers with no second conversion.
- **Thought signatures land on `text` parts too, not just thought parts.** Verified against live Vertex: a plain "reply OK" turn came back with `thoughtsTokenCount: 143`, **no** `thought: true` part, and a `thoughtSignature` on the text part. So `ChatContentBlock.text` also carries optional `signature`/`provider`, and Gemini replays it — otherwise reasoning context silently dies between turns. When consecutive text parts coalesce into one block, last signature wins.
- **Cross-provider history is sanitized both ways.** Because the model is switchable mid-thread, history routinely mixes providers, and a thought signature is only valid to the provider that minted it. `ChatContentBlock.text`/`thinking`/`tool_use` carry an optional `provider` tag (absent = `anthropic`, so pre-existing rows are correct). `sanitizeForAnthropic` drops foreign `thinking` blocks and strips the Gemini-only `signature`/`provider` fields off `text` and `tool_use`; `toGeminiContents` only replays signatures tagged `gemini`. **`tool_use` blocks are never dropped** — that would orphan the paired `tool_result` and make the request invalid.
- **Pricing:** per-model provider list rates in `chat/pricing.ts` (Gemini 3.6 Flash $1.50/$7.50 per Mtok, cached input $0.15, no cache-write charge; Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5; Anthropic cache write 1.25×, cache read 0.1× of input) × a fixed 1.5 markup — always exactly 1.5× what the API bills; no env knobs (`INFRAWRENCH_CHAT_MARKUP` and `INFRAWRENCH_CHAT_PRICE_*_PER_MTOK` are gone). Unknown models fall back to Opus rates, so **a new model without a rate row overcharges by ~3×** — add both together. Gemini usage normalization: `inputTokens = promptTokenCount − cachedContentTokenCount` (Gemini's prompt count includes cached tokens, Anthropic's doesn't) and `outputTokens = candidatesTokenCount + thoughtsTokenCount` (reasoning bills at the output rate). Each turn's tokens are persisted as `chat_usage(cost_micros)`; if `INFRAWRENCH_STRIPE_CHAT_METER_EVENT` is set we also push a Stripe meter event keyed by customer.
- **Monthly cap:** `organizations.chat_monthly_cap_micros`. Checked at the start of each turn; cap reached → `spend_blocked` SSE event (carries `freeTier`), user message persisted but no model call. Orgs without an active/past_due subscription get a $5/month free-tier cap (`FREE_TIER_CAP_MICROS` in `chat/billing.ts`); a configured org cap below $5 still wins.
- **Tool schemas:** `toolToProvider` converts Zod → JSON Schema once, with zod-to-json-schema's default draft-07 target (`$refStrategy: "none"`); each provider re-wraps that same schema. Never use `target: "openApi3"` — OpenAPI 3.0 emits boolean `exclusiveMinimum`/`nullable`, which Anthropic rejects ("JSON schema is invalid. It must match JSON Schema draft 2020-12").
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

- **`peerIntegrations`** — instantiate another plugin from this resource's outputs and render its panes as extra tabs. Managed-Kubernetes resources declare a `kubernetes` peer via the `kubeconfig` output. Managed-DB resources declare a `postgres` / `mysql` / `mssql` / `redis` / `mongodb` peer via a `connectionString` output, engine-gated with `showWhen: { fieldKey: "engine", equals: "..." }`. Mark big-blob outputs (kubeconfig YAML) `hidden: true` so they don't clutter the outputs panel but remain resolvable. MCP/chat reach sidecars via `list_resource_sidecars` + `parentResourceId` on the resource tools; `getClientForResource` resolves the parent's type from the synced `resources` row or, when unsynced, by live-probing the parent plugin's peer-declaring types.
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
- **EventBridge rule:** dim is `RuleName`; rules on a custom bus publish with an additional `EventBusName` dimension — CloudWatch matches dimension sets exactly, so add it only when the bus isn't `default`.
- **Scaleway Cockpit:** series have **no `scaleway_` prefix** and are keyed by `resource_id` (UUID) for instances but **`resource_name`** (the display name) for Kapsule clusters — verified against Scaleway's own preconfigured alert rules. Kapsule pushes only control-plane gauges (`kubernetes_cluster_k8s_shoot_*`) to the Scaleway data source by default; node/pod metrics require a user-installed Helm chart into a _custom_ data source, so don't query them.
- **OVH:** the only Public Cloud metrics API is managed databases (`GET .../database/{engine}/{clusterId}/metric[/{name}]`, fixed `period` enum `lastHour…lastYear`, per-host `dataPoints` with epoch-second timestamps). The old `/instance/{id}/monitoring` endpoint was removed from the OVH API entirely (404s, absent from the schema) — instance metrics cannot be implemented.

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

- `sandbox.ts` — `runWorkflow({source, host, interactive, limits?, onLog?})`. Uses `loadAsyncQuickJs(@jitl/quickjs-ng-wasmfile-release-asyncify)` (the **async/asyncify** WASM build is required so guest code can `await __host(...)`). Pure WASM → identical in Electron + Node, no native rebuild; hard `memoryLimit` (bytes) + `executionTimeout` (ms) + `maxStackSize` (bytes). **Bundling gotcha:** the `wasmfile` variant's emscripten loader reads `emscripten-module.wasm` from `__dirname` at runtime; Rollup doesn't copy it. The desktop main build (`electron.vite.config.ts` → `copyQuickJsWasm` plugin) emits it to `out/main/chunks/emscripten-module.wasm` (next to the bundled chunk); the three esbuild-bundled services (web, poller, github-watcher) copy it into their `dist/` via `workflow-runtime/scripts/copy-wasm.mjs`, appended to each `build` script — any NEW service that bundles the sandbox must do the same. Without it, runs fail with `Aborted(ENOENT: ... emscripten-module.wasm)`. The guest program is assembled as: `import {__host,__accountsTree} from "env"` + the prelude + the user's transpiled code as a default-exported async IIFE. `runSandboxed(({evalCode})=>evalCode(program), {env, allowFetch:false, allowFs:false, ...limits})` returns `{ok:true,data}|{ok:false,error}`.
- `host.ts` — `WorkflowHost` interface (platform implements: listPlugins, listResources/getResource/resolveOutput, create/update/deleteResource, listStorageObjects/readStorageObject, prompt, getMetric/setMetric) + `dispatch(host, ctx, method, args)` — the single RPC router. `prompt` throws when `ctx.interactive` is false.
- `prelude.ts` — `PRELUDE`: JS injected into the isolate that builds `globalThis.infra` (`infra.accounts[plugin].getByName/getById/list()` → an account handle with **one grouped accessor per resource type** `account.<group>.{list(), get(id), create/update/delete(...)}` where `<group>` = `camel(pluralDisplayName)` (e.g. `droplets`, `r2Buckets`); create/update/delete are present only when the type's `supports*` flag is set (read-only types get list+get) — plus `.resolveOutput`; `infra.prompt`, `infra.metrics`, `infra.output`, `infra.log`). There is no `.resources` map, `.storage` namespace, or generic `.call` — all removed. **Storage** is folded into the resource: storage-capable types (`rt.storage`) return resources mixed with `{ list(prefix?), get(key) }` bound to that bucket (bucket name = `externalId` ⟶ fallback to id's last segment), typed as `StorageResource extends WorkflowResource`. Group/storage names come from `pascal`/`camel(displayName/pluralDisplayName)` which **must stay byte-identical to codegen's `pascalCase`/`camelCase`** so runtime names match the generated `.d.ts`. on top of the single async `__host(method, argsJson)` RPC + `__accountsTree` + `__metrics`. Keeping the object graph in pure JS (not marshalled across the WASM boundary) is what makes it robust + trivially typeable. **Metrics** are a `Proxy` over the `__metrics` snapshot: `infra.metrics.<key>` reads are synchronous (property getters can't await); writes update the snapshot + mark the key dirty, and `globalThis.__flushMetrics` (called by sandbox `buildProgram` after the user task settles, even on failure) persists final values via `metric.set`. The host gained `listMetrics(): Record<key, value>` (in `WorkflowHost`/`buildWorkflowHost` deps, implemented by all runners + the desktop bridge) which `runWorkflow` reads at start to build the snapshot.
- `transpile.ts` — esbuild `transform({loader:"ts"})`, strip-only (no typecheck; editor handles diagnostics).
- `typecheck.ts` — `typecheckWorkflow({source, dts, libDir?, limit?})` builds a real `ts.Program` over two virtual files (`infra.d.ts` + `workflow.ts`) with an in-memory `CompilerHost`, and returns `{diagnostics:[{line,column,code,category,message}], hasErrors, degraded}` positioned against the ORIGINAL source. Compiler options mirror `WorkflowEditorView`'s Monaco options **exactly** (target ESNext, `lib:["lib.es2020.d.ts"]`, `strict:false`) so headless and in-editor diagnostics agree — change one, change both. Top-level await is legalized by **appending** `export {};` (appending, not prepending, keeps every line number intact) rather than by ignoring TS 1375/1378. **Lib resolution is the gotcha:** the `lib.*.d.ts` files are data read from disk, and a bundled service can't resolve the `typescript` package at runtime, so `scripts/copy-ts-libs.mjs` copies them (es*/decorators*, no DOM — 92 files, ~600KB) into `dist/ts-libs`, appended to web's `build` script next to `copy-wasm.mjs`. Any NEW service that type-checks workflow source must do the same, or the check silently degrades to syntax-only (`degraded: true`, which every caller must surface). Candidate order: `INFRAWRENCH_TS_LIB_DIR` → `<module dir>/ts-libs` → `require.resolve("typescript")` → `ts.getDefaultLibFilePath`; a candidate only counts if it actually holds `lib.es2020.d.ts`.
- `codegen.ts` — `generateInfraDts({plugins, metrics, interactive})` emits the `infra.d.ts` whose shape **mirrors the prelude**, specialized with real account names (string-literal `getByName` union), per-plugin resource handles, and the workflow's declared metrics as **typed properties** on `InfraMetrics` (`runCount: number | null`, etc.; an index signature when none are declared). `prompt` typed `never` for non-interactive.
- `build-host.ts` — `buildWorkflowHost(deps)` maps plugin-base `PluginClient` methods to the host ops; platforms supply `{listPlugins, getClient, readStorageObject, getMetric, setMetric, prompt}`.

**DB** — server-core `src/db/workflow-schema.ts` (re-exported from `db/schema.ts`): `workflows` (organizationId, source, `trigger` jsonb, `metricDefs` jsonb, enabled, `webhookToken`, `nextRunAt`, lastRunAt, syncVersion, deletedAt), `workflowRuns` (status/triggerSource/logs/output/error/timings), `workflowMetrics` (key/label/type/unit/value, unique on (workflowId,key)), `workflowPages` (per-(workflowId,key) `infra.page` cooldown row: `lastPagedAt`/`lastMessage`, unique on (workflowId,key) — migration `0031_warm_kree.sql`, which also adds `push_preferences.workflow_pages`), and `dashboardWorkflowPins` (organizationId, dashboardId→dashboards, workflowId→workflows, gridX, unique on (dashboardId,workflowId)) — pins a workflow's metrics onto a dashboard. Migrations `web/src/db/migrations/0017_workflows.sql` + `0018_young_wolfpack.sql` (drizzle-kit generated; defined in workflow-schema.ts since it FKs both `dashboards` and `workflows`). Desktop SQLite mirror appended to `desktop/src/db/schema.ts` `MIGRATIONS` (`WORKFLOWS_MIGRATION` + `DASHBOARD_WORKFLOW_PINS_MIGRATION`).

**Web** — routes `web/src/api/routes/workflows.ts` (transport only; org-scoped CRUD + `GET /:id/typings` + `POST /:id/check` + `POST /:id/run` + runs/metrics; currently reuses `dashboards:read/write` perms — dedicated `workflows:*` is a TODO) over **`web/src/services/workflows.ts`**, which owns the CRUD, trigger validation/normalization, `generateWorkflowTypings`, and `checkWorkflowSource`. The tool registry drives that same module (mirrors how `services/budgets.ts` backs both the `/budgets` routes and the cost tools), so the two surfaces can't drift. Public git webhook `routes/workflows-webhook.ts` (`POST /api/workflows/git/:token`, matched by `webhookToken`, branch-filtered on `ref`). `services/workflow-host.ts` (`buildOrgWorkflowHost`, `listOrgPlugins`) + `services/workflow-runner.ts` (delegates non-interactive runs to the shared server-core runner). Browser transport `web/src/lib/workflow-client.ts`.

**Shared server-core runner** — `server-core/src/workflows/runner.ts` (`@infrawrench/server-core/workflows/runner`) `runOrgWorkflow({organizationId, workflowId, triggerSource})`: builds the host via its own account-client factory (decrypt → getPlugin → host services → createClient), runs non-interactive, persists the run. Used by both the web manual route and the poller.

**Poller** — `poller/src/loop.ts` runs a cron pass each tick: due `workflows` (enabled, `nextRunAt <= now`) → `runOrgWorkflow(..., "cron")` → recompute `nextRunAt` via `cron-parser` from `trigger.expression`.

**Git triggers (GitHub App + watcher)** — git triggers are web/proxy-only (desktop hides the Git option: `WorkflowsPanel`/`TriggerEditor` take `gitTriggers`, off for the local client). Auth is a **GitHub App** (`server-core/src/github/app.ts`, env `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_SLUG`): RS256 app JWT (hand-rolled via `node:crypto`) → per-installation tokens (cached) → list repos / read branch head SHA; `signInstallState`/`verifyInstallState` (HMAC keyed off the private key) bind an install to an org. Web routes `web/src/api/routes/github.ts`: org-scoped `/github/status|install-url|repos` + `DELETE /github/installations/:id`, and a public `/api/github/setup` callback that records the `github_installations` row (org ⟶ installationId). The git trigger jsonb stores `{repo, branch, installationId}`; `WebWorkflowsPanel` loads status/repos and wires the picker. The new **`github-watcher`** service (`app/packages/github-watcher`, mirrors poller's build/start) polls every 30s: enabled git-trigger workflows → `getBranchHeadSha` → if changed vs `workflows.gitLastSha`, `runOrgWorkflow(...,'git')` (first-sight records the SHA without running). DB: `githubInstallations` + `workflows.gitLastSha` (migration `0019`). The old token webhook (`/api/workflows/git/:token`) still exists for non-App providers.

**Desktop local cron** — `desktop/src/lib/cron-runner.ts` (`startCronRunner`, started in `__root` alongside the metric pinger) is the renderer-side equivalent for local workflows: every 30s it finds enabled cron workflows, runs the due ones via `runWorkflowById(id, {interactive:false, triggerSource:"cron"})` (extracted from the desktop workflow client), and reschedules `next_run_at` with `cron-parser`. It reports the enabled-cron count via `set_crons_active`; main's `hasBackgroundWork()` (pings **or** crons) keeps the window hidden-not-quit on close so schedules keep firing in the background (can't fire while fully quit). Workflow create/update/delete dispatch `WORKFLOWS_CHANGED_EVENT` so the runner re-syncs promptly (and a trigger change nulls `next_run_at` to force a reschedule). The cron trigger UI (`WorkflowsPanel` `TriggerEditor`) offers presets + a raw expression with a plain-English `describeCron` summary.

**UI** — `@infrawrench/ui/workflows`: `WorkflowsPanel` (list + Monaco TS editor with the generated `infra.d.ts` injected via `monaco.languages.typescript.typescriptDefaults.addExtraLib`, trigger config, **metrics-definition section**, run + logs/output, runs history), `WorkflowEditorView`, `WorkflowIcon`, and `WorkflowDashboardCard` (a pinned-workflow dashboard card: metric label/value list, last-run line, inline **Run** button). New workspace-tab kind `{kind:"workflows"}` in `ui.store.ts` (URL-routed: desktop `/workflows`, web `/org/$orgId/workflows`); both web (`WebWorkspaceTabsViewport` + `WebSidebar`) and desktop (`WorkspaceTabsViewport` + `Sidebar` + `lib/workflow-client.ts` over `electronAPI`, with `infra.prompt` round-tripped via the `workflow-prompt` event / `workflow_prompt_response` channel) render it.

**Pin a workflow to a dashboard** — sidebars list individual workflows as `DraggableSidebarWorkflow` items (drag data `{ workflow: DraggableWorkflow }`); `DndShell.onPinWorkflowToDashboard` fires when one is dropped on a dashboard (sidebar tab or surface). Web: `POST /api/org/:orgId/dashboards/workflow-pin|workflow-unpin`, and `loadWorkflowPins` enriches the dashboard GET/`/default/full` responses with `workflowPins` (name + declared metrics' current values + last-run status, all DB-only). Desktop: local-only (`pinWorkflow`/`unpinWorkflow` in `lib/pins.ts`, `dashboard_workflow_pins` table); the `WorkflowPinCard` loads its own metrics from SQLite and runs via the local workflow client. Cloud-org desktop mode shows no workflow drag source (local workflows can't pin to cloud dashboards) and the root drop handler toasts a "switch to Local" hint.

**Budget triggers (cloud-only)** — `{kind:"budget", budgetId, percent?, metric?}` ("when budget A goes over X% of its monthly amount, measured against month-to-date `actual` spend or the month-end `forecast`"; percent defaults to 100, metric to `actual`). Evaluated by `server-core/src/workflows/budget-triggers.ts` from **inside** `evaluateBudgetsForOrg` — cost data only moves when the poller collects it, so it piggybacks on the alert pass and reuses the `budgetMonthStatus` already computed (no extra ClickHouse queries). That restructured the loop: a budget with **no** alert thresholds is still evaluated when a workflow watches it. Fire-once-per-month is a conditional `UPDATE … SET budget_last_fired_key = '<month>:<metric>:<percent>' WHERE id = ? AND budget_last_fired_key IS DISTINCT FROM ?` + `RETURNING` (migration `0030`) — no marker table; competing poller replicas race for the row and only the winner runs, and editing the threshold changes the key so it re-arms. A **null forecast** (not enough data to fit one) is skipped, not treated as zero. `runner.ts` imports are **lazy** (`await import("./runner.js")`) so the cost/budget path the web server pulls in for plain budget reads doesn't drag in the QuickJS sandbox. Budget triggers never set `nextRunAt`, so the poller's cron claim ignores them. UI: `WorkflowsPanel` takes `budgetIntegration?: {budgets, loading}` (web supplies it from `/api/org/:orgId/budgets`; desktop omits it and the Budget option stays hidden, exactly like `gitTriggers`).

**`infra.event`** — what started the run, injected as a third env string (`__event`) next to `__accountsTree`/`__metrics` and frozen in the prelude. `RunWorkflowOptions.event` / `RunOrgWorkflowOptions.event`; defaults to `{kind: triggerSource}` (a `budget` source with no event falls back to `"api"` rather than claiming a crossing it can't describe). `generateInfraDts({triggerKind})` types it: budget triggers get the full `BudgetTriggerEvent` (budgetId/budgetName/month/currency/amountCents/metric/percent/observedCents/actualCents/forecastCents), everything else `{kind: "manual"|"cron"|"git"|"api"}`. Every `generateInfraDts` call site must pass `triggerKind` alongside `interactive`.

**`infra.costs.write(rows)` — workflow-reported spend (cloud-only)** — the escape hatch for money with no provider plugin (SaaS invoice, chargeback, colo). Host op `writeCosts` (`WorkflowHost`/`ClientHostDeps`, RPC `costs.write`), implemented by `server-core/src/cost/workflow-costs.ts` `writeWorkflowCostRows`, which validates and writes straight into `cost_daily` via the existing `insertCostRows`. Desktop omits the dep → `WorkflowCapabilityError`, and `generateInfraDts({costs:false})` types `infra.costs` as `never` so the editor says so first. **The safety-critical bit:** `cost_daily`'s frozen ORDER BY does NOT include `plugin_id`, so a workflow row attributed to a real `accountId` could otherwise collide with a poller-collected row for the same day/service and silently replace it. Every workflow row therefore gets a reserved `infrawrench:workflow: <workflowId>` tag, which changes `tags_hash` and guarantees a disjoint key space — while re-runs still replace the workflow's OWN rows (same key, newer `ingested_at`), giving free restatement semantics. `plugin_id` is always `"workflow"` (labelled "Workflow" in the provider dimension) and `account_id` defaults to `workflow:<workflowId>` (labelled `"<name> (workflow)"`); both label lookups live in `web/src/services/cost-query.ts listCostDimensionValues`, with raw-value fallbacks so deleted workflows keep their history. Caps: 1000 rows/call (the prelude chunks larger arrays), 50 000 rows/run (counter closed over in `buildOrgWorkflowHost`, so it spans calls), 32 tags/row, 256 chars/field; `infrawrench:` tag keys rejected.

**Workflow tools (MCP + chat)** — `web/src/tools/workflows.ts`: `list_workflows`, `get_workflow`, `get_workflow_typings`, `check_workflow_source`, `write_workflow`, `run_workflow` + `delete_workflow` (both destructive-tier — `run_workflow` executes arbitrary user code that can delete infra, so it gets the same chat approval as `apply_manifest`). The pairing is the point: `get_workflow_typings` returns the org's generated `infra.d.ts` as **raw text** (`okText`, not JSON — double-escaping a 100KB d.ts is wasteful), and `write_workflow` type-checks the _resulting_ workflow (new source × new trigger × new metrics, since a trigger change alone can invalidate it) and **refuses to save** on errors, returning `line:col TS#### message` diagnostics for the model to fix; `skipTypecheck` overrides. Permissions mirror the routes (`dashboards:read`/`dashboards:write`). The tool's `trigger` input is a **flat object with a `kind` enum**, not a Zod discriminated union — the same schema has to survive conversion to both Anthropic's and Gemini's JSON-Schema dialects, and the service validates the combination anyway (`validateTrigger` checks a budget trigger's `budgetId` against the org's real budgets, so a typo 404s instead of silently never firing).

**Desktop main** — `electron/workflows.ts` (IPC `workflow_list/create/update/delete/typings/run/runs/metrics` + `workflow_prompt_response`; node:sqlite via small `dbRun/dbAll/dbGet` cast helpers; manual/interactive only).

Docs: `website/src/content/docs/features/workflows.md`.

**Desktop `infra.prompt`** — Electron's `window.prompt` is a no-op, so the desktop host's `prompt` (`askUser` in `lib/workflow-client.ts`) calls `requestWorkflowPrompt` (`lib/workflow-prompt.ts`), which dispatches a `WORKFLOW_PROMPT_EVENT` and awaits a resolver. `WorkflowPromptHost` (mounted once in `__root.tsx`) renders a real modal per prompt — text/password/number/select inputs or Yes/No for `boolean` — and resolves with the typed value (or `null` on cancel). All renderer-side: the main-process sandbox already bridges `prompt` host calls back to the renderer via `workflow_host_call`.

**Still TODO**: dedicated `workflows:*` permissions; desktop↔cloud sync of workflows + workflow_metrics (syncVersion/deletedAt columns already present); desktop storage-object reads inside workflows (currently throws); web manual-run prompts (the panel's HTTP `/run` is non-interactive — interactive prompting needs the websocket path).

## Infrafile (`deploy`) — building and shipping a user's project

A **project's** build-and-deploy description, as opposed to a workflow's automation. One
TypeScript file named `Infrafile` at a repo root calls `defineInfra({ envs, plan, dockerfile,
deploy })`. Docs: `website/src/content/docs/features/infrafile.md`.

**The Infrafile is never stored.** Not in Postgres, not in SQLite. The CLI reads `./Infrafile`
from disk (walking up to the repo root); the web app fetches it from git through the existing
GitHub App (`server-core/github/app.ts` `getFileContents`). A stored copy would be a second
source of truth that silently drifts from the one in version control. What _is_ persisted is
the record of a run (`deployment_runs`) — env, commit, image, status, logs, and the **rendered**
Dockerfile, so a run is reproducible without the repo state that produced it.

**It reuses the workflow isolate, it does not fork it.** `sandbox.ts` was split: the isolate
itself (limits, the pause-aware budget, the interrupt/refusal pair) moved to
`workflow-runtime/src/isolate.ts` (`runIsolate`), and `runWorkflow` / `runInfrafile` are two
program epilogues over it. An Infrafile's stages are ordinary workflow code in functions —
`infra.*`, `fetch` and `console` behave identically.

**Stages are host RPCs, which is the whole design.** `infrafile.envs` → `plan()` →
`infrafile.plan` → `dockerfile()` → `infrafile.dockerfile` → **`infrafile.build`** → `deploy()`.
The Docker build happens _outside_ the isolate, as a long RPC. That is what lets the build read
as a straight line in the file while running on a machine the sandbox can't touch, and it is
why `infrafile.{build,push,copyTo,run}` are in `extraPausedMethods` — a five-minute image build
is not guest execution and must not consume the run's budget.

- **Bookkeeping vs capability.** Choosing the env, recording the plan, collecting notes are
  identical everywhere and live in `InfrafileRunSink` (owned by `run.ts`, reached through
  `WorkflowRunContext.infrafile`). Only real work — build, push, copyTo, run, pre-supplied
  answers — reaches the host via `InfrafileHostOps`.
- **No resource marshalling.** `JSON.stringify` already drops the methods the prelude mixes
  onto a resource, so `plan().buildOn` arrives host-side as its plain identifying fields.
  `plan()` has exactly two reserved keys, `buildOn` and `registry`; everything else is the
  author's.
- **`select(key, label, items)`** is what makes a deploy scriptable. The key is answerable by
  `--set key=value` (`host.infrafileAnswer`) so the same file runs in CI; a non-interactive run
  with no answer fails _naming the key and the options_. Values are labels, not indices, for
  that reason. It returns the original item, so picking a resource yields a usable resource.
- **`run(command, opts)`** executes inside the built image with the project mounted at
  `/workspace`. This is how a non-container target ships (a Worker, a static site): the image is
  a toolchain, not an artifact, and the deploy publishes from it. A non-zero exit fails the
  deploy (with the tail of stderr) unless `allowFailure`.

**Hosted builds are the web default (`server-core/infrafile/build-cloud.ts`).** A web deploy
with no `buildOn` builds on **Google Cloud Build**, so a paying customer needs no build host —
which is also what makes the non-container targets deployable from web at all, since a Worker
project frequently owns no VM. **It is emphatically NOT built in our cluster**: a Dockerfile's
`RUN` is arbitrary code with network, so in-cluster it would sit one `curl` from the metadata
server (`169.254.169.254` → node SA creds) and every other pod — exactly what `egress-proxy`
exists to keep workflow `fetch` away from, and a build is strictly more capable than a fetch.
Cloud Build's isolation is structural rather than a NetworkPolicy we have to keep getting right.

- **The image goes to the customer's registry** (`plan().registry`), not ours. Pushing to an
  Infrawrench registry would mean their cluster couldn't pull without us minting and rotating a
  pull credential for it.
- **The registry password goes through Secret Manager**, created per build and destroyed in a
  `finally`. A step's args are recorded in _our_ project's build history, so a `--password` flag
  would persist a customer credential in our logs.
- Source is GitHub's own tarball (`getRepoTarball`) — the pod moves bytes, no git binary and no
  credential reaches the build. A first step flattens the `owner-repo-sha/` prefix GitHub wraps
  everything in and writes the rendered Dockerfile beside the source, which is how this module
  avoids a hand-rolled tar writer.
- **`run()` is one single-step build per call**, since calls are interleaved with arbitrary JS in
  `deploy()` and can't be known upfront. Combine with `&&` when latency matters. Making it work
  across that split needed three things that are easy to miss: the built image is **always pushed
  to a staging Artifact Registry repo** (`GCP_BUILD_STAGING_REPO`) because a step's image is
  _pulled from a registry_ and an image built in one build's daemon does not exist on the next
  build's worker; the run build **reuses the same `storageSource`** so `/workspace` holds the
  project the way the local driver mounts it; and logging is **`GCS_ONLY` with a `logsBucket`** so
  the command's stdout can be read back — without it `run()` returns `""` on cloud and the same
  Infrafile silently behaves differently depending on where it was deployed from. `run()` env goes
  through Secret Manager per variable, same reasoning as the registry password. The staged image is
  deleted after the deploy; give the repo a TTL policy as the backstop.
- **Where the image runs**: a Cloud Build worker, never our cluster. It was built from a customer
  Dockerfile, so running it beside our pods is the same exposure as building it there.
- **The command is wrapped so it reports its own streams and exit code.** Cloud Build gives one
  interleaved log and a pass/fail verdict, so the step runs
  `( cmd ) >out 2>err; code=$?` and replays both around **nonce-delimited markers**. Two traps
  here, both found by running it: a **brace group is wrong** — `exit 1` inside `{ }` kills the
  whole shell and the markers never print, losing the output _and_ the code, so it must be a
  subshell; and **filtering Cloud Build's banners by regex is wrong** — it silently ate any line
  of the command's own output starting with `DONE`/`BUILD`/`PUSH`, which is why parsing is by
  marker and not by shape. A non-shell `entrypoint` can't be wrapped, so it falls back to the
  build's verdict and the whole log. `parseWrappedOutput` is exported as a test seam.
- Bounded by `HOSTED_BUILD_TIMEOUT_SECONDS` (1200) and metered into
  `deployment_runs.build_seconds` / `build_runner`. Env: `GCP_BUILD_PROJECT_ID`,
  `GCP_BUILD_STAGING_BUCKET`, `GCP_BUILD_REGION`, and `GCP_BUILD_SA_KEY` only off-GKE (on GKE the
  pod's workload identity is used). Absent config = hosted builds unavailable, reported as such.

**Three build paths, deliberately.** The CLI shells out to the local `docker` binary
(`desktop/electron/infrafile/build-local.ts`) — warm cache, no VM, and it can deploy a dirty
working tree. The web app builds over SSH on the resource `buildOn` names
(`server-core/infrafile/build-ssh.ts`), cloning the repo there because the browser has no
working tree and the GKE pods have no daemon. `buildOn: "local"` from the web means hosted, since a browser has no daemon to
offer. The accepted risk is that one Infrafile has two builders; the mitigation is that both
receive an identical, already-validated `BuildRequest` normalized in `host.ts` `dispatch`.

**Secrets never reach an argv.** `docker run -e K=secret` and `ssh 'cmd --token=…'` both land in
`ps` for every user on the box. Registry passwords go in on stdin (`--password-stdin`), `run()`
environments go through a mode-0600 `--env-file`, and the GitHub clone token is SFTP'd as a file
that a git askpass helper reads (then deleted, with the origin remote dropped so it doesn't
linger in `.git/config` — the same precaution `agent-setup.ts` takes). Env names and values are
validated in `dispatch`: a newline in a value would forge extra `KEY=value` lines in the
env-file.

**The CLI needed its own plugin host.** It runs in Electron main with no renderer, so it cannot
use the renderer's IPC-backed `createPluginClient`, and importing `src/plugins/loader.ts` drags
a static ESM value import into the CommonJS main tree (`node16` rejects it outright). Hence
`electron/infrafile/plugin-host.ts` (decrypt from SQLite + call `drivers.ts` directly) and
`electron/infrafile/plugins.ts` (the same 28 dynamic imports, CJS-safe). Keep both free of GUI
side effects.

**Interactive runs are websockets, on both surfaces.** `select` needs a live round trip, so the
web deploy is `deploy:*` frames on `/api/ws` (`services/deployment-ws.ts`), mirroring the
`workflow:*` protocol minus the line debugger. The HTTP routes cover only what answers in one
shot: `/repos`, `/envs`, `/plan`, and the run history.

**`@infrawrench/ui/workflows/prompt-bridge` is a separate tsup entry on purpose.** Moving the
desktop prompt modal into `ui` (so web stopped using `window.prompt`, which discards `kind` and
`options` and made `select` impossible in a browser) meant the desktop's _data layer_ imported
the ui barrel — dragging React and Monaco into a Node test until `cloud-api.test.ts` timed out.
Data-layer modules import the React-free entry; only components import the barrel. Same
precedent as `agents/launch-command`.

Permissions are `deployments:read` / `:plan` / `:write` — **not** the `dashboards:*` squat
workflows took. Three tiers because previewing and shipping are different risks: `read` is the
history and declared envs (inert), `plan` runs the repo's `plan()` against the org's host so it
IS code execution but builds and ships nothing, `write` actually deploys. Members get read+plan;
write is admin/owner. The split is what makes "let members look but not ship" expressible — with
`plan` folded into `read` it was an accident of the read grant rather than a decision. The
websocket frame carries `planOnly`, so `deployment-ws.ts` gates on the same split the routes do;
without that check the socket is a way around them (its upgrade only establishes
`resources:execute`).

**Surfaces**: web tab `{kind:"deployments"}` at `/org/$orgId/deployments`
(`ui/src/deployments/DeploymentsPanel.tsx`, transport `web/src/lib/deployment-client.ts`);
`infrawrench deploy` / `deploy log` / `deploy typings`; mobile is a **read-only** run list
(`mobile/src/app/org/[orgId]/deployments.tsx`) — deploying asks questions through `select`,
streams for minutes and ships production code, none of which suits a phone.

**Rollback replays, it does not rebuild.** `runInfrafile({ rollback })` skips `plan()`,
`dockerfile()` and the build, calling `deploy()` with the plan and image a past run recorded — the
point is the bytes that were known good, not a reconstruction. The Infrafile is re-read **at that
run's commit**, so `resolveInfrafile` accepts a 40-char SHA as a ref (the branches API only
resolves names). Consequence to remember: `plan` arrives as recorded JSON, so a resource in it is
plain data, not a live handle — a `deploy()` needing handles takes them from `infra.*`. Surfaces:
`POST /deployments/runs/:id/rollback`, the history's Roll back button, and
`infrawrench deploy rollback [--to-run <id>]` (`--to` was taken by the time range).

**Web deploys are paid-plan-gated; previews are not.** `services/entitlements.ts`
(`planAccess` / `requirePaidPlan`, 402 `PlanRequiredError`) is the one place that reads what a
plan grants — billing routes own _buying_ one. The gate sits in `runDeployment` rather than the
route, so the websocket path is covered too, and it is skipped for `planOnly` so a free org can
still see what a deploy would do. `past_due` counts as paid on purpose: Stripe is still retrying,
and revoking the ability to ship on a bounced card takes it away exactly when nobody is watching
for the reason. The CLI builds locally and is not gated.

**Hotlink**: `/deploy/github.com/owner/name` (`routes/deploy.$.tsx`, splat) → resolves the org
(straight through with one, asks with several) → `/org/:id/deployments?repo=`. The `repo` search
param rides the `{kind:"deployments"; repo?}` tab target into `DeploymentsPanel.initialRepo`. The
tab id deliberately ignores `repo` so a second hotlink retargets the open Deploy tab instead of
stacking one tab per repository.

**One image name across all three drivers** (`infrafileImageRef` in `infrafile/types.ts`). Each
driver used to derive its own — local from the build directory, the others from a hardcoded
`app` — so the _same_ Infrafile produced `minimal:production` from the CLI and
`app:production-a1b2c3d` from the web app, and a `deploy()` naming its image in a manifest worked
from one origin and not the other. The default tag differed too.

**A deploy holds a per-(org, env) lock**: `running` rows block a second deploy with a 409. Without
it two people shipping the same env both proceed and the infrastructure takes whichever finished
last — a race whose loser never learns it happened. Plan-only previews are exempt.

**`buildOn: "local"` is refused on web, not reinterpreted.** It names the operator's own daemon,
which has no meaning server-side; silently building elsewhere answers a different question than
the one the Infrafile asked. Omit `buildOn` for a hosted build.

**A failed deploy pages** via `pageFromExternal` (source `deployments`, key `deploy:<env>`), so a
retry loop pages once per env rather than per attempt. **Deploys report to GitHub** through
`createGithubDeployment`/`setGithubDeploymentStatus`; both are best-effort, because GitHub being
slow must never be what fails a deploy. Note `required_contexts: []` is load-bearing there —
it defaults to every check on the ref, so GitHub 409s exactly when CI is pending, i.e. when a
deploy usually starts.

**Still TODO**: tests for the two build drivers + the web wiring — both need live infrastructure,
so only the runtime is covered.

## Dashboard card order (one sequence across three tables)

Resource pins, workflow pins, and widgets each live in their own table with their own `grid_x`, but the grid drags as **one** sequence — a cost graph can sit between two resource cards. `client-core/src/dashboard-cards.ts` owns the contract (it moved out of `ui/src/dnd/card-order.ts` when mobile started rendering the same dashboards; `@infrawrench/ui` re-exports it, so web and desktop imports are unchanged): `dashboardCardId(kind, id)` (`"widget:abc"`, parsed back by `parseDashboardCardId`; ids may themselves contain colons, so it splits on the first only), `orderDashboardCards`, `moveDashboardCard`, `cardOrderIndex`. `DndShell` emits `iw:dashboard-card-reorder` with `{activeCardId, overCardId}` (was `{activeResourceId, overResourceId}`); both `DashboardView`s merge their three collections into one `DashboardCard[]`, hold it in a ref for the once-registered listener, renumber every card's `gridX` to its new index, and persist.

**No backfill migration.** Legacy dashboards have three independent 0..n sequences, so `orderDashboardCards` detects duplicate `gridX` values across kinds and falls back to the historical grouping (resources → workflows → widgets) until the first drag renumbers the dashboard into one global sequence. It converges on use. For that to hold, every insert has to take the next slot **across all three tables** — `nextGridX()` in `routes/dashboards.ts`, used by pin / workflow-pin / widget create.

`POST /dashboards/:id/reorder` takes `{cards: [{kind, id}]}` (whole grid, index → `gridX`) and still accepts the older `{resourceIds}`. Only resource pins bump `syncVersion` — they're the only card kind the desktop sync protocol carries (`routes/sync.ts`). Desktop: `reorderCloudCards` → IPC `cloud_reorder_pins`; local mode updates `dashboard_pins`/`dashboard_workflow_pins` directly (widgets are cloud-only, so they never appear in a local sequence).

**Layout gotcha:** the `SortableDashboardCard` wrapper is the grid item, so grid-positioning classes belong on it (`className="col-span-2"` for cost graphs, moved off `CostGraphCard`), and it carries `[&>*]:h-full` so the card still fills a row stretched by a taller neighbour.

## Cost graphs, budgets & alerts (cloud-only)

Spend reporting as dashboard widgets. Pipeline mirrors the metrics path: **plugin `fetchCostData` → daily poller pass → ClickHouse `cost_daily` → `/api/org/:orgId/costs|budgets` → shared recharts components**.

**Plugin contract** — `plugin-base/src/cost.ts`: `CostCapabilityDeclaration` (`dimensions: ["service"|"region"|"resource"|"tag"]`, `maxHistoryDays` default 365, `restatementDays` default 3, `periodNative` for invoice-monthly providers), `CostRow` (`{date: "YYYY-MM-DD" UTC, service?, region?, resourceId?, tags?, currency, amount, usageAmount?, usageUnit?}` — amounts are money; usage-priced plugins convert internally), `CostFetchRange` (inclusive ISO dates). Manifest gains optional `costs` (zod in `validation/manifest.schema.ts`); client gains optional `fetchCostData(accountId, range)`. Capability gating = `manifest.costs` present (same pattern as `sqlDriver`).

**Collection** — separate daily claim pass, NOT the 15s hot path (billing APIs are throttled; AWS CE bills $0.01/request). `accounts` gained `cost_last_polled_at`/`cost_next_poll_at`/`cost_poll_failure_count`/`cost_backfilled_at` (+ due-index; migration `0021`). `poller/src/claim.ts` `claimDueCostAccounts(limit, costCapablePluginIds)` (30-min lease, `NULL cost_next_poll_at` = due, plugin-id list computed at boot); `poller/src/cost-poll.ts` (24h ± 1h jitter reschedule, 1h→24h exp backoff); third defensive pass `tickCosts()` (concurrency 2) in `loop.ts`. `server-core/src/cost/collect.ts` `collectAccountCosts`: first run backfills `maxHistoryDays` in month chunks (crash-safe: ReplacingMergeTree dedupes re-fetches) then sets `costBackfilledAt`; incrementals re-fetch the trailing restatement window. `loadAccountClient` is now exported from `sync-resources.ts`. Pure date helpers in `cost/dates.ts` (db-free for tests).

**Storage** — ClickHouse `cost_daily` (in `clickhouse/migrate.ts`): ReplacingMergeTree(ingested_at), ORDER BY (org, account, day, service, region, resource_id, **tags_hash**, currency), 3-year TTL. `tags_hash` = FNV-1a-64 of canonicalized tags computed in Node (`cost-writers.ts hashTags`) because Map columns can't be key columns; **the ORDER BY is frozen once shipped**. Readers (`cost-readers.ts`): `queryCosts` (binning daily/weekly(`toStartOfWeek(day,1)`)/monthly in SQL, cumulative = app-side running sum; group-by dims incl. `tags[key]`; filters in/not_in; **FINAL**; per-currency series, never merged), `getCostDimensionValues`, `getCostTagKeys`, `getCostCoverage`. Postgres (migration `0022`): `dashboard_widgets` (kind `cost_graph|budget`, jsonb config validated at API boundary, grid coords — new table per pin kind, the `dashboardWorkflowPins` precedent), `budgets` (amountCents, currency, `filters` jsonb CostFilter[], `thresholds` jsonb `{type: actual|forecast, percent}[]`), `budget_alert_events` (**unique(budgetId, month, thresholdType, thresholdPercent)** = fire once/month; `onConflictDoNothing` + RETURNING detects fresh crossings).

**API** — permissions `costs:read`, `budgets:read`, `budgets:write` (member gets both reads). Routes: `web/src/api/routes/costs.ts` (`POST /costs/query` — top-N + "Other" fold server-side per currency, previous-period = same query shifted one span, forecast = least-squares over trailing 30 daily totals from `server-core/src/cost/forecast.ts`; `GET /costs/dimensions` incl. `dimension=tag-keys`; `GET /costs/status` per-account capability/backfill/coverage), `routes/budgets.ts` (CRUD + `/events`; list enriches with current-month actual+forecast via `budget-eval.ts budgetMonthStatus`), widget CRUD in `routes/dashboards.ts` (`POST/PATCH/DELETE /dashboards/widgets*`; `widgets[]` added to dashboard GETs). OpenAPI paths `openapi/paths/costs.ts|budgets.ts` + widget schemas in `paths/dashboards.ts`.

**Collection failures are user-visible** — a provider that needs setup (GCP without its BigQuery billing export) used to read as an account with no spend: the poller only `console.error`'d and backed off. Plugins now throw `CostSetupError` (`plugin-base/src/cost.ts`) carrying an optional `helpLink {label, url}` built from what the plugin knows about the account, so the link deep-links to the page that fixes it (GCP: `console.cloud.google.com/billing/export?project=<id>`). `server-core/src/cost/failure.ts` `describeCostFailure` normalizes any throw into `{message, helpLink}` — **matched structurally on `name === "CostSetupError"`, never `instanceof`**, because plugins bundle their own copy of plugin-base, and non-`https:` URLs are dropped so the UI only ever renders a safe anchor. Stored on `accounts` as `cost_poll_error`/`cost_poll_error_help_label`/`cost_poll_error_help_url` (migration `0029`), cleared on the next success, surfaced through `GET /costs/status` as `costPollError`. Rendered by `ui/src/cost/CostCollectionNotice.tsx` above the widgets in both `DashboardView`s, by the native `mobile/src/components/CostCollectionNotice.tsx` above the cards in `mobile/src/features/dashboard/DashboardBody.tsx`, and by `infrawrench costs` (warnings above the chart, `collectionFailures` in `--json`). The status contract (`CostAccountStatus`, `CostPollError`, `failingCostAccounts`) lives in `client-core/src/costs.ts` because mobile doesn't depend on `@infrawrench/ui`, which re-exports it.

**Budget alerts** — `server-core/src/cost/budget-eval.ts` `evaluateBudgetsForOrg` runs from the poller after each successful cost collection; fresh crossings page via `sendBudgetAlertPage` in `twilio-pager.ts` (SMS-only fan-out reusing org Twilio settings/recipients; no email — no email infra exists).

**Frontend** — shared components in `@infrawrench/ui/cost` (React) + React-free `@infrawrench/ui/cost/config` (zod config schemas + `resolveCostDateRange`; own tsup entry so the server API can import it without UI code). `ui/src/cost/`: `config.ts`, `transform.ts` (pure pivot/fold/comparison-align/forecast-splice — unit-tested), `CostGraphCard` (recharts ComposedChart: stacked/multi bar, line, stacked area, pie; forecast = dashed line keyed `__forecast__`, comparison = muted dashed `__previous__` totals line; "Other" always gray `#6b7280`; per-currency series with mixed-currency notice), `CostGraphConfigModal` + `CostFilterRows` (shared with budgets), `BudgetCard` (progress bar, threshold ticks, forecast marker, alert badge), `BudgetConfigModal`. Web `DashboardView`: "+" tile is now an `AddMenu` popover (Pin resource / Cost graph / Budget); `costApi` wraps `apiFetch`. Desktop: cloud-mode only (`activeCloudOrgId`); IPC handlers in `electron/cloud-data/costs.ts` (+ preload whitelist), renderer wrappers `src/lib/cloud-costs.ts`, same shared components; local mode never shows cost entries. Budget widget config = `{version, budgetId}` — the budget row outlives the widget.

**Provider integrations** — each plugin's `src/cost-data.ts`: AWS (Cost Explorer `GetCostAndUsage`, service+region daily, needs `ce:GetCostAndUsage` IAM, us-east-1 signing, $0.01/request). Wave 2+: Vercel (FOCUS `/v1/billing/charges`), DigitalOcean, Azure (Cost Mgmt Query API), ClickHouse Cloud (usageCost, CHC=list-$), Atlas/PlanetScale/Scaleway/OVH (invoice/consumption, periodNative), Databricks (system.billing × list_prices via SQL warehouse, list-$), Neon (consumption units × published rates), Turso (org invoices), Cloudflare (PayGo usage API — **v1 alpha**), GCP (BigQuery billing export; optional `billingExportTable` credential field, `CostSetupError` with a console deep link until configured). No API: Fly, Hetzner, Netlify, Cloudinary ($-underivable), protocol plugins.

**Mobile renders the same widgets, not a pointer to the web app.** The Dashboards tab (`org/[orgId]/index.tsx`, labelled "Home" until it became a list) is `GET /dashboards` — every dashboard, default first — and opening one pushes `dashboard/[dashboardId]`, where `mobile/src/features/dashboard/DashboardBody.tsx` renders resource pins, workflow pins, cost graphs, and budgets in `orderDashboardCards` order. That screen is a hidden tab (`href: null`), so it has no back affordance of its own: the layout draws a `headerLeft` chevron back to `/org/:orgId`, and the screen `setOptions({title})` once the fetch lands, since the title is data the layout can't know. There is no standing "Budgets" section anywhere, because a budget belongs to the dashboard it was created on — which is why `budget_breach` pushes route to **`/org/:orgId/costs`** (`pushDataToPath`) rather than the dashboard list: the Costs tab lists every budget in the org, so an alert always opens something that contains the budget it is about. Its earlier standalone version also read `status.actualCents`, a shape `GET /budgets` never returned (actual/forecast/month are top-level), so every budget rendered at $0: that class of drift is why the contract now lives in client-core rather than being re-declared per screen.

**Mobile authors dashboards too, over the same endpoints.** `New dashboard` on the list (`POST /dashboards`, then straight into the empty one — the only reason to make it is to put something on it) and an `Edit` toggle on the dashboard screen that turns `DashboardBody` editable via one optional `editing: DashboardEditing | null` prop. Everything it writes is an endpoint web already had (`/dashboards/pin`, `/unpin`, `/workflow-unpin`, `/widgets` POST/PATCH/DELETE, `/:id/reorder`, `/:id/rename`, `DELETE /:id`, `/budgets` POST/PUT) — **no server surface was added and no `API_VERSION` bump was needed**, which is the bar for mirroring a cloud feature onto mobile. `useDashboardEditing.ts` holds every mutation: failures `Alert` once and re-throw so a sheet can also show them inline, and a reorder writes the new `gridX` into the cached `DashboardData` (`cardOrderIndex`) _before_ the request — the Move up/Move down buttons replace drag-and-drop, and a card that only moves after a round trip reads as a dropped tap. Three deliberate gaps against web: no drag (arrows instead), no custom absolute date range in the graph editor (two date pickers don't fit a sheet; a config that already has one is shown and preserved), and no zod validation client-side — the schemas live in `@infrawrench/ui`, which mobile can't import, so the editors are valid by construction over the client-core enums and the API is the validator.

The sheets are `mobile/src/features/dashboard/{AddCard,CostGraph,Budget,BudgetPicker,PinResource}Sheet.tsx` over `mobile/src/components/form.tsx` (`Sheet`, `TextField`, `ChipSelect`, `ChipMultiSelect`, `ToggleChip`, `BareInput`) — **chips, not dropdowns**: a phone select is itself a modal, and nesting one inside a sheet that is already one is where native pickers go wrong. `CostFilterEditor.tsx` is the native `CostFilterRows`, over the same `GET /costs/dimensions`. What moved to client-core for this (the "second host moves it" rule): `BudgetInput`, `CostDimensionOption`, `DEFAULT_COST_GRAPH_CONFIG`, `DEFAULT_BUDGET_INPUT`, and the four label maps; `ui/src/cost/config.ts` re-exports each at its old name and now also asserts `Exact<z.infer<typeof budgetInputSchema>, BudgetInput>`, so the schema can't drift from the interface mobile builds against.

`mobile/src/features/dashboard/CostChart.tsx` draws all five chart types with `react-native-svg` — recharts is DOM-only. It shares binning, axis (`niceAxis`), and formatting with web through client-core, so a bar lands on the same tick. Two deliberate differences: a phone has no hover, so the tooltip layer is replaced by a legend carrying each series' period total (which also supplies the secondary encoding the two closest hues in our categorical order need), and only the first and last bucket are labelled on the x axis — interior labels collide at phone width. The series colours are copied from web's `chart-theme.ts` (`#60a5fa`…), _not_ re-picked: colour follows the entity across surfaces.

Docs: `website/src/content/docs/features/cloud-costs.md` (+ dashboard.md "+"-menu update, roles doc, per-plugin pages).

### The Costs panel and budget lifecycle

`CostsPanel` (`ui/src/cost/CostsPanel.tsx`) is a workspace tab beside Agents and Workflows — target kind `costs`, sidebar entry, `/costs` route on both hosts, and a read-only `costs` tab on mobile. It shows month-to-date spend (a fixed `mtd` config with only a group-by choice; anything configurable belongs on a dashboard where it can be saved) over the org's budgets.

**A budget is an org object, not a dashboard object.** It evaluates and alerts whether or not any dashboard carries a card for it, and `dashboard_widgets` points at it by `config.budgetId` with no foreign key — so a budget can outlive every card. Before this panel the only way to reach one was to find a dashboard showing it, which meant removing a card made a still-firing budget unreachable. That is what the panel fixes, and why `BudgetWithStatus.placements` exists: each row names the dashboards showing it, or says "On no dashboard".

The two directions are deliberately asymmetric, and both hosts must keep it that way:

- Removing a **card** (`DELETE /dashboards/widgets/:id`) is a display change. The budget is untouched.
- Deleting a **budget** (`softDeleteBudget`) also soft-deletes every widget pointing at it. Nothing else ever would: a widget resolves its row by `config.budgetId`, so a card left behind renders as a permanent "budget unavailable" tile that no amount of dashboard editing explains.

The dashboard `+` menu offers **New budget** and **Existing budget** for the same reason — one budget, many views. Adding a placement from either side is the same plain widget POST; `BudgetPickerModal` is shared by web and desktop so the two cannot drift.

Desktop gates the sidebar entry on `activeCloudOrgId` (spend is collected server-side, so local mode has nothing to show) and `createDesktopCostsClient` resolves the org per call rather than closing over it, matching the dashboard's cost API. Mobile omits the mutating half of `CostsClient` and `CostsPanel` renders read-only rather than showing controls that would fail on click.

## Pushing in from outside (pages & cost rows over the API)

Two endpoints let a server that isn't Infrawrench push _into_ it — the mirror image of everything else, which pulls. Both are the HTTP twin of a workflow primitive, and in both cases the workflow path was refactored to share the mechanism rather than being copied.

**Routing/auth.** `POST /api/org/:orgId/costs/rows` (`web/src/api/routes/cost-ingest.ts`) and `POST|DELETE /api/org/:orgId/pages` (`routes/pages.ts`) are registered on `api` **before** the `orgScoped` mount, exactly like chat, because `sessionMiddleware` 401s an `iwk_` key and an unattended caller has nothing else. They authenticate through `web/src/auth/org-request-auth.ts` `authenticateOrgRequest(c, pathOrgId, scope)` — session cookie / WorkOS bearer / API key, pinned to the path org, permission enforced on **every** path via `effectivePermissions` (so a key never exceeds its owner's role). That module is chat's old `chat/auth.ts` generalized; `authenticateChat` is now a four-line wrapper that only narrows the scope type. New permissions: `costs:write`, `pages:write` — deliberately **not** in the member system role.

**Cost push.** `server-core/src/cost/cost-ingest.ts` holds the validator/mapper/writer for every non-collected cost row; `cost/workflow-costs.ts` (`infra.costs.write`) and `cost/external-costs.ts` (the endpoint) are thin callers differing only in their `CostIngestSource` — plugin id, reserved tag, fallback account id, error prefix, per-call cap. The reserved tag is the whole invariant: `cost_daily`'s ORDER BY doesn't include `plugin_id` and is frozen, so pushed rows carry `infrawrench:workflow=<id>` or `infrawrench:source=<name>` to keep their key space disjoint from the pollers' and from each other. Ids live in db-free `cost/workflow-cost-ids.ts` / `cost/external-cost-ids.ts`; API rows report provider `external` and, absent an `accountId`, account `external:<source>`. `web/src/services/cost-query.ts` labels both synthetic providers in one `providerNames()` helper and now labels synthetic accounts in `labelSeries` too, not just in the dimension list.

**Paging.** `server-core/src/paging/deliver.ts` owns the protocol — resolve key/cooldown, claim, fan out over Twilio/push/Slack/Teams, roll the claim back when every transport reached nobody — behind a `PageCooldownStore` interface, because the cooldown row differs per caller but nothing else does. `workflows/paging.ts` backs it with `workflow_pages` (keyed by workflow); `paging/external-pages.ts` backs it with the new `external_pages` table (keyed by org+source+key, migration `0036`). Both claims are a single conditional upsert whose `setWhere` reads the existing row, which is what stops two replicas double-paging. API pages reuse the **`workflowPages` notification trigger** rather than adding a fourth column to three tables — the user-facing label across web/mobile is now just "Pages". Push payload gains an `api_page` variant (`client-core/src/push.ts` + `mobile/src/lib/push.ts` parse/route, deep-links to the org home).

`source` is one idea across both surfaces, so its rule lives once in `server-core/src/source-name.ts` (`isValidSourceName`, `SOURCE_NAME_HELP`).

**CLI.** `infrawrench page <message> --source …`, `infrawrench page clear`, and `infrawrench costs push --source … [--file|stdin]` (`desktop/electron/cli/commands/push.ts`) wrap both endpoints — the CLI is usually already on the box that has the news. Suppressed pages exit zero and print the retry time.

Docs: `website/src/content/docs/features/server-push.md` (+ cloud-costs, workflows, cli, push/Slack/Teams alert triggers, roles, api-keys).

## Accessibility conventions

Established during the July 2026 a11y sweep (react-doctor Accessibility findings: 78 → 0). Keep new code within these patterns:

- **Modals** — `ui/src/components/Modal.tsx` is a native `<dialog>` (free focus trap/restore, Escape via `cancel`, body scroll-lock). Always pass `ariaLabel` (the dialog's accessible name, usually the visible heading text). Backdrop click-away lives in an effect listener, not a JSX handler — keep it that way (jsx_a11y flags mouse handlers on `<dialog>`). SpotlightSearch uses the same native-dialog pattern with `backdrop:` Tailwind variants.
- **Form fields** — visible `<label>` + `htmlFor`/`id` wired via `useId()` (never hardcoded ids; components can mount twice). Composite pickers (CostFilterRows, KeyValueListEditor…) get a `<span>` caption + `role="group"`/`aria-labelledby`, with each inner control `aria-label`ed. Placeholder text is never the only name. Monaco editors are named via `options.ariaLabel`.
- **Hover-revealed controls** — every `opacity-0 group-hover:opacity-100` must also carry `group-focus-within:opacity-100` (+ `focus-visible:opacity-100` on the focusable element itself).
- **Draggable pills** — dnd-kit ref/listeners/attributes go on an inner native `<button>`; the styled wrapper stays non-interactive so pin/open/action buttons are siblings, not nested interactives (reference: `desktop/src/routes/_account-detail/-ResourcePill.tsx`).
- **Menus** — context menus and dropdowns use `role="menu"`/`menuitem`, `aria-expanded`/`aria-haspopup` on triggers, Escape-to-close with focus restore, ArrowUp/Down roving focus, and Shift+F10/ContextMenu-key as the keyboard right-click (reference: `ui/src/components/OrgSwitcher.tsx`, `desktop/src/components/SidebarAccounts.tsx`).
- **Async status** — loading/error/result-count changes go through `role="status"`/`role="alert"` (sr-only where there's no visible text); terminals mirror connection state into an sr-only status div; charts get `role="img"` + a summary `aria-label` (or `aria-hidden` when purely duplicative).
- **Theme** — `theme.css` on-surface text tokens are tuned to WCAG AA (4.5:1) against surface/raised/overlay in both schemes — recheck contrast before changing them. Global `:focus-visible` outline and a `prefers-reduced-motion` kill-switch live at the bottom of `theme.css`.

## Code conventions from the July 2026 quality sweep

Nine parallel passes over the whole repo (deduplication, shared types, dead code, circular
imports, weak types, defensive code, legacy paths, comments, godfiles). The rules below are what
those passes established or discovered; the reasoning is preserved because in several places the
obvious-looking cleanup is the wrong one.

### Where a shared type lives

There is no `shared-types` package — do not create one. Types go in exactly one of four places,
chosen by who must agree:

- **`@infrawrench/plugin-base`** — the plugin↔host contract. Zero internal dependencies; nothing
  may make it depend on an app package.
- **`@infrawrench/client-core`** — every HTTP wire shape, plus the pure client logic that operates
  on it (cost contract, dashboard cards, chat, WS frames, push payloads, account-section rules).
  Depends only on `plugin-base`. This is the home for anything the _server produces and a client
  consumes_: `web`, `desktop`, `mobile`, `server-core` and the CLI all reach it.
- **`@infrawrench/ui`** — React-facing types (component props, editor state) plus a re-export shim
  over client-core, because web and desktop depend on `ui` rather than client-core directly.
  `ui/src/api-types.ts` is that shim: add new wire types to `client-core/src/api-types.ts`.
- **the owning package** — anything genuinely local.

`server-core` depends on `client-core`, never the reverse, so a wire contract is declared once and
the producer is typechecked against it. Annotate a route's service function with the client-core
type rather than letting the object literal float — `getOrgCostStatus` went unannotated while three
separate declarations claimed to describe its output.

Prefer deriving over restating: `z.infer`, `$inferSelect`, `Extract<Union, {…}>`, `Omit<…>`. Where
a zod schema and a hand-written type must match, pin them with the `Exact<A, B>` assertion pattern
in `ui/src/cost/config.ts` — it fails the build on drift and costs nothing at runtime.

**Mobile is the tell.** If a type lives in `ui` and mobile needs it, mobile _cannot_ import it and
will silently hand-write a second copy. That is how the mobile billing screen came to read
`GET /billing/status` as a bare subscription when the server returns a
`{ complimentary, subscription }` envelope — every org rendered blank plan rows for as long as both
copies existed.

### Module layering and circular imports

The workspace package graph is a DAG and should stay one: `plugin-base` and `client-core` are
leaves, `ui` depends on `client-core` and never the reverse, `server-core` depends on the plugins,
and `web`/`desktop`/`mobile`/`poller` sit on top. Adding an `@infrawrench/*` dependency that points
back down the stack is the one thing that turns a clean graph into a tangled one.

Check with `npx madge --circular --extensions ts,tsx --ts-config tsconfig.json src` from inside a
package (its own tsconfig, so `@/…` aliases resolve), or
`npx dpdm --no-warning --no-tree --exit-code circular:1 'src/**/*.ts'`, which additionally follows
pnpm workspace links. Neither is a devDependency; run them with `npx`.

Where a module has both a contract (types describing a payload) and machinery (DB queries, network
transport), put the contract in its own import-free leaf. `server-core/src/push/` is the pattern:
`types.ts` (leaf) ← `expo-client.ts` (transport) ← `dispatch.ts` (DB fan-out), with `dispatch.ts`
re-exporting the types so the published `push/dispatch` subpath stays stable. This matters more
than the cycle itself — `db/client` opens a connection as an import side effect, so a type living
beside it is a connection waiting to be opened by a consumer who only wanted a string union.

### Error handling

Errors must reach a place a human sees: an HTTP response, a WS error frame, a toast or React error
state, a structured log in a long-running process, or a non-zero CLI exit. A `catch` that returns
`[]`, `null` or `0` turns a backend outage into an empty UI, which is worse than a 500 because
nobody can tell it apart from "you have no data".

- **`isXConfigured()` and "X is broken" are different states.** ClickHouse readers
  (`server-core/src/clickhouse/readers.ts`) return `[]` when ClickHouse is not configured — that
  deployment genuinely has no metric history. A configured-but-failing ClickHouse throws.
- **`Promise.allSettled` is for isolation, not for ignoring.** Wherever it keeps one failure from
  killing a batch (poller type listings, pin probes, notification fan-out), the rejected `reason`
  must still be logged with enough context to identify which item failed.
- Fan-out helpers (`sendSlackToOrg`, `sendMsTeamsToOrg`, `sendPushToOrg`) deliberately return
  delivery counts instead of throwing, and each has a `…Test` counterpart that _does_ throw so the
  settings UI can show the real transport error. Keep that pairing when adding a transport.

### Shared write helpers in `server-core`

Three invariants that used to be copy-pasted now live in one place each:

- **`secret-states`** — `setLiteralSecretState` / `setOutputRefSecretState`. A
  `secret_field_states` row is either a literal or an output-ref, and writing one kind must clear
  the other kind's columns. Adding a column to that table means updating the clear-list in
  `src/secret-states.ts` and nowhere else. (The seven inlined copies had drifted: one flipped
  `resolution_kind` to `output-ref` while leaving `encrypted_value` populated, retaining secret
  material the user believed they had replaced.)
- **`created-resource`** — `upsertCreatedResource`, for the four flows that create a resource and
  need its `resources` row before the next sync. Deliberately distinct from `sync-resources`'s
  `upsertResource`, which merges JSON columns and bumps `sync_version` because a lister's view is
  partial; a create response is authoritative and overwrites.
- **`tick-loop`** — the `TickLoop` base class behind the poller and github-watcher, plus
  `runService` / `installShutdownHandlers`. Ticks are scheduled after the previous one settles,
  never on a fixed interval; an overrunning tick is skipped rather than run concurrently; `stop()`
  allows 30s of drain to match Kubernetes' `terminationGracePeriodSeconds`.

`server-core/env-loader.mjs` is the single dev-time `.env` preloader for web, poller and
github-watcher. It searches `app/packages/web/` first (that package owns the canonical `.env`),
then the cwd, and never overwrites an existing `process.env` entry.

`@infrawrench/ui`'s `src/components/schema-tokens.ts` owns the mapping from a plugin's
`BadgeNode.color` / `StatusDotNode.status` to Tailwind classes. Renderers must not inline their own
ladder — the peer pane and the detail view previously drew `degraded` in two different yellows.

### Typing vendor SDK request bodies

Plugin clients assemble create/update bodies from a `Record<string, string>` of form fields.
Annotate the body with the SDK's own params type (`const body: XCreateParams = {…}`) — never build
a `Record<string, unknown>` and cast. The cast is not free: it hides the case where a free-text
form field is posted against a closed string-literal union, which is a silent API 400. Removing 36
such casts from the Cloudflare plugin surfaced 17 live wire-format bugs. When a form value must
become a literal union, narrow it with a membership guard and a documented default:

```ts
const METRICS = ["cosine", "euclidean", "dot-product"] as const;
type Metric = (typeof METRICS)[number];
const isMetric = (v: string): v is Metric => (METRICS as readonly string[]).includes(v);
```

A second cast is not a fix. If the params type is a discriminated union the body genuinely cannot
satisfy (Cloudflare DNS records, Page Rules actions), keep the cast and name the union and the
`.d.ts` line in a comment.

- **Hand-written ambient module declarations are unverified.** `.d.ts` files we author for untyped
  dependencies (e.g. `memcached/src/memjs.d.ts`) are asserted, not checked — a wrong signature
  there is worse than no types, because call sites work around it with casts instead of fixing it.
  That file promised a `stats(): Promise<…>` that memjs does not have. Read the dependency's source
  before declaring a method.
- **`tsgo` does not surface mixin-provided members** (`class X extends Mixin(Base) {}`). mysql2's
  `query`/`execute` are the live example, so those casts are load-bearing — build the local
  interface out of the library's own exported packet types so a breaking upgrade still shows up.
- **`exactOptionalPropertyTypes`** is inherited by every package including `ui`. Widen the
  _declaration_ to `prop?: T | undefined` when the type is ours; use a conditional spread
  `{...(v !== undefined ? { k: v } : {})}` when the receiving type is a third party's.

### Dead-code tooling

`knip.json` drives the sweep (`npx knip`). Two things about it are load-bearing:

- **Entry points must match the real build inputs, not the obvious file.** The desktop main-process
  entry is `electron/index.ts` (the `--cli` dispatcher), _not_ `electron/main.ts`. Pointing knip at
  `main.ts` makes it report the entire `electron/cli/` tree — the shipped CLI — as dead code.
- **`@kubernetes/client-node`, `cloudflare`, `dockerode` and `ssh2` are deliberately direct
  dependencies** of `web`, `poller` and `github-watcher` even though no source file imports them.
  Each esbuild `build` script marks them `--external:`, so they must resolve from `node_modules` at
  runtime, reached through the plugin node drivers. They sit in `ignoreDependencies` — do not
  "clean them up".

Knip's `exports` and `types` buckets are noisy here: a type referenced only by an exported
signature in its own module still counts as unused. Treat that bucket as informational.

**`noUnusedLocals` is not enabled in any tsconfig**, so dead imports and locals are invisible to
`pnpm typecheck`. A periodic `tsgo --noEmit --noUnusedLocals -p <pkg>/tsconfig.json` sweep is the
only thing that catches them; it found 123 where knip found one unused file in ~1,830.

### Decomposing big plugin clients

Split by vendor domain, not by line count. The established shape (AWS, and now DigitalOcean) is a
thin `PluginClient` class owning auth, caches and dispatch, delegating to ctx-object modules beside
it: `create-handlers.ts` (dispatcher) + `create-handlers/<domain>.ts`, `detail-renderers.ts`
(barrel) + `detail-renderers/<domain>.ts`, `resource-listers.ts`, `metric-series.ts`,
`enrich-detail.ts`, `status-dots.ts`, `nosql-console.ts`. Each extracted module takes a narrow
context interface holding just the `fetch` wrapper and the caches it needs, so modules stay
leaf-ward of the client and unit-test with a fake `fetch`. The original module path always keeps
exporting the same names, so a split is never a breaking change.

`create-handlers/` modules return `null` for a `typeId` they do not handle; the dispatcher takes
the first non-null result and throws if every module declines. Arms are mutually exclusive, so
module order is not significant.

A big file is not automatically a godfile. `cloudflare/src/metric-series.ts` is ~1,750 lines of one
export over 12 homogeneous per-product fetchers — splitting it buys a 13-import barrel and nothing
else. `desktop/src/lib/agent-client.ts` is multi-responsibility but knitted together by six
module-level singleton maps, where a wrong split is a silent duplicate-VM-provision bug.

### Legacy paths deliberately kept

- **`organization_members.role` / `invitations.role` text fallback.** Migration `0009` added
  `role_id` with no backfill; it is populated lazily by `backfillMembershipRole()`, so production
  still has `role_id IS NULL` rows where the text fallback is the only thing resolving permissions.
- **API-key legacy SHA-256 lookup / `legacyHashSunsetAt`** — an active self-terminating sunset, not
  stale compat. Removing it locks out keys still sitting in customers' CI.
- **The `{ role }` body param and the `resourceIds` reorder form** — superseded for first-party
  clients but published in `openapi.json` and all nine SDKs, so removal is a major bump.
- **v1 ciphertext reads, desktop `master.key`, GCP legacy Cloud Run ids, AWS `legacyHost()`** — all
  read data at rest or are the only implementation of a live path.

`APP_URL` is now the only app-origin env var; the `NEXT_PUBLIC_APP_URL` fallback (a leftover from
the pre-Hono Next.js shell) is gone. `PUBLIC_BASE_URL` still takes precedence for the OpenAPI
server URL and the MCP well-known documents only. `invitations.token` was dropped in migration
`0035_concerned_mesmero` — invitations are hash-only at rest, the raw token existing only in the
one-time `POST /team/invitations` response. `decrypt()` now always takes an AAD; desktop's
`main-utils.ts` keeps `aad` optional because it still writes v1 for cloud tokens.

### Known-broken, recorded rather than fixed

- **Chat metered billing has no replay path.** `web/src/chat/billing.ts` reports each `chat_usage`
  row to Stripe best-effort. If Stripe is unreachable the row keeps a null `stripeUsageRecordId`
  and is never retried — that usage is not billed. `chat_usage_unreported_idx` exists to support a
  replay job that has not been written. Do not assume unreported rows are eventually reconciled.
- **Fallback rows must not invent field values.** When a lister's `Describe*` enrichment fails,
  push empty strings for the fields you could not read (see the ACM fallback in
  `aws/src/resource-listers-extended/security.ts`), never a plausible default. The WAF, Cognito and
  Step Function fallbacks in that file violate this and will display `defaultAction: ALLOW` /
  `mfaConfiguration: OFF` for resources whose real posture is unknown.
- **Create-form cost estimates should come from the provider's pricing API**, per region — see
  `azure/src/pricing.ts` and `gcp/src/pricing.ts`. `aws/src/cost-estimate.ts` is a static us-east-1
  table covering instance generations the size picker no longer offers; treat it as known-broken
  rather than the pattern to copy.
- **Mobile secret fields render a "Tap to copy" affordance wired to nothing** — the
  `resolveFieldValue` handler it dispatches to is supplied by no screen, so it silently no-ops.
- **`FilestoreInstanceResourceType`** is fully implemented in the GCP plugin — lister, create
  config, create, delete, resolve-output, tests — and simply never registered in the manifest.
