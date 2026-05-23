---
title: Kafka
description: Connect to any Apache Kafka cluster — browse topics, consumer groups, and cluster metadata.
sidebar_order: 26
---

## What you can manage

- **Cluster** — broker count, controller, cluster ID, version.
- **Topics** — list, create (with partitions + replication factor), delete.
- **Consumer groups** — list, inspect protocol, delete.

## Credentials

Infrawrench uses a custom `kafka://` URL to bundle the bootstrap brokers and authentication into one credential field.

### Plaintext (no auth)

```
kafka://broker1:9092
```

For multiple brokers, use the `brokers=` query param since standard URLs can't carry a comma-separated host:

```
kafka://placeholder:9092?brokers=b1:9092,b2:9092,b3:9092
```

### SASL / SSL

Supported SASL mechanisms: `plain`, `scram-sha-256`, `scram-sha-512`.

```
kafka://broker1:9092?sasl=scram-sha-256&user=alice&password=…&ssl=true
```

Equivalent shorthand — credentials in the URL userinfo, `kafkas://` for TLS:

```
kafkas://alice:secret@broker1:9092?sasl=scram-sha-256
```

URL-encode special characters in `user` and `password` (e.g. `@` → `%40`).

### Reference an output

If you've added a managed-Kafka resource elsewhere (Aiven, Confluent Cloud, MSK), reference its connection-string output instead of pasting a URL.

<insert [Kafka Add-account form with the kafka:// URL field filled in] here>

## Notable flows

- **Sidebar lists Topics and Consumer Groups** under the cluster — the cluster itself is the top-level entry per account.
- **Create topic** from the cluster's detail view — pick partition count and replication factor.
- **Delete topic / group** from the resource's own detail view.

<insert [Cluster detail view showing brokers, topics, and consumer groups] here>

## Tips & limits

- Internal topics that start with `__` (e.g. `__consumer_offsets`) are hidden from the topic list.
- Replication factor must be `≤` the number of brokers — creation will fail upstream otherwise.
- For private clusters (AWS MSK in a VPC, on-prem brokers), bind the account to a bastion so the host tunnels Kafka traffic through it.
- This plugin uses [kafkajs](https://kafka.js.org/); native-binary clients (librdkafka-backed) are not currently supported.
