---
title: Secret export to Kubernetes
description: Drag a cloud resource onto a cluster to create a K8s secret with its credentials.
sidebar_order: 9
---

Got an RDS database, an S3 bucket or a Redis cluster whose credentials you need inside a Kubernetes pod? Instead of copying them into a YAML file, point the two resources at each other and Infrawrench creates the `Secret` for you.

## Create a secret on the web

Start from the cluster or account that will hold the secret, then pick the source:

1. Open the Kubernetes resource you want the secret to live in.
2. Click **Connect resource** in the action bar.
3. Search for the source resource (for example, an RDS instance) and press Enter.
4. The **Create Kubernetes Secret** dialog opens. It shows the template, the keys and where each value comes from.
5. Pick a namespace, rename keys if you like, and set the secret name.
6. Click **Create Secret**.

<insert [The Create Kubernetes Secret dialog opened from Connect resource, showing the key rows, namespace picker and secret name] here>

## Create a secret on desktop

The desktop app has the same **Connect resource** button. You can also drag: pick up the source resource in the sidebar (or from an account's detail page) and drop it on a Kubernetes account or cluster resource. You can't drop onto a namespace, so choose the namespace in the **Create Kubernetes Secret** dialog that opens.

<insert [Desktop drag gesture from an RDS database in the sidebar onto an EKS cluster, with the drop target highlighted] here>

## Send credentials to a VM instead

If the target has an SSH host but no Kubernetes, **Connect resource** writes the credentials to a file on that host. The dialog becomes **Deploy Credentials via SSH** and asks for:

- the SSH key and username
- the format: a `.env` file or shell `export` lines
- the file path

When a target supports both, a **K8s Secret** / **SSH Env Deploy** switcher appears at the top.

![Secret export dialog with DB_HOST, DB_USER, DB_PASSWORD keys and namespace picker](https://agent-assets.infrawrench.com/docs-screenshots/features/secret-export-to-kubernetes/create-secret-dialog.png)

## Supported resources

- **AWS:** RDS, Aurora, Redshift, ElastiCache, S3, Lambda, SQS, SNS, DynamoDB, ECS, EKS
- **GCP:** Cloud SQL, GCS
- **Azure:** SQL Database, Storage accounts
- **DigitalOcean:** managed databases, Spaces
- **Neon, PlanetScale, Turso:** databases and branches
- **Redis, Memcached** (via output reference)
- **Cloudflare:** R2 buckets, Workers KV

Each resource type has its own template that sets which keys are exported and what the values look like.

## What gets created

A standard `Opaque` `Secret` in the namespace you picked, with values base64-encoded as Kubernetes requires. There are no labels or annotations beyond the defaults. To add some, edit the [manifest](./manifest-editor.md) afterwards.

## Update a secret

Drag the same resource onto the same cluster again. Infrawrench spots the existing secret and offers to update it in place. Do this after a [reroll](../core-concepts/secret-rerolls.md) or any credential rotation.

## Delete a secret

Infrawrench doesn't manage the secret after it's created. If you remove the source resource, the Kubernetes secret stays. Delete it yourself from the Kubernetes plugin.
