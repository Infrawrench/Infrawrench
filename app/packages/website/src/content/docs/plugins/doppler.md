---
title: Doppler
description: Manage Doppler projects, environments and configs with a secrets editor, service tokens, integrations and syncs, webhooks, workplace users, groups and service accounts, and read the activity log.
sidebar_order: 50
---

Connect a Doppler workplace to manage its secrets and who can reach them.

## What you can manage

- **Workplace**: the account opens on the workplace, with its name and billing and security contacts (editable). The **Logs** tab shows the workplace activity log.
- **Projects**: create, rename, change the description or delete a project.
- **Environments**: create an environment (name and slug), rename it or change its slug, or delete it with its configs.
- **Configs**: root and branch configs with their environment, lock state, inheritance and when an application last fetched them. The **Keys** tab lists every secret and lets you read, add, change and delete values. **Create** a branch config, rename it, **Clone** it with all its secrets, **Lock** or **Unlock** it, make it inheritable, or delete it. The **Logs** tab shows the config's change log. Branch configs no application has ever fetched appear under potential savings.
- **Secrets**: each secret's visibility (masked, unmasked or restricted) and note. Values never sync into Infrawrench. Set a new value, change the visibility or note, or delete it. A secret's value is an output, so another resource (a Kubernetes secret, an SSH server's environment) can reference it and stay in step.
- **Service tokens**: config-scoped tokens with their access (read or read/write) and expiry. **Create** one (the token is shown once and kept as a secret output you can export as `DOPPLER_TOKEN`) or revoke it. Expiring tokens appear on the expiry radar.
- **Integrations and secrets syncs**: each integration with its type and kind, and each sync's config and last sync time. Delete either (deleting a sync keeps the secrets already synced to the target).
- **Webhooks**: per project. Create, edit the name, URL and configs, **Enable** or **Disable**, or delete.
- **Users**: workplace members and their role. **Change role** picks from the workplace's roles.
- **Groups**: members, projects and default project role. Create, rename, change the default role and members (by email), or delete.
- **Service accounts and their API tokens**: with each token's last use and expiry. Delete a service account or revoke a token.

## Credentials

1. In the [Doppler dashboard](https://dashboard.doppler.com), open your avatar menu, **Tokens**, and **Generate** a personal token (it starts with `dp.pt.`). It sees everything you can see.
2. Or, for a connection that does not depend on a person, create a service account under **Team**, **Service Accounts**, give it a workplace role, and generate an **API token** for it (`dp.sa.`).
3. Paste the token. Config-scoped service tokens (`dp.st.`) cannot list projects, so they are refused.

<insert [Doppler Add-account form with the API token filled in] here>

<insert [Doppler config detail page with the Keys tab listing secrets] here>

## Tips & limits

- Secrets are listed for up to 100 configs (3,000 secrets in all). Every config's Keys tab still shows all of its secrets.
- Restricted secrets cannot be read back: the Keys tab and the secret's value output refuse them, as Doppler does.
- The Keys tab shows raw values, with `${OTHER_SECRET}` references unexpanded; the secret's value output is the computed value.
- Creating integrations and syncs needs credentials for the target service and is done in Doppler.
- Doppler's API has no billing endpoint, so there is no cost data.
- [Export to Terraform](../features/terraform-export.md) writes projects, environments, branch configs and groups for the `DopplerHQ/doppler` provider. Secrets are never exported.
