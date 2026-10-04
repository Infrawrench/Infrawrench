---
title: Redis
description: Connect to any Redis (or Redis-compatible) instance and run commands.
sidebar_order: 15
---

## What you can manage

- Run commands via the [KV console](../features/kv-console.md).
- Browse keys by prefix.

## Credentials

Paste a Redis URL:

```
redis://:password@host:6379/0
rediss://:password@host:6380/0
```

Or reference an output from a managed Redis resource (DigitalOcean, ElastiCache, Upstash).

![Redis Add-account form with URL field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/redis/add-account.png)

## Notable flows

- **KV console** for arbitrary commands.
- **SSH tunnel** for private instances.
- **Metrics**: the Metrics tab charts one INFO reading per sample (ops/sec, connected and blocked clients, used memory, evictions, expirations, hit ratio, keys, and average command latency since restart). The chart fills in as Infrawrench samples the instance.
- **Redis Cloud** databases open this plugin as their Redis tab, so the [Redis Cloud](./redis-cloud.md) plugin needs no connection string.

## Tips & limits

- `rediss://` enables TLS. Use it for any cloud-managed Redis.
- Streaming commands (`MONITOR`, `SUBSCRIBE`) hold the connection; stop them explicitly.
