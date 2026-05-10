---
title: Google Cloud
description: Manage Compute Engine, GKE, Cloud SQL, App Engine, BigQuery, and GCS.
sidebar_order: 3
---

## What you can manage

- **Compute** — Compute Engine VM instances.
- **Kubernetes** — GKE clusters (links to the [Kubernetes plugin](./kubernetes.md)).
- **Databases** — Cloud SQL (Postgres, MySQL).
- **Analytics** — BigQuery datasets and tables.
- **App hosting** — App Engine services.
- **Storage** — Cloud Storage buckets.

## Credentials

Two ways to connect:

1. **OAuth browser flow** (recommended for humans). Click **Sign in with Google** in the add-account form. Pick the project.
2. **Service account JSON** (for automation). Paste the JSON key downloaded from IAM → Service Accounts.

<insert [GCP Add-account form with OAuth button and service account textarea] here>

## Notable flows

- **SSH terminal** on Compute Engine VMs — infrawrench injects your chosen SSH key via the instance metadata API.
- **SQL editor** on Cloud SQL (Postgres and MySQL).
- **File browser** on GCS buckets.
- **Secret export to K8s** for Cloud SQL and GCS (with service account key export as a secret).

## Tips & limits

- OAuth tokens refresh automatically. If you revoke the grant from your Google account, reconnect the plugin.
- VM pricing is shown at creation time. It is an estimate — actual billing depends on sustained-use discounts and committed-use contracts.
- BigQuery results are paged; very large queries stream into the grid.
