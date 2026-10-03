---
title: OpenSearch
description: Connect to an OpenSearch (or Elasticsearch-compatible) cluster — browse indices, run searches, manage snapshots.
sidebar_order: 25
---

The OpenSearch plugin gives you a single account per cluster. It speaks the OpenSearch REST API, so it also works against Elasticsearch (7.x+) and forks like Aiven for OpenSearch.

For provider-managed OpenSearch (DigitalOcean, AWS, OVH), you don't normally add an account here directly — the cluster shows up as an **OpenSearch** tab inside the managed-database resource detail page, and connection details flow through automatically.

## What you can manage

- **Cluster health** — green/yellow/red status, shard counts, pending tasks
- **Nodes** — per-node roles, IP, JVM heap usage, disk usage
- **Indices** — health, doc count, store size, primary/replica shard counts
- **Per-index actions** — refresh, force-merge, clear cache, delete
- **Create index** — name, shards, replicas, and an optional inline mapping
- **Reindex** — copy documents from one index to another (same cluster), as a background task
- **Search** — pick an index, paste a Query DSL JSON and get the top hits back
- **Unassigned shards** — when any shard is unassigned, the overview lists it with the reason and offers **Retry allocation**
- **Snapshots** tab — register an S3 repository, take snapshots on demand, and browse each repository's snapshots (newest 25) with state, duration and shard counts; restore or delete any of them
- **Snapshot policies** (Snapshot Management) — list policies with their schedule and retention, start / stop / delete them, and create one from a repository, a schedule preset and a retention age
- **Aliases & streams** tab — list aliases (write index, filter, routing), add an alias to an index, remove one; list data streams with health and backing-index count, roll one over or delete it
- **Index lifecycle** tab — list Index State Management (ISM) policies with their states and the index patterns they auto-apply to; create a retention policy that deletes indices past an age, apply a policy to an index or detach it, delete a policy
- **Query insights** tab — the slowest recent queries (latency, CPU, memory, indices, shard count and the query itself) from the Query Insights plugin
- **Dashboard stats + metrics** — cluster status, total nodes/indices/docs, store size, JVM heap %, disk used %, CPU %, pending tasks, and cumulative search / indexing operations

![OpenSearch cluster detail page showing Cluster, Health, Nodes, and Indices sections with per-row action buttons](https://agent-assets.infrawrench.com/docs-screenshots/plugins/opensearch/cluster-detail.png)

## Credentials

The plugin supports three auth modes. **Auth Mode** is a plain text field, not a dropdown — type one of `basic`, `apiKey` or `awsSigv4` into it (matching is case-insensitive). Leave it empty and the plugin infers the mode: AWS access key and secret present means SigV4, otherwise an API key means `apiKey`, otherwise basic auth.

The add-account form shows **every** credential field at once — nothing appears or disappears as you change the mode, and the field descriptions are what tell you which ones a given mode reads. The form also treats them all as required, so fill the ones your mode ignores with a placeholder such as `-` to enable the submit button.

### Basic auth (most clusters, including DigitalOcean / OVH managed)

Set:

- **Endpoint** — `https://host:9200` (or `:25060` for DigitalOcean)
- **Username** — typically `doadmin`, `admin`, or a user you created
- **Password**
- **CA Certificate** (optional) — paste the cluster's PEM-encoded CA when it uses a private CA. DigitalOcean managed OpenSearch uses DO's internal CA — Infrawrench auto-fills this from the managed-database tab.

If the endpoint URL embeds credentials (e.g. `https://doadmin:pw@host:25060`), the plugin will pull them out automatically — you don't have to split them by hand.

### API key (modern clusters)

Set **Auth Mode** to `apiKey` and paste the base64-encoded key (the same value Elasticsearch's `GET _security/api_key` endpoint returns under `encoded`). The plugin sends it as `Authorization: ApiKey <key>`.

### AWS SigV4 (Amazon OpenSearch Service)

For IAM-controlled Amazon OpenSearch domains, set:

- **Auth Mode** — `awsSigv4`
- **AWS Access Key ID** / **AWS Secret Access Key** (and optionally **AWS Session Token**)
- **AWS Region** — e.g. `us-east-1`
- **AWS Service** — defaults to `es`; set to `aoss` for OpenSearch Serverless collections

The plugin signs every request with SigV4 using the same `@smithy/signature-v4` signer the AWS SDK uses, so any IAM policy attached to the user/role flows through unchanged.

![OpenSearch Add-account form with the Auth Mode text field and every credential field listed below it](https://agent-assets.infrawrench.com/docs-screenshots/plugins/opensearch/add-account.png)

## Notable flows

- **DigitalOcean → OpenSearch** — Open a DO managed OpenSearch cluster; the **OpenSearch** tab appears automatically with the endpoint and CA cert pre-filled. No manual account needed.
- **OVH → OpenSearch** — Same pattern. OVH never returns user passwords from its API, so the OpenSearch tab works for users whose password Infrawrench captured at create time. For pre-existing users you'll have to rotate the password from the OVH side and paste it in.
- **AWS → OpenSearch** — The OpenSearch tab shows on AWS OpenSearch domain detail pages with the endpoint pre-filled, but auth (basic vs SigV4) still needs the credentials filled in on the standalone account.

## Tips & limits

- **Plugin-backed tabs degrade gracefully.** Snapshot policies and ISM need the Index Management plugin, and Query insights needs the query-insights plugin (OpenSearch 2.12 and later). Clusters without them (Elasticsearch, some managed services) show "not available" in those sections; everything else keeps working.
- **Restoring a snapshot never overwrites live indices.** Every non-system index in the snapshot is restored under a `restored-` prefix (so `logs-1` comes back as `restored-logs-1`), and cluster-wide state is left alone. Reindex or swap an alias once you have checked the copy.
- **Retention policies apply to new indices automatically.** A policy created from the Index lifecycle tab carries an ISM template for its pattern, so indices created later pick it up; existing indices need **Apply policy to index**. Patterns must be narrower than `*`, which would also match system indices.
- **Query insights** shows the current window only (the last few minutes by default). If it is empty, check that `search.insights.top_queries.latency.enabled` is on.

- **Snapshot repositories** — registering an S3 repository needs the `repository-s3` plugin installed cluster-side. DigitalOcean, OVH, and Amazon OpenSearch Service all ship it by default. Bring-your-own clusters may need to install and configure IAM/access for the bucket.
- **Force-merge is destructive on writeable indices** — only run it on read-only indices that are no longer being written to. The action prompts for confirmation before sending.
- **Search results are capped at 10 hits in the prompt UI.** For deeper exploration use OpenSearch Dashboards (Kibana) directly — the plugin doesn't try to replace it.
- **SigV4 + non-AWS endpoints don't mix** — if you set Auth Mode to `awsSigv4` against a non-AWS cluster, the cluster will reject signed requests it can't verify. Use `basic` or `apiKey` instead.
