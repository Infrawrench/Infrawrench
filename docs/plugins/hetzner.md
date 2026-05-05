---
title: Hetzner Cloud
description: Manage Hetzner servers, volumes, firewalls, and floating IPs.
sidebar_order: 5
---

## What you can manage

- Servers (create with image + size + datacenter + SSH key)
- Volumes
- Floating IPs
- Firewalls
- Networks

## Credentials

Hetzner Cloud Console → select a project → **Security → API tokens → Generate API token**. Read + write.

<insert [Hetzner Add-account form with API token field] here>

Each API token is project-scoped. Add one infrawrench account per Hetzner project.

## Notable flows

- **SSH terminal** on servers.
- Idempotent SSH key upload: when you pick a key from infrawrench during server creation, it is uploaded to Hetzner if not already present.
- **Secret export to K8s** is not supported for Hetzner resources directly (they do not hold secrets).

## Tips & limits

- Hetzner is cheap and fast, but its API has global rate limits. A single large account refresh may briefly throttle.
- Snapshots and backups are not yet exposed in the UI — coming.
