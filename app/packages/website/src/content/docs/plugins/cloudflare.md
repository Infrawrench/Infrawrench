---
title: Cloudflare
description: Manage zones, DNS, Workers, R2, Pages, KV, D1, Tunnels, Access, and more.
sidebar_order: 20
---

The Cloudflare plugin is broad — 23 resource types across DNS, edge compute, storage, and zero-trust.

## What you can manage

- **DNS & zones** — zones, DNS records (with proxy status toggle), email routing.
- **Edge compute** — Workers (with script editor), Pages, Workers KV, D1 (SQLite), Hyperdrive.
- **Storage** — R2 buckets (with the [file browser](../features/file-browsers.md)).
- **Zero Trust** — Access applications, Tunnels.
- **Zone settings** — cache, security, SSL, performance toggles, edited via the [manifest editor](../features/manifest-editor.md).

## Credentials

Cloudflare dashboard → **My Profile → API Tokens → Create Token**. Use the “Edit zone DNS” template for DNS-only, or a custom token with the permissions matching the resources you plan to manage.

<insert [Cloudflare Add-account form with API token field] here>

## Notable flows

- **DNS record editor** with type-aware fields (A, AAAA, CNAME, MX, TXT, SRV, CAA).
- **Worker script editing** in Monaco with deploy.
- **R2 file browser** and **secret export to K8s** for bucket credentials.
- **Zone setting patches** — field-by-field, partial failures reported individually.

## Tips & limits

- Cloudflare’s API returns paginated lists; very large zones (1000s of records) load in chunks.
- Tokens can be scoped to specific zones. If you only see some zones, check the token scope.
