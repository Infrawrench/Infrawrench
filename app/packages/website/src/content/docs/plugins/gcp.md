---
title: Google Cloud
description: Manage Compute Engine, GKE, Cloud SQL, App Engine, BigQuery, and GCS.
sidebar_order: 3
---

Connect a Google Cloud project to work with its VMs, clusters, databases, storage, AI models and costs from one place.

## What you can manage

- **Projects**: the GCP projects your service account key can see, so you pick a project from a list instead of typing its ID.
- **Compute**: Compute Engine VM instances.
- **Kubernetes**: GKE clusters (see the [Kubernetes plugin](./kubernetes.md)).
- **Databases**: Cloud SQL (Postgres, MySQL), AlloyDB (you pick the PostgreSQL version, 14 to 18, when you create it), and Memorystore for Redis, Memcached and **Valkey**.
- **Analytics**: BigQuery datasets and tables.
- **App hosting**: App Engine services, Cloud Run services and **Cloud Run jobs**.
- **Storage**: Cloud Storage buckets.
- **AI/ML**: Vertex AI endpoints and a curated list of Vertex AI Gemini chat models (Gemini 3.8, 3.7, 3.6 and 3.5 Flash, 3.5 and 3.1 Flash-Lite, the Gemini 3.1 Pro and 3 Flash previews, and Gemini 2.5).

Region pickers list every public Google Cloud region, including Mexico (`northamerica-south1`), Stockholm (`europe-north2`) and Bangkok (`asia-southeast3`). If a service isn't offered in the region you pick, you'll get an error naming the region. The VM image picker includes Debian 13 (Trixie).

## Connect an account

Paste a **Service account key (JSON)**. To get one, go to GCP Console > IAM & Admin > Service Accounts > Keys > Add key. The service account needs the Viewer role (or equivalent read permissions) on the project, plus any roles for the resources you want to manage (Compute Admin, Cloud SQL Admin, and so on).

You can also set a **Project ID** to override the project in the key. Leave it blank to use the project from the key file.

![GCP Add-account form with service account JSON textarea and optional project ID field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gcp/add-account.png)

### Check permissions and use a least-privilege role

The add-account form, and **Check credentials** on the account page, test what your service account can do. See [Credential preflight](../core-concepts/credential-preflight.md). It checks:

- **Resource inventory**: a sample of the list permissions Infrawrench uses: `compute.instances.list`, `storage.buckets.list`, `container.clusters.list`, `cloudsql.instances.list`, `run.services.list`, `pubsub.topics.list`, `bigquery.datasets.get`, `secretmanager.secrets.list`.
- **Metrics and dashboards**: `monitoring.timeSeries.list` for the Metrics tabs and `logging.logEntries.list` for the Logs tabs.
- **[Idle resource findings](../features/idle-resources.md)**: `monitoring.timeSeries.list`, used to flag idle GKE clusters and Cloud NAT gateways.
- **Cost reporting**: `bigquery.jobs.create` and `bigquery.tables.getData`, plus the **Billing export table** field must be set. If it isn't, the checklist points you to the [billing export setup](https://cloud.google.com/billing/docs/how-to/export-data-bigquery).

The generator gives you a custom role definition in YAML. Create it with `gcloud iam roles create infrawrench --project=YOUR_PROJECT --file=role.yaml` and grant it to the service account instead of the broad Viewer role. For cost reporting, also grant the role (or **BigQuery Data Viewer**) on the billing export dataset itself.

### Enable each service's API

Google Cloud turns every API off by default in each project. If an API has never been enabled, Google returns a permission error instead of an empty list. So a project that only uses Compute Engine will show sync errors for Cloud SQL, Spanner, Cloud Run, Secret Manager and others until you enable those APIs, even though there's nothing there.

You'll see a message like this:

> The Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled for project my-project. Enable it at https://console.cloud.google.com/apis/library/sqladmin.googleapis.com?project=my-project, it can take a few minutes to take effect.

Follow the link and click **Enable** for each service you want listed, or leave the rest off and ignore the warnings. Enabling an API you don't use costs nothing on its own.

## What you can do

- **SSH terminal** on Compute Engine VMs. Infrawrench adds your chosen SSH key to the instance metadata.
- **SQL editor** on Cloud SQL (Postgres, MySQL, SQL Server). It connects directly to the instance's public IP with the root password (see [Connect to Cloud SQL](#connect-to-cloud-sql)).
- **File browser** on GCS buckets.
- **Secret export to K8s** for Cloud SQL and GCS (including exporting a service account key as a secret).
- **Gemini Playground** on Vertex AI Gemini models. Open any model under **AI/ML** and use the **Playground** tab to chat with it. Replies stream in as they're written, and the whole conversation is sent on each turn. Requests use Vertex AI's `global` endpoint, which serves every model in the list (the Gemini 3.x previews are only available there). The service account needs the **Vertex AI User** role (`roles/aiplatform.user`), and the Vertex AI API must be enabled on the project.
- **Send test messages** to Pub/Sub topics and Cloud Tasks queues from the **Publish** or **Create task** tab on the detail page. See [Send test messages](../features/send-test-message.md). The service account needs `roles/pubsub.publisher` and `roles/cloudtasks.enqueuer` respectively.

![GCP Gemini model detail page with the Playground tab open, showing a streamed assistant reply](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gcp/gemini-playground.png)

## Run Cloud Run jobs

Cloud Run jobs run containers to completion instead of serving requests. Each job shows its image, task count, parallelism, retries, task timeout and the status of its latest execution.

- **Execute** on the detail page starts a new execution with the job's settings. While the latest execution is pending or running, **Cancel execution** stops it.
- The **Executions** tab lists the 20 most recent executions with their status, tasks succeeded, and start and finish times.
- **Logs** shows the job's `cloud_run_job` entries from Cloud Logging. **Metrics** charts completed and running executions and task attempts, p95 CPU and memory utilization, and billable instance time.
- **Create** asks for a name, region (from Cloud Run's region list), container image, tasks, parallelism, retries, timeout, CPU, memory and an optional service account from a picker.
- **Edit** changes the image, task count, parallelism, retries and timeout. Only those values change, so environment variables, secrets and volumes you set elsewhere are kept.

The service account needs `run.jobs.list` to list jobs, `roles/run.developer` to create, edit or delete them, and `run.jobs.run` (in `roles/run.invoker`) to execute them.

<insert [Cloud Run job detail page with the Execute header action and the Executions tab listing recent runs] here>

## Manage Memorystore for Valkey

Valkey instances, with cluster mode on or off, show their node type, shard and replica counts, engine version, authentication and in-transit encryption settings. The detail page shows the endpoint clients connect to (and the reader endpoint for cluster-mode-disabled instances with replicas). You can export the **Host**, **Port** and **Valkey URL** outputs as secrets. The URL uses `rediss://` when in-transit encryption is on.

- **Create** asks for the instance ID, region, VPC network (from a picker), mode, shard count (cluster mode only), replicas, node type (every type from shared-core-nano to highmem-2xlarge, with its vCPU and memory), Valkey version (9.1 is in Preview), authentication, in-transit encryption and deletion protection. The network needs a [service connection policy](https://cloud.google.com/memorystore/docs/valkey/networking) for Memorystore in that region before you can create the instance.
- **Edit** scales the node type, shard count and replicas per shard, upgrades the Valkey version, and turns deletion protection on or off. Only the fields you change are sent. Cluster-mode-disabled instances always keep exactly one shard.
- **Metrics** charts CPU and memory utilization, used memory, connected clients, commands, keys, keyspace hits and misses, evicted keys, and network in and out.

Listing needs `memorystore.instances.list` (in `roles/memorystore.viewer`). Creating and editing need `roles/memorystore.admin`.

## Metrics and logs

The **Metrics** tab reads Cloud Monitoring and the **Logs** tab reads Cloud Logging, both for the resource you're looking at. Each chart shows the whole resource as one line, rather than one slice of it (one response code or one storage class, for example). Counters are shown as per-second rates, latency is the 95th percentile, and utilization is 0 to 100 percent. Longer time ranges are averaged into wider steps so a 30-day view stays readable.

| Resource                             | Metrics                                                                                                                                                                        | Logs                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Compute Engine VM                    | CPU, network sent and received, disk read and write bytes and operations, memory used (e2 machine types only)                                                                  | Serial console, guest and Ops Agent logs            |
| GKE cluster                          | Node count, node CPU (allocatable), CPU cores in use, memory used, node network, container restarts                                                                            | Container, pod, node and cluster audit logs         |
| Cloud SQL                            | CPU, memory and disk utilization, disk used, connections (MySQL and SQL Server, or PostgreSQL backends), disk IO, network, MySQL queries, PostgreSQL transactions, replica lag | Database and audit logs                             |
| AlloyDB instance                     | CPU, available memory, connections, new connections, transactions                                                                                                              |                                                     |
| Cloud Run service and Cloud Function | Request rate, 5xx responses, p95 latency, instances, p95 CPU and memory, network, p95 startup latency, billable instance time                                                  | Revision logs                                       |
| Cloud Run job                        | See [Run Cloud Run jobs](#run-cloud-run-jobs)                                                                                                                                  | Job logs                                            |
| App Engine service                   | Responses, p95 latency, instances, estimated billed instances, memory, network                                                                                                 | `gae_app` logs for the service                      |
| Cloud Storage bucket                 | Total bytes and object count (including noncurrent and soft-deleted objects; measured once a day), API requests, bytes sent and received                                       |                                                     |
| BigQuery dataset                     | Stored bytes, table count, uploaded bytes                                                                                                                                      |                                                     |
| Spanner instance                     | CPU, storage used, nodes, processing units, sessions, API requests, p95 request latency                                                                                        |                                                     |
| Bigtable instance                    | CPU load and storage utilization of the busiest cluster, nodes, data stored, requests, errors, p95 server latency, bytes in and out                                            |                                                     |
| Filestore instance                   | Used space, free space, read and write operations and bytes, read and write latency (not on Basic tier)                                                                        |                                                     |
| Memorystore for Redis                | CPU in use, memory usage, connected clients, commands, cache hit ratio, keys, evicted keys, network traffic                                                                    |                                                     |
| Memorystore for Memcached            | CPU, hit ratio, items, active connections, operations, evictions, bytes in and out                                                                                             |                                                     |
| Memorystore for Valkey               | See [Manage Memorystore for Valkey](#manage-memorystore-for-valkey)                                                                                                            |                                                     |
| Pub/Sub topic                        | Publish requests, p95 publish latency, byte cost, retained messages and bytes, oldest retained message age                                                                     |                                                     |
| Pub/Sub subscription                 | Undelivered messages, backlog size, oldest unacked age, sent and acked messages, p95 ack latency, pull and push requests, dead-lettered messages                               |                                                     |
| Cloud Tasks queue                    | Queue depth, task attempts, p95 attempt delay, API requests                                                                                                                    | Queue logs                                          |
| Cloud Scheduler job                  |                                                                                                                                                                                | Attempt logs                                        |
| Workflow                             | Started and finished executions, p95 execution time, execution backlog, internal errors, I/O steps                                                                             | Execution logs                                      |
| Dataflow job                         | vCPUs in use, system lag, data watermark lag, backlog, elements produced, total vCPU and memory time                                                                           | Job and worker logs                                 |
| Composer environment                 | Celery workers, unfinished and finished tasks, DAG bag size, DAG parse time, scheduler heartbeats, database CPU                                                                | Airflow logs                                        |
| Vertex AI endpoint                   | Predictions, errors, p95 prediction latency, replicas, CPU                                                                                                                     |                                                     |
| Backend service                      | Requests, 5xx responses, p95 backend and total latency, request and response bytes (external HTTP(S) load balancers)                                                           |                                                     |
| Cloud NAT                            | Port usage, open and new connections, bytes and packets sent and received, dropped packets                                                                                     |                                                     |
| Cloud Armor policy                   |                                                                                                                                                                                | Requests the policy evaluated on its load balancers |

Charts only appear when Cloud Monitoring has data, so a service with no traffic in the time range shows fewer charts. The service account needs **Monitoring Viewer** (`roles/monitoring.viewer`) for metrics and **Logs Viewer** (`roles/logging.viewer`) for logs.

## Idle resource findings

Once a day, Infrawrench checks your GKE clusters and Cloud NAT gateways and adds idle ones to [Potential savings](../features/idle-resources.md):

- **GKE clusters** are flagged when nothing ran outside the namespaces GKE manages (`kube-system`, `kube-public`, `kube-node-lease`, `gke-*`, `gmp-*`), or when the nodes averaged under 2% CPU. A Standard cluster with system metrics turned off can't be checked and is never flagged. The estimated saving is the $0.10 cluster-hour management fee plus the first node pool's nodes and boot disks at list price. One zonal or Autopilot cluster per billing account is covered by the free-tier credit. The fix is `gcloud container clusters delete`.
- **Cloud NAT gateways** are flagged when VMs are assigned to them but sent no traffic through them. These findings carry no estimate, because Cloud NAT bills per assigned VM and the VM count isn't available. The fix is `gcloud compute routers nats delete`.

Forwarding rules aren't checked. Unused static IPs are already flagged by the [orphan finder](../features/orphan-finder.md).

## Export to Terraform

[Eject to Terraform](../features/terraform-export.md) covers Cloud Storage buckets, VPC networks and subnets, GKE clusters, Pub/Sub topics, Cloud DNS zones, BigQuery datasets, Artifact Registry repositories, service accounts, Cloud Run jobs (`google_cloud_run_v2_job`; only the first container's image is exported) and Memorystore for Valkey instances (`google_memorystore_instance`).

## Connect to Cloud SQL

The PostgreSQL, MySQL and SQL Server tabs on a Cloud SQL instance connect directly to the instance's public IP, using the root password Infrawrench saved when the instance was created. To reach it from your machine:

1. Enable a public IP on the instance (Cloud SQL > your instance > Connections > Networking > Public IP). Instances you create from Infrawrench have this on by default, and the create form has the toggle.
2. Add your client IP (or `0.0.0.0/0` if you accept the risk) to **Authorized networks** on the same screen so Cloud SQL accepts the connection.

If the instance has no public IP, the tab explains your options: add a public IP, run Infrawrench inside the VPC, or set up Cloud VPN or IAP. Infrawrench doesn't tunnel through automatically.

## Just-in-time access

[Just-in-time access](../features/just-in-time-access.md) on Google Cloud gives the requester's Google account a project IAM binding with a **time-bound IAM Condition** (`request.time < timestamp("…")`), titled after the request. Google stops honouring the binding when the window ends. Infrawrench also removes it, and extending a grant updates the condition.

Each grant is its own conditional binding, so removing it never touches the person's existing, unconditional bindings for the same role. Google doesn't allow conditions on the basic roles (Owner, Editor, Viewer), so those aren't offered. Every predefined and custom role is. Google advises at most 100 conditional bindings per project policy, which limits how many grants can be live in one project at once.

The service account needs `resourcemanager.projects.getIamPolicy` and `resourcemanager.projects.setIamPolicy` on each target project (the Project IAM Admin role), `iam.roles.list` for the role picker, and `resourcemanager.projects.list` to offer projects other than its own.

## Tips and limits

- Service account keys never expire on Google's side, but rotating them is good practice. Paste a new key any time.
- VM pricing is shown when you create a VM. It's an estimate: your actual bill depends on sustained-use discounts and committed-use contracts.
- BigQuery results are paged, and very large queries stream into the grid.

## Set up cost graphs

Google Cloud has no cost API, so [cost graphs and budgets](../features/cloud-costs.md) read your Cloud Billing **BigQuery export**. A billing admin sets this up once, and every step is in the console (there's no API or `gcloud` equivalent).

**1. Create the dataset the export writes to.** In BigQuery, click **Create dataset** in the project you want to bill the queries to. Any name works (`billing_export` is common). You need the dataset before you can turn on the export.

**2. Turn on the export.** Open **Billing > Billing export** ([console.cloud.google.com/billing/export](https://console.cloud.google.com/billing/export)) and choose your Cloud Billing account if asked. Then:

- Open the **BigQuery export** tab.
- Click **Enable standard Export**. Each export type (FOCUS, standard, detailed) is enabled separately. Infrawrench reads the **standard usage cost** one.
- Pick your project from the **Projects** dropdown and your dataset from **Dataset ID**.
- Click **Save**. If the BigQuery API isn't on yet, the page offers **Enable BigQuery API** first.

<insert [Cloud Billing "Billing export" page, BigQuery export tab, with the standard usage cost export enabled and showing the project and dataset it writes to] here>

**3. Copy the table name into Infrawrench.** The export creates a table named `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`, with the dashes in the billing account ID turned into underscores. It appears a few hours after you save, so come back once it exists. Paste the full `project.dataset.table` into the account's **Billing export table** field:

```
my-project.billing_export.gcp_billing_export_v1_012345_ABCDEF_678901
```

The service account needs `roles/bigquery.jobUser` on its project and `roles/bigquery.dataViewer` on the export dataset. Costs are shown net of credits, broken down by service, region and project. The export only collects data from the day you enable it. It isn't retroactive, so your cost graphs start there instead of covering the usual year of history.

GCP accounts also show the [blended cost basis](../features/cloud-costs.md#blended), which spreads committed-use discount credits across the projects that used the covered SKUs, in proportion to cost. Day totals don't change. Newer spend-based discounts that price usage directly (without a credit) are shown as billed.

Until all three steps are done, GCP cost graphs stay empty and the dashboard shows a banner with a link to the billing export settings for this account's project. See [when collection fails](../features/cloud-costs.md#when-collection-fails).

Expect one more wait after that. A correctly set up export usually has no rows for its first day or two, because Google backfills nothing. During that time the account shows no error, and the dashboard says [there is nothing to collect yet](../features/cloud-costs.md#when-there-is-nothing-to-collect-yet). If it's been longer than that, check the export is still enabled and writing to the dataset you pasted. An export can create its table and then never deliver data if it's turned off again.

### List prices

Infrawrench also reads the export's `cost_at_list` column, the cost at Google's public list price. [Managed accounts](../features/managed-accounts.md#re-rating-to-public-pricing) use it to re-rate a customer's invoice to public pricing. A list price is only shown for a day and service when every row behind it has one (Google fills the column from 29 June 2023). Older export tables without the column still work for cost collection.

## Commitments

GCP accounts fill the [Commitments](../features/commitments.md) section with **committed-use discounts**, read daily from Compute Engine. This needs `compute.commitments.list` (included in `roles/compute.viewer`), and no billing export.

Two things are specific to Google Cloud:

- A committed-use discount is measured in **resource units** (vCPUs, GB of memory, local SSD), and Google reports no price for it. The row shows the committed units and "price not reported".
- Since the commitment is in units, not dollars, its utilization can't be worked out from spend. It reads "not measurable from spend" instead of a percentage, so it never looks like 0%.

## Vulnerability findings

GCP accounts show vulnerability findings from **Artifact Analysis**: the CVEs Google's scanner found in the project's Artifact Registry images (and language packages, when package scanning is on for a repository). For each affected package you see the CVE, the scanner's severity and CVSS score, the installed and fixed versions, whether a fix exists, and whether the CVE is on CISA's Known Exploited Vulnerabilities list. Findings Google has marked _not affected_ or _fixed_ are left out.

What you need:

- The **Container Scanning API** (`containerscanning.googleapis.com`) enabled on the project. Without it nothing is scanned. If the list comes back empty, Infrawrench checks whether this API is on and tells you, instead of reporting a clean project (that check uses `serviceusage.services.get`, which the Viewer role includes).
- The **Container Analysis API** (`containeranalysis.googleapis.com`) enabled.
- `containeranalysis.occurrences.list` on the project, in the **Container Analysis Occurrences Viewer** role (`roles/containeranalysis.occurrences.viewer`). The least-privilege role from the generator above doesn't include it, so add the permission or grant this role as well.

Findings are matched to what's running: **Cloud Run services and jobs** by their container images (every container, sidecars included), and GKE workloads through the Kubernetes plugin. A Cloud Run service deployed by tag matches on repository and tag. One deployed by digest matches exactly.

Limits: Infrawrench reads up to 20,000 findings per project, and marks the list as partial past that. Artifact Analysis only keeps rescanning images pulled in the last 30 days. Older images keep their last results, which can be out of date.
