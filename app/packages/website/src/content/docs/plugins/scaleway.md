---
title: Scaleway
description: Manage Scaleway Compute instances, Kapsule, managed RDB, and Object Storage.
sidebar_order: 6
---

## What you can manage

- Compute instances (Instances and Elastic Metal)
- Kapsule clusters (managed Kubernetes)
- Managed RDB (Postgres / MySQL)
- Object Storage (S3-compatible)

## Credentials

Scaleway Console → **Identity and Access Management → API keys → Generate API key**. You will need the **Access key**, **Secret key**, and your **Organization ID** and default **Project ID**.

<insert [Scaleway Add-account form with access / secret / org / project fields] here>

## Notable flows

- **SSH terminal** on Compute instances.
- **SQL editor** on RDB (via output reference).
- **File browser** on Object Storage.
- Zone / region picker on resource creation.

## Tips & limits

- Resources are scoped to a Project; pick the default at account add-time.
- Kapsule kubeconfigs can be exported to the [Kubernetes plugin](./kubernetes.md) via output reference.
