---
title: Memcached
description: Connect to a Memcached server and run text-protocol commands.
sidebar_order: 16
---

Connect a Memcached server to run commands against it from Infrawrench.

## What you can do

- Run text-protocol commands in the [KV console](../features/kv-console.md): `get`, `set`, `delete`, `stats` and so on, one command per line.

## Connect a server

There's one **Server(s)** field. Enter `host:port` (the default port is `11211`), or a comma-separated list for several servers.

Memcached has no authentication by default, so don't expose it publicly. Use an [SSH tunnel](../features/ssh-tunnels.md) or a private network.

![Memcached Add-account form with the Server(s) field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/memcached/add-account.png)

## Limits

- SASL-authenticated Memcached isn't supported.
- Memcached has no pub/sub and no persistence. Pick Redis if you need either.
