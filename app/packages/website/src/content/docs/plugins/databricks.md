---
title: Databricks
description: Manage Databricks compute, workflows, SQL, AI/BI, apps, model serving, vector search, Lakebase Postgres, and Unity Catalog.
sidebar_order: 18
---

## What you can manage

- Compute: clusters (start, restart, terminate, resize), node types, and cluster policies
- SQL warehouses (start, stop, edit size / scaling / auto-stop, with in-app SQL editor), saved SQL queries, and AI/BI dashboards
- Workspace assets: notebooks, files, directories, dashboards, and Git folders
- Model Serving endpoints (with a streaming chat **Playground**)
- Workflows: jobs (run now, cancel runs, recent run history) and Lakeflow Spark Declarative Pipelines, formerly Delta Live Tables (start an update, full refresh, stop)
- Unity Catalog: catalogs, schemas, tables, volumes, functions, and registered models
- Vector Search endpoints and indexes
- Databricks Apps (start, stop)
- Lakebase Postgres projects (create, edit, delete) and their branches
- Secret scopes (metadata only; secret values are never exposed by the API)

## Credentials

Databricks workspace → **User Settings → Developer → Access tokens → Generate new token**. You will need the workspace URL too.

![Databricks Add-account form with workspace URL and PAT fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/databricks/add-account.png)

## Notable flows

- **SQL editor** against a running SQL warehouse — results fetched via REST, not a persistent connection.
- **Cluster inventory** uses the current Clusters API, including paginated cluster listings, node types, and Spark-version-backed create pickers where the workspace grants access.
- **Job runs**: a job's detail page lists its last 10 runs (state, result, trigger, start time, duration). **Run now** triggers a run and **Cancel runs** cancels every active run.
- **Start / stop**: clusters, SQL warehouses and apps get Start / Stop (Terminate for clusters) buttons that follow their current state, and all three can go on [sleep/wake schedules](../features/sleep-schedules.md). Terminating a cluster keeps its configuration; deleting it from Infrawrench removes it permanently.
- **Editing compute**: the Edit button on a cluster resizes it (a fixed worker count, or Min / Max Workers to switch to autoscaling) without a restart. On a SQL warehouse it changes the name, size (2X-Small to 5X-Large), min / max clusters, auto-stop, Photon and spot policy; Infrawrench sends the warehouse's other settings back unchanged.
- **Serverless SQL warehouses**: pick **Serverless** as the type on create; Infrawrench creates a Pro warehouse with serverless compute enabled, which is what the API expects.
- **Pipelines**: **Start update** runs an incremental update, **Full refresh** recomputes every table (it asks first), and **Stop** halts the active update.
- **Catalog Explorer coverage** includes the Unity Catalog three-level namespace plus volumes, functions, and MLflow registered models.
- **AI/BI dashboards** use the current Lakeview dashboard API. Legacy SQL dashboards are deprecated by Databricks and are not treated as the primary dashboard surface.
- **Secret scopes** list scope names and backends, including Azure Key Vault metadata when Databricks returns it. Secret keys and values are not displayed.

## Model Serving

Model Serving endpoints show up as their own resource type. Each card lists the endpoint name, readiness state, task, and creator. The state reflects the endpoint's `ready` flag — `READY` means it can serve traffic.

### Playground

Open a Model Serving endpoint and switch to the **Playground** tab to chat with it directly. The endpoint must be OpenAI-compatible (chat completions). Each turn sends the full conversation to `serving-endpoints/{name}/invocations` with `stream: true`, and replies stream back token-by-token. Token usage is shown under the input when the endpoint reports it.

The Playground is disabled until the endpoint is `READY` — wait for it to come online and reload the tab.

![Databricks Model Serving endpoint detail page with the Playground tab open, showing a streamed assistant reply](https://agent-assets.infrawrench.com/docs-screenshots/plugins/databricks/serving-endpoint-playground.png)

## Lakebase Postgres

Lakebase projects are managed Postgres databases with autoscaling compute, scale-to-zero and copy-on-write branches, read through the Lakebase Postgres API. Databricks creates every new Lakebase database as a project, and is migrating older provisioned instances to projects.

- **Create** a project with a name, a permanent project ID, a Postgres version (16, 17 or 18; 17 is the default), the compute range in capacity units (CU), and how long compute waits idle before scaling to zero (or never).
- **Edit** the name, the default compute range, the scale-to-zero delay, and the restore window (48 to 840 hours of history for point-in-time restore and branching). Compute settings are the defaults for the project's endpoints.
- **Branches** list under each project with state, size, source branch and whether they are the default or protected. Non-default branches can be deleted; the default branch cannot.

## Tips & limits

- SQL warehouse must be running before queries work; starting one can take a minute.
- Catalog, volume, function, and registered-model browsing requires Unity Catalog permissions. The plugin skips catalogs or schemas the token cannot browse.
- The Playground only works with chat-completion-style serving endpoints; classic ML model endpoints that expect a different request shape won't respond.
- Workspace object inventory is intentionally shallow across the main workspace roots so large workspaces do not trigger a full recursive crawl.
- Cluster settings other than the worker count (Spark version, node type, auto-termination) need a full cluster edit and a restart; change those in the Databricks UI.

## Cost graphs

Databricks workspaces feed [cost graphs & budgets](../features/cloud-costs.md) from the `system.billing.usage` and `system.billing.list_prices` system tables, queried through a SQL warehouse — daily costs by product with per-cluster/warehouse attribution.

- The workspace must be Unity Catalog-enabled and the token's principal needs `USE CATALOG system` plus `SELECT` on the `system.billing` tables, and access to at least one SQL warehouse (a stopped warehouse will auto-start; queries are tiny).
- Dollars are DBUs × **list price** — contract discounts are not reflected. Underlying cloud infra (e.g. EC2 under your clusters) is never included; that spend belongs to your AWS/Azure/GCP account.
