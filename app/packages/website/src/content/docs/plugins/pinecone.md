---
title: Pinecone
description: Manage Pinecone serverless and pod-based indexes, read capacity, backups, backup schedules, restores, collections and assistants, plus projects, API keys and service accounts through the Admin API.
sidebar_order: 51
---

Pinecone is a managed vector database. This plugin covers its control plane: the indexes in a project and everything around them (read capacity, deletion protection, tags, backups, restores, collections), Pinecone Assistant, and, when you add a service account, the organization's projects, API keys and service accounts.

## What you can manage

- **Indexes**: serverless (managed), BYOC and pod-based indexes, with status, kind (dense vectors, sparse vectors, integrated embedding, or document indexes with full-text search fields), dimension, metric, embedding model, cloud and region, host, record and namespace counts, and a namespaces table. Edit deletion protection, tags, and read capacity: switch between on-demand and dedicated read nodes, and change the node type, replicas and shards. On pod-based indexes edit replicas and pod size. Create serverless indexes for your own dense or sparse vectors, or with integrated embedding where Pinecone embeds your text with a hosted model you pick from a list. Take a backup or save a pod-based index as a collection from the index page.
- **Backups**: every backup in the project, with its source index, record and namespace counts, size and status. Create one for any serverless index, restore one into a new index, or delete it. A backup whose source index has been deleted shows on the [Potential savings](../features/orphan-finder.md) page.
- **Backup schedules**: daily, weekly or monthly automatic backups per serverless index. Change the frequency and retention, or pause and resume the schedule from its Edit form. The detail page lists the backups the schedule has taken and the next one it will take.
- **Restore jobs**: progress and status of every restore into a new index.
- **Collections**: static copies of pod-based indexes. Create (pick the source index) and delete.
- **Assistants**: status, region, instructions and metadata, and the files uploaded to each assistant. Create an assistant, edit its instructions and metadata, delete it, and chat with it from the **Chat** tab with a choice of model.
- **Projects** (service account only): rename, change the pod limit, turn on CMEK enforcement, create and delete.
- **API keys** (service account only): every project's keys with their roles. Create a key with roles picked from a list, change its name or roles, or delete it. A key created from Infrawrench keeps its value as a sensitive output; Pinecone shows a key once, so keys created elsewhere have no value here.
- **Service accounts** (service account only): rename, create, delete, and rotate the client secret. The new secret is kept as a sensitive output.

Indexes, models, regions, projects and roles are all pickers; you never type an id.

Each index exposes its name, host URL and the project API key as outputs, and the **Pinecone environment variables** export writes `PINECONE_API_KEY`, `PINECONE_INDEX` and `PINECONE_HOST` into a Kubernetes secret or a server's environment.

## Credentials

- **API key** (required): a project API key from the Pinecone console. Open the project, then **API keys**, then **Create API key**. The default **ProjectEditor** role lets Infrawrench manage everything in the project; **ProjectViewer** is enough for read-only use. One account covers one project.
- **Service account client ID and secret** (optional): add these to manage projects, API keys and service accounts. In the console open **Organization settings**, **Access**, **Service accounts**, create one with the **Organization Owner** or **Organization Manager** role, and copy the client ID and the secret (shown once).
- **Project** (optional): the project the API key belongs to. With a service account it is a picker; otherwise copy the id from the console URL after `/projects/`. It turns on the Prometheus metrics and the pod quota below.

<insert [Pinecone Add-account form showing the API key, service account and project fields] here>

## Metrics

Pinecone has no time-series query API, so each sync records the current values and Infrawrench builds the history from them:

- From the index's stats (every deployment type): records, namespaces, and fullness for pod-based and dedicated indexes.
- From Pinecone's Prometheus endpoint (serverless and BYOC, when the project is set): stored bytes, upsert, query, fetch, update, delete and list counts, query and upsert time, read and write units, read-node CPU, memory and storage fullness, and scheduled-backup failures. Counts and units are running totals.

<insert [Pinecone index detail page with the Metrics tab showing records and read units over a week] here>

## Quotas

With a service account and the project set, the project's pod limit appears on the [quota radar](../features/quota-radar.md): pods used by pod-based indexes (shards times replicas) against `max_pods`. Serverless-only projects have no pod quota.

## Terraform and status

Indexes, collections, projects, API keys and service accounts can be [exported to Terraform](../features/terraform-export.md) for the official `pinecone-io/pinecone` provider, with import ids. Document indexes with full-text search fields have no Terraform equivalent yet and are reported as unsupported.

Pinecone's [status page](https://status.pinecone.io) feeds [provider status](../features/provider-status.md): a serverless region or pod environment incident shows next to the indexes in it, and an Index Management incident against everything.

## Limits and quirks

- Pinecone no longer lets new pod-based indexes be created through its current API; existing ones can still be scaled here. Pod size only goes up, and shards are fixed.
- Pinecone has no billing or usage API, so there is no cost data for this plugin. The console's Usage page and CSV export remain the source for spend.
- Backups and backup schedules are for serverless and BYOC indexes; collections only for pod-based ones.
- Index names are 1 to 45 lowercase letters, digits or hyphens. The plugin checks this before calling Pinecone.
