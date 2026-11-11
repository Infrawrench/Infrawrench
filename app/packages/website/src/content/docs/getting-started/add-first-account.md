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

1. Click **Manage accounts** in the sidebar, then **Add account**.
2. Pick **DigitalOcean** from the provider list.
3. Give the account a display name (for example "personal" or "work").
4. Paste the API token.
5. Click **Save**.

![Add-account modal with provider picker and DigitalOcean form](https://agent-assets.infrawrench.com/docs-screenshots/getting-started/add-first-account/add-account-modal-digitalocean.png)

Many providers also have a **Connect with &lt;Provider&gt;** button at the top of the form. Sign in to the provider, approve access, and the token is filled in and kept fresh for you. See [Connect with OAuth](../features/connect-with-oauth.md).

For some providers (AWS, Google Cloud, Cloudflare) the form also has a **Check credentials** button. It shows what your credential can actually do, capability by capability, and can generate the exact least-privilege policy to grant. See [Credential preflight](../core-concepts/credential-preflight.md).

### Choose what the connection is for

Some providers power more than one app: AWS has resources for Infrastructure, a bill for Costs and metrics for Observability. For those, the form shows **Use this connection for** with one checkbox per app. They all start ticked.

Untick the apps you don't want this account used for. Two things follow from the choice:

- **The credential needs less.** The checklist and the least-privilege template under **Check credentials** only cover the apps you kept, so a connection for Costs alone asks for billing permissions and nothing else.
- **Only those apps collect data.** A connection for Costs alone has its bill read and no resources listed. A connection without Costs has no cost data collected.

Apps your organization has turned off under **Settings > Apps** are not offered here, so the credential is never asked for permissions nobody will use. If one of those apps is turned on later, its row on the Apps page tells you how many connections still lack its permissions.

![The add-account form for AWS with only Costs ticked under "Use this connection for": the credential check lists Cost reporting, Idle resource findings and AI request attribution, and the generated IAM policy contains only Cost Explorer actions](https://agent-assets.infrawrench.com/docs-screenshots/getting-started/add-first-account/add-account-2-costs-only-dark.png)

You can change the choice later. Open the account page and click **Change apps**. Adding an app starts collecting for it straight away, so give the credential that app's permissions first; the same dialog shows what they are. An account connected for Costs only has no resource list, and its page says so.

<insert [Account page of an AWS account connected for Costs only: the "Connected for Costs only" notice in place of the resource sections, with the Change apps button] here>

Providers that power a single app don't show the choice. In the desktop app without a cloud organization, the choice only shapes the policy template: nothing is collected in the background there, so nothing is stored.

Settings you'll rarely need, like a custom CA certificate for a self-hosted endpoint or a TLS-intercepting proxy, are under **Advanced options** at the bottom of the form. That section opens on its own if one of them already has a value.

## 3. Watch your resources appear

Within a few seconds the sidebar fills with your Droplets, Kubernetes clusters, databases, Spaces and domains. Click any resource to open its detail page.

![Sidebar populated with DigitalOcean resources grouped by type](https://agent-assets.infrawrench.com/docs-screenshots/getting-started/add-first-account/sidebar-do-resources.png)

## What next

- **Create a resource:** click **+** on any resource group (for example Droplets) to open the create form.
- **Pin favorites to the dashboard:** see [Dashboard](../features/dashboard.md).
- **Add another provider:** do the same with AWS, Kubernetes, Postgres and others. See [Plugins](../plugins/aws.md).
- **Learn how things are organized:** [Resources and accounts](../core-concepts/resources-and-accounts.md) explains the sidebar.
