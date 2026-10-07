---
title: NATS
description: Manage a self-hosted NATS server - health and limits, routes, gateways and leaf nodes, accounts and connections, JetStream streams, consumers, key-value buckets and object stores you can create, edit and delete, a message and key browser, and publish and request/reply.
sidebar_order: 50
---

Connect a nats-server to see the server and who is connected, and to manage JetStream: create and edit streams, consumers, key-value buckets and object stores, browse and delete messages, read and write keys, and publish messages or send requests.

An account can use two endpoints, and you can give it either or both:

- The **client port** (4222, the one your applications use) is what publishing and every JetStream change go through, using the credentials you enter. It also lists streams, consumers, buckets and object stores.
- The **monitoring port** (8222) serves the read-only views only it has: server health and limits, routes, gateways and leaf nodes, all accounts, and open connections.

## What you can see and do

- **Server**: name, version, cluster, health (`/healthz`), uptime, connections against the maximum, subscriptions, slow consumers, traffic, memory and CPU, routes, gateways and leaf nodes, whether TLS and auth are required, and JetStream storage and memory against their limits. The server's TLS certificate appears on the expiry radar. The **Publish** tab sends a message to any subject: a plain publish, a request that waits for and shows the first reply, or a JetStream publish that waits for the stored acknowledgement, with optional headers. The **Describe** tab shows subscription routing statistics. Without a monitoring URL the server comes from the client connection's handshake (version, cluster, limits and JetStream usage for your account).
- **Peers**: routes to other servers in the cluster, gateways to other clusters and leaf node connections, with address, round trip time, traffic and subscriptions (monitoring URL).
- **Accounts**: connections, leaf nodes, subscriptions, messages and bytes sent and received, slow consumers, and each account's JetStream storage, memory, streams and consumers (monitoring URL; with only a server URL you see the account your credentials belong to).
- **Streams**: subjects, retention, storage, replicas, limits, messages, bytes, sequence range and leader. **Create** one from the account (name, subjects, retention, storage, replicas, what happens when it is full, message, byte, age, per-subject and size limits, the duplicate window, compression, direct get, and whether deletes and purges are refused). **Edit** changes the description, subjects, limits, replicas, discard policy, duplicate window and compression; the **Configuration** tab edits the full JSON configuration for anything else. **Purge** empties the stream, and **Purge Subject** removes one subject's messages, optionally keeping the newest few or everything from a sequence on. The **Keys** tab is a message browser: newest first, filter by subject (wildcards allowed) or type a sequence number to jump to it, open a message to read its subject, time, headers and body, and delete it. **Delete Message** removes one by sequence, optionally erasing it on disk. The **Publish** tab publishes into the stream and reports the sequence it was stored at, with an optional message ID for deduplication. A stream with a single replica is flagged as a low-severity posture finding.
- **Consumers**: under their stream, with push or pull mode, deliver and ack policies, filter subjects and progress: pending, waiting for acknowledgement, redelivered, delivered and acknowledged sequences, and last activity. **Create** one from a stream (durable name, pull or push with its deliver subject and group, filter subjects, where to start: the first, last or new messages, the last per subject, a sequence or a time, ack policy and wait, maximum deliveries and pending acks, replay rate and maximum waiting pulls). **Edit** changes the description, ack wait, maximum deliveries and pending acks, filter subjects and deliver subject, and the **Configuration** tab edits the full JSON. **Pause** stops deliveries until a time you pick and **Resume** restarts them (nats-server 2.11 or later).
- **Key-value buckets**: history depth, expiry, size limits, storage, replicas, keys and values. **Create** and **Edit** set the history, expiry, size limits and replicas. The **Keys** tab reads, writes and deletes keys; the overview lists the bucket's latest revisions (puts and deletes), and the **Describe** tab every key's revisions.
- **Object stores**: expiry, size limit, storage, replicas and size. **Create** and **Edit** set the expiry, size limit and replicas. The **Files** tab lists objects (a `/` in a name shows as a folder), uploads files up to 32 MB and deletes objects; the overview lists each object's size, chunks, modified time and digest.
- **Connections**: up to 1,024 open client connections, busiest first, with name, address, account, user, client library, uptime, idle time, round trip, subscriptions and traffic (monitoring URL).

Deleting a stream, consumer, bucket or object store uses the usual **Delete** button. The server's limits (client connections, JetStream storage and memory) appear under Quotas.

<insert [NATS stream detail page with the Keys tab open on a message, showing its subject, headers and body] here>

## Credentials

1. Enter the **Server URL**, for example `nats://nats.internal:4222`, or `tls://nats.internal:4222` when the server requires TLS. Separate several servers of one cluster with commas.
2. Enter the credentials the server expects:
   - **User** and **Password** for user and password authorization.
   - **Token** for token authorization.
   - **NKey Seed** (the line starting `SU` in the user's `.nk` file) for NKey authentication.
   - **Credentials File** for decentralised (JWT) authentication: paste the whole `.creds` file that `nsc` or the `nats` CLI wrote, not its path.
   - **Client Certificate** and **Client Key** when the server verifies client certificates.
   - **CA Certificate** when the server's certificate comes from a private CA.
3. Optionally enter the **Monitoring URL**, for example `http://nats.internal:8222`, for the server, peer, account and connection views. Enable it with `http_port: 8222` in the server configuration (or `-m 8222`) and include the `http_base_path` if one is set. nats-server has no authentication there; if a reverse proxy in front of it asks for some, enter it under **Monitoring Proxy Username**, **Password** or **Token**.

The user needs permission to publish and subscribe on `$JS.API.>` and `_INBOX.>` to manage JetStream, and on the subjects you publish to.

<insert [NATS Add-account form with the server URL, user and password, and monitoring URL filled in] here>

**Check credentials** reports separately whether the monitoring endpoint answers, whether the client port accepts your credentials, and whether JetStream is enabled for your account.

## Tips & limits

- **Writes go to your account.** Everything you create lands in the account your credentials belong to. A stream the monitoring endpoint shows in another account is read only here; add an account with that account's credentials to manage it.
- **One server per account.** In a cluster, the client port reaches the whole JetStream cluster, but the monitoring views cover the one server they point at, and its JetStream report lists only the streams it holds a replica of.
- **Private servers**: the desktop app connects directly. The cloud app reaches a private server through an [SSH tunnel](../features/ssh-tunnels.md) on the account. A tunnel forwards one port and points every URL on the account at it, so forward the client port (4222) and leave the monitoring URL empty, or keep a second account for monitoring. Through a tunnel the server is reached as `127.0.0.1`; if it uses TLS, set **TLS Server Name** to the name on its certificate. Do not expose the monitoring port to the internet.
- **The console** at the bottom of a resource sends raw driver commands (`info`, `streams`, `stream ORDERS`, `kv-keys config`, `publish orders.created hello`) using only the server URL, so it authenticates with whatever the URL itself carries (`nats://user:password@host` or `nats://token@host`). The resource views always use the account's full credentials.
- Message bodies, values and objects are shown as text; binary content is shown as base64. Object downloads are not available here; use `nats object get`.
- Metrics are point-in-time readings, so the charts fill in as Infrawrench records them.
- [Export to Terraform](../features/terraform-export.md) writes durable streams and consumers for the `nats-io/jetstream` provider, with import ids, from the configuration the server reports. Key-value buckets, object stores and ephemeral consumers are left out.
