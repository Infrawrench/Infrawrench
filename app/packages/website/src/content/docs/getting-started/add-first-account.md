---
title: Add your first account
description: Connect a cloud provider account so infrawrench can list and manage your resources.
sidebar_order: 2
---

This walkthrough uses DigitalOcean because its credential is the simplest: one API token. Every plugin works the same way. Check each [plugin page](../plugins/digitalocean.md) for its exact fields.

## 1. Get an API token from DigitalOcean

1. Sign in to DigitalOcean.
2. Go to **API > Tokens**.
3. Click **Generate new token** and give it read and write scope.
4. Copy the token. You won't see it again.

## 2. Add the account in infrawrench

1. Click **Add account** in the sidebar.
2. Pick **DigitalOcean** from the provider list.
3. Give the account a display name (for example "personal" or "work").
4. Paste the API token.
5. Click **Save**.

![Add-account modal with provider picker and DigitalOcean form](https://agent-assets.infrawrench.com/docs-screenshots/getting-started/add-first-account/add-account-modal-digitalocean.png)

Many providers also have a **Connect with &lt;Provider&gt;** button at the top of the form. Sign in to the provider, approve access, and the token is filled in and kept fresh for you. See [Connect with OAuth](../features/connect-with-oauth.md).

For some providers (AWS, Google Cloud, Cloudflare) the form also has a **Check credentials** button. It shows what your credential can actually do, capability by capability, and can generate the exact least-privilege policy to grant. See [Credential preflight](../core-concepts/credential-preflight.md).

Settings you'll rarely need, like a custom CA certificate for a self-hosted endpoint or a TLS-intercepting proxy, are under **Advanced options** at the bottom of the form. That section opens on its own if one of them already has a value.

## 3. Watch your resources appear

Within a few seconds the sidebar fills with your Droplets, Kubernetes clusters, databases, Spaces and domains. Click any resource to open its detail page.

![Sidebar populated with DigitalOcean resources grouped by type](https://agent-assets.infrawrench.com/docs-screenshots/getting-started/add-first-account/sidebar-do-resources.png)

## What next

- **Create a resource:** click **+** on any resource group (for example Droplets) to open the create form.
- **Pin favorites to the dashboard:** see [Dashboard](../features/dashboard.md).
- **Add another provider:** do the same with AWS, Kubernetes, Postgres and others. See [Plugins](../plugins/aws.md).
- **Learn how things are organized:** [Resources and accounts](../core-concepts/resources-and-accounts.md) explains the sidebar.
