---
title: Azure
description: Manage VMs, AKS, Container Apps, App Service, SQL Database, CosmosDB, Managed Redis, Azure OpenAI, and storage.
sidebar_order: 2
---

Connect an Azure subscription to browse, create and manage its resources.

## What you can manage

- **Compute**: Virtual Machines, App Service, Function Apps, App Service Plans, Container Instances.
- **Container Apps**: container apps, Container Apps jobs, and the Container Apps environments they run in.
- **Kubernetes**: AKS clusters (links to the [Kubernetes plugin](./kubernetes.md)).
- **Databases**: SQL Database, CosmosDB, PostgreSQL and MySQL flexible servers.
- **Caches**: Azure Cache for Redis and its successor, Azure Managed Redis.
- **AI**: Azure AI Foundry, Azure OpenAI and Azure AI services accounts, with their model deployments.
- **Storage**: Storage accounts (Blob, File, Queue, Table).
- **Networking**: VNets, Subnets, NSGs, Load Balancers, NAT gateways, Application gateways, Public IPs.
- **Security**: Key Vault (keys, secrets, certificates).

## Connect your account

1. In the Azure Portal, create a service principal: **Microsoft Entra ID > App registrations > New registration > Certificates & secrets > New client secret**.
2. Grant it the roles it needs on the subscription.
3. In Infrawrench, paste the **Tenant ID**, **Client ID**, **Client secret** and **Subscription ID**.

![Azure Add-account form with tenant / client / secret / subscription fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/azure/add-account.png)

## What you can do

- **Create resources**: 26 resource types from the create form: container apps, resource groups, VMs (the form creates the VNet, NIC, public IP and an NSG if you don't pick existing ones), managed disks, VNets (with a default subnet), NSGs, public IPs, load balancers, AKS clusters, storage accounts, SQL Database (on a new or existing server), Cosmos DB, PostgreSQL and MySQL flexible servers, Redis Cache, App Service, Function Apps, container instances, container registries, Key Vaults, Service Bus and Event Hub namespaces, Log Analytics workspaces, managed identities, DNS zones, and Entra ID app registrations (which also create the matching service principal).
- **Start, stop and restart** from the detail page header. The buttons match the resource's current state. This works on VMs (stop deallocates, restart reboots), AKS clusters, App Service and Function Apps, container instances, PostgreSQL and MySQL flexible servers, application gateways, and container apps. Container Apps jobs get a **Run now** button that starts one execution.
- **Sleep schedules** for every type above except jobs. See [Sleep schedules](../features/sleep-schedules.md). Each one uses the stop that halts compute billing, and the confirmation tells you what keeps billing.
- **SSH terminal** on Linux VMs.
- **SQL editor** on Azure SQL Database.
- **File browser** on Blob Storage.
- **Secret export to K8s** for SQL Database and Storage accounts.
- **Read-only manifest view** on every resource.
- **Send test messages** to queues or topics in a Service Bus namespace, and events to hubs in an Event Hub namespace, from the **Send** tab. See [Send test messages](../features/send-test-message.md). The service principal needs the **Azure Service Bus Data Sender** or **Azure Event Hubs Data Sender** role on the namespace.

## App Service Plans

App Service Plans are read-only. Infrawrench doesn't create them. Each plan shows its SKU, tier and size, its instance count, whether its workers are Linux or Windows, and how many apps use it. A dedicated plan with no apps is flagged by the [orphan finder](../features/orphan-finder.md). Free and Functions consumption tiers bill per execution, so they're never flagged.

Web apps and function apps link to their plan in the [dependency graph](../features/dependency-graph.md), so opening a plan shows everything it hosts.

The **Metrics** tab shows plan-wide CPU and memory percentage, disk and HTTP queue length, data in and out, established TCP connections and outbound sockets. Use these to decide when to scale, since one app's metrics don't show plan-level saturation.

![Azure App Service Plan detail page showing the SKU, tier and instance-count fields, with a Dependencies tab listing the web apps that run on the plan](https://agent-assets.infrawrench.com/docs-screenshots/plugins/azure/app-service-plan-detail.png)

## Container Apps

Container apps, Container Apps jobs and Container Apps environments are listed from the subscription. An app shows its image, CPU and memory, replica bounds, ingress (external, internal or disabled), target port, revisions mode and latest revision. It links to its environment, container registry and managed identities in the [dependency graph](../features/dependency-graph.md). Its public URL is an output.

### Create an app

Pick a resource group, an environment (the app is created in the environment's region), an image, a CPU and memory pair, ingress, target port and the replica range.

To pull a private image, pick an **Azure Container Registry**. The registry needs its admin user enabled, and its password is stored as an app secret. Leave it empty for public images, or when the app pulls with a managed identity that has AcrPull.

### Edit an app

You can change the image, CPU, memory, and minimum or maximum replicas of the app's first container. Everything else stays as it is, and Azure rolls out the change as a new revision. Set min replicas to 0 to let the app scale to zero.

### Metrics and logs

The **Metrics** tab shows CPU and memory (as a percentage of the limit and in absolute terms), requests, response time, replica count, restarts, network in and out, resiliency retries and timeouts, GPU utilization on GPU workload profiles, and JVM memory and garbage collections for Java apps. Jobs chart executions, CPU and memory used against what they requested, restarts and network traffic. Environments chart workload profile node count and the ingress pods' CPU and memory.

The **Logs** tab shows the same logs as `az containerapp logs show`. On an app, pick a replica's container from the dropdown for its console output, or **System events** for scaling, revision and probe events. An app scaled to zero has only system events. On an environment, the tab shows environment-wide system events. Each fetch returns up to the last 300 lines.

Jobs show their trigger (manual, schedule with its cron expression, or event), parallelism, timeout and retry limit. Environments show their default domain, static IP, workload profiles, zone redundancy, whether they're internal-only, and their infrastructure subnet.

<insert [Azure Container App detail page showing the image, CPU/memory, replica and ingress fields, the URL output, and Stop in the header] here>

## Azure Managed Redis

Azure Managed Redis clusters (`Microsoft.Cache/redisEnterprise`) are listed alongside Azure Cache for Redis, which Microsoft is retiring in their favour. Each cluster shows its SKU, Redis version, high availability and redundancy, minimum TLS version and public network access, plus its database settings: client protocol, clustering and eviction policies, modules, persistence, and whether access keys are accepted.

The hostname, port, primary key and a `rediss://` connection string are outputs, so the **Redis** tab, Kubernetes secret export and output references work the same as for Azure Cache for Redis. New clusters have **access keys disabled** by default (Microsoft Entra ID only), and the key outputs tell you so. To use keys, turn on access keys authentication on the cluster's database.

The **Metrics** tab shows CPU, server load, memory used, operations per second, cache hits and misses, latency, connected clients, evictions and key count.

[Posture checks](../features/posture-checks.md) flag a database that accepts plaintext connections, and a cluster with high availability disabled.

## AI services and Azure OpenAI

Azure AI Foundry, Azure OpenAI and other Azure AI services accounts (`Microsoft.CognitiveServices/accounts`) show their kind, SKU, endpoint, custom subdomain, network access, and every **model deployment** (name, model and version, deployment SKU and capacity).

The endpoint and an **API key** are outputs. The **Azure OpenAI** secret export template writes them as `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY`. Accounts with key authentication disabled are Entra ID only, and the key output says so.

The **Metrics** tab shows requests, prompt, completion and total tokens, time to response, availability and provisioned (PTU) utilization for OpenAI and Foundry models, and calls, errors and latency for other kinds. Posture checks flag accounts that still accept API keys.

## Metrics and logs

Every resource type has a **Metrics** tab from Azure Monitor, except resource groups, networking plumbing (VNets, subnets, NSGs, route tables), managed identities and app registrations. It needs only the **Reader** role. Metrics a resource's SKU or tier doesn't emit are hidden. Highlights beyond CPU and memory:

- **Virtual machines**: available memory percentage, B-series CPU credits, OS and data disk IOPS and bandwidth consumed, disk latency, VM-level cached and uncached IOPS consumed, inbound and outbound flows, and VM availability.
- **AKS clusters**: node CPU, memory, disk and network, ready pods, node conditions, unschedulable pods, and the control plane's API server CPU, memory and inflight requests and etcd database usage.
- **SQL Database**: CPU, DTU, serverless app CPU and memory, data and log IO, workers, sessions, successful, failed and firewall-blocked connections, deadlocks and availability.
- **PostgreSQL and MySQL flexible servers**: storage, IOPS and disk queue depth, failed or aborted connections, network in and out, CPU credits, replication lag, backup storage, transaction ID usage (PostgreSQL) and queries and slow queries (MySQL).
- **Cosmos DB**: requests, request units, normalized RU consumption, throttled requests, server-side latency, availability, provisioned and autoscaled throughput, data, index and document counts.
- **App Service and Function Apps**: requests, response time, HTTP 2xx/4xx/5xx, data in and out, health check status, queued requests, connections, instance count, and Flex Consumption's on-demand and always-ready executions.
- **Messaging**: Service Bus active, dead-lettered and scheduled messages, server and user errors, throttling, send latency and namespace CPU and memory. Event Hubs requests, errors, throttling, quota-exceeded errors, connections and Capture bytes and backlog.
- **Networking**: application gateway requests, failures, healthy hosts, total and backend response time, client RTT and capacity units. Load balancer SNAT connections and ports. NAT gateway dropped packets. Firewall health, throughput, SNAT port utilization and latency. Public IP DDoS status. DNS zone record-set and virtual network link counts.
- **Storage, registries and vaults**: storage server latency and availability. Container registry pulls and pushes (total and successful), data transfer and task run time. Key Vault API results and availability.
- **Log Analytics workspaces**: ingestion volume and time, query count, failed queries and query availability.

Container instances, container apps and Container Apps environments also have a **Logs** tab. For a container instance, it shows the selected container's recent output with timestamps. Azure keeps those logs only while the group is running.

## Idle resource findings

Once a day, Infrawrench checks your load balancers, NAT gateways and application gateways and adds idle ones to [Potential savings](../features/idle-resources.md). This needs `Microsoft.Insights/metrics/read`, which the Reader and Monitoring Reader roles include.

- **Load balancers**: Standard SKU with at least one rule (a balancer with no rules costs nothing), judged on `ByteCount`.
- **NAT gateways**: one attached to no subnet is flagged right away, since it bills by the hour either way. Otherwise judged on `ByteCount`.
- **Application gateways**: running v2 gateways, judged on `TotalRequests` and `HealthyHostCount`. Reserved capacity units cost extra on top of the estimate.

The fixes offered are `az network lb delete`, `az network nat gateway delete`, and `az network application-gateway stop` (then `delete`). Azure has no credential check in Infrawrench yet, so a missing-permission message appears on the Idle rules form instead.

## Run CI jobs

An Azure connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets a resource group of its own (`iwci-<kind>-<id>`), in the job's `cloud.region` (`eastus` when it names none), and the group and everything in it is deleted when the job ends:

| `cloud.kind` | Runs on                            | Default `machine` | Default `image`                               |
| ------------ | ---------------------------------- | ----------------- | --------------------------------------------- |
| `vm`         | A virtual machine with a public IP | `Standard_D2s_v5` | Ubuntu 24.04                                  |
| `container`  | A Container Instances group        | `2vcpu-4gb`       | `docker.io/library/buildpack-deps:noble-curl` |
| `build`      | An ACR Tasks run, with Docker      | `2vcpu`           | `docker.io/library/docker:cli`                |

A `vm` image other than the default is `publisher:offer:sku[:version]`. A container `machine` is `<vCPUs>vcpu-<GB>gb`. Container Instances runs x64 images only.

Nothing a job runs on has a managed identity. A VM's admin password is random and never kept, and no rule lets anything in to use it. An ACR Tasks run needs a registry, so each `build` job makes an empty Basic registry in its resource group, and the run is signed in only to that registry. A Basic registry is billed by the day, so each `build` job adds one day of a Basic registry to its cost. An ACR Tasks run lasts at most 8 hours.

Every job also stops on its own when its time is up: a VM has an auto-shutdown schedule at the job's deadline (for jobs under 23 hours), a container's command ends itself, and a run has ACR Tasks' own timeout. Azure free trial subscriptions can't run ACR Tasks.

Opting a connection in checks the roles assigned to the app registration at the subscription (or above) and names any action that is missing. Roles it holds through a group, or only on one resource group, aren't seen. **Contributor** on the subscription covers everything. The actions are:

- **Every kind**: `Microsoft.Resources/subscriptions/resourceGroups/write`, `/read` and `/delete`.
- **`vm`**: `Microsoft.Resources/deployments/write` and `/read`, `Microsoft.Network/virtualNetworks/write`, `Microsoft.Network/virtualNetworks/subnets/join/action`, `Microsoft.Network/publicIPAddresses/write` and `/join/action`, `Microsoft.Network/networkInterfaces/write` and `/join/action`, `Microsoft.Compute/virtualMachines/write` and `/read`, and `Microsoft.DevTestLab/schedules/write`.
- **`container`**: `Microsoft.ContainerInstance/containerGroups/write`, `/read` and `/delete`.
- **`build`**: `Microsoft.ContainerRegistry/registries/write`, `/read` and `/delete`, `Microsoft.ContainerRegistry/registries/scheduleRun/action`, `Microsoft.ContainerRegistry/registries/runs/read` and `Microsoft.ContainerRegistry/registries/runs/cancel/action`.

The check also names any resource provider the subscription hasn't registered (`Microsoft.Compute`, `Microsoft.Network`, `Microsoft.ContainerInstance` or `Microsoft.ContainerRegistry`).

## Tips and limits

- One account connects to one subscription. For tenants with several subscriptions, add one Infrawrench account per subscription.
- To use Key Vault, the service principal needs an access policy or RBAC role on the vault itself. The subscription role isn't enough.
- Some details take an extra read per resource: a VM's network addresses, an app registration's service principal, and the databases and deployments under Managed Redis and AI services. Each list makes at most 1,000 requests a poll, so on a very large subscription every resource is listed but only some get those details each time. Infrawrench starts from a different resource each poll, so the rest fill in over the next few, and a detail it could not read keeps its last value. If Azure starts throttling, the filling stops for that poll.
- SQL databases are the exception, since they can only be found by reading each server. A subscription with more SQL servers than fit in one poll fails that list with an error rather than showing part of it.

## Cost graphs

Azure subscriptions feed [cost graphs and budgets](../features/cloud-costs.md) from Cost Management, collected daily with service and region breakdowns (13 months of history).

- The service principal needs the **Cost Management Reader** role on the subscription. Plain **Reader** isn't enough.

### Charge types

Cost rows are split by **charge type**, so a month with a reservation purchase doesn't look like runaway usage.

| Azure charge type                                     | Shown as                 |
| ----------------------------------------------------- | ------------------------ |
| Usage, billed on demand                               | Usage                    |
| Usage, covered by a reservation or savings plan       | Commitment-covered usage |
| Purchase, when a reservation or savings plan backs it | Commitment fee           |
| Purchase, otherwise (Marketplace, support)            | Other                    |
| UnusedReservation, UnusedSavingsPlan                  | Commitment fee           |
| Refund                                                | Refund                   |
| Credit                                                | Credit                   |
| Tax                                                   | Tax                      |
| RoundingAdjustment                                    | Adjustment               |

Things to know:

- **Rows that aren't usage have no service and no region.** Azure reports purchases with "No service name" and "No resource location" anyway.
- **The charge types you see depend on your agreement.** Reservation and savings plan purchases and refunds belong to the billing account, so a subscription rarely shows them, and pay-as-you-go subscriptions never do. Enterprise Agreement accounts get no refund rows.
- **If your subscription doesn't support the breakdown, costs still work.** Only Enterprise Agreement and Microsoft Customer Agreement accounts support it. Otherwise every row shows as usage.

### Blended commitment discounts

Subscriptions that support amortized cost also report the [blended cost basis](../features/cloud-costs.md#blended). No extra role is needed beyond Cost Management Reader. A service whose covered usage can't all be priced keeps its amortized figures on the blended basis.

### Amortized cost and coverage

Azure gives two views of cost. **Actual cost** is like a bank statement: a reservation purchase lands in full on the day you paid, and usage it covers costs zero. **Amortized cost** spreads the purchase over its term, so covered hours show what they're actually worth. Infrawrench collects both, and shows the difference as commitment-covered usage on the amortized [cost basis](../features/cloud-costs.md#cash-amortized-and-blended).

This is what powers the [Commitments](../features/commitments.md) coverage figure for Azure. It doesn't need an Enterprise Agreement.

Two things follow:

- **A reservation purchase counts as zero on the amortized basis.** Its cost is already spread across the covered and unused hours, so counting it again would double it.
- **Unused commitment hours are shown too.** Azure reports wasted reservation and savings plan hours as `UnusedReservation` and `UnusedSavingsPlan`. They appear as commitment fees on the amortized basis only, so cash totals don't change. They don't count as covered usage, so an oversized reservation shows up as spend without lifting coverage or utilization.

**If your subscription doesn't support amortized cost, nothing breaks.** Pay-as-you-go subscriptions can't show amortized reservation costs, and Microsoft Online Services Agreement accounts have no commitment purchases. In that case all costs show as usage, and the amortized view matches cash.

### Upgrading from an earlier version

Nothing is required of you. Older days are corrected automatically the next time they're re-collected.

Earlier docs described a manual `ALTER TABLE cost_daily DELETE`. Don't run it. It's no longer needed.

![Cost graph for an Azure subscription grouped by charge type, showing a Usage series alongside a Commitment fee spike on a reservation purchase day](https://agent-assets.infrawrench.com/docs-screenshots/plugins/azure/cost-graph.png)

## Commitments

Azure accounts feed the [Commitments](../features/commitments.md) section with **reservations** and **savings plans**, refreshed daily.

- The service principal needs **Reader** on the reservations, or the **Reservations Reader** role at tenant scope. Reservation access is granted separately from subscription roles. Savings plans also need **Reader** on them (or **Savings plan Reader**). Without it, savings plans aren't listed, but reservations still are.
- **Savings plans show their hourly commitment** as a dollar figure, and utilization is measured against it.
- Azure doesn't report reservation purchase prices here, so reservations show "price not reported".
- Azure reports its **own utilization** (1, 7 and 30-day figures). These are labelled as provider-reported and shown next to, never mixed with, the utilization Infrawrench calculates from your costs.
- Savings plans apply across regions, so they show "All regions".
- **Coverage uses amortized figures**, since on cash figures covered usage costs nothing and every account would read 0%. See [Amortized cost and coverage](#amortized-cost-and-coverage). Subscriptions without amortized data are listed as excluded rather than counted as 0%.
- **Per-reservation utilization needs an Enterprise Agreement or Microsoft Customer Agreement.** Coverage doesn't. The provider-reported utilization figures are always available.

## Vulnerability findings

Azure accounts show **open container image vulnerabilities** found by **Microsoft Defender for Cloud** in the subscription's container registries. Each finding is one CVE in one package of one image, with the severity, CVSS score, installed and fixed versions, and exploit signals where Defender reports them.

- **Plan required.** Container image scanning only runs with the paid **Defender for Containers** or **Defender CSPM** plan and **Registry access** turned on (Defender for Cloud, Environment settings, the subscription, the plan's Settings). Without either, the account says scanning isn't enabled rather than showing "no vulnerabilities".
- **Permissions.** The **Reader** role on the subscription is enough. It covers `Microsoft.Security/assessments/read` and `Microsoft.Security/pricings/read`. CVSS scores come from a tenant-wide table. If the service principal can't see it, findings still appear with severity but no score.
- **Only open findings** are listed.
- **Linked to running resources.** Each finding names the image as `<registry login server>/<repository>` with its digest. It's matched against running **Container Apps** (every container and init container), **Container Apps jobs**, **Container Instances** groups, and **App Service** and **Function Apps** running a custom container (`DOCKER|` image). AKS workloads are matched through the Kubernetes integration.
- **Limits.** Up to 50,000 recommendations are read per subscription. Past that, the source shows an error and keeps the findings it last read. Defender doesn't rescan images that haven't been pushed or pulled in 30 days and aren't running in a monitored cluster, so their findings can be out of date.
