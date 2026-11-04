---
title: Redis
description: Connect to any Redis (or Redis-compatible) instance and run commands.
sidebar_order: 15
---

## What you can manage

- Run commands in the [KV console](../features/kv-console.md).
- Browse keys by prefix.

## Connect an instance

Paste a Redis URL:

```
redis://:password@host:6379/0
rediss://:password@host:6380/0
```

Or reference an output from a managed Redis resource (DigitalOcean, ElastiCache, Upstash).

![Redis Add-account form with URL field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/redis/add-account.png)

## Things you can do

- **KV console** for any command.
- **SSH tunnel** for private instances.
- **Metrics**: the Metrics tab charts ops/sec, connected and blocked clients, used memory, evictions, expirations, hit ratio, keys, and average command latency since restart. The chart fills in as Infrawrench samples the instance.
- **Redis Cloud** databases open this plugin as their Redis tab, so the [Redis Cloud](./redis-cloud.md) plugin doesn't need a connection string.

## Tips & limits

- `rediss://` turns on TLS. Use it for any cloud-managed Redis.
- Streaming commands (`MONITOR`, `SUBSCRIBE`) hold the connection open until you stop them.
