---
title: Hetzner Cloud
description: Manage Hetzner servers, volumes, networks, load balancers, images, and IP resources.
sidebar_order: 5
---

## What you can manage

- Servers (create with image + size + datacenter + SSH key)
- Volumes
- Floating IPs
- Firewalls
- Networks
- Load balancers
- Primary IPs
- SSH keys
- Images, including snapshots and backups returned by the Hetzner API
- Placement groups

## Credentials

Hetzner Cloud Console → select a project → **Security → API tokens → Generate API token**. Read + write.

<insert [Hetzner Add-account form with API token field] here>

Each API token is project-scoped. Add one infrawrench account per Hetzner project.

## Notable flows

- **SSH terminal** on servers.
- Idempotent SSH key upload: when you pick a key from infrawrench during server creation, it is uploaded to Hetzner if not already present.
- **Load balancer and network inventory** so service topology is visible without leaving the app.
- **Secret export to K8s** is not supported for Hetzner resources directly (they do not hold secrets).

## Tips & limits

- Hetzner is cheap and fast, but its API has global rate limits. A single large account refresh may briefly throttle.
