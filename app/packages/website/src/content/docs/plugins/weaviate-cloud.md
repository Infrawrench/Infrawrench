---
title: Weaviate Cloud
description: List and create Weaviate Cloud clusters, connect any number of Weaviate Cloud or self-hosted clusters to one account, and manage collections, tenants, aliases, backups, database users and roles inside them.
sidebar_order: 51
---

Weaviate is an open-source vector database, and Weaviate Cloud runs it for you. One Infrawrench account covers many clusters: the ones your Weaviate Cloud organization lists, plus any cluster you add by its endpoint, self-hosted ones included. Inside each connected cluster, you can manage collections, tenants, aliases, backups, database users and roles.

## Two kinds of credential

Weaviate Cloud splits management in two, and so does this plugin:

- **Your organization** (which clusters exist, creating new ones) needs you to sign in as your Weaviate Cloud user. There's no API key for it.
- **Inside a cluster** (collections and everything else) needs one of that cluster's API keys. Each cluster has its own keys, so each cluster is connected on its own.

You can use either without the other. A sign-in alone lists your clusters and lets you connect them one by one. Endpoints alone work for Weaviate Cloud and self-hosted clusters alike.

## Connect your account

- **Weaviate Cloud Sign-in** (optional): lists your organization's clusters and lets you create new ones. To get it:
  1. Install the official [wcloud CLI](https://github.com/weaviate/weaviate-cloud#install) (`brew install weaviate/tap/weaviate-cloud` or `npm install -g weaviate-cloud`).
  2. Run `wcloud auth login` and finish signing in in your browser.
  3. Open `wcloud/credentials.json` in your user config folder (`~/Library/Application Support` on macOS, `~/.config` on Linux, `%AppData%` on Windows) and paste its `refresh_token` value, or paste the whole file.

  Running `wcloud auth logout` afterwards ends this session, and the account stops listing clusters. If that happens, sign in again and paste the new token.

- **REST Endpoint** and **API Key** (optional): one cluster to connect directly. In the [Weaviate Cloud console](https://console.weaviate.cloud/), open the cluster and copy the **REST Endpoint** from its details panel. Then open **API Keys**, choose **New key** and copy it (it's shown once). An **Admin** key, or the key of a user with the `admin` role, lets Infrawrench manage everything. A **ReadOnly** key lists everything but can't change it. For a self-hosted cluster, use its base URL. Leave the key empty only if it allows anonymous access.
- **More Clusters** (optional): more clusters, one per line, written as the REST endpoint, a space, and the cluster's API key. Clusters you connect by endpoint from Infrawrench are added here, and deleting a line disconnects that cluster.
- **Self-Hosted Cluster Hosts** (advanced, optional): only for an account that goes through a [bastion](../features/bastion-vms.md). Pick the self-hosted clusters from **More Clusters** so the bastion lets their traffic through. Clusters on `weaviate.cloud` don't need picking. A bastion only reaches public addresses.
- **CA certificate** (advanced): for self-hosted clusters behind a private CA.

Fill in a sign-in, an endpoint, or both.

<insert [Weaviate Cloud Add-account form showing the Weaviate Cloud Sign-in, REST Endpoint, API Key and More Clusters fields] here>

## Clusters

The account opens on its clusters, side by side with their status:

- From your organization: name, cluster ID, tier, region and cloud, lifecycle status (creating, ready, suspended and so on, with Weaviate's reason if one failed), and when a free cluster expires.
- From the cluster itself, once connected: Weaviate version, node health, total objects and shards, loaded modules and a per-node table.
- **Connection**: whether the key comes from the account's credentials, from a key you connected, or is missing.

The **REST URL**, **gRPC host** and API key are outputs. The **Weaviate environment variables** export writes `WEAVIATE_URL` and `WEAVIATE_API_KEY` into a Kubernetes secret or a server's environment.

<insert [Weaviate Cloud account page listing several clusters with their tier, region, lifecycle and node health, one of them marked Not connected] here>

### Connect a listed cluster

A cluster your sign-in lists starts out **Not connected**, since Weaviate Cloud doesn't hand out cluster keys with the list.

1. Open the cluster and choose **Connect**.
2. Paste an Admin API key from the cluster's **API Keys** panel. Infrawrench checks it against the cluster before saving it.

**Replace API key** swaps it later, and **Disconnect** forgets it. The cluster itself keeps running.

Weaviate Cloud shows a new cluster's first API key exactly once. If nobody has seen it yet, leave the key empty in **Connect** and Infrawrench uses that one-time key.

### Add a cluster

**New cluster** offers two options:

- **Create a new Weaviate Cloud cluster** (needs a sign-in): pick a region your organization offers and the tier. Leave the name empty and Weaviate Cloud picks one. Only free sandbox clusters can be created this way (one collection, 100,000 objects, no backups or replication, one per user across all of their organizations). The new cluster appears once it's ready, usually a few minutes later, and connects itself with its one-time key.
- **Connect an existing cluster by endpoint**: paste a REST endpoint and API key. This works for any Weaviate, including self-hosted. Clusters your organization lists keep their key alongside them. Anything else is added to **More Clusters**.

<insert [New Weaviate cluster form with the region picker and the free tier selected] here>

## Inside a cluster

- **Collections**: vectorizer (or named vectors), vector index, properties with their types, tokenization and indexes, object count, shards and the vector indexing queue per shard, replication factor and multi-tenancy. Create a collection with a vectorizer picked from the modules the cluster has loaded, a vector index type, typed properties, replication and multi-tenancy. Edit the description, replication factor and automatic tenant creation and activation. Delete a collection.
- **Tenants** of multi-tenant collections: create several at once, switch between active, inactive and offloaded, or delete.
- **Aliases**: create an alias, point it at another collection without touching clients, or delete it.
- **Backups**: if the cluster has a backup module (`backup-gcs`, `backup-s3`, `backup-azure` or `backup-filesystem`), list backups with status, collections and size, back up all or chosen collections (**Back up now** on the cluster), restore one, or cancel one in progress.
- **Database users** (RBAC): every user with roles, whether it's active, and when its key was last used. Create a user with roles picked from a list (its API key is kept as a sensitive output), change its roles, rotate its key, deactivate or reactivate it, or delete it. Users appear on the [access review](../features/access-review.md).
- **Roles** (RBAC): every role and the actions and scopes of its permissions. You can delete custom roles.

Each of these lists objects from every connected cluster and names the cluster they belong to. Create them from inside the cluster you want them in.

## Metrics

Weaviate keeps no history Infrawrench can read, so Infrawrench records current values from each cluster and builds the charts from those: objects, shards, healthy nodes and the vector indexing queue per cluster, and objects, shards and queue per collection.

<insert [Weaviate collection detail page showing properties, shards and the Metrics tab] here>

## Limits and quirks

- **No resizing, upgrading or deleting clusters.** You can list clusters, see their status and create free clusters, with no version picker. Paid clusters, cluster changes, deletion, organization members, cluster API keys and billing stay in the [Weaviate Cloud console](https://console.weaviate.cloud/). There's no Weaviate Terraform provider either.
- Only ready clusters in the signed-in organization are listed. A cluster still being created, or in another of your organizations, doesn't appear until it's ready.
- There's no provider status, since status.weaviate.cloud has no machine-readable incident feed.
- Aliases need Weaviate 1.32 or later. Database users and roles need 1.30 or later with RBAC on. On older clusters, those sections stay empty.
- A backup restore fails if a collection in it still exists on the cluster. Delete or rename it first.
- Multi-tenancy is fixed when a collection is created.
- Weaviate shows a database user's key once. Users you create or rotate in Infrawrench keep their key here. Others don't.
