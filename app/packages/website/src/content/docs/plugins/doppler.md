---
title: Doppler
description: Manage Doppler projects, environments and configs with a secrets editor, service tokens, integrations and syncs, webhooks, workplace users, groups and service accounts, and read the activity log.
sidebar_order: 50
---

Connect a Doppler workplace to manage its secrets and who can reach them.

## What you can manage

- **Workplace**: the account opens on your workplace, with its name and billing and security contacts (you can edit them). The **Logs** tab shows the workplace activity log.
- **Projects**: create, rename, change the description or delete a project.
- **Environments**: create one (name and slug), rename it or change its slug, or delete it along with its configs.
- **Configs**: root and branch configs with their environment, lock state, inheritance and when an app last fetched them.
  - The **Keys** tab lists every secret. Read, add, change and delete values there.
  - **Create** a branch config, rename it, **Clone** it with all its secrets, **Lock** or **Unlock** it, make it inheritable, or delete it.
  - The **Logs** tab shows the config's change log.
  - Branch configs that no app has ever fetched show under potential savings.
- **Secrets**: each secret's visibility (masked, unmasked or restricted) and note. Values are never stored in Infrawrench. Set a new value, change the visibility or note, or delete it. A secret's value is an output, so another resource (a Kubernetes secret, an SSH server's environment) can reference it and stay in step.
- **Service tokens**: config-scoped tokens with their access (read or read/write) and expiry. **Create** one (the token is shown once and kept as a secret output you can export as `DOPPLER_TOKEN`) or revoke it. Expiring tokens show on the expiry radar.
- **Integrations and secrets syncs**: each integration with its type and kind, and each sync's config and last sync time. You can delete either. Deleting a sync keeps the secrets already synced to the target.
- **Webhooks**: per project. Create, edit the name, URL and configs, **Enable** or **Disable**, or delete.
- **Users**: workplace members and their role. **Change role** lets you pick from the workplace's roles.
- **Groups**: members, projects and default project role. Create, rename, change the default role and members (by email), or delete.
- **Service accounts and their API tokens**: with each token's last use and expiry. Delete a service account or revoke a token.

## Connect your account

1. In the [Doppler dashboard](https://dashboard.doppler.com), open your avatar menu, go to **Tokens**, and **Generate** a personal token (it starts with `dp.pt.`). It sees everything you can see.
2. Or, if you want a connection that doesn't depend on one person, create a service account under **Team > Service Accounts**, give it a workplace role, and generate an **API token** for it (`dp.sa.`).
3. Paste the token. Config-scoped service tokens (`dp.st.`) can't list projects, so they're refused.

<insert [Doppler Add-account form with the API token filled in] here>

<insert [Doppler config detail page with the Keys tab listing secrets] here>

## Tips and limits

- Secrets are listed for up to 100 configs (3,000 secrets in all). Each config's Keys tab still shows all of its secrets.
- Restricted secrets can't be read back. The Keys tab and the secret's value output refuse them, just like Doppler does.
- The Keys tab shows raw values, with `${OTHER_SECRET}` references not expanded. The secret's value output gives the computed value.
- Creating integrations and syncs needs credentials for the target service, so do that in Doppler.
- Doppler's API has no billing data, so there are no costs.
- [Export to Terraform](../features/terraform-export.md) writes projects, environments, branch configs and groups for the `DopplerHQ/doppler` provider. Secrets are never exported.
