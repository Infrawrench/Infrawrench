---
title: KV console
description: Run Redis and Memcached commands against your connected caches.
sidebar_order: 5
---

The KV console lets you type Redis and Memcached commands straight into a cache you've connected. Think of it as the [SQL editor](./sql-editor.md) for key-value stores.

![KV console with a few SET / GET commands and their replies](https://agent-assets.infrawrench.com/docs-screenshots/features/kv-console/redis-console-commands.png)

## Open the console

Click **Console** on any of these:

- A Redis account or a Redis-compatible resource (Upstash, ElastiCache with Redis, DigitalOcean managed Redis via output reference).
- A Memcached account or ElastiCache with Memcached.

## What you can run

- **Redis:** the full command set your server version supports.
- **Memcached:** text-protocol commands (`get`, `set`, `delete`, `stats`, and so on).

There's no autocomplete. An empty console suggests a couple of commands to get you started. Use **↑** and **↓** to step through the last hundred commands you ran in that session, and **Clear** to empty the output.

Replies are formatted by type: strings as text, lists as bullets, hashes as tables.

## Things to watch

- `MONITOR`, `SUBSCRIBE` and other streaming commands keep the connection open until you stop them.
- On the web app, commands travel through a proxy, so run latency-sensitive benchmarks locally.
- There's no undo. `FLUSHALL` really does flush everything.
