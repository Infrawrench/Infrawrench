---
title: Databricks
description: Manage Databricks clusters, SQL warehouses, jobs, and catalogs.
sidebar_order: 18
---

## What you can manage

- Clusters
- SQL warehouses (with in-app SQL editor)
- Model Serving endpoints (with a streaming chat **Playground**)
- Jobs
- Unity Catalog: catalogs, schemas, tables

## Credentials

Databricks workspace → **User Settings → Developer → Access tokens → Generate new token**. You will need the workspace URL too.

<insert [Databricks Add-account form with workspace URL and PAT fields] here>

## Notable flows

- **SQL editor** against a running SQL warehouse — results fetched via REST, not a persistent connection.
- **Cluster start / stop** for interactive clusters.
- **Job runs** list with status and links out to the Databricks UI for detailed logs.

## Model Serving

Model Serving endpoints show up as their own resource type. Each card lists the endpoint name, readiness state, task, and creator. The state reflects the endpoint's `ready` flag — `READY` means it can serve traffic.

### Playground

Open a Model Serving endpoint and switch to the **Playground** tab to chat with it directly. The endpoint must be OpenAI-compatible (chat completions). Each turn sends the full conversation to `serving-endpoints/{name}/invocations` with `stream: true`, and replies stream back token-by-token. Token usage is shown under the input when the endpoint reports it.

The Playground is disabled until the endpoint is `READY` — wait for it to come online and reload the tab.

<insert [Databricks Model Serving endpoint detail page with the Playground tab open, showing a streamed assistant reply] here>

## Tips & limits

- SQL warehouse must be running before queries work; starting one can take a minute.
- Catalog browsing requires Unity Catalog; legacy hive_metastore workspaces show only the default catalog.
- The Playground only works with chat-completion-style serving endpoints; classic ML model endpoints that expect a different request shape won't respond.
