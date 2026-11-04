---
title: DigitalOcean
description: Manage DigitalOcean Droplets, Kubernetes, App Platform, load balancers, firewalls, managed databases, Spaces, and DNS.
sidebar_order: 4
---

Connect DigitalOcean with a single API token, then manage Droplets, databases, networking, storage and AI resources from Infrawrench.

## What you can manage

- **Droplets**: list, create (with image, size, region and SSH key pickers) and delete. From the detail page: power on, off and cycle, reboot, shutdown, snapshot (auto-named or named), rename, resize, rebuild from image, reset the root password, enable IPv6, turn backups on or off, restore, and change the backup policy.
- **Block-storage volumes**: list, create, delete, attach and detach (drag a volume onto a Droplet to attach it), resize, snapshot.
- **Snapshots**: one sidebar group for every Droplet _and_ volume snapshot, deletable from the detail page. To restore into a Droplet, use the Droplet's **Actions > Restore from Backup**.
- **Custom images**: your own images (uploaded ISOs, snapshots promoted to images, backups). Distribution and marketplace images are still available in the Droplet create form.
- **Network File Storage (NFS)**: create NFSv4.1 shares (standard or high-performance) in a VPC, mountable across multiple Droplets and DOKS nodes. The share's detail page shows the mount target and a ready-to-paste `mount -t nfs` command.
- **Reserved IPs**: list, create, assign, reassign, unassign and delete static addresses you can move between Droplets (formerly "floating IPs"). Each shows its region, the Droplet holding it, its project, and whether DigitalOcean has an action pending on it. Unassigned addresses are flagged by the [orphan finder](../features/orphan-finder.md). See [Reserved IPs](#reserved-ips).
- **VPCs**: list, create (name and region, with an optional CIDR range and description) and delete the private networks your Droplets, DOKS nodes, NFS shares and Dedicated Inference endpoints sit in. Each shows its region, IP range, description and whether it's the region's default. You can't delete a region's default VPC or a VPC that still has members; DigitalOcean rejects those with a 403.
- **NAT gateways**: list, create (region and VPC pickers, size 1 to 5, TCP, UDP and ICMP timeouts), edit size, name and timeouts, and delete. They give private Droplets outbound internet access through one egress IP. See [Networking services](#networking-services).
- **VPC peerings**: connect two VPCs (two VPC pickers), rename, delete.
- **Load balancers**: create regional HTTP and regional network (TCP/UDP) load balancers, edit them, manage forwarding rules, the health check and target Droplets, and chart every metric DigitalOcean offers. Global load balancers can be listed and edited here but are created in the DigitalOcean console. See [Load balancers](#load-balancers).
- **Cloud Firewalls**: create with inbound rules, sources and target Droplets or tags, then add and remove allow or deny rules, Droplets and tags from the detail page. See [Cloud Firewalls](#cloud-firewalls).
- **Certificates**: Let's Encrypt certificates for domains whose DNS DigitalOcean hosts (domain picker plus subdomains, wildcards included), or uploaded custom certificates. Expiry dates feed the Expiry radar.
- **CDN endpoints**: put the Spaces CDN in front of a bucket (with a bucket picker when the account has Spaces keys), set the cache TTL, attach a custom domain with a certificate, and purge cached paths.
- **Uptime checks**: HTTP(S) and ping checks from up to four regions. The detail page shows status per region, 30-day uptime and the last outage, plus alerts (down, latency, SSL expiry; email and Slack). Pause and resume from the header.
- **App Platform apps**: list, redeploy, force a rebuild, restart (all or chosen components), roll back, cancel a deployment in progress, edit the app spec, delete. Includes build, deploy and run logs, and CPU, memory, restart and daily bandwidth metrics. See [App Platform](#app-platform).
- **Droplet autoscale pools**: list, edit the scaling settings (min and max Droplets and CPU or memory targets, or a fixed count), view members and scaling history, chart pool metrics, and delete the pool with or without its Droplets. Create pools in the DigitalOcean console.
- **Kubernetes (DOKS)**: clusters, with a kubeconfig for the [Kubernetes plugin](./kubernetes.md), node CPU, memory and bandwidth metrics, and a **Logs** tab listing the notices DigitalOcean posts when something affects the cluster (such as delayed provisioning).
- **Managed databases**: Postgres, MySQL, Valkey (Redis-compatible caching), MongoDB, Kafka, OpenSearch, and Weaviate (private preview). Connection strings are outputs you can use from the matching client plugins. DigitalOcean retired Managed Redis on 30 June 2025, so the create form makes Valkey clusters. Older Redis clusters still appear and connect through the Redis plugin.
- **Agent Platform**: list, create and delete Gradient AI agents. The agent's deployment URL is an output you can reference from other resources.
- **Knowledge Bases**: list, create, edit and delete RAG knowledge bases. Manage data sources (Spaces buckets, web crawls), start and cancel indexing jobs, and see indexing history. The `kbaas.do-ai.run/v1/{uuid}/retrieve` retrieval endpoint is an output.
- **Inference Router**: list, create and delete model routers, which pick the right model for each call to balance cost and latency.
- **Dedicated Inference**: list, create and delete dedicated GPU model deployments. Public and private VPC endpoints are outputs.
- **Batch Inference jobs**: list and cancel batch jobs running against OpenAI or Anthropic.
- **Model API Keys**: list and delete the keys for `inference.do-ai.run` (serverless inference and OpenAI-compatible SDK access). Create new keys in DigitalOcean's Model Studio.
- **Spaces**: S3-compatible object storage, with the [file browser](../features/file-browsers.md). Buckets in every Spaces region are found, including LON1, TOR1, BLR1, ATL1 and MKC1.
- **DNS**: domains and records.
- **Projects**: list, create, edit (name, description, purpose, environment) and delete. Click **Edit Project…** at the bottom of the project detail page to rename or repurpose a project.

![DigitalOcean Project detail page with the Edit Project button at the bottom highlighted](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/project-detail.png)

## Credentials

1. In DigitalOcean, go to **API > Tokens > Generate new token**. Give it read and write scope.
2. Paste the token into the add-account form.

![DigitalOcean Add-account form with API token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/add-account.png)

## Droplet detail page

The Droplet detail page gives you:

- A **header action bar** with Power On, Reboot and Shutdown buttons that match the Droplet's state, and a one-click **Take Snapshot** (named with the Droplet name and a timestamp).
- An **Actions tab** with everything else: Power Cycle, hard Power Off, named Snapshot, Rename, Resize (choose CPU and RAM only, or include disk), Rebuild, Enable IPv6, Reset Root Password, Enable or Disable Backups, Change Backup Policy (daily or weekly, plus hour and weekday), and Restore from Backup. Destructive actions ask you to confirm.
- A **Metrics tab** with CPU, load (1, 5 and 15 min), memory (total, available, free, cached), disk read and write, filesystem size and free space, and bandwidth in and out on public and private interfaces. Memory, disk, load and filesystem charts only appear when the [DO Metrics Agent](https://docs.digitalocean.com/products/monitoring/how-to/install-metrics-agent/) is installed on the Droplet.
- A **Logs** tab with the last 24 hours of the Droplet's logs from [DigitalOcean Insights](https://docs.digitalocean.com/products/insights/) (public preview). Choose **all** or **errors** (severity ERROR and above). Logs only exist for Droplets running the Insights Observability agent in a supported region, and your token needs the `insights:read` scope. If something's missing, the tab tells you which.
- **Backups**, **Snapshots** and **Volumes** tabs, with links to each item's detail page where available.

![DigitalOcean droplet detail page with the Actions tab open showing Power, Snapshot & Image, Configuration, and Backups sections](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/droplet-actions-tab.png)

![DigitalOcean droplet Metrics tab with CPU, load, memory, bandwidth, and filesystem charts](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/droplet-metrics-tab.png)

## Managed databases

To create a cluster, pick the engine, region, node size and node count. Once it's running, here's what to know.

### Users (and where the password comes from)

DigitalOcean shows a database user's password **only once**, when the user is created. The built-in `doadmin` and `do-readonly` users never show theirs.

- **Postgres and MySQL**: the password comes with the cluster, so the SQL editor tab works right away.
- **MongoDB, Valkey, OpenSearch and Kafka**: you need your own user for the connection tab to work. Click **+ Make connection user** in the cluster's header. Infrawrench creates the user, saves the credential DigitalOcean returns (a password, or for Kafka the mTLS cert and key) encrypted in your local secret store, and the tab starts working.
- **Kafka** users also need an ACL, so the form adds **Topic** and **Permission** fields. They default to `admin` on every topic (`*`) so the user works straight away, but you can narrow them (for example `produceconsume` on `events-*`) before creating. Kafka connects with **SASL/SCRAM-SHA-256** over TLS, which needs the user's password. DigitalOcean only returns it when your token has the **`database:view_credentials`** scope. That scope is _not_ part of "Full Access", so if Kafka reports a missing password, regenerate the token with it ticked.

You can also create users from the **DB Users** section on the detail page. **Make connection user** is the one-click version that also saves the credential.

### Metrics tab

Every engine charts CPU, memory and disk usage plus load (1, 5 and 15 minute). MySQL clusters also show the share of reads that use an index, select, insert, update and delete rates, and connected, active and newly created threads.

### Logs tab

DigitalOcean doesn't offer process logs through its API. The Logs tab shows the cluster's **event history** instead: creates, scaling, maintenance and power cycles. Use it to see what's been happening to the cluster, not as a query log.

![DigitalOcean managed-database detail page with the DB Users section expanded showing a freshly-minted user](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/managed-database-db-users.png)

![DigitalOcean managed-database Logs tab showing the cluster event stream](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/managed-database-logs.png)

## NFS shares

Create a share from any project's NFS sidebar group:

1. Pick a region that supports NFS. Unsupported regions return a 422 error.
2. Choose a size: minimum 50 GiB, maximum 16,000 GiB.
3. Choose a performance tier: Standard ($0.15 / GiB-mo) or High Performance ($0.30 / GiB-mo, tuned for GPUs).
4. Pick a VPC. Only Droplets and DOKS nodes in this VPC can reach the share. Add more VPCs later in the DigitalOcean console.

The share's detail page then shows the mount target and a copy-paste `sudo mount -t nfs -o nfsvers=4.1 …` command for the share.

![DigitalOcean NFS share detail page showing the mount target and mount command](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/nfs-share-detail.png)

## Reserved IPs

A reserved IP is a static address you can move between Droplets without changing DNS. DigitalOcean used to call these "floating IPs".

Know the pricing: **an assigned reserved IP is free, and an unassigned one costs $5.00/month ($0.01/hour)**. A forgotten address is a common surprise on a DigitalOcean bill, so Infrawrench flags unassigned ones.

When you create one, you choose what it's for:

- **A Droplet**: pick the Droplet. The address is reserved in its region and assigned straight away, so it's never billed.
- **A region**: pick a region (and optionally a project). The address is reserved but unassigned, and billing starts.

From the detail page you can **Assign** (or **Reassign**) it to another Droplet, **Unassign** it, or delete it. The Droplet picker only shows Droplets in the address's region, because DigitalOcean doesn't allow cross-region assignment. You can also drag a reserved IP onto a Droplet in the sidebar; if the regions don't match, Infrawrench tells you why.

While DigitalOcean has an action in progress, the address shows as **locked** and the assign and unassign buttons are hidden until it finishes.

Deleting a reserved IP releases it, and you won't get the same address back. You can only delete it once it's unassigned.

![DigitalOcean Reserved IP detail page for an unassigned address, showing the Assignment section with the "Billed while unassigned" row and the Assign to Droplet button in the header](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/reserved-ip-unassigned.png)

## VPCs

Every DigitalOcean account has a default VPC in each region, and everything you create lands in one. The **VPCs** sidebar group lists them all with region, IP range, description and default flag.

The [dependency graph](../features/dependency-graph.md) automatically connects Droplets, NFS shares (one edge per VPC they're exported to) and Dedicated Inference deployments to the VPC they're in.

To create a VPC, enter a name and a region. Leave **IP Range** blank and DigitalOcean picks a free `/20` that won't clash with your other networks, or set your own between `/28` and `/16` from the RFC1918 ranges. You can only delete a VPC when it's empty and isn't the region's default.

![DigitalOcean VPC detail page showing region, IP range and the default flag](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/vpc-detail.png)

## Load balancers

The create form asks for:

- A name, region and type (regional HTTP or regional network).
- Whether it's external or internal to its VPC.
- The node count.
- What it sends traffic to: specific Droplets (multi-select) or every Droplet with a tag (tag picker).
- The first forwarding rule and the health check. An HTTPS, HTTP/2 or HTTP/3 entry rule asks for a certificate from your account.

**Edit** changes the name, node count (DigitalOcean allows one resize per hour), HTTP idle timeout, HTTP-to-HTTPS redirect, PROXY protocol, backend keepalive and TLS cipher policy. Everything you don't change stays as it was.

The detail page lists the forwarding rules (each with **Remove**) and the health check. Header actions let you **+ Add rule** (including TLS passthrough), edit the **Health check**, and **+ Add Droplets** or **Remove Droplets** (only Droplets in the load balancer's region). The **Metrics** tab charts requests per second, responses by status class, connections and connection limit, load balancer CPU, HTTP, TCP and UDP throughput, TLS connections, firewall drops, backend response time (average, p50, p95, p99), session duration, queue size, backend connections, health checks per Droplet, and Droplet downtime.

A regional load balancer with no target Droplets and no tag is flagged by the [orphan finder](../features/orphan-finder.md), because DigitalOcean bills every node whether or not anything sits behind it.

<insert [DigitalOcean load balancer detail page showing the Forwarding Rules table, Health Check section and the Add rule / Add Droplets header actions] here>

## Cloud Firewalls

To create a firewall, enter:

- A name.
- Inbound rules, as rows of ports and protocol (leave ports blank for all ports).
- The addresses those rules accept traffic from (anywhere by default).
- Whether outbound traffic is allowed.
- The Droplets and tags to protect.

From the detail page you can add a rule in either direction with an **Allow** or **Deny** action, remove any rule, and apply the firewall to (or remove it from) Droplets and tags. **Edit** renames it. A firewall applied to nothing is flagged by the orphan finder.

## Networking services

- **NAT gateways** send a VPC's outbound traffic through one public egress IP, so Droplets without public interfaces can still reach the internet. Each size unit adds 2 Gbps of bandwidth and includes 100 GiB of outbound transfer a month. The egress IP is an output you can reference from other resources.
- **VPC peerings** connect two VPCs whose IP ranges don't overlap. Only the name can change after creation.

## App Platform

Apps are listed under their project with the state of the current deployment, the live URL and components. Create new apps in the DigitalOcean console, since that means writing an app spec against a Git or container source. Everything after that you can do here:

- **Deploy** starts a new deployment, and **Force rebuild** does the same without cached builds. **Restart…** restarts running instances without a build, for all components or the ones you pick.
- **Roll back…** redeploys an earlier successful deployment. While the app is pinned to a rollback, **Commit rollback** and **Revert rollback** appear.
- **Cancel deployment** appears while a deployment is in progress.
- The **App Spec** tab lets you edit the app spec as JSON. Applying it validates and redeploys the app.
- The **Logs** tab shows run, build, deploy and crashed-instance (`RUN_RESTARTED`) logs. Pick the type from the dropdown.
- The **Metrics** tab charts CPU, memory and restart count per component, plus the app's outbound bandwidth per UTC day (up to 31 days of the selected range).

<insert [DigitalOcean App Platform app detail page showing the Deployments table and the Deploy / Restart / Roll back header actions] here>

## Gradient AI Platform & Inference Engine

DigitalOcean's AI features come in two related products:

- **Gradient AI Platform** (formerly the GenAI Platform): agents, knowledge bases and the inference router.
- **Inference Engine**: serverless inference (`inference.do-ai.run/v1/…`), batch inference jobs and Dedicated Inference deployments.

Infrawrench groups them in the sidebar so you can manage agents, knowledge bases, routers, dedicated GPU deployments, batch jobs and model API keys side by side. They aren't tied to projects, so they appear as top-level groups under the account.

### Agents

An agent is a chat endpoint built from a foundation model, an instruction (system prompt), any knowledge bases, and optional function or agent routes. The create form asks for:

- **Name**: must be unique within the team.
- **Workspace**: every agent belongs to one. New accounts have none; leave the picker empty and a `default` workspace is created for you (like the DigitalOcean console), or click **+ New workspace** to name one.
- **Region**: only regions where Gradient AI runs are shown.
- **Model source**: either a **single foundation model** (Anthropic, OpenAI and DigitalOcean-hosted Meta models are listed) or an **Inference Router**. Pick an existing router, or click **+ New router** next to the picker to create one with a name, optional description and optional fallback models without leaving the form. You can use one or the other, not both.
- **Instruction**: the system prompt. Optional.

You can switch an existing agent between a model and a router at any time with **Edit Agent** on the detail page. The change takes effect immediately.

#### Agent detail page

The agent detail page covers what the DigitalOcean console's Overview, Observability and Resources tabs do:

- **Playground tab**: chat with the deployed agent, with replies streaming in live. The first time someone opens it, Infrawrench creates one `infrawrench-playground` access key for the agent and stores it encrypted. In the cloud workspace that key is shared across your org, and the secret stays on the server and is never shown to other users. Cmd/Ctrl+Enter sends, **Stop** cancels a reply, and **New chat** clears the history. Token usage appears under each reply when available.
- **Endpoint section**: the Deployment URL and the OpenAI-compatible base URL (`…/api/v1`), each with a copy button. The **Make Public** / **Make Private** header button changes who can reach the endpoint; its label always shows the action it will take, not the current state.
- **Embed section**: when the endpoint is public, you get DigitalOcean's chatbot widget `<script>` snippet to copy into your site's HTML. For private endpoints, the section reminds you to make the endpoint public first.
- **Endpoint Access Keys**: listed inside the agent. Create one from the agent's detail page; the secret is shown once and stored encrypted in your local secret store. Delete from the row's context menu.
- **Metrics tab**: input, output and total tokens, plus throughput (tokens/s), latency and time to first token, for the selected time range. Agents with no traffic show an empty state.
- **Knowledge Bases section**: every attached knowledge base, each with **Detach**. Attach one by dragging it onto the agent in the sidebar or with **+ Attach knowledge base** in the header.
- **Function Routes section**: each function route's name, FaaS target (`namespace/name`) and description, with **Detach**. **+ Add function route** asks for the function name, FaaS name and namespace, and optional input and output JSON Schemas.
- **Agent Routes (child agents) section**: routes from this agent to others, with optional `route_name` and `if_case`. **+ Route to child agent** opens a picker plus those two fields.
- **Settings**: **Edit Agent** changes the name, description, instruction, temperature, max_tokens, k, and the model or router.

The agent's deployment URL is available as the `deploymentUrl` output and the `agentEndpoint` alias. `agentEndpoint` is the OpenAI-compatible base URL, so you can paste it into any OpenAI SDK that takes a `baseURL`.

![DigitalOcean Agent detail page with deployment URL and attached knowledge bases visible](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/agent-detail.png)

### Knowledge Bases

Create a knowledge base from the sidebar group. The form asks for:

- **Name** and optional **tags**.
- **Region**: the same regions as agents.
- **Embedding model**.

Knowledge bases are stored in an OpenSearch vector database (the `database_id` field shows which cluster). The `retrievalEndpoint` output is the retrieval URL, `https://kbaas.do-ai.run/v1/{uuid}/retrieve`, which supports both semantic and keyword search.

You can edit the **Name** and **tags** from the detail page. Region and embedding model are fixed once created. The detail page also manages the content:

- **Data Sources**: every source feeding the index, with its last indexing status and **Reindex** and **Remove** on each row. Add sources from the header:
  - **+ Add Spaces source**: index files in a Spaces bucket. If the account has Spaces API keys, pick the bucket; otherwise type the bucket name and pick its region. An optional folder or object path limits indexing to part of the bucket.
  - **+ Add web source**: crawl a public website from a starting URL. Pick the crawl scope (Scoped, Path, Domain, Subdomains or Sitemap) and whether to index media. The crawler indexes up to about 5,500 pages.
- **Reindex all**: start an indexing job over every source. Existing content stays searchable while it runs.
- **Indexing Jobs**: recent indexing history with status, progress per source, token usage, and **Cancel** for jobs still pending or running.

Adding a source starts indexing on its own, so you only need **Reindex** when the bucket or website content changes.

File uploads and Dropbox or Google Drive sources still need the DigitalOcean console.

![DigitalOcean Knowledge Base detail page showing the data sources table, indexing jobs, and the add-source header actions](https://agent-assets.infrawrench.com/docs-screenshots/plugins/digitalocean/knowledge-base-detail.png)

### Inference Router

A router gives your app one endpoint and picks the cheapest model that can handle each prompt. Use one when:

- Your prompts **vary in difficulty** (some are easy for small models, some need frontier models).
- You want **automatic fallback** when a model is unavailable.

The create form takes a name, optional description and a **routing preset**. Presets fill the router with recommended models and routing policies. Pick "None" to create an empty router and set it up later. Routers run in all regions, so there's no region picker.

The router's detail page shows a **Routing Policies** table (each task, its candidate models, and whether it prefers the cheapest, fastest or a balanced option) and a **Fallback Models** table for requests that don't match a policy. Manage policies here:

- **+ Add policy** (header): pick a task, a preference (Balanced, Cheapest or Fastest), and the models it may use. Leave the models empty to use the task's recommended defaults.
- **Edit** (per row): change a policy's models or preference.
- **Remove** (per row): drop a policy so its requests go to the fallback models.

Tasks and models come from DigitalOcean's presets, so every choice is valid.

### Dedicated Inference

Dedicated Inference is the always-on GPU version of serverless inference. Use it when your traffic is steady, you have strict latency targets, or you want to bring your own model. The create form asks for:

- **Region**: only Gradient AI regions are shown.
- **GPU Size**: shows GPU count and monthly price.
- **Model**: pick from the list of models each GPU size supports, or paste a Hugging Face model ID to bring your own.
- **Public endpoint**: when on, you get both public and private VPC addresses; otherwise only the private one.
- **VPC**: optional; defaults to the region's default VPC.
- **Hugging Face token**: only needed for gated Hugging Face models.

When provisioning finishes, the `publicEndpointUrl` and `privateEndpointUrl` outputs are filled in.

<insert [DigitalOcean Dedicated Inference create form showing the GPU size picker with prices] here>

### Batch Inference

Batch jobs run large workloads against OpenAI or Anthropic in the background and return results within 24 hours, at a much lower cost than real-time inference. Infrawrench lists every batch job in the account, newest first, with provider, endpoint, status and request counts. You can **cancel** a job from its detail page but not edit it. Upload input files (JSONL) and download results in the DigitalOcean console or with the `inference.do-ai.run/v1/batches/files` endpoints.

### Model API Keys

These keys authenticate requests to `https://inference.do-ai.run/v1/*` (serverless inference, including OpenAI-compatible SDKs). DigitalOcean no longer lets you create them through the API, so create new keys in Model Studio. Infrawrench lists your existing keys and lets you delete them.

For the rest of the DigitalOcean API (`/v2/...`), keep using the personal access token you added when you connected the account.

The detail page shows **Name**, **Created By** and **Last Used**, with **Refresh** and delete. There's no secret to reveal; the key only exists in Model Studio. Don't confuse these with **Agent API Keys**, which do show a secret once.

<insert [DigitalOcean Model API Key detail page showing the Name / Created By / Last Used details and no secret value] here>

### Vector Databases (Weaviate / OpenSearch / PostgreSQL)

DigitalOcean's vector databases are in the **Managed Database** group. The engine picker includes:

- **Weaviate**: private preview; you need to sign up at digitalocean.com. Choosing it in a region without Weaviate returns a 422 error.
- **OpenSearch**: pair it with the [OpenSearch plugin](./opensearch.md) for indices, search and vector k-NN.
- **PostgreSQL** with `pgvector`, through the [Postgres plugin](./postgres.md).

Connection strings and CA certificates work the same way as other managed databases, so the same tabs and secret-export templates apply.

## Notable flows

- **SSH terminal** on Droplets.
- **Droplets in [Workflows](../features/workflows.md)**: `droplets.create({...})` autocompletes `region`, `size` and `image` with real values, and `sshPublicKey` autocompletes your Infrawrench SSH keys by name. Reach a new Droplet with `droplet.waitUntilReachable()` then `droplet.ssh("…", { sshKey: "<key name>" })` (full result or streamed).
- **SQL editor** on managed Postgres and MySQL, through the [Postgres](./postgres.md) and [MySQL](./mysql.md) plugins.
- **OpenSearch tab** on managed OpenSearch clusters (indices, search, snapshots) through the [OpenSearch plugin](./opensearch.md). The endpoint and CA cert are filled in for you.
- **File browser** on Spaces.
- **Secret export to K8s** for managed databases and Spaces.

## Tips & limits

- Creating a Droplet needs at least one SSH key. Upload one in DigitalOcean under **Settings > SSH keys** (not in Infrawrench), or use an existing key.
- DOKS kubeconfigs rotate from time to time. Refresh to get the latest one.

## Cost graphs

DigitalOcean accounts feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs by product and region.

- Your API token needs the `billing:read` scope, plus `account:read`.
- DigitalOcean's daily figures are nightly estimates and can differ slightly from the month-end invoice. Data is available from December 2025 onward.
