---
title: Kafka
description: Connect to any Apache Kafka cluster to browse topics, consumer groups, and cluster metadata.
sidebar_order: 26
---

Connect any Apache Kafka cluster to see its brokers, manage topics and consumer groups, and send test messages.

## What you can manage

- **Cluster**: broker count, controller, cluster ID and version.
- **Topics**: list, create (with partitions and replication factor) and delete.
- **Consumer groups**: list, inspect the protocol and delete.

## Connect a cluster

You connect with a `kafka://` URL that holds the bootstrap brokers and the authentication in one field.

### Plaintext (no auth)

```
kafka://broker1:9092
```

For several brokers, use the `brokers=` query parameter:

```
kafka://placeholder:9092?brokers=b1:9092,b2:9092,b3:9092
```

### SASL and SSL

Supported SASL mechanisms: `plain`, `scram-sha-256` and `scram-sha-512`.

```
kafka://broker1:9092?sasl=scram-sha-256&user=alice&password=…&ssl=true
```

Or the shorter form, with credentials in the URL and `kafkas://` for TLS:

```
kafkas://alice:secret@broker1:9092?sasl=scram-sha-256
```

URL-encode special characters in `user` and `password` (for example, `@` becomes `%40`).

### Use an output instead

If you've already added a managed Kafka resource (Aiven, Confluent Cloud, MSK), pick its connection-string output instead of pasting a URL.

![Kafka Add-account form with the kafka:// URL field filled in](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kafka/add-account.png)

## Work with topics and groups

- Each account shows the cluster at the top of the sidebar, with **Topics** and **Consumer Groups** under it.
- **Create a topic** from the cluster's detail view. Pick the partition count and replication factor.
- **Create a topic from another resource**: when Kafka shows up as a tab on another resource (for example, the **Kafka** tab of a DigitalOcean Managed Database), you'll see a **+ Create Topic** button even when the cluster is empty. Consumer groups have no create button. They appear when a consumer subscribes.
- **Delete a topic or group** from its own detail view.
- **Send a test record** to any topic from the **Produce** tab on its detail page. See [Send test messages](../features/send-test-message.md). Your credentials need produce ACLs on the topic.

![Cluster detail view showing brokers, topics, and consumer groups](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kafka/cluster-detail.png)

## Tips and limits

- Internal topics that start with `__` (like `__consumer_offsets`) are hidden from the topic list.
- Replication factor can't be more than the number of brokers, or topic creation fails.
- Private clusters (AWS MSK in a VPC, on-prem brokers) work from the desktop app on a machine that can reach the brokers. The web app connects to brokers directly, never through a [bastion](../features/bastion-vms.md), so there they need public addresses.
- Clients built on native binaries (librdkafka) aren't supported.
