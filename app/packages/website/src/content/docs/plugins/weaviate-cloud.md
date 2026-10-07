---
title: Weaviate Cloud
description: List and create Weaviate Cloud clusters, connect any number of Weaviate Cloud or self-hosted clusters to one account, and manage collections, tenants, aliases, backups, database users and roles inside them.
sidebar_order: 51
---

Weaviate is an open-source vector database; Weaviate Cloud runs it for you. One Infrawrench account covers many clusters: the ones your Weaviate Cloud organization lists, plus any cluster you add by its endpoint, self-hosted ones included. Inside each connected cluster, Infrawrench manages collections, tenants, aliases, backups, database users and roles through the cluster's own REST API.

## Two halves, two kinds of credential

Weaviate Cloud splits management in two, and so does this plugin:

- **The organization** (which clusters exist, creating new ones) goes through Weaviate Cloud's provisioning API, the one Weaviate's official `wcloud` CLI uses. It signs in with your Weaviate Cloud user, not an API key.
- **Inside a cluster** (collections and everything else) goes through that cluster's REST endpoint with one of its API keys. Each cluster has its own keys, so each cluster is connected on its own.

You can use either half without the other: a sign-in alone lists your clusters and lets you connect them one by one; endpoints alone work exactly like before, for Weaviate Cloud and self-hosted clusters alike.

## Credentials

- **Weaviate Cloud Sign-in** (optional): lists your organization's clusters and lets you create new ones. Weaviate Cloud has no organization API keys; it only accepts a signed-in user. To get one:
  1. Install the official [wcloud CLI](https://github.com/weaviate/weaviate-cloud#install) (`brew install weaviate/tap/weaviate-cloud` or `npm install -g weaviate-cloud`).
  2. Run `wcloud auth login` and finish the sign-in in your browser.
  3. Open `wcloud/credentials.json` in your user config folder (`~/Library/Application Support` on macOS, `~/.config` on Linux, `%AppData%` on Windows) and paste its `refresh_token` value, or paste the whole file.

  Running `wcloud auth logout` afterwards revokes this session, so the account stops listing clusters. If that happens, sign in again and paste the new token.

- **REST Endpoint** and **API Key** (optional): one cluster to connect directly. In the [Weaviate Cloud console](https://console.weaviate.cloud/), open the cluster, copy the **REST Endpoint** from its details panel, then open **API Keys**, choose **New key** and copy it (it is shown once). An **Admin** key, or the key of a user with the `admin` role, lets Infrawrench manage everything; a **ReadOnly** key lists everything but cannot change it. For a self-hosted cluster, use its base URL; leave the key empty only when it allows anonymous access.
- **More Clusters** (optional): further clusters, one per line, written as the REST endpoint, a space, and the cluster's API key. Clusters you connect by endpoint from Infrawrench are added here, and deleting a line disconnects that cluster.
- **CA certificate** (advanced): for self-hosted clusters behind a private CA.

Fill in a sign-in, an endpoint, or both.

<insert [Weaviate Cloud Add-account form showing the Weaviate Cloud Sign-in, REST Endpoint, API Key and More Clusters fields] here>

## Clusters

The account opens to its clusters, shown side by side with their status:

- From the organization: name, cluster ID, tier, region and cloud, lifecycle status (creating, ready, suspended and so on, with Weaviate's reason when one failed), and when a free cluster expires.
- From the cluster itself, once it is connected: Weaviate version, node health, total objects and shards, loaded modules and a per-node table.
- **Connection**: whether the key comes from the account's credentials, from a key you connected, or is missing.

The **REST URL**, **gRPC host** and API key are outputs, and the **Weaviate environment variables** export writes `WEAVIATE_URL` and `WEAVIATE_API_KEY` into a Kubernetes secret or a server's environment.

<insert [Weaviate Cloud account page listing several clusters with their tier, region, lifecycle and node health, one of them marked Not connected] here>

### Connect a listed cluster

A cluster the sign-in lists starts out **Not connected**: the organization API can list clusters but cannot hand out their keys. Open it and choose **Connect**, then paste an Admin API key from the cluster's **API Keys** panel. Infrawrench checks the key against the cluster before keeping it. **Replace API key** swaps it later and **Disconnect** forgets it; the cluster itself keeps running.

Weaviate Cloud shows a new cluster's first API key exactly once. If nobody has seen it yet, leave the key empty in **Connect** and Infrawrench takes that one-time key instead.

### Add a cluster

**New cluster** offers two things:

- **Create a new Weaviate Cloud cluster** (needs a sign-in): pick a region from the ones your organization offers and the tier; leave the name empty and Weaviate Cloud picks one. Weaviate Cloud's provisioning API only creates free sandbox clusters (one collection, 100,000 objects, no backups or replication, one per user across all of their organizations). The new cluster appears once it is ready, usually a few minutes later, and connects itself with its one-time key.
- **Connect an existing cluster by endpoint**: paste a REST endpoint and API key. This works for any Weaviate, including self-hosted. Clusters your organization lists are connected with their key kept beside them; anything else is written into **More Clusters**.

<insert [New Weaviate cluster form with the region picker and the free tier selected] here>

## Inside a cluster

- **Collections**: vectorizer (or named vectors), vector index, properties with their types, tokenization and indexes, object count, shards and the vector indexing queue per shard, replication factor and multi-tenancy. Create a collection with a vectorizer picked from the modules the cluster has loaded, a vector index type, typed properties, replication and multi-tenancy. Edit the description, replication factor and automatic tenant creation and activation. Delete a collection.
- **Tenants** of multi-tenant collections: create several at once, switch between active, inactive and offloaded, or delete.
- **Aliases**: create an alias, repoint it at another collection without touching clients, or delete it.
- **Backups**: when the cluster has a backup module (`backup-gcs`, `backup-s3`, `backup-azure` or `backup-filesystem`), list backups with status, collections and size, start a backup of all or chosen collections (**Back up now** on the cluster), restore one, or cancel one in progress.
- **Database users** (RBAC): every user with roles, whether it is active, and when its key was last used. Create a user with roles picked from a list (its API key is kept as a sensitive output), change its roles, rotate its key, deactivate or reactivate it, or delete it. Users appear on the [access review](../features/access-review.md).
- **Roles** (RBAC): every role and the actions and scopes of its permissions. Custom roles can be deleted.

Each of these lists every connected cluster's objects and names the cluster they belong to. Create them from inside the cluster they belong in.

## Metrics

Weaviate has no time-series API over REST, and Weaviate Cloud does not expose the Prometheus port. Each sync records the current values from each cluster's node status, and Infrawrench builds the history: objects, shards, healthy nodes and the vector indexing queue per cluster, and objects, shards and queue per collection.

<insert [Weaviate collection detail page showing properties, shards and the Metrics tab] here>

## Limits and quirks

- **No resizing, upgrading or deleting clusters.** Weaviate Cloud's provisioning API (beta) lists clusters, reports their status and creates free clusters; it has no routes for anything else, and no version picker. Paid clusters, changes to a cluster, deletion, organization members, cluster API keys and billing stay in the [Weaviate Cloud console](https://console.weaviate.cloud/). There is no Weaviate Terraform provider either.
- The organization API lists only clusters that are ready, and only the signed-in organization's. A cluster that is still being created, or that sits in another of your organizations, does not appear until it does.
- No status feed: status.weaviate.cloud publishes no incidents in a machine-readable form.
- Aliases need Weaviate 1.32 or later, database users and roles need 1.30 or later with RBAC on. On older clusters those sections stay empty.
- A backup restore fails if a collection in it still exists on the cluster; delete or rename it first.
- Multi-tenancy is fixed when a collection is created.
- Weaviate shows a database user's key once. Users created or rotated from Infrawrench keep their key here; others do not.
