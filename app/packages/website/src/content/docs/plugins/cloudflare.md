---
title: Cloudflare
description: Manage Cloudflare zones, DNS, Workers, R2, KV, D1, Tunnels, Access, and more.
sidebar_order: 20
---

Connect a Cloudflare account to manage 35 resource types across DNS, edge compute, storage, AI, security, and Zero Trust.

## What you can manage

- **DNS and zones**: zones, DNS records (with a proxy status toggle), email routing, custom hostnames, health checks.
- **Edge compute**: Workers (script editor plus an editable Settings tab), Workflows, Workers KV, D1 (SQLite), Hyperdrive, Durable Object namespaces.
- **AI**: the Workers AI text-generation model catalog (each with a chat Playground), Vectorize indexes, AI Gateway gateways, and AI Search (AutoRAG) instances.
- **Storage**: R2 buckets, with the [file browser](../features/file-browsers.md), default storage class, and r2.dev public access.
- **Zero Trust**: Access applications and policies, Tunnels.
- **Security and traffic**: WAF custom rules, rate limiting rules, redirect rules, cache rules, IP access rules, load balancers, waiting rooms, Spectrum applications, and Turnstile widgets.
- **Account**: notification (alerting) policies, Logpush jobs, Secrets Store secrets.
- **Data and analytics**: Basin Pipelines streams, sinks and pipelines, Basin Catalog (Apache Iceberg on R2) catalogs and tables with a Basin SQL editor, and Workers Analytics Engine datasets with their own SQL editor. See [Basin](#basin-pipelines-catalog-and-sql) and [Workers Analytics Engine](#workers-analytics-engine).
- **Zone settings**: cache, security, SSL, and performance options on the zone's **Zone Settings** tab, as toggles, dropdowns and numbers. You can turn DNSSEC on or off from the zone header.

## Connect with Cloudflare

1. Pick Cloudflare in the add-account form.
2. Click **Connect with Cloudflare**.
3. Sign in to Cloudflare, choose which Cloudflare account(s) Infrawrench may reach, and approve the permissions. The account name is filled in for you.

What you should know:

- **What you grant:** the same permissions as the token template below (read and edit on zones, DNS, Workers, R2, KV, D1, Queues, Hyperdrive, Tunnels, Access, rules and everything else Infrawrench manages; read on Analytics and Account Analytics), plus your user details and account memberships so Infrawrench can find your accounts. Nothing outside these features.
- **Cost graphs:** Cloudflare's OAuth has no billing permission, so the consent screen also asks for **Account API Tokens: Edit**. It's optional and you can untick it. When costs are collected, Infrawrench uses it to create a short-lived token named "Infrawrench cost sync (temporary)" that can only read billing on that one account, reads your usage, and deletes the token straight away. The token expires within the hour in case the delete fails, and Infrawrench never stores it. This works if the Cloudflare member who connects is a Super Administrator, or has billing access and API token provisioning. If you untick the permission or your role lacks it, Cost reporting shows what's missing. Reconnect to fix it, or paste an API token with **Billing Read** instead.
- **Staying connected:** Infrawrench refreshes your access in the background.
- **Revoking access:** in the Cloudflare dashboard, go to **My Profile > Access Management > Authorizations** (Manage OAuth authorizations). Infrawrench then marks the account **Reconnect required**.
- **Missing account?** If an account doesn't appear in Cloudflare's account picker, an administrator of that account may have turned off **Public OAuth App access** (Manage Account > Members > Settings).
- Works from the web app, the desktop app in cloud mode, and desktop-local accounts.

## Credentials

Prefer an API token? Here's how to create one with the right scopes:

1. In the **Add account** or **Update credentials** form, click the **"Create a token with these scopes"** link next to the API token field.
2. Cloudflare's token creator opens with the scopes Infrawrench uses already selected. Review them and create the token.
3. Copy the token and paste it into the field. Cloudflare only shows the token once.

To scope a token by hand, go to the Cloudflare dashboard, open **My Profile > API Tokens > Create Token**, and grant the permissions for the resources you plan to manage. If the token can't read a resource type, that tab tells you the exact permission to add (for example **Account · Hyperdrive:Read**) instead of showing an empty list. Spectrum has no permission of its own; the **Zone** permission covers it.

![Cloudflare Add-account form with the API token field and the "Create a token with these scopes" link highlighted](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/add-account.png)

### Credential preflight & token template

The add-account form, and **Check credentials** on the account page, verify your token and show what it can reach for each capability. See [Credential preflight](../core-concepts/credential-preflight.md).

- **Resource inventory**: **Zone Read** (needed for every zone-scoped resource) and **Account Settings Read** (for account-scoped resources such as Workers, R2, KV and D1). Some resource types need more scopes; the resource tab tells you which when one is missing.
- **Metrics and dashboards**: **Analytics Read** and **Account Analytics Read**.
- **Cost reporting**: **Billing Read**. A connected (OAuth) account is checked by creating, using and deleting the temporary billing token, just like a real cost run.

An expired or disabled token is flagged on every row. Tick the capabilities you want and the generator gives you the permission list plus a link that opens Cloudflare's token creator with exactly those scopes filled in.

## Edit resources

Most Cloudflare resources have an **Edit** button on their detail page that opens a settings form. No raw JSON. Only the fields you change are updated, so the rest of the resource stays as it was. Fields that identify the resource or are managed by Cloudflare (a rule's expression target, a custom hostname's name, a health check's protocol) are read-only.

You can edit DNS records, all five rule types (WAF custom, rate limiting, redirect, cache, IP access), page rules, email routing rules, waiting rooms, load balancers, Hyperdrive configs, custom hostnames, Spectrum applications, Logpush jobs, Access applications and policies, Turnstile widgets, health checks, notification policies, AI Gateways, R2 buckets (default storage class), and Secrets Store secrets. Editing needs the same token permission that grants write access to that resource.

## Turnstile, Health Checks, and Notifications

- **Turnstile widgets**: create, edit and delete Turnstile (CAPTCHA alternative) widgets. The create form takes a name, allowed domains, and a widget mode (Managed, Non-interactive or Invisible). Each widget exposes its public **Site Key** and a sensitive **Secret Key** as output references, plus a one-click credentials export (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`). The detail page gives you ready-to-paste code: an HTML snippet (the `api.js` script and a `cf-turnstile` div inside a form) for your site, and a server-side snippet that posts the token to `siteverify` using your `TURNSTILE_SECRET_KEY`. The secret itself never appears in the snippet. Needs **Turnstile:Edit**.

![Cloudflare Turnstile widget detail page showing the "Add the widget to your site" section with the copyable HTML embed snippet and the server-side verification snippet below it](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/turnstile-detail.png)

- **Health checks**: standalone origin monitors, separate from load-balancer pools. Create an HTTP, HTTPS or TCP check against an address. The detail page shows status, consecutive fails and successes, and interval, timeout and retries, all editable. Needs **Health Checks:Edit**.
- **Notification policies**: account-level alerts. Pick an alert type (SSL events, health-check status, origin or edge error rates, DDoS, billing, expiring tokens, failing Logpush, and more) and enter recipient emails separated by commas. You can turn a policy on or off and edit recipients later. Needs **Notifications:Edit**.
- **Vectorize indexes**: create and delete vector-database indexes for Workers AI and RAG. Enter a name, the vector dimensions (must match your embedding model), and a distance metric (cosine, euclidean or dot product). The index name is an output reference and a Worker-binding credentials export. Needs **Vectorize:Edit**.
- **AI Gateway**: create, edit and delete AI Gateways, the proxy that adds caching, rate limiting, logging and analytics in front of your model providers (Workers AI, OpenAI, Anthropic and more).
  - The create form takes a gateway id (the slug in the gateway URL) plus log collection, a cache TTL, a rate limit (requests, window, and fixed or sliding technique), authenticated-gateway enforcement, and Logpush.
  - The gateway id is an output reference and an `AI_GATEWAY_ID` credentials export.
  - The detail page has the copyable **gateway endpoint URL** (the OpenAI SDK `/compat` base URL), a copyable **code example**, a **Metrics** tab (requests, tokens in and out, cost, errors, cache hits), and a **Playground** tab.
  - The Playground lets you chat with any Workers AI text-generation model **through this gateway**. It uses your Cloudflare token, so you don't need provider keys, and the traffic shows up in the gateway's own logs and analytics. Pick the model from the dropdown at the top.
  - Needs **AI Gateway:Edit**, plus **Workers AI:Read** for the Playground. Without it the model list and chat return an authentication error.
  - If **Authenticated Gateway** is on, the Playground is disabled because it can't supply the gateway token. Turn it off to chat here, or call the gateway from your own code with a `cf-aig-authorization` header.

![Cloudflare AI Gateway detail page showing the gateway endpoint URL, the code example, and the Metrics and Playground tabs](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/ai-gateway-detail.png)

- **AI Search**: list and delete AI Search (formerly AutoRAG) instances, the managed RAG pipelines over an R2 bucket or a web crawler. The detail page shows the source type, generation and embedding models, backing Vectorize index, status, paused state and last activity. Create new instances in the Cloudflare dashboard wizard. Needs **AI Search:Read** to list, and write access to delete.
- **Durable Object namespaces**: a read-only list of the namespaces your deployed Workers declare (name, exported class, owning script, and whether it uses SQLite storage). You add or remove them by redeploying the Worker. The detail page has an **Instances** browser showing live objects and whether each holds stored data, plus a Metrics tab. Cloudflare has no public API to read or edit a Durable Object's storage from outside a Worker, so use the Cloudflare dashboard's Data Studio (for SQLite-backed objects) to inspect it. Uses **Workers Scripts:Read**.

![Infrawrench Durable Object namespace detail page showing the Instances table (Object ID + Stored Data columns) and the read-only storage note](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/durable-object-namespace-detail.png)

## Workflows

**Workflows** lists every Cloudflare Workflow in the account: the durable, multi-step runs a Worker declares. You create a workflow by deploying the Worker that exports it, so there's no create form. Here you can inspect, run and delete workflows.

- **Details** show the exported class, the owning Worker, instance counts per state (running, queued, waiting, paused, errored, complete, terminated), any cron schedules with the next run, and when it was last triggered.
- **Recent Instances** lists the 25 newest instances with status, trigger source (API, binding, event or cron), and start and end times. Each row has the controls that fit its state: **Pause**, **Resume**, **Terminate** and **Restart**.
- **Trigger Instance** in the header starts a new instance with no params. To pass params, trigger it from your Worker binding or with `wrangler workflows trigger`.
- The **Metrics** tab charts instance starts, successes, failures and terminations, plus step successes, step failures and failed step attempts.
- The workflow name is an output reference and a `WORKFLOW_NAME` credentials export.

To change workflow settings (class, script, step limits, schedules), redeploy the Worker. Uses the **Workers Scripts** permission.

<insert [Cloudflare Workflow detail page showing the Workflow Details list and the Recent Instances table with Pause/Terminate/Restart row buttons] here>

## Secrets Store

**Secrets Store Secrets** are account-level secrets that Workers, AI Gateway and other Cloudflare services can share, so you don't copy the same value into each Worker.

- **Create** a secret: pick the store, a name, the value, the services allowed to use it (Workers, AI Gateway, Access, Containers, Digital Experience Monitoring, Web Search), and an optional comment. If the account has no store yet, Infrawrench creates the `default_secrets_store` one, just like the dashboard.
- **Edit** to rotate the value, change the comment, or change which services can use it. Cloudflare never returns a stored value, so the **Value** field stays blank. Leave it empty to keep the current secret.
- The detail page shows the store, scopes, status, and how many of the account's secrets are in use, plus a copyable `[[secrets_store_secrets]]` binding snippet for `wrangler.toml`. The store id and secret name are output references and a `SECRETS_STORE_ID` / `SECRET_NAME` credentials export.

Needs the **Secrets Store** permission (Read to list, Edit to create, change or delete). The "Create a token with these scopes" link includes it.

## Basin (Pipelines, Catalog and SQL)

[Cloudflare Basin](https://developers.cloudflare.com/basin/) went GA on 2026-10-01 and is the new name for the Cloudflare Data Platform: **Basin Pipelines** (formerly Pipelines), **Basin Catalog** (formerly R2 Data Catalog) and **Basin SQL** (formerly R2 SQL). You manage all three from the account sidebar.

- **Basin Streams**: the buffers events land in.
  - **Create** takes a name, whether HTTP ingest is on (and whether it needs a token), allowed CORS origins, whether Workers can send through a binding, and an optional schema (`{ "fields": [{ "name": "user_id", "type": "string", "required": true }] }`). Leave the schema blank for an unstructured stream.
  - **Edit** changes HTTP ingest, token auth, CORS and the Worker binding. Cloudflare doesn't let you change a stream's schema after creation.
  - The detail page has a copyable `curl` example for the stream's ingest endpoint and a `[[pipelines]]` binding snippet. The stream ID and endpoint are output references and credentials exports.
- **Basin Sinks**: where pipelines write.
  - Pick **Basin Catalog table** (Iceberg, Parquet), then choose the catalog from your buckets with Basin Catalog enabled, a namespace and a new table name. Or pick **Files in an R2 bucket** with a bucket, path prefix, partitioning pattern, and JSON or Parquet.
  - Compression, roll interval and roll size are optional.
  - A sink writes with this account's own API token by default, so only fill in the credentials if you want a separate token or R2 key.
  - Sinks can't be edited. Create a new one instead.
- **Basin Pipelines**: the SQL that connects a stream to a sink.
  - **Create** takes a name, a source stream, a destination sink, and optional SQL. With the SQL blank, the pipeline copies every event unchanged (`INSERT INTO <sink> SELECT * FROM <stream>`).
  - The detail page shows the status, the streams and sinks it reads and writes, the SQL, and any failure reason.
  - Pipeline SQL can't be edited. To change it, create a new pipeline and delete the old one.
- **Basin Catalogs**: one per R2 bucket.
  - **Create** turns the catalog on for a bucket you pick (only buckets without one are listed). You can also turn on table maintenance: compaction with a 64, 128, 256 or 512 MB target file size, and snapshot expiration with a maximum age and a minimum number of snapshots to keep.
  - Maintenance runs with a stored service token. Leave **Maintenance Token** blank to use this account's token.
  - **Edit** changes the maintenance settings or replaces the token.
  - **Delete** disables the catalog. The bucket and its data files stay in R2, but Iceberg clients can't reach the tables until you enable it again.
  - The detail page lists the catalog's tables and gives the **Catalog URI** and **Warehouse** (also output references and an `ICEBERG_CATALOG_URI` / `ICEBERG_WAREHOUSE` credentials export), with a PyIceberg example for connecting Spark, DuckDB, Trino, Snowflake or StarRocks.
- **Basin Tables**: every Iceberg table across your active catalogs, grouped by catalog and also listed in the sidebar. The detail page shows the namespace, table UUID and storage locations. **Edit** sets per-table compaction and snapshot expiration, which override the catalog's defaults. Tables are created by sinks or Iceberg clients; Infrawrench doesn't drop them.

### Basin SQL editor

Basin Catalogs and Basin Tables have a **SQL Editor** tab, the same one D1 and BigQuery use. Queries run against that catalog's warehouse, so refer to tables as `namespace.table` and join across any tables in the catalog. Autocomplete suggests the catalog's tables but not column names.

Basin SQL is read-only (`SELECT`, `EXPLAIN`, CTEs, joins, window functions). It's billed per byte scanned with a 10 MB minimum per query, so add a `LIMIT` and filter on partition columns while you explore.

<insert [Basin Table detail page showing the SQL Editor tab with a SELECT against default.events and a result grid] here>

### Metrics

- **Pipelines**: records and bytes ingested, decode errors, records and bytes delivered, files written, and dropped events by error type (missing field, type mismatch, parse failure, null value). Streams show the ingest half and sinks the delivery half.
- **Catalogs and tables**: catalog requests, failed requests, average request latency, maintenance jobs and failures, and files and bytes compacted.

### Permissions

The "Create a token with these scopes" link includes **Pipelines: Edit**, **Workers R2 Data Catalog: Edit** and **Workers R2 SQL: Read**. Basin SQL also needs R2 storage read access, which the link's **Workers R2 Storage: Edit** covers. Metrics need **Account Analytics: Read**.

HTTP ingest with token auth expects callers to send a token with **Pipelines: Send**. That's separate from the token Infrawrench uses. If your token was created before these scopes were added, add them by hand.

Cloudflare's legacy (pre-streams) Pipelines API is deprecated and isn't listed. Manage those pipelines in the dashboard, or move them to streams and sinks.

## Workers Analytics Engine

**Analytics Engine Datasets** lists every dataset in the account. A dataset appears once a Worker writes to it through an `[[analytics_engine_datasets]]` binding. Cloudflare has no API to create or delete one, so you can't do that here.

- **SQL Editor**: query any dataset with the [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/). Autocomplete knows every dataset and its fixed columns (`timestamp`, `index1`, `blob1` to `blob20`, `double1` to `double20`, `_sample_interval`). The default query charts events per hour for the last day. Rows are sampled under load, so weight counts and sums by `_sample_interval`.
- **Metrics**: data points written (sample-weighted) and rows stored, per hour, or per five minutes for windows under six hours. Analytics Engine keeps three months of data.
- The detail page has a binding snippet with a `writeDataPoint()` example. The dataset name is an output reference and an `ANALYTICS_ENGINE_DATASET` credentials export.

Needs **Account Analytics: Read**, which the "Create a token with these scopes" link includes.

## Notable flows

- **DNS records table**: a zone's records show as a Cloudflare-style table (type, name, content, proxy, TTL) where you can create and delete records inline. See [DNS records](../features/dns-records.md).
- **DNS record editor**: fields adapt to the record type (A, AAAA, CNAME, MX, TXT, SRV, CAA). You can [point A, AAAA and CNAME values at another resource](../features/dns-records.md), such as an AWS Elastic IP, and they stay up to date.
- **Worker script editing** with deploy, plus an editable **Settings** tab. See [Worker settings](#worker-settings). Workers also get **Logs** and **Traces** tabs; see [Worker logs and traces](#worker-logs-and-traces).
- **R2 file browser** and **secret export to K8s** for bucket credentials.
- **R2 storage class and public access**: new buckets take a default storage class (Standard or Infrequent Access) along with the location hint. **Edit** changes it later, and only new uploads use the new class. The bucket's **Public Development URL** section shows whether its `r2.dev` URL is serving, with **Enable r2.dev Access** and **Disable r2.dev Access** buttons. The URL is also a **Public r2.dev URL** output reference. The `r2.dev` URL is rate limited and meant for development; use a custom domain for production.
- **KV namespace browser**: open a Workers KV namespace and use the **Keys** tab to list keys (paginated, with an optional prefix filter), view values, add or overwrite a key, and delete keys. Values are treated as UTF-8 text.
- **D1 SQL editor**: open a D1 database and use the **SQL Editor** tab to run queries. The default query lists your tables.
- **Hyperdrive connection editing**: the **Edit** form changes the origin connection (host, port, protocol, database, user), the name and the caching toggle.
  - Cloudflare never returns the origin password, so the **Password** field stays blank. Leave it empty to keep the current password, or type a new one to rotate it. Renaming or toggling caching won't touch your credentials.
  - Needs **Hyperdrive:Edit**.
  - The detail page shows query, cache and latency metrics. The **Hyperdrive ID** is an output reference and a `HYPERDRIVE_ID` credentials export for a Worker `[[hyperdrive]]` binding.
  - There's no SQL tab, because a Hyperdrive endpoint is only reachable from inside a Worker.
- **Zone settings form**: each setting on the **Zone Settings** tab is a toggle, dropdown or number. **Apply** saves only the settings you changed.
- **Purge cache**: use the **Purge Everything** button in a zone's header. See [Cache](#cache).
- **Expose a service over a tunnel**: drag a Tunnel onto a server (any account or provider) to expose HTTP, HTTPS, SSH or TCP through Cloudflare. Infrawrench sets up the tunnel ingress and DNS and installs `cloudflared` on the host. See [Expose a service over a Cloudflare Tunnel](../features/cloudflare-tunnel-ssh.md).

![Cloudflare KV namespace detail page with the Keys tab open, showing a list of keys with the value of a selected key displayed](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/kv-keys-tab.png)

- **Workers AI Playground**: open any model under **Workers AI Models** and use the **Playground** tab to chat with it. Replies stream in as they're written, and token usage shows under each reply when Cloudflare returns it. Needs **Workers AI:Read** to list models and chat.

![Cloudflare Workers AI model detail page with the Playground tab open, showing a streamed assistant reply](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/workers-ai-playground.png)

- **Queue detail page**: shows the queue's settings (delivery delay, retention period, pause state), a **Consumers** tab listing each bound Worker or pull consumer with its batch size, retry policy and dead-letter queue, and a **Publish** tab for sending a one-off test message. Publishing needs **Queues:Edit**.

![Cloudflare Queue detail page with the Consumers tab open, showing a table of Worker consumers and their retry settings](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/queue-consumers-tab.png)

## Worker settings

Open a Worker and switch to the **Settings** tab for a labeled form. No raw JSON. Settings are grouped:

- **General**: usage model (read-only), Logpush, the `workers.dev` subdomain toggle, and tags.
- **Observability**: the main switch and head sampling rate (0 to 1), then Workers Logs (on or off, invocation logs, logs sampling rate, persist) and Workers Traces (on or off, traces sampling rate, persist). OpenTelemetry export destinations are read-only; manage them in the Cloudflare dashboard. Changing one setting leaves the others, destinations included, as they were.
- **Compatibility**: compatibility date and flags (read-only; change them by redeploying the Worker).
- **Placement**: Smart Placement mode (read-only).
- **Limits**: the CPU limit per invocation (read-only).
- **Triggers**: cron expressions, plus a read-only view of tail consumers.
- **Bindings**: a read-only count of the Worker's bindings.

Each editable row saves on its own. Read-only rows are deploy-time configuration, so change them by redeploying. Editing needs **Workers Scripts:Edit**.

![Cloudflare Worker detail view with the Settings tab open, showing the General and Observability groups populated for a real Worker](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/worker-settings-tab.png)

## Worker logs and traces

Workers Observability stores a Worker's logs and traces. Turn it on per Worker in the **Settings** tab (the **Observability** group) or with `observability.enabled = true` in your Wrangler config. The Worker's overview shows whether Workers Logs and Workers Traces are on and at what sampling rate.

- **Logs tab**: the newest log events, oldest first, with timestamp, level and message.
  - Each invocation gets one summary line with its trigger (`GET /path`, cron, queue and so on), HTTP status, outcome, CPU and wall time, and the data center that ran it. A short request id ties console lines back to their invocation.
  - Use the dropdown to show errors, warnings and errors, failed invocations (any outcome other than `ok`), invocations only, or console logs only.
  - The tab looks back 24 hours, then the full retention window (7 days, 3 on the Free plan) if that's empty. If nothing comes back, it tells you whether logging is off or the Worker has just been quiet.
  - Workers also show up in the [log workspace](../features/log-workspace.md), so you can tail them alongside other services and alert on a match.
- **Traces tab**: recent traces from the last 24 hours, each with its root span, span count, duration, the Workers it crossed, and any errors. Turn on Workers Traces first; until then the tab tells you how.

Both tabs need **Account · Workers Observability:Edit**, even though they only read data. That's the permission Cloudflare requires, and the "Create a token with these scopes" link asks for it. Without it, the Logs tab shows a missing-permission message and the Metrics tab leaves out the log-level and span charts.

<insert [Cloudflare Worker detail page with the Logs tab open, the filter dropdown set to "failed invocations", showing invocation summary lines with status, outcome, CPU and wall time] here>

<insert [Cloudflare Worker detail page with the Traces tab open, showing a table of recent traces with root span, span count, duration, services and errors] here>

## Cache

To clear all of Cloudflare's cached content for a zone, open the zone and click **Purge Everything** in the header. It's the same as the dashboard's _Caching > Configuration > Purge Everything_. Infrawrench asks you to confirm first. Visitors may briefly reach your origin while the cache refills. Needs the **Cache Purge** permission, which the "Create a token with these scopes" link includes.

## Rules engine

A zone's **Rules & WAF** tab lists every rule type. Each create form starts with a **zone picker**, so you don't need to copy zone IDs.

- **WAF custom rules**: match an expression and `block`, `challenge`, `js_challenge`, `managed_challenge`, `skip` or `log` the request.
- **Rate limiting rules**: match an expression, then allow _N_ requests per period (with counting characteristics) before the action fires.
- **Redirect rules**: match an expression and send the visitor to a target URL with a 301, 302, 307 or 308, optionally keeping the query string.
- **Cache rules**: match an expression and make matching requests cacheable (with an optional edge TTL override) or bypass the cache.
- **IP access rules**: allow, block or challenge by IP, CIDR range, ASN or country.

Each rule's detail page shows its expression, action and status, and you can create and delete rules in place.

Permissions: WAF and rate limiting rules need **WAF**, cache rules need **Cache Settings**, redirect rules need **Transform Rules**, and IP access rules use **Firewall Services**. The "Create a token with these scopes" link includes all of them.

![Cloudflare zone Rules & WAF tab showing WAF custom, rate limiting, redirect, and cache rules](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudflare/zone-rules-waf-tab.png)

## DNSSEC

Open a zone and click **Enable DNSSEC** or **Disable DNSSEC** in the header. After you enable it, add the DS record Cloudflare generates at your domain registrar to finish activation. Uses the **DNS:Edit** permission.

## Metrics

Resources with useful traffic or health data get a **Metrics** tab, so you can check them without leaving Infrawrench:

- **Zone**: requests, bandwidth, cached requests, threats, unique visitors.
- **Worker**: requests, errors, subrequests, CPU and wall time p50 and p99, and failed invocations by outcome (exception, exceeded resources, client disconnected, internal error). With Workers Observability on, you also get log events per level (log, info, warn, error, debug), and with Workers Traces on, span count and span duration p50 and p99. These need the permission in [Worker logs and traces](#worker-logs-and-traces).
- **R2 bucket**: Class A and Class B operations, object count, stored bytes.
- **Spectrum application**: events, ingress and egress bytes, connections.
- **D1 database**: read and write queries, rows read and written, response bytes, query batch latency p90 (daily).
- **KV namespace**: reads, writes, deletes, lists, key count and stored bytes (daily).
- **Queue**: messages produced, consumed, acknowledged and retried, bytes transferred, backlog.
- **Hyperdrive**: total queries, cache hits and misses, errors, query and result bytes, query and connection latency.
- **Load balancer**: total requests and a per-pool breakdown.
- **Waiting room**: active users, queued users, new users per minute, time on origin p50, time waited p90.
- **Turnstile widget**: challenge volume in fifteen-minute buckets.
- **Workflow**: instances started, succeeded, failed and terminated, plus steps succeeded, steps failed and failed step attempts.
- **Durable Object namespace**: invocation requests, response body size, CPU time and stored bytes.
- **Basin pipeline, stream and sink**: records and bytes ingested and delivered, decode errors, files written, dropped events by error type (hourly).
- **Basin catalog and table**: catalog requests, failures and average latency, maintenance jobs and compaction volume.
- **Analytics Engine dataset**: data points written and rows stored.

The token needs **Account Analytics:Read** for account resources and **Zone Analytics:Read** for zone resources. The "Create a token with these scopes" link includes both. A resource with no traffic in the selected window shows an empty Metrics tab, which is expected.

## Tips & limits

- Very large zones (thousands of records) load in chunks.
- Tokens can be scoped to specific zones. If you only see some zones, check the token's scope.
- Analytics keep the last 31 days of data. A wider range shows the most recent 31 days (7 days for Turnstile) rather than an empty chart.
- Since 2026-10-02, every plan, including Free and Pro, keeps at least 31 days of Cloudflare's adaptive analytics (HTTP requests, security events, DNS and similar), so most metric ranges up to about 30 days return data on every plan. Zone traffic charts use an aggregated dataset that keeps its per-plan limits ([changelog](https://developers.cloudflare.com/changelog/product-group/analytics/)): 3 days on a Free zone. A zone chart over a longer range shows the most recent window your plan allows.

## Cost graphs

Cloudflare accounts feed [cost graphs & budgets](../features/cloud-costs.md) with per-product costs across the usage-based products (Workers, R2, D1, Workers AI, Vectorize, Images, Stream and more), tagged by `zone` and split by billing period.

- The token needs **Billing Read**, which the "Create a token with these scopes" link includes. Older tokens without it show a "missing Billing Read" error on the cost card. Re-create the token from the link and update the account's credentials.
- Cost data is generally available for self-serve accounts; Enterprise coverage is still rolling out. If your account isn't covered yet, the cost card says so.
- Amounts are contracted costs per billing period, so daily graphs show them as steps. Cloudflare refreshes the data daily.

## AI Gateway request logs

An AI Gateway can be an [AI attribution](../features/ai-attribution.md) source. Its request log (provider, model, tokens, the gateway's cost estimate and the `cf-aig-metadata` header) splits spend on the providers behind the gateway (OpenAI, Anthropic, Bedrock and so on, connected as their own accounts) by caller.

- The token needs **Account · AI Gateway:Read**, and log collection must be on for the gateway.
- Cached responses are skipped, since they never reach a provider's bill.
- A gateway with more than 200,000 requests in a day is read up to that limit and the day is marked partial.
