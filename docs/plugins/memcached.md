---
title: Memcached
description: Connect to a Memcached server and run text-protocol commands.
sidebar_order: 16
---

## What you can manage

- Run text-protocol commands via the [KV console](../features/kv-console.md): `get`, `set`, `delete`, `stats`, etc.

## Credentials

Host + port (default `11211`). Memcached has no auth by default — do not expose it publicly. Use an [SSH tunnel](../features/ssh-tunnels.md) or a private network.

<insert [Memcached Add-account form with host and port fields] here>

## Notable flows

- **KV console** — single command-per-line.

## Tips & limits

- SASL-authenticated Memcached is not supported.
- There is no pub/sub and no persistence; pick Redis if you need either.
