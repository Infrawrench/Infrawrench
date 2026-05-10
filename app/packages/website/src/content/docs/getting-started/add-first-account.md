---
title: Add your first account
description: Connect a cloud provider so infrawrench can list and manage your resources.
sidebar_order: 3
---

This walkthrough uses DigitalOcean because it has the simplest credential: a single API token. Any plugin follows the same shape — see each [plugin page](../plugins/digitalocean.md) for the exact fields.

## 1. Get an API token from DigitalOcean

1. Sign in to DigitalOcean.
2. Go to **API → Tokens**.
3. Click **Generate new token**. Give it read + write scope.
4. Copy the token. You will not see it again.

## 2. Add the account in infrawrench

1. Click **Add account** in the sidebar.
2. Pick **DigitalOcean** from the provider list.
3. Give the account a display name (e.g. “personal”, “work”).
4. Paste the API token.
5. Click **Save**.

<insert [Add-account modal with provider picker and DigitalOcean form] here>

## 3. Watch your resources appear

Within a few seconds the sidebar populates with your Droplets, Kubernetes clusters, databases, Spaces, and domains. Click any resource to see its detail page.

<insert [Sidebar populated with DigitalOcean resources grouped by type] here>

## What next

- **Create a resource** — click **+** on any resource group (e.g. Droplets) to open the creation form.
- **Pin favorites to the dashboard** — see [Dashboard](../features/dashboard.md).
- **Add another provider** — repeat with AWS, Kubernetes, Postgres, etc. See [Plugins](../plugins/aws.md).
- **Learn the mental model** — [Resources and accounts](../core-concepts/resources-and-accounts.md) explains how the sidebar is organized.
