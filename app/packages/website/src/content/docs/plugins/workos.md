---
title: WorkOS
description: Manage WorkOS organizations, domains, users, memberships, groups and invitations, watch SSO connections and Directory Sync directories, define roles and permissions, issue organization API keys, toggle feature flags, and wire up webhook endpoints.
sidebar_order: 48
---

## What you can manage

- **Organizations**: create one (optionally with domains), rename it, set or clear its external ID, delete it. The detail page shows each domain's verification state and counts of members, pending invites, connections and directories. Its **Logs** tab shows the organization's recent WorkOS events (memberships, invitations, domains, roles, SSO and Directory Sync activity, sign-ins, sessions, API keys and groups) and who triggered them. Its **Metrics** tab counts SSO sign-ins, SSO failures (failed and timed out), sessions created and Directory Sync user and group changes over time.
- **Admin Portal links**: on an organization, **Get credentials** creates a fresh Admin Portal link for SSO setup, Directory Sync setup, domain verification, SAML certificate renewal, Audit Logs, Log Streams or Bring Your Own Key. Send it to the organization's IT admin. It expires five minutes after it's created.
- **Organization domains**: add a domain to an organization, see the TXT record name and value to publish, then **Verify**. Delete a domain to release it.
- **Users**: AuthKit / User Management users. Create one with an optional password, edit names, the verified flag, the external ID and the preferred locale, or delete. The user page lists recent sessions (method, IP address, user agent, impersonation) and offers **Send verification email** for unverified users and **Sign out everywhere**, which ends every active session. Users belong to the environment, so one user can be in many organizations.
- **Memberships**: the links between users and organizations. Create one with a user and role picker, change the role, deactivate and reactivate without losing role assignments, or remove it. Memberships with several roles list all of them.
- **Groups**: named sets of an organization's memberships. Create, rename and delete them. The group page lists its members and lets you add or remove one with a picker.
- **Invitations**: send one to an email address with a role and an expiry (1 to 30 days), and resend or revoke it while it's pending. Expiries show on the Expiry radar.
- **SSO connections**: Okta SAML, Entra/Azure SAML, Google OAuth, generic OIDC and the rest. Rename or delete them here. Set them up through an Admin Portal link or the WorkOS dashboard.
- **Directories**: Directory Sync links (SCIM, Google Workspace, Workday, …) with their synced **directory users** and **directory groups** underneath, plus active, inactive and group counts. A directory with invalid credentials shows a warning explaining why. **Sync now** queues an immediate sync of a linked directory.
- **Roles**: environment roles with their permission lists. Create and rename them here, and use **Edit permissions…** to replace a role's permissions from a picker. Delete environment roles in the WorkOS dashboard.
- **Organization roles**: custom roles for one organization (slugs start with `org-`). Create one with permissions, rename it, edit its permissions, or delete it.
- **Permissions**: the permission slugs roles and API keys grant. Create, rename and delete them. WorkOS-managed system permissions can't be deleted.
- **Organization API keys**: keys your application issued to an organization with WorkOS API Keys. Create one with a permission picker and an optional expiry. The full key is the sensitive `apiKey` output, only available for keys created here. **Expire now** or delete a key. Expiry dates show on the Expiry radar, and keys appear in access reviews with their last-used time.
- **Feature flags**: the environment's flags with their enabled state, default value, tags and owner. Turn a flag on or off, and add or remove an organization or user as a target. Define new flags in the WorkOS dashboard.
- **Webhook endpoints**: create, edit and delete, with an event picker covering every event WorkOS publishes. You can change the subscribed events later. The signing secret is a sensitive `signingSecret` output for checking payload signatures.

## Connect your environment

There's one field. Get the key from the WorkOS dashboard under **API Keys**.

- `sk_test_…` keys manage the **sandbox** environment, and `sk_live_…` keys manage **production**. Each account covers one environment, so add two accounts to see both.
- This has nothing to do with how you sign in to Infrawrench. The plugin manages **your** WorkOS environment with your key.

![WorkOS Add-account form with the API key field and the dashboard help link](https://agent-assets.infrawrench.com/docs-screenshots/plugins/workos/add-account.png)

## Pick, don't type

You never type an `org_…` or `user_…` id:

- Creating a membership or invitation offers an **organization picker** (skipped when you start from an organization's page), a **user picker** over your users, and a **role picker** with live role names: the organization's roles when it's known, environment roles otherwise.
- Leaving the role unset uses the organization's default role.
- Creating a domain, organization role, API key or group uses the same organization picker. Role and API key permissions come from a picker over your environment's permissions. Feature flag targets are picked from your organizations and users, and group members from the organization's memberships.

![Create-invitation form opened from an organization, showing the role picker populated with live role names](https://agent-assets.infrawrench.com/docs-screenshots/plugins/workos/create-invitation.png)

## Tips & limits

- **Deleting an invitation revokes it**, and the accept link stops working straight away.
- **Memberships managed by Directory Sync can't be deactivated or reactivated here**, since the next sync would undo the change.
- **Deactivating a membership keeps its role assignments**, so reactivating restores the user exactly as they were.
- **Organization domains created here start as `pending`.** Verify them in the WorkOS dashboard. The organization page shows each domain's state.
- **Set up connections and directories outside Infrawrench.** Setup needs the customer's identity provider, so use an Admin Portal link (from the organization's **Get credentials**) or the dashboard.
- **The webhook signing secret is an output**, not a field. Use `signingSecret` where you need it (secret exports, output references).
- **Metrics are counted from events**, and there's no cost data, since WorkOS has no metrics or billing API. Only SSO sign-ins can be tied to an organization, so password, magic auth, social and passkey sign-ins aren't charted. Longer windows show the latest 30 days. For a very busy organization, the chart starts at the oldest of the most recent 2,000 events.
