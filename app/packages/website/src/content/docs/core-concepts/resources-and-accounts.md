---
title: Resources and accounts
description: How infrawrench organizes what you connect and what you manage.
sidebar_order: 1
---

Two concepts do most of the work.

## Account

An **account** is one set of credentials for one provider. Examples:

- A DigitalOcean API token for your personal projects.
- An AWS access key pair for your employer’s staging account.
- A kubeconfig for a cluster a teammate shared with you.

You can have many accounts per provider (for example, two DigitalOcean accounts: personal and work). Each account lives under the same plugin but is isolated — its resources only show up grouped under that account.

### Rotating an account's credentials

When you regenerate a token upstream (rotation schedule, scope upgrade, leaked secret), open the account detail page and click **Update credentials**. The form prefills non-sensitive fields and leaves sensitive ones blank with a "leave blank to keep current value" placeholder so you only have to retype the bits you're changing. Synced resources, pins, dashboards, and SSH-tunnel bindings stay intact.

<insert [Account detail page header showing the Rename / Update credentials / Remove buttons] here>

## Resource

A **resource** is anything the plugin can list or create: a Droplet, an EC2 instance, a DNS record, a Postgres database, a Kubernetes pod. Every resource belongs to exactly one account.

## How the sidebar is organized

```
Providers
├── DigitalOcean
│   ├── personal (account)
│   │   ├── Droplets (6)
│   │   ├── Managed Databases (2)
│   │   └── DNS Zones (3)
│   └── work (account)
│       └── ...
├── AWS
│   └── staging (account)
│       └── ...
└── Kubernetes
    └── my-cluster (account)
        └── ...
```

<insert [Sidebar showing two DigitalOcean accounts and one AWS account expanded] here>

The sidebar auto-refreshes every 30 seconds. You can manually refresh an account or resource group from its context menu.

## Resource detail pages

Click any resource to open its detail page. Every detail page has:

- **Status** — provider-reported state (running, stopped, error).
- **Outputs** — values this resource produces that other resources can reference (see [Output references](./output-references.md)).
- **Actions** — plugin-specific controls (SSH, SQL editor, start / stop, manifest edit, etc.).
- **Raw data** — the full API response, collapsed.

## Next

- [Output references](./output-references.md) — wire resources together.
- [Secret rerolls](./secret-rerolls.md) — reassign a reference when upstream changes.
- [Desktop, web, and mobile](./desktop-vs-web.md) — what differs between the surfaces.
