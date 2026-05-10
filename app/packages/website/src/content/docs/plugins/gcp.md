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

Paste a **Service account key (JSON)** — download from GCP Console → IAM & Admin → Service Accounts → Keys → Add key. The service account needs the Viewer role (or equivalent read permissions) on the project, plus any roles required for the resources you want to manage (Compute Admin, Cloud SQL Admin, etc.).

You can optionally set a **Project ID** to override the project embedded in the key. Leave blank to use the project from the key file.

<insert [GCP Add-account form with service account JSON textarea and optional project ID field] here>

## Notable flows

- **SSH terminal** on Compute Engine VMs — infrawrench injects your chosen SSH key via the instance metadata API.
- **SQL editor** on Cloud SQL (Postgres and MySQL).
- **File browser** on GCS buckets.
- **Secret export to K8s** for Cloud SQL and GCS (with service account key export as a secret).

## Tips & limits

- Service account keys never expire on Google's side, but rotating them is good hygiene — paste a new key any time.
- VM pricing is shown at creation time. It is an estimate — actual billing depends on sustained-use discounts and committed-use contracts.
- BigQuery results are paged; very large queries stream into the grid.
