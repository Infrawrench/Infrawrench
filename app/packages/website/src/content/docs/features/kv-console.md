---
title: KV console
description: Run Redis and Memcached commands against your connected caches.
sidebar_order: 5
---

The KV console is the key-value counterpart to the [SQL editor](./sql-editor.md). It gives you a command-line style interface against Redis and Memcached instances you have connected.

<insert [KV console with a few SET / GET commands and their replies] here>

## Where to open it

Click the **Console** button on:

- A Redis account or a Redis-compatible resource (Upstash, ElastiCache with Redis, DigitalOcean managed Redis via output reference).
- A Memcached account or ElastiCache with Memcached.

## What it supports

- **Redis** — the full command set your server version exposes. Autocomplete on command names.
- **Memcached** — text-protocol commands (`get`, `set`, `delete`, `stats`, etc.).

Replies are rendered with type hints: strings as strings, lists as bulleted lists, hashes as tables.

## Things to watch

- `MONITOR`, `SUBSCRIBE`, and other streaming commands hold the connection open until you stop them.
- On the web app the console is WebSocket-proxied, so very latency-sensitive benchmarking is better done locally.
- There is no undo. `FLUSHALL` flushes all.
