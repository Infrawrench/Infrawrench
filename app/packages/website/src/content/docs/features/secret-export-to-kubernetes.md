---
title: Secret export to Kubernetes
description: Drag a cloud resource onto a cluster to create a K8s secret with its credentials.
sidebar_order: 9
---

This is the flagship cross-plugin flow. You have an RDS database, or an S3 bucket, or a Redis cluster, and you want those credentials available inside a Kubernetes pod. Instead of copying them into a YAML file, you drag the resource onto a cluster in the sidebar and infrawrench creates the `Secret` for you.

<insert [Drag gesture from an RDS database card onto an EKS cluster in the sidebar] here>

## How it works

1. Open the source resource (e.g. an RDS instance).
2. Drag its sidebar entry onto a Kubernetes cluster (or a namespace inside one).
3. A dialog opens showing the secret keys and resolved values.
4. Pick a namespace and (optionally) rename keys.
5. Click **Create secret**.

![Secret export dialog with DB_HOST, DB_USER, DB_PASSWORD keys and namespace picker](https://agent-assets.infrawrench.com/docs/screenshots/features/secret-export-dialog.png)

## Which resources support it

Resources that declare a secret export template. Current list:

- **AWS** — RDS, Aurora, Redshift, ElastiCache, S3, Lambda, SQS, SNS, DynamoDB, ECS, EKS
- **GCP** — Cloud SQL, GCS
- **Azure** — SQL Database, Storage accounts
- **DigitalOcean** — managed databases, Spaces
- **Neon, PlanetScale, Turso** — databases and branches
- **Redis, Memcached** (via output reference)
- **Cloudflare** — R2 buckets, Workers KV

Each plugin controls its template — what keys are exported, what shape the values take.

## What it writes

A standard `Opaque` `Secret` in the namespace you picked. Keys are base64-encoded as K8s requires. No labels or annotations beyond the defaults; edit the [manifest](./manifest-editor.md) afterwards if you want to add them.

## Updating a secret

Re-drag the same resource onto the same cluster. Infrawrench detects the existing secret and offers to update it in place. This is the usual flow after a [reroll](../core-concepts/secret-rerolls.md) or a credential rotation.

## Delete

The secret is not auto-managed. If you remove the source resource, the K8s secret stays. Delete it manually from the Kubernetes plugin.
