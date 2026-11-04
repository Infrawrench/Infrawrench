---
title: OpenSearch
description: Connect to an OpenSearch (or Elasticsearch-compatible) cluster to browse indices, run searches and manage snapshots.
sidebar_order: 25
---

Add one account per cluster. It works with OpenSearch, Elasticsearch (7.x and later) and forks like Aiven for OpenSearch.

If your OpenSearch is managed by DigitalOcean, AWS or OVH, you usually don't add an account here. The cluster shows up as an **OpenSearch** tab on the managed database's detail page, with the connection details already filled in.

## What you can manage

- **Cluster health**: green, yellow or red status, shard counts, pending tasks.
- **Nodes**: roles, IP, JVM heap usage and disk usage per node.
- **Indices**: health, doc count, store size, primary and replica shard counts.
- **Index actions**: refresh, force-merge, clear cache, delete.
- **Create index**: name, shards, replicas, and an optional inline mapping.
- **Reindex**: copy documents from one index to another on the same cluster, as a background task.
- **Search**: pick an index, paste a Query DSL JSON and get the top hits back.
- **Unassigned shards**: when any shard is unassigned, the overview lists it with the reason and offers **Retry allocation**.
- **Snapshots** tab: register an S3 repository, take snapshots on demand, and browse each repository's snapshots (newest 25) with state, duration and shard counts. Restore or delete any of them.
- **Snapshot policies**: list policies with their schedule and retention, start, stop or delete them, and create one from a repository, a schedule preset and a retention age.
- **Aliases & streams** tab: list aliases (write index, filter, routing), add an alias to an index or remove one. List data streams with health and backing-index count, and roll one over or delete it.
- **Index lifecycle** tab: list Index State Management (ISM) policies with their states and the index patterns they apply to. Create a retention policy that deletes indices past an age, apply a policy to an index or detach it, or delete a policy.
- **Query insights** tab: the slowest recent queries, with latency, CPU, memory, indices, shard count and the query itself.
- **Dashboard stats and metrics**: cluster status, total nodes, indices and docs, store size, JVM heap %, disk used %, CPU %, pending tasks, and total search and indexing operations.
- **Node metrics**, summed or averaged across nodes: OS memory used % and 1-minute load, average search and indexing latency, search and write thread pool queues and rejections, old-generation GC count and time, circuit breaker trips, open HTTP connections, segment count, running merges, query cache and fielddata size, query cache evictions, and transport bytes in and out. Counters are lifetime totals and latencies are lifetime averages, so watch the slope. The chart fills in as Infrawrench samples the cluster. Amazon OpenSearch Service domains also get CloudWatch history through the [AWS plugin](./aws.md).

![OpenSearch cluster detail page showing Cluster, Health, Nodes, and Indices sections with per-row action buttons](https://agent-assets.infrawrench.com/docs-screenshots/plugins/opensearch/cluster-detail.png)

## Connect a cluster

There are three ways to sign in. **Auth Mode** is a text field, not a dropdown: type `basic`, `apiKey` or `awsSigv4` (case doesn't matter). If you leave it empty, Infrawrench picks for you: AWS keys mean SigV4, otherwise an API key means `apiKey`, otherwise basic auth.

The form shows **every** credential field at once, whatever mode you pick. The field descriptions say which ones each mode uses. Every field is marked required, so put a placeholder such as `-` in the ones your mode ignores to enable the submit button.

### Basic auth (most clusters, including DigitalOcean and OVH managed)

Fill in:

- **Endpoint**: `https://host:9200` (or `:25060` for DigitalOcean)
- **Username**: usually `doadmin`, `admin`, or a user you created
- **Password**
- **CA Certificate** (optional): paste the cluster's PEM-encoded CA if it uses a private CA. For DigitalOcean managed OpenSearch, Infrawrench fills this in from the managed database tab.

If your endpoint URL includes credentials (for example `https://doadmin:pw@host:25060`), Infrawrench pulls them out for you.

### API key (modern clusters)

Set **Auth Mode** to `apiKey` and paste the base64-encoded key (the `encoded` value Elasticsearch's `GET _security/api_key` returns).

### AWS SigV4 (Amazon OpenSearch Service)

For IAM-controlled Amazon OpenSearch domains, fill in:

- **Auth Mode**: `awsSigv4`
- **AWS Access Key ID** and **AWS Secret Access Key** (and optionally **AWS Session Token**)
- **AWS Region**: for example `us-east-1`
- **AWS Service**: defaults to `es`. Set it to `aoss` for OpenSearch Serverless collections.

Requests are signed the same way the AWS SDK signs them, so any IAM policy on the user or role applies as usual.

![OpenSearch Add-account form with the Auth Mode text field and every credential field listed below it](https://agent-assets.infrawrench.com/docs-screenshots/plugins/opensearch/add-account.png)

## Open OpenSearch from a cloud provider

- **DigitalOcean**: open a managed OpenSearch cluster. The **OpenSearch** tab appears with the endpoint and CA cert filled in. You don't need a separate account.
- **OVH**: same idea. OVH never returns user passwords, so the tab works for users whose password Infrawrench saw when it created them. For older users, reset the password in OVH and paste it in.
- **AWS**: the OpenSearch tab shows on AWS OpenSearch domain pages with the endpoint filled in, but you still need to enter credentials (basic or SigV4) on a standalone account.

## Tips & limits

- **Some tabs need cluster plugins.** Snapshot policies and ISM need the Index Management plugin, and Query insights needs the query-insights plugin (OpenSearch 2.12 and later). Clusters without them (Elasticsearch, some managed services) show "not available" in those sections. Everything else keeps working.
- **Restoring a snapshot never overwrites live indices.** Every non-system index comes back with a `restored-` prefix (so `logs-1` becomes `restored-logs-1`), and cluster-wide state is left alone. Reindex or swap an alias once you've checked the copy.
- **Retention policies apply to new indices automatically.** Indices created later that match the pattern pick the policy up. For existing indices, use **Apply policy to index**. Patterns must be narrower than `*`, which would also match system indices.
- **Query insights shows the current window only** (the last few minutes by default). If it's empty, check that `search.insights.top_queries.latency.enabled` is on.
- **Snapshot repositories need the `repository-s3` plugin** on the cluster. DigitalOcean, OVH and Amazon OpenSearch Service include it. Your own clusters may need it installed, plus IAM or access set up for the bucket.
- **Only force-merge read-only indices.** Force-merge is destructive on indices that are still being written to. You'll be asked to confirm first.
- **Search shows up to 10 hits.** For deeper exploration, use OpenSearch Dashboards (Kibana).
- **SigV4 only works with AWS endpoints.** Other clusters reject signed requests. Use `basic` or `apiKey` instead.
