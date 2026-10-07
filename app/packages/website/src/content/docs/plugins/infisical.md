---
title: Infisical
description: Manage Infisical projects, environments, folders, secrets, secret syncs, machine identities, dynamic secrets, certificates and audit logs on Infisical Cloud or a self-hosted instance.
sidebar_order: 60
---

Infisical is an open-source secrets, certificate and key management platform. Infrawrench connects to Infisical Cloud (US or EU) or to your own self-hosted or dedicated instance with a machine identity.

## What you can manage

- Projects (create, rename, change the slug, delete protection, auto-capitalization, secret sharing and the point-in-time version limit)
- Environments (create, rename, reorder, delete)
- Folders (create anywhere in the tree, rename, describe, delete)
- Secrets (create, rename, set a new value, comment, rotation reminders, delete; values are read on demand and never stored in Infrawrench)
- Secret syncs (watch status, edit the source and auto-sync, sync now, import from the destination, remove synced secrets, delete)
- Legacy native integrations (status, sync now, delete)
- Machine identities (create with an organization role, edit, delete protection, Universal Auth, client secrets, project access)
- Dynamic secrets (edit TTLs, mint leases, see and revoke active leases)
- Certificate authorities and certificates in certificate management projects (issue, renew, revoke, download the certificate or the full bundle)

## Credentials

Infrawrench signs in as a **machine identity** with Universal Auth:

1. In Infisical, go to **Organization Settings → Access Control → Identities** and choose **Create identity**. The **Admin** organization role lets Infrawrench list every identity and read audit logs; **Member** is enough for project-level work.
2. Open the identity, add **Universal Auth**, copy the **Client ID**, then choose **Create Client Secret** and copy the secret (Infisical shows it once).
3. Add the identity to each project you want to manage (**Project Settings → Access Control → Machine Identities**). A project the identity is not a member of is invisible to it.
4. In Infrawrench, enter the **Instance URL** (`https://app.infisical.com` for US Cloud, `https://eu.infisical.com` for EU Cloud, or your own URL), the client ID and the client secret. A self-hosted instance with a private CA can take its certificate under **Advanced options**.

<insert [Infisical add-account form showing the Instance URL, Client ID and Client Secret fields] here>

## Notable flows

- **Secrets without leaking values**: secrets sync with their keys, folders, comments and versions only. The **Value** output fetches the current value when you reveal it or when another resource references it. **Edit** sets a new value (leave it blank to keep the current one) or renames the key. Environments that require approval open a change request instead, and Infrawrench says so.
- **Pickers instead of ids**: creating a secret or folder offers every project, environment and folder path the identity can see in one list; machine identities pick from the organization's roles; certificates pick a certificate profile.
- **Secret syncs**: a failed sync shows its last error. **Sync now** queues a sync, **Import from destination** asks whether Infisical's or the destination's value wins on a conflict, and **Remove synced secrets** deletes what the sync wrote at the destination.
- **Machine identities**: **Enable Universal Auth**, **Get credentials** mints a new client secret (shown once, as an env file), **Revoke client secret**, **Token settings** (TTLs and trusted IPs), **Clear lockouts**, and **Add to project** / **Remove from project** with a project role.
- **Dynamic secrets**: **Get credentials** mints a lease with the default TTL; the detail page lists active leases and **Revoke lease** deletes one at the provider.
- **Certificates**: issue from a profile, **Renew**, **Revoke** with a reason, and download the PEM chain or (when Infisical holds the key) the full bundle. Certificates and CAs feed the Expiry radar.
- **Audit logs and metrics**: projects, environments, secrets and machine identities have a Logs tab backed by Infisical's audit log. A project's Metrics tab charts secret reads, secret changes, identity logins and failed logins.
- **Terraform export** for projects, environments, folders, secrets (values as variables) and machine identities with the official `Infisical/infisical` provider.

<insert [Infisical secret sync detail view showing a failed sync status, its last error message, and the Sync now and Import from destination actions] here>

## Tips & limits

- Creating secret syncs is left to Infisical: each of the 50+ destinations has its own configuration and app connection. Existing syncs can be edited, run and deleted here.
- Dynamic secrets are discovered in the root and in up to 40 folders per environment. Creating one needs provider-specific inputs, so it is done in Infisical.
- Audit logs and the Metrics tab need an Infisical plan that includes audit logs, and an identity whose organization role can read them. The Metrics tab reads at most 5,000 events per window.
- Only shared secrets are listed; personal overrides belong to individual users.
- Infisical's status page does not distinguish US from EU incidents, so a status incident is shown against every Infisical account.
