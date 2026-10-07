---
title: NATS
description: Watch a self-hosted NATS server through its monitoring endpoint - health and limits, routes, gateways and leaf nodes, accounts, connections, and JetStream streams, key-value buckets and consumers with their progress.
sidebar_order: 50
---

Connect a nats-server's HTTP monitoring endpoint to see the server, who is connected, and how its JetStream streams and consumers are doing. The connection is read only.

## What you can see

- **Server**: the account opens on the server, with its name, version, cluster, health (`/healthz`), uptime, connections against the maximum, subscriptions, slow consumers, traffic, memory and CPU, routes, gateways and leaf nodes, whether TLS and auth are required, and JetStream storage and memory against their limits. The server's TLS certificate appears on the expiry radar. The **Describe** tab shows subscription routing statistics. The Metrics tab records connections, subscriptions, slow consumers, memory, CPU, message totals and JetStream usage.
- **Peers**: routes to other servers in the cluster, gateways to other clusters and leaf node connections, with address, round trip time, traffic and subscriptions.
- **Accounts**: connections, leaf nodes, subscriptions, messages and bytes sent and received, slow consumers, and each account's JetStream storage, memory, streams and consumers.
- **Streams**: every JetStream stream under its account (key-value buckets and object stores are labelled as such), with subjects, retention, storage, replicas, limits, messages, bytes, sequence range and leader. The **Describe** tab shows the full configuration. A stream with a single replica is flagged as a low-severity posture finding.
- **Consumers**: under their stream, with push or pull mode, deliver and ack policies, filter subjects and progress: pending, waiting for acknowledgement, redelivered, delivered and acknowledged sequences, and last activity.
- **Connections**: up to 1,024 open client connections, busiest first, with name, address, account, user, client library, uptime, idle time, round trip, subscriptions and traffic.

The server's limits (client connections, JetStream storage and memory) appear under Quotas.

## Credentials

1. Make sure the server's monitoring port is enabled (`http_port: 8222` in the server configuration, or `-m 8222`).
2. Enter the **Monitoring URL**, for example `http://nats.internal:8222`. It is the monitoring port, not the client port 4222. Include the `http_base_path` if your server sets one.
3. nats-server has no authentication on the monitoring port. If you put a reverse proxy in front of it, enter its **Username** and **Password** or **Bearer Token** under **Advanced options**, and its CA certificate if it uses a private CA.

<insert [NATS Add-account form with the monitoring URL filled in] here>

**Check credentials** confirms the server answers `/varz`, and whether JetStream and account information are available.

<insert [NATS stream detail page with message counts and its consumers] here>

## Tips & limits

- **Read only.** The monitoring endpoint cannot change anything, and creating or editing streams, publishing messages or closing connections needs the NATS client protocol, which this plugin does not speak. Use the `nats` CLI for those.
- **One server per account.** Each account watches one server. In a cluster, a server's JetStream report lists only the streams it holds a replica of; add an account for each server, or point at the meta leader, to see them all.
- **Private servers**: the desktop app connects directly. The cloud app reaches a private server through an [SSH tunnel](../features/ssh-tunnels.md) on the account (forward to port 8222). Monitoring is meant for trusted networks; do not expose port 8222 to the internet.
- Metrics are point-in-time readings, so the charts fill in as Infrawrench records them.
- [Export to Terraform](../features/terraform-export.md) writes durable streams and consumers for the `nats-io/jetstream` provider, with import ids, from the configuration the server reports. Key-value buckets, object stores and ephemeral consumers are left out.
