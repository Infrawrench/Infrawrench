---
title: Fly.io
description: Manage Fly apps, machines, volumes, certificates, and IP allocations across 36 regions.
sidebar_order: 8
---

## What you can manage

- Apps (list, view config)
- Machines (start / stop / restart, state tracking)
- Volumes
- Certificates
- IP allocations

## Credentials

Fly.io dashboard → **Account → Access Tokens → Create Token**. Tokens are organization-scoped, so you also need to tell infrawrench which org to use.

- **API Token** — the token from the Fly dashboard.
- **Organization Slug** — your Fly org slug (defaults to `personal`).

![Fly Add-account form with API token and organization slug fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fly/add-account.png)

Infrawrench uses the token for both the Machines API and the GraphQL API.

## Notable flows

- **SSH terminal** on machines that have `fly ssh` enabled.
- Region picker across all 36 Fly regions when creating machines.
- Machine state (started, stopped, destroyed) tracked in the list view.
- **Certificate and IP inventory** across every app in the configured organization.

## Tips & limits

- Fly apps can be organization-scoped. Tokens scoped to one org will not see apps from another.
- Machine creation via infrawrench sets only common fields — for complex configs (custom init, metadata, anti-affinity), use `flyctl` and pull the result back in.
