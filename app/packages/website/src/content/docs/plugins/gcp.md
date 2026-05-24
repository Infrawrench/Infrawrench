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
- **AI/ML** — Vertex AI endpoints and a curated list of Vertex AI Gemini chat models.

## Credentials

Paste a **Service account key (JSON)** — download from GCP Console → IAM & Admin → Service Accounts → Keys → Add key. The service account needs the Viewer role (or equivalent read permissions) on the project, plus any roles required for the resources you want to manage (Compute Admin, Cloud SQL Admin, etc.).

You can optionally set a **Project ID** to override the project embedded in the key. Leave blank to use the project from the key file.

<insert [GCP Add-account form with service account JSON textarea and optional project ID field] here>

## Notable flows

- **SSH terminal** on Compute Engine VMs — infrawrench injects your chosen SSH key via the instance metadata API.
- **SQL editor** on Cloud SQL (Postgres, MySQL, SQL Server) — direct connection to the instance's public IP using the embedded root password (see below).
- **File browser** on GCS buckets.
- **Secret export to K8s** for Cloud SQL and GCS (with service account key export as a secret).
- **Gemini Playground** on Vertex AI Gemini models — open any model under **AI/ML** and use the **Playground** tab to chat with it. Responses stream token-by-token through Vertex AI's OpenAI-compatible chat endpoint (`us-central1`), authorized with the account's service account. The whole conversation history is sent on each turn. The service account needs the **Vertex AI User** role (`roles/aiplatform.user`) and the Vertex AI API enabled on the project.

<insert [GCP Gemini model detail page with the Playground tab open, showing a streamed assistant reply] here>

## Cloud SQL connectivity

The PostgreSQL / MySQL / SQL Server tabs on a Cloud SQL instance connect directly to the instance's public IP using the root password Infrawrench stored at create time. To make this reachable from your machine you need to:

- Enable a public IP on the instance (Cloud SQL → this instance → Connections → Networking → Public IP). New instances created from Infrawrench have this enabled by default; the create modal exposes the toggle.
- Add your client IP (or `0.0.0.0/0` if you accept the risk) to **Authorized networks** on the same screen so Cloud SQL accepts the inbound connection.

If the instance has no public IP, the tab renders a static guidance pane explaining the options (add public IP, run Infrawrench inside the VPC, or set up Cloud VPN / IAP) — Infrawrench doesn't try to dial through a tunnel automatically.

## Tips & limits

- Service account keys never expire on Google's side, but rotating them is good hygiene — paste a new key any time.
- VM pricing is shown at creation time. It is an estimate — actual billing depends on sustained-use discounts and committed-use contracts.
- BigQuery results are paged; very large queries stream into the grid.
