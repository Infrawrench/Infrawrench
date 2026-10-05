---
title: Google Cloud
description: Manage Compute Engine, GKE, Cloud SQL, App Engine, BigQuery, and GCS.
sidebar_order: 3
---

## What you can manage

- **Projects** — the GCP projects your service-account key can see, so surfaces can offer a picker instead of asking for a project ID.
- **Compute** — Compute Engine VM instances.
- **Kubernetes** — GKE clusters (links to the [Kubernetes plugin](./kubernetes.md)).
- **Databases** — Cloud SQL (Postgres, MySQL), AlloyDB (pick the PostgreSQL version, 14 to 18, at create time), and Memorystore for Redis, Memcached and **Valkey**.
- **Analytics** — BigQuery datasets and tables.
- **App hosting** — App Engine services, Cloud Run services and **Cloud Run jobs**.
- **Storage** — Cloud Storage buckets.
- **AI/ML** — Vertex AI endpoints and a curated list of Vertex AI Gemini chat models (Gemini 3.8, 3.7, 3.6 and 3.5 Flash, 3.5 and 3.1 Flash-Lite, the Gemini 3.1 Pro and 3 Flash previews, and Gemini 2.5).

Region pickers list every public Google Cloud region, including Mexico (`northamerica-south1`), Stockholm (`europe-north2`) and Bangkok (`asia-southeast3`). A service that is not offered in a region rejects it with an error naming the region. The VM image picker includes Debian 13 (Trixie).

## Credentials

Paste a **Service account key (JSON)** — download from GCP Console → IAM & Admin → Service Accounts → Keys → Add key. The service account needs the Viewer role (or equivalent read permissions) on the project, plus any roles required for the resources you want to manage (Compute Admin, Cloud SQL Admin, etc.).

You can optionally set a **Project ID** to override the project embedded in the key. Leave blank to use the project from the key file.

![GCP Add-account form with service account JSON textarea and optional project ID field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gcp/add-account.png)

### Credential preflight & least-privilege role

The add-account form (and **Check credentials** on the account page) tests the service account's permissions with a single `projects.testIamPermissions` call — see [Credential preflight](../core-concepts/credential-preflight.md):

- **Resource inventory** — a representative sample of the list permissions the plugin uses: `compute.instances.list`, `storage.buckets.list`, `container.clusters.list`, `cloudsql.instances.list`, `run.services.list`, `pubsub.topics.list`, `bigquery.datasets.get`, `secretmanager.secrets.list`.
- **Metrics & dashboards** — `monitoring.timeSeries.list` for the Metrics tabs and `logging.logEntries.list` for the Logs tabs.
- **Cost reporting** — `bigquery.jobs.create` and `bigquery.tables.getData`, plus the **Billing export table** field must be set; the checklist points at the [billing export setup](https://cloud.google.com/billing/docs/how-to/export-data-bigquery) when it isn't.

The generator emits a custom role definition in YAML — create it with `gcloud iam roles create infrawrench --project=YOUR_PROJECT --file=role.yaml` and grant it to the service account instead of the broad Viewer role. Cost reporting additionally needs the role (or **BigQuery Data Viewer**) on the billing export dataset itself.

### Each service's API has to be enabled

GCP ships every API switched off per project, and asking about a service that has never been turned on returns a permission error rather than an empty list. So a project using only Compute Engine will show sync errors for Cloud SQL, Spanner, Cloud Run, Secret Manager and the rest until those APIs are enabled — even though there is nothing there to list.

Infrawrench reports these as, for example:

> The Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled for project my-project. Enable it at https://console.cloud.google.com/apis/library/sqladmin.googleapis.com?project=my-project — it can take a few minutes to take effect.

Follow the link and click **Enable** for each service you want listed, or leave the rest disabled and ignore the warnings. Enabling an API you do not use costs nothing on its own.

## Notable flows

- **SSH terminal** on Compute Engine VMs — infrawrench injects your chosen SSH key via the instance metadata API.
- **SQL editor** on Cloud SQL (Postgres, MySQL, SQL Server) — direct connection to the instance's public IP using the embedded root password (see below).
- **File browser** on GCS buckets.
- **Secret export to K8s** for Cloud SQL and GCS (with service account key export as a secret).
- **Gemini Playground** on Vertex AI Gemini models — open any model under **AI/ML** and use the **Playground** tab to chat with it. Responses stream token-by-token through Vertex AI's OpenAI-compatible chat endpoint, authorized with the account's service account. The whole conversation history is sent on each turn. Requests go to Vertex AI's `global` endpoint, which serves every model in the list (the Gemini 3.x previews are only offered there). The service account needs the **Vertex AI User** role (`roles/aiplatform.user`) and the Vertex AI API enabled on the project.
- **Send test messages** to Pub/Sub topics and Cloud Tasks queues from a **Publish** / **Create task** tab on the detail page — see [Send test messages](../features/send-test-message.md). The service account needs `roles/pubsub.publisher` and `roles/cloudtasks.enqueuer` respectively.

![GCP Gemini model detail page with the Playground tab open, showing a streamed assistant reply](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gcp/gemini-playground.png)

## Cloud Run jobs

Cloud Run jobs run containers to completion instead of serving requests. Each job lists its image, task count, parallelism, retries, task timeout and the status of its latest execution.

- **Execute** on the detail page starts a new execution with the job's configuration. While the latest execution is pending or running, **Cancel execution** stops it.
- The **Executions** tab lists the 20 most recent executions with their status, tasks succeeded, and start and finish times.
- **Logs** reads the job's `cloud_run_job` entries from Cloud Logging, and **Metrics** charts completed and running executions and task attempts, p95 CPU and memory utilization, and billable instance time.
- **Create** takes a name, region (from Cloud Run's own region list), container image, tasks, parallelism, retries, timeout, CPU, memory and an optional service account from a picker.
- **Edit** changes the image, task count, parallelism, retries and timeout. Infrawrench reads the live job and changes only those values, so environment variables, secrets and volumes set elsewhere are kept.

The service account needs `run.jobs.list` to list jobs, `roles/run.developer` to create, edit or delete them, and `run.jobs.run` (in `roles/run.invoker`) to execute them.

<insert [Cloud Run job detail page with the Execute header action and the Executions tab listing recent runs] here>

## Memorystore for Valkey

Valkey instances, in cluster mode or with cluster mode disabled, are listed with their node type, shard and replica counts, engine version, authentication and in-transit encryption settings. The detail page shows the endpoint clients connect to (and the reader endpoint for cluster-mode-disabled instances with replicas), and the **Host**, **Port** and **Valkey URL** outputs can be exported as secrets. The URL uses `rediss://` when in-transit encryption is on.

- **Create** asks for the instance ID, region, VPC network (from a picker), mode, shard count (cluster mode only), replicas, node type (every type from shared-core-nano to highmem-2xlarge, with its vCPU and memory), Valkey version (9.1 is in Preview), authentication, in-transit encryption and deletion protection. The network needs a [service connection policy](https://cloud.google.com/memorystore/docs/valkey/networking) for Memorystore in that region before the instance can be created.
- **Edit** scales the node type, shard count and replicas per shard, upgrades the Valkey version, and toggles deletion protection. Only the fields you change are sent. Cluster-mode-disabled instances always keep exactly one shard.
- **Metrics** charts CPU and memory utilization, used memory, connected clients, commands, keys, keyspace hits and misses, evicted keys, and network in and out.

Listing needs `memorystore.instances.list` (in `roles/memorystore.viewer`); creating and editing need `roles/memorystore.admin`.

## Metrics and logs

The **Metrics** tab reads Cloud Monitoring and the **Logs** tab reads Cloud Logging, both scoped to the resource. Each chart combines every series the metric is split into (response codes, storage classes, replication roles, databases) into one line, so it shows the whole resource rather than one slice of it. Counters are charted as per-second rates, latency charts are the 95th percentile, and utilization is a 0 to 100 percent scale. Windows longer than about five hours are averaged into wider buckets so a 30-day range stays readable.

| Resource                             | Metrics                                                                                                                                                                        | Logs                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Compute Engine VM                    | CPU, network sent and received, disk read and write bytes and operations, memory used (e2 machine types only)                                                                  | Serial console, guest and Ops Agent logs            |
| GKE cluster                          | Node count, node CPU (allocatable), CPU cores in use, memory used, node network, container restarts                                                                            | Container, pod, node and cluster audit logs         |
| Cloud SQL                            | CPU, memory and disk utilization, disk used, connections (MySQL and SQL Server, or PostgreSQL backends), disk IO, network, MySQL queries, PostgreSQL transactions, replica lag | Database and audit logs                             |
| AlloyDB instance                     | CPU, available memory, connections, new connections, transactions                                                                                                              |                                                     |
| Cloud Run service and Cloud Function | Request rate, 5xx responses, p95 latency, instances, p95 CPU and memory, network, p95 startup latency, billable instance time                                                  | Revision logs                                       |
| Cloud Run job                        | See [Cloud Run jobs](#cloud-run-jobs)                                                                                                                                          | Job logs                                            |
| App Engine service                   | Responses, p95 latency, instances, estimated billed instances, memory, network                                                                                                 | `gae_app` logs for the service                      |
| Cloud Storage bucket                 | Total bytes and object count (including noncurrent and soft-deleted objects; measured once a day), API requests, bytes sent and received                                       |                                                     |
| BigQuery dataset                     | Stored bytes, table count, uploaded bytes                                                                                                                                      |                                                     |
| Spanner instance                     | CPU, storage used, nodes, processing units, sessions, API requests, p95 request latency                                                                                        |                                                     |
| Bigtable instance                    | CPU load and storage utilization of the busiest cluster, nodes, data stored, requests, errors, p95 server latency, bytes in and out                                            |                                                     |
| Filestore instance                   | Used space, free space, read and write operations and bytes, read and write latency (not on Basic tier)                                                                        |                                                     |
| Memorystore for Redis                | CPU in use, memory usage, connected clients, commands, cache hit ratio, keys, evicted keys, network traffic                                                                    |                                                     |
| Memorystore for Memcached            | CPU, hit ratio, items, active connections, operations, evictions, bytes in and out                                                                                             |                                                     |
| Memorystore for Valkey               | See [Memorystore for Valkey](#memorystore-for-valkey)                                                                                                                          |                                                     |
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

Charts only appear for series Cloud Monitoring has data for; a service with no traffic in the window shows fewer charts. The service account needs **Monitoring Viewer** (`roles/monitoring.viewer`) for metrics and **Logs Viewer** (`roles/logging.viewer`) for logs.

## Terraform export

[Eject to Terraform](../features/terraform-export.md) covers Cloud Storage buckets, VPC networks and subnets, GKE clusters, Pub/Sub topics, Cloud DNS zones, BigQuery datasets, Artifact Registry repositories, service accounts, Cloud Run jobs (`google_cloud_run_v2_job`; only the first container's image is exported) and Memorystore for Valkey instances (`google_memorystore_instance`).

## Cloud SQL connectivity

The PostgreSQL / MySQL / SQL Server tabs on a Cloud SQL instance connect directly to the instance's public IP using the root password Infrawrench stored at create time. To make this reachable from your machine you need to:

- Enable a public IP on the instance (Cloud SQL → this instance → Connections → Networking → Public IP). New instances created from Infrawrench have this enabled by default; the create modal exposes the toggle.
- Add your client IP (or `0.0.0.0/0` if you accept the risk) to **Authorized networks** on the same screen so Cloud SQL accepts the inbound connection.

If the instance has no public IP, the tab renders a static guidance pane explaining the options (add public IP, run Infrawrench inside the VPC, or set up Cloud VPN / IAP) — Infrawrench doesn't try to dial through a tunnel automatically.

## Tips & limits

- Service account keys never expire on Google's side, but rotating them is good hygiene — paste a new key any time.
- VM pricing is shown at creation time. It is an estimate — actual billing depends on sustained-use discounts and committed-use contracts.
- BigQuery results are paged; very large queries stream into the grid.

## Cost graphs

GCP has no cost API, so [cost graphs & budgets](../features/cloud-costs.md) read your Cloud Billing **BigQuery export**. This is a one-time setup done by a billing admin, and there is no API or `gcloud` equivalent — every step is in the console.

**1. Create the dataset the export writes into.** BigQuery → **Create dataset**, in the project you want to bill the queries to. Any name works (`billing_export` is conventional). The export cannot be enabled without an existing dataset.

**2. Turn on the export.** Open **Billing → Billing export** ([console.cloud.google.com/billing/export](https://console.cloud.google.com/billing/export)) and choose your Cloud Billing account if prompted, then:

- Open the **BigQuery export** tab.
- Click **Enable standard Export**. Each export type — FOCUS, standard, detailed — is enabled separately; Infrawrench reads the **standard usage cost** one.
- Pick your project from the **Projects** dropdown and your dataset from **Dataset ID**.
- Click **Save**. If the BigQuery API is not on yet, the page offers **Enable BigQuery API** first.

<insert [Cloud Billing "Billing export" page, BigQuery export tab, with the standard usage cost export enabled and showing the project and dataset it writes to] here>

**3. Copy the table name into Infrawrench.** The export creates a table named `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`, with the billing account's dashes turned into underscores. It appears a few hours after you save — not immediately — so come back once it exists. Paste the full `project.dataset.table` into the account's **Billing export table** field:

```
my-project.billing_export.gcp_billing_export_v1_012345_ABCDEF_678901
```

The service account needs `roles/bigquery.jobUser` on its project and `roles/bigquery.dataViewer` on the export dataset. Costs are net of credits, broken down by service, region, and project. Note the export only accumulates data from the day it is enabled — it is not retroactive, so cost graphs start there rather than covering the usual year of backfill.

Until all three steps are done, GCP cost graphs stay empty and the dashboard shows a banner saying so, linked straight to the billing export settings for this account's project — see [when collection fails](../features/cloud-costs.md#when-collection-fails).

Expect one more wait after that. The table is created before it holds anything, so a correctly configured export still returns no rows for its first day or two — Google backfills nothing and starts writing only once its billing pipeline catches up. During that window the account reports no error and the dashboard says [there is nothing to collect yet](../features/cloud-costs.md#when-there-is-nothing-to-collect-yet) rather than showing a failure. If it has been longer than that, confirm the export is still enabled and writing to the dataset you pasted — an export can create its table and then never deliver if it is turned off again.

### List prices

The query also sums the export's `cost_at_list` column, the cost at Google's public list price, which [managed accounts](../features/managed-accounts.md#re-rating-to-public-pricing) use when re-rating a customer's invoice to public pricing. A day/service group is only given a list price when every export row in it carried one (the column is populated from 29 June 2023). An export table old enough to lack the column is retried without it, so cost collection never depends on it.

## Commitments

GCP accounts feed the [Commitments](../features/commitments.md) section with **committed-use discounts**, listed daily via the Compute Engine commitments API (`compute.commitments.list`, included in `roles/compute.viewer` — no billing export required for this part).

Two things are specific to GCP here:

- A committed-use discount is denominated in **resource units** — vCPUs, GB of memory, local SSD — and Google's API reports **no money for it at all**. The row shows the committed units and "price not reported"; a substituted dollar figure would be an invention.
- Because the commitment is in units rather than dollars, its utilization cannot be derived from cost rows. It reads "not measurable from spend" rather than a percentage — deliberately, since 0% and "unknown" must not look alike.
