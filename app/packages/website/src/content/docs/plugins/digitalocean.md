---
title: DigitalOcean
description: Manage Droplets, Kubernetes, managed databases, Spaces, and DNS.
sidebar_order: 4
---

The most approachable cloud plugin — a single API token is all you need.

## What you can manage

- **Droplets** — list, create (image + size + region + SSH key pickers), delete.
- **Kubernetes (DOKS)** — clusters, with kubeconfig output for the [Kubernetes plugin](./kubernetes.md).
- **Managed databases** — Postgres, MySQL, Redis, MongoDB. Connection strings are outputs you can reference from the matching client plugins.
- **Spaces** — S3-compatible object storage, with the [file browser](../features/file-browsers.md).
- **DNS** — domains and records.

## Credentials

1. DigitalOcean → **API → Tokens → Generate new token**. Read + write scope.
2. Paste into the add-account form.

<insert [DigitalOcean Add-account form with API token field] here>

## Notable flows

- **SSH terminal** on Droplets.
- **SQL editor** on managed Postgres and MySQL (via output reference to the [Postgres](./postgres.md) / [MySQL](./mysql.md) plugins).
- **File browser** on Spaces.
- **Secret export to K8s** for managed databases and Spaces.

## Tips & limits

- Droplet creation needs at least one SSH key. Upload via **Settings → SSH keys** on DigitalOcean (not infrawrench) or use an existing key reference.
- DOKS kubeconfigs rotate periodically. Infrawrench re-fetches on refresh.
