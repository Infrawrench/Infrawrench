---
title: WorkOS
description: Manage WorkOS organizations, domains, users, memberships, groups and invitations, watch SSO connections and Directory Sync directories, define roles and permissions, issue organization API keys, toggle feature flags, and wire up webhook endpoints.
sidebar_order: 48
---

## What you can manage

- **Organizations** — the tenant containers. Create one (optionally with domains), rename it, set or clear its external ID, delete it. The detail page shows each domain's verification state and counts of members, pending invites, connections and directories. Its **Logs** tab shows the organization's recent WorkOS events (memberships, invitations, domains, roles, SSO and Directory Sync activity, sign-ins, sessions, API keys and groups) with who triggered them.
- **Admin Portal links** — on an organization, **Get credentials** mints a fresh Admin Portal link for SSO setup, Directory Sync setup, domain verification, SAML certificate renewal, Audit Logs, Log Streams or Bring Your Own Key. Send it to the organization's IT admin; it expires five minutes after it is created.
- **Organization domains** — add a domain to an organization, see the TXT record name and value to publish, then **Verify**. Delete a domain to release it.
- **Users** — AuthKit / User Management users. Create one with an optional password, edit names, the verified flag, the external ID and the preferred locale, delete. The user page lists recent sessions (method, IP address, user agent, impersonation) and offers **Send verification email** for unverified users and **Sign out everywhere**, which revokes every active session. Users are environment-level: one user can belong to many organizations.
- **Memberships** — the user ↔ organization links. Create one with a user and role picker, reassign the role, deactivate and reactivate without losing role assignments, or remove it. Memberships holding several roles list all of them.
- **Groups** — named sets of an organization's memberships (the Groups API). Create, rename and delete them; the group page lists its members and lets you add or remove one with a picker.
- **Invitations** — send one to an email address with a role and an expiry (1–30 days), resend or revoke it while pending. Expiries feed the cross-provider Expiry radar.
- **SSO connections** — Okta SAML, Entra/Azure SAML, Google OAuth, generic OIDC and the rest. Rename or delete them here; set them up through an Admin Portal link or the WorkOS dashboard.
- **Directories** — Directory Sync links (SCIM, Google Workspace, Workday, …) with their synced **directory users** and **directory groups** underneath, plus active, inactive and group counts. The directory state (linked, validating, invalid credentials) drives the status dot. **Sync now** queues an immediate sync of a linked directory.
- **Roles** — environment roles from the Authorization API, with their permission lists. Create and rename here, and use **Edit permissions…** to replace the role's permissions from a picker. The API has no environment role delete, so removal stays in the WorkOS dashboard.
- **Organization roles** — custom roles scoped to one organization (slugs start with `org-`). Create one with permissions, rename it, edit its permissions, or delete it.
- **Permissions** — the permission slugs roles and API keys grant. Create, rename and delete them; WorkOS-managed system permissions cannot be deleted.
- **Organization API keys** — keys your application issued to an organization with WorkOS API Keys. Create one with a permission picker and an optional expiry; the full key is the sensitive `apiKey` output, available only for keys created here. **Expire now** or delete a key. Expiry dates feed the Expiry radar, and keys appear in access reviews with their last-used time.
- **Feature flags** — the environment's flags with their enabled state, default value, tags and owner. Turn a flag on or off, and add or remove an organization or user as a target. Define new flags in the WorkOS dashboard.
- **Webhook endpoints** — full CRUD, with an event picker covering every event WorkOS publishes; edit the subscribed events later. The signing secret is exposed as a sensitive `signingSecret` output for verifying payload signatures.

## Credentials

One field. WorkOS dashboard → **API Keys**.

- `sk_test_…` keys manage the **sandbox** environment, `sk_live_…` keys manage **production**. An account maps to one environment — add two accounts to see both.
- This is unrelated to the WorkOS credentials Infrawrench itself signs in with. The plugin manages **your** WorkOS environment with your key.

![WorkOS Add-account form with the API key field and the dashboard help link](https://agent-assets.infrawrench.com/docs-screenshots/plugins/workos/add-account.png)

## Pickers everywhere

You never type an `org_…` or `user_…` id:

- Membership and invitation creation offer an **organization picker** (skipped when you create from an organization's page), a **user picker** over your synced users, and a **role picker** fed live from the Authorization API — org-scoped roles when the organization is known, environment roles otherwise.
- Leaving the role unset uses the organization's default role.
- Domain, organization role, API key and group creation use the same organization picker; role and API key permissions come from a picker over your environment's permissions; feature flag targets are picked from your organizations and users; group members are picked from the organization's memberships.

![Create-invitation form opened from an organization, showing the role picker populated with live role names](https://agent-assets.infrawrench.com/docs-screenshots/plugins/workos/create-invitation.png)

## Tips & limits

- **Deleting an invitation revokes it.** WorkOS has no invitation delete; revoke is the removal operation, and the accept link stops working immediately.
- **Directory-managed memberships hide the deactivate/reactivate actions.** Directory Sync owns those rows — a manual change would be overwritten on the next sync.
- **Deactivating a membership keeps its role assignments**, so reactivation restores the user exactly as they were.
- **Organization domains created here start in `pending` state.** Verify them in the WorkOS dashboard; the organization page shows each domain's state.
- **Connections and directories are set up outside Infrawrench.** Setup needs the customer's identity provider, so it runs through an Admin Portal link (from the organization's **Get credentials**) or the dashboard.
- **The webhook signing secret is shown as a sensitive output**, not a field — resolve `signingSecret` where you need it (secret exports, output references).
- **No metrics or billing API.** WorkOS exposes neither usage time-series nor spend, so there is no Metrics tab and the plugin reports no costs.
