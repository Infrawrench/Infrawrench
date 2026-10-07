---
title: Weaviate Cloud
description: Manage the inside of a Weaviate cluster (collections, tenants, aliases, backups, database users and roles) on Weaviate Cloud or self-hosted, with node health and object counts.
sidebar_order: 51
---

Weaviate is an open-source vector database; Weaviate Cloud runs it for you. Weaviate Cloud has **no public management API**, so creating, resizing, upgrading and deleting clusters stays in the Weaviate Cloud console. What this plugin manages is everything inside a cluster, through the cluster's own REST API. It works the same against a self-hosted Weaviate.

Each account in Infrawrench is one cluster, and the account opens straight onto it.

## What you can manage

- **Cluster**: Weaviate version, hosting (Weaviate Cloud or self-hosted), cloud and region read from the endpoint, node health, total objects and shards, loaded modules, and a per-node table. The **REST URL**, **gRPC host** and API key are outputs, and the **Weaviate environment variables** export writes `WEAVIATE_URL` and `WEAVIATE_API_KEY` into a Kubernetes secret or a server's environment.
- **Collections**: vectorizer (or named vectors), vector index, properties with their types, tokenization and indexes, object count, shards and the vector indexing queue per shard, replication factor and multi-tenancy. Create a collection with a vectorizer picked from the modules the cluster has loaded, a vector index type, typed properties, replication and multi-tenancy. Edit the description, replication factor and automatic tenant creation and activation. Delete a collection.
- **Tenants** of multi-tenant collections: create several at once, switch between active, inactive and offloaded, or delete.
- **Aliases**: create an alias, repoint it at another collection without touching clients, or delete it.
- **Backups**: when the cluster has a backup module (`backup-gcs`, `backup-s3`, `backup-azure` or `backup-filesystem`), list backups with status, collections and size, start a backup of all or chosen collections, restore one, or cancel one in progress.
- **Database users** (RBAC): every user with roles, whether it is active, and when its key was last used. Create a user with roles picked from a list (its API key is kept as a sensitive output), change its roles, rotate its key, deactivate or reactivate it, or delete it. Users appear on the [access review](../features/access-review.md).
- **Roles** (RBAC): every role and the actions and scopes of its permissions. Custom roles can be deleted.

## Credentials

- **REST Endpoint**: in the [Weaviate Cloud console](https://console.weaviate.cloud/), open the cluster and copy the **REST Endpoint** from its details panel. For a self-hosted cluster, its base URL.
- **API Key**: in the cluster's details panel open **API Keys**, then **New key**, and copy the key (it is shown once). An **Admin** key, or the key of a user with the `admin` role, lets Infrawrench manage everything; a **ReadOnly** key lists everything but cannot change it. Leave it empty only for a self-hosted cluster with anonymous access.
- **CA certificate** (advanced): for a self-hosted cluster behind a private CA.

<insert [Weaviate Cloud Add-account form with the REST endpoint and API key fields] here>

## Metrics

Weaviate has no time-series API over REST, and Weaviate Cloud does not expose the Prometheus port. Each sync records the current values from the cluster's node status, and Infrawrench builds the history: objects, shards, healthy nodes and the vector indexing queue for the cluster, and objects, shards and queue per collection.

<insert [Weaviate collection detail page showing properties, shards and the Metrics tab] here>

## Limits and quirks

- No cluster lifecycle, billing, status feed or Terraform: Weaviate Cloud offers none of them programmatically, and its status page publishes no machine-readable feed.
- Aliases need Weaviate 1.32 or later, database users and roles need 1.30 or later with RBAC on. On older clusters those sections stay empty.
- A backup restore fails if a collection in it still exists on the cluster; delete or rename it first.
- Multi-tenancy is fixed when a collection is created.
- Weaviate shows a database user's key once. Users created or rotated from Infrawrench keep their key here; others do not.
