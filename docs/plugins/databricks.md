---
title: Databricks
description: Manage Databricks clusters, SQL warehouses, jobs, and catalogs.
sidebar_order: 18
---

## What you can manage

- Clusters
- SQL warehouses (with in-app SQL editor)
- Jobs
- Unity Catalog: catalogs, schemas, tables

## Credentials

Databricks workspace → **User Settings → Developer → Access tokens → Generate new token**. You will need the workspace URL too.

<insert [Databricks Add-account form with workspace URL and PAT fields] here>

## Notable flows

- **SQL editor** against a running SQL warehouse — results fetched via REST, not a persistent connection.
- **Cluster start / stop** for interactive clusters.
- **Job runs** list with status and links out to the Databricks UI for detailed logs.

## Tips & limits

- SQL warehouse must be running before queries work; starting one can take a minute.
- Catalog browsing requires Unity Catalog; legacy hive_metastore workspaces show only the default catalog.
