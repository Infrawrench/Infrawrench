---
title: RabbitMQ
description: Manage a self-hosted RabbitMQ cluster through its management API - virtual hosts, exchanges, queues, bindings, policies, users and permissions, connections, shovels and federation - peek at and publish messages, and chart message rates, queue depth and node resources.
sidebar_order: 50
---

Connect a RabbitMQ cluster through the management plugin's HTTP API to see and change its topology, users and policies, and to watch messages move.

## What you can manage

- **Cluster**: the account opens on the cluster, with its name, RabbitMQ and Erlang versions, object totals, queued messages, message rates, listeners and any memory or disk alarm. **Edit** renames the cluster. The **Definitions** tab shows the full definitions export (users with password hashes, virtual hosts, topology, policies and parameters) and imports an edited document; an import adds and updates objects but never deletes any. **Rebalance queues** spreads quorum queue and stream leaders across nodes. The Metrics tab charts publish, deliver, ack and redeliver rates and ready and unacknowledged messages.
- **Nodes**: memory against the high watermark, free disk against its limit, file descriptors, sockets, Erlang processes, uptime, enabled plugins and network partitions. A node in alarm shows red, a partitioned node is flagged as a posture finding, and the Metrics tab charts its resource use.
- **Virtual hosts**: create one, edit its description, tags, default queue type, message tracing, deletion protection and its connection and queue limits, or delete it with everything in it.
- **Exchanges**: type, durability, arguments, the policy applied and publish rates, plus the bindings they route through. Declare one (with an alternate exchange or other arguments) or delete it. The **Publish** tab sends a test message with a routing key, content type, delivery mode, message and correlation ids and headers, and says whether it was routed to any queue.
- **Queues**: classic and quorum queues and streams with depth, consumers, consumer capacity, memory, leader and members, effective policy and message rates, plus their consumers and bindings. Declare one with a TTL, length limit or dead lettering, **Purge** it, or delete it. The **Describe** tab peeks at the first ten ready messages, and the **Publish** tab sends to the queue through the default exchange. A queue with ready messages and no consumers shows as degraded; one with neither is suggested as unused.
- **Bindings**: exchange to queue and exchange to exchange, with routing key and arguments. Create one by picking the source and destination, or delete it.
- **Policies** and **operator policies**: pattern, what they apply to, priority and definition. Create, edit the pattern and priority, open the definition in a JSON editor with **Edit definition**, or delete.
- **Users**: tags, whether a password is set, connection and channel limits and the virtual hosts each user can reach. Create a user, change its tags and limits, **Set password**, or delete it. The built-in `guest` user is flagged.
- **Permissions** and **topic permissions**: configure, write and read patterns per user and virtual host, and routing-key patterns per topic exchange. Grant, edit or revoke.
- **Connections** and **channels**: who is connected, from where, with which client and protocol, with TLS or not, and the traffic, prefetch and unacknowledged messages on each channel. **Close connection** disconnects a client with a reason it is told.
- **Shovels**: dynamic shovels with their state, source and destination and message counters. Create one between queues or exchanges on this or another broker, **Restart** it, or delete it.
- **Federation upstreams**: URI, upstream exchange or queue, prefetch, reconnect delay and ack mode, with the status of their federation links. Create, edit or delete.

The cluster's resource limits (file descriptors, sockets, Erlang processes and memory per node, and any virtual host queue or connection limit) appear under Quotas, with usage read from the broker.

## Credentials

1. Make sure the management plugin is enabled (`rabbitmq-plugins enable rabbitmq_management`) and enter its **Management API URL** with the port, for example `http://mq.example.com:15672` or `https://mq.example.com:15671`.
2. Enter a **Username** and **Password**. A user with the `administrator` tag can manage everything:

   ```sh
   rabbitmqctl add_user infrawrench '<password>'
   rabbitmqctl set_user_tags infrawrench administrator
   rabbitmqctl set_permissions -p / infrawrench '.*' '.*' '.*'
   ```

   A `monitoring` user sees nodes and every connection but cannot change users or policies; a `policymaker` user can manage policies, shovels and federation. The `guest` user can only sign in from localhost.

3. If the broker authenticates with OAuth 2 (`rabbitmq_auth_backend_oauth2`), paste an access token under **Advanced options** instead of a username and password.
4. If the management listener's certificate is signed by a private CA, paste the CA certificate under **Advanced options**.

<insert [RabbitMQ Add-account form with the management URL, username and password filled in] here>

**Check credentials** shows which of the management, monitoring, policy and administrator capabilities the user has, and names the tag each missing one needs. Lists the user's tags cannot see (users and permissions for a non-administrator, for example) show as empty instead of failing.

<insert [RabbitMQ queue detail page with depth and rates, the Consumers and Bindings tables, and the Purge button] here>

<insert [RabbitMQ queue Describe tab showing peeked messages] here>

<insert [RabbitMQ exchange Publish tab with routing key, headers and a message body] here>

## Tips & limits

- **Private brokers**: the desktop app connects directly. The cloud app reaches a private broker through an [SSH tunnel](../features/ssh-tunnels.md) on the account (forward to the management port). Through a tunnel the connection goes to `127.0.0.1`, so an HTTPS certificate must also cover that address; plain HTTP over the tunnel avoids the problem.
- **Peeking requeues.** The Describe tab reads messages the way the management UI's Get messages button does, and puts them back, so they come back marked redelivered and may change position. Streams cannot be peeked this way.
- **Charts need management statistics.** Rates and history come from the management plugin's own sample store (up to a day back at the default retention). If statistics collection is disabled, the Metrics tab shows the current readings only.
- Up to 5,000 queues, 2,000 exchanges, 1,000 connections and 2,000 channels are listed.
- Only users in RabbitMQ's internal user store are listed; LDAP and OAuth users do not appear.
- The default exchange's implicit binding to every queue is not listed as a binding.
- Deleting one topic permission clears that user's topic permissions in the virtual host and grants the others back, because the API can only clear them all at once.
- Shovel and federation upstream URIs are stored with their passwords masked. Shovels and federation need the `rabbitmq_shovel_management` and `rabbitmq_federation_management` plugins; without them those lists are empty.
- [Export to Terraform](../features/terraform-export.md) writes virtual hosts, exchanges, queues, bindings, policies, operator policies, users, permissions, topic permissions, federation upstreams and shovels for the `cyrilgdn/rabbitmq` provider, with import ids. Passwords and URIs with credentials become sensitive variables.
