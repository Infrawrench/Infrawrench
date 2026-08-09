---
title: Memcached
description: Connect to a Memcached server and run text-protocol commands.
sidebar_order: 16
---

## What you can manage

- Run text-protocol commands via the [KV console](../features/kv-console.md): `get`, `set`, `delete`, `stats`, etc.

## Credentials

A single **Server(s)** field — `host:port` (default port `11211`), or a comma-separated list for multiple servers. Memcached has no auth by default — do not expose it publicly. Use an [SSH tunnel](../features/ssh-tunnels.md) or a private network.

![Memcached Add-account form with the Server(s) field](https://agent-assets.infrawrench.com/docs/screenshots/plugins/memcached-add-account.png)

## Notable flows

- **KV console** — single command-per-line.

## Tips & limits

- SASL-authenticated Memcached is not supported.
- There is no pub/sub and no persistence; pick Redis if you need either.
