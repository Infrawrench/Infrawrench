---
title: Databricks
description: Manage Databricks compute, workflows, SQL, AI/BI, apps, model serving, vector search, Lakebase Postgres, and Unity Catalog.
sidebar_order: 18
---

Connect a Databricks workspace to run its compute, jobs and SQL, chat with serving endpoints, browse Unity Catalog and track what it costs.

## What you can manage

- Compute: clusters (start, restart, terminate, resize), node types, and cluster policies
- SQL warehouses (start, stop, edit size, scaling and auto-stop, with an in-app SQL editor), saved SQL queries, and AI/BI dashboards
- Workspace assets: notebooks, files, directories, dashboards, and Git folders
- Model Serving endpoints (with a streaming chat **Playground**)
- Workflows: jobs (run now, cancel runs, recent run history) and Lakeflow Spark Declarative Pipelines, formerly Delta Live Tables (start an update, full refresh, stop)
- Unity Catalog: catalogs, schemas, tables, volumes, functions, and registered models
- Vector Search endpoints and indexes
- Databricks Apps (start, stop)
- Lakebase Postgres projects (create, edit, delete) and their branches
- Secret scopes (names and backends only; secret values are never shown)

## Connect your account

1. In your Databricks workspace, open **User Settings > Developer > Access tokens** and click **Generate new token**.
2. In Infrawrench, enter the token and your workspace URL.

![Databricks Add-account form with workspace URL and PAT fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/databricks/add-account.png)

## Work with compute, SQL and jobs

- **Run SQL** in the SQL editor against a running SQL warehouse.
- **Start and stop**: clusters, SQL warehouses and apps get Start and Stop buttons (Terminate for clusters) that follow their current state. All three can go on [sleep/wake schedules](../features/sleep-schedules.md). Terminating a cluster keeps its configuration. Deleting it from Infrawrench removes it permanently.
- **Resize a cluster**: the Edit button sets a fixed worker count, or Min and Max Workers to switch to autoscaling, without a restart.
- **Edit a SQL warehouse**: change the name, size (2X-Small to 5X-Large), min and max clusters, auto-stop, Photon and spot policy. Its other settings stay as they are.
- **Create a serverless SQL warehouse**: pick **Serverless** as the type when you create it.
- **Run jobs**: a job's detail page lists its last 10 runs (state, result, trigger, start time, duration). **Run now** starts a run and **Cancel runs** cancels every active run.
- **Run pipelines**: **Start update** runs an incremental update, **Full refresh** recomputes every table (it asks first), and **Stop** halts the active update.
- **Browse Unity Catalog**: catalogs, schemas and tables, plus volumes, functions and MLflow registered models.
- **AI/BI dashboards** are listed. Legacy SQL dashboards, which Databricks has deprecated, are not the main dashboard view.
- **Secret scopes** show scope names and backends, including Azure Key Vault details when Databricks returns them. Secret keys and values are never displayed.

## Model Serving

Model Serving endpoints have their own resource type. Each card shows the endpoint name, readiness state, task and creator. `READY` means the endpoint can serve traffic.

### Chat in the Playground

Open a Model Serving endpoint and switch to the **Playground** tab to chat with it. The endpoint must be OpenAI-compatible (chat completions). Replies stream back as they're generated, and token usage shows under the input when the endpoint reports it.

The Playground is disabled until the endpoint is `READY`. Wait for it to come online and reload the tab.

![Databricks Model Serving endpoint detail page with the Playground tab open, showing a streamed assistant reply](https://agent-assets.infrawrench.com/docs-screenshots/plugins/databricks/serving-endpoint-playground.png)

## Metrics and logs

| Resource         | Metrics tab                                                                                                                        | Logs tab                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Cluster          | Workers and target workers over time; CPU, CPU I/O wait and memory used %, network in and out per minute                           | The cluster event log: creation, resizes, restarts, terminations and why |
| SQL warehouse    | Queries, failed queries, average query duration and data read per interval                                                         |                                                                          |
| Job              | Duration, queue time and failure of each run in the window                                                                         |                                                                          |
| Serving endpoint | CPU and memory %, requests, 4xx and 5xx errors, provisioned concurrency, average request latency, inference latency and queue time | Server logs and build logs for each served model                         |
| Pipeline         |                                                                                                                                    | The pipeline event log, with error messages under failed events          |

- **Cluster CPU, memory and network** need `USE CATALOG system` and `SELECT` on `system.compute`, plus a SQL warehouse that is **already running**. Opening the Metrics tab never starts a warehouse. With none running, the tab shows the worker count only. Databricks records this data with a delay, so the last few minutes can be missing.
- **Serving endpoint** charts fill in over time while you have the endpoint open, because Databricks only reports current values.
- **SQL warehouse query history** reaches back at most 30 days and charts up to the 5,000 most recent queries in the window.
- Logs for foundation model and external model entities aren't available. The Logs tab says so.

## Lakebase Postgres

Lakebase projects are managed Postgres databases with autoscaling compute, scale-to-zero and copy-on-write branches. Databricks creates every new Lakebase database as a project and is moving older provisioned instances to projects.

- **Create** a project with a name, a permanent project ID, a Postgres version (16, 17 or 18; 17 is the default), the compute range in capacity units (CU), and how long compute waits idle before scaling to zero (or never).
- **Edit** the name, the default compute range, the scale-to-zero delay, and the restore window (48 to 840 hours of history for point-in-time restore and branching). Compute settings are the defaults for the project's endpoints.
- **Branches** are listed under each project with state, size, source branch and whether they are the default or protected. You can delete any branch except the default one.

## Export costs into Unity Catalog

A Databricks workspace can be the destination of a [scheduled cost export](../features/cost-exports.md#destination-snowflake-or-databricks-table). Infrawrench loads its cost rows into a Unity Catalog table you pick (or creates it as a Delta table) through a SQL warehouse, replacing each exported period. The token's principal needs USE CATALOG, USE SCHEMA and CREATE TABLE on the schema, plus CAN USE on the warehouse. The export dialog prints the GRANT statements for you.

## Tips & limits

- A SQL warehouse must be running before queries work. Starting one can take a minute.
- Browsing catalogs, volumes, functions and registered models needs Unity Catalog permissions. Catalogs or schemas your token can't browse are skipped.
- The Playground only works with chat completion style serving endpoints. Classic ML model endpoints that expect a different request shape won't respond.
- The workspace view covers the main workspace folders rather than every nested folder, so large workspaces stay fast.
- Cluster settings other than the worker count (Spark version, node type, auto-termination) need a full edit and a restart. Change those in the Databricks UI.

## Cost graphs

Databricks workspaces feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs by product, attributed to each cluster and warehouse. Costs are read from the `system.billing.usage` and `system.billing.list_prices` system tables through a SQL warehouse.

- The workspace must have Unity Catalog enabled. The token's principal needs `USE CATALOG system`, `SELECT` on the `system.billing` tables, and access to at least one SQL warehouse. A stopped warehouse will start automatically; the queries are tiny.
- Dollars are DBUs × **list price**, so contract discounts aren't reflected. The cloud infrastructure under your clusters (for example EC2) is never included. That spend shows up in your AWS, Azure or GCP account.
