---
title: Resources and accounts
description: How infrawrench organizes the provider accounts you connect and the resources you manage, from the sidebar to account and detail pages.
sidebar_order: 1
---

Two ideas cover most of infrawrench: accounts and resources.

## Account

An **account** is one set of credentials for one provider. For example:

- A DigitalOcean API token for your personal projects.
- An AWS access key pair for your employer's staging account.
- A kubeconfig for a cluster a teammate shared with you.

Many providers also let you add an account by signing in to the provider instead of pasting a token. It's still an ordinary account, with the credentials refreshed for you. See [Connect with OAuth](../features/connect-with-oauth.md).

You can have as many accounts per provider as you like (say, a personal and a work DigitalOcean account). Each one is kept separate, and its resources show up under that account only.

### Update an account's credentials

When you regenerate a token at the provider (a rotation schedule, a scope change, a leaked secret), open the account page and click **Update credentials**. Non-sensitive fields are filled in for you. Sensitive ones are blank with a "leave blank to keep current value" placeholder, so you only retype what's changing. Your synced resources, pins, dashboards and SSH tunnel bindings stay as they are.

For an account added with **Connect with &lt;Provider&gt;**, the form shows **Reconnect** and **Use a token instead** in place of the token field. See [Connect with OAuth](../features/connect-with-oauth.md#switching-between-a-connection-and-a-token).

![Account detail page header showing the Rename / Update credentials / Remove buttons](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/resources-and-accounts/account-header-actions.png)

## Resource

A **resource** is anything a plugin can list or create: a Droplet, an EC2 instance, a DNS record, a Postgres database, a Kubernetes pod. Every resource belongs to exactly one account.

## The sidebar

```
Providers
├── DigitalOcean
│   ├── personal (account)
│   │   ├── Droplets (6)
│   │   ├── Managed Databases (2)
│   │   └── DNS Zones (3)
│   └── work (account)
│       └── ...
├── AWS
│   └── staging (account)
│       └── ...
└── Kubernetes
    └── my-cluster (account)
        └── ...
```

![Sidebar showing two DigitalOcean accounts and one AWS account expanded](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/resources-and-accounts/sidebar-accounts-expanded.png)

The sidebar refreshes every 30 seconds. To refresh an account or resource group now, use its right-click menu.

Healthy things have no marker. When an account or resource needs attention (its resources failed to load, a refresh failed, or the provider reports it as errored or degraded), a warning triangle appears next to its name. Hover it to see why. The same triangle marks problems across the app: a down probe, a firing alert rule, an offline bastion, a failed environment.

The sidebar only lists top-level resources, so the common ones are quick to reach. Nested resources like DNS records and database users are under their parent, or on the account page.

## Account pages

Click an account name to open its account page, the full list of everything Infrawrench knows about that account.

Each resource type gets its own tab, including nested types like DNS Records and DB Users that the sidebar leaves out. Tabs show their resource count in parentheses. Empty types are still listed if you can create one, so the create button is always there. Opening a tab fetches fresh data for that type from the provider.

Each resource is a square tile you can drag. It shows the resource's status and a few key facts, such as CPU, memory, region or size. These come from the last sync, so opening the page costs no extra provider calls, and they aren't live metrics. Which facts appear depends on what the provider reports, and a tile with nothing useful to show just has its name.

The search box narrows the tabs. It matches type names and also resource names, hosts, regions and engines. Type `d` and you keep every tab whose name or contents match. Type a Droplet's name and you jump to it. Search only hides tabs, it never shows hidden ones.

The [mobile app](../features/mobile-app.md) has the same sections and search, shown as scrollable cards instead of tabs.

![A DigitalOcean account page with a search query typed, narrowing the tab bar to the matching sections. With the search box empty, the same bar lists every resource type](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/resources-and-accounts/account-page-search-narrowed.png)

### When a list can't be read whole

A sync removes a resource when the provider stops listing it, so Infrawrench only trusts a list it read to the end. If a section has more rows than Infrawrench reads, or the provider answers with something that isn't a list, the sync refuses that list. The section keeps the rows it already had, which may be out of date, and the other sections carry on syncing as usual.

You see the reason in these places:

- **Account page:** on the section itself, when it refreshes.
- **Web sidebar:** a warning triangle next to the account. Hover it to read why.
- **[Mobile app](../features/mobile-app.md):** below **Sync from provider** on the account page.
- **[CLI](../features/cli.md):** the sync counts as failed, and the CLI prints the last copy it has and says why on stderr.

If your organization has paging on, a list that keeps being refused opens a [sync failure incident](../features/mobile-push-notifications.md#sync-failure-incidents) like any other failing section.

A few plugins read only part of a list on purpose, because the provider's rate limit wouldn't allow more, such as [GitLab](../plugins/gitlab.md) past its 100 most recently active projects. Those rows stay as last read instead of being removed, and the plugin's page says so.

### Providers with a single root

With a few providers, a credential can only ever reach one top-level resource. [UploadThing](../plugins/uploadthing.md) is the clearest case: an API key belongs to one app.

For those, opening the account takes you straight to that resource's detail page, and the sidebar expands the account directly to what's inside it (for UploadThing, your files). It's still a normal resource with its own outputs and its own URL.

This only applies when a second resource is impossible. If you just happen to have one project today, you still get the normal account page.

## Resource detail pages

Click any resource to open its detail page. Every detail page has:

- **Status:** the state the provider reports (running, stopped, error).
- **Outputs:** values this resource produces that other resources can reference (see [Output references](./output-references.md)).
- **Actions:** plugin-specific controls (SSH, SQL editor, start / stop, manifest edit and so on).
- **Raw data:** the full API response, collapsed.

## Next

- [Output references](./output-references.md): wire resources together.
- [Secret rerolls](./secret-rerolls.md): point a reference somewhere else when things change.
- [Desktop, web, and mobile](./desktop-vs-web.md): what differs between the apps.
