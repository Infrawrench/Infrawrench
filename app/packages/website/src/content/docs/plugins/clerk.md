---
title: Clerk
description: Manage Clerk users, sessions, organizations, domains, JWT templates, OAuth applications, enterprise SSO, machines, allow and block lists, invitations and sign-up restrictions.
sidebar_order: 63
---

Each Clerk account you add is one Clerk instance: the development or production environment of a Clerk application. Open the account to see the instance with its user counts, sign-up restrictions and webhooks.

## What you can manage

- The instance (allowed origins, support email, sign-up restrictions, organization defaults, bot protection, webhooks)
- Users (create, edit, set a password, ban, lock, reset MFA, revoke sessions, organization memberships, delete)
- Organizations (create, rename, member limit, members and roles, invitations, delete)
- Domains (the primary domain and satellites, with the DNS records Clerk needs; add satellites, set a proxy URL)
- JWT templates (create, edit claims, lifetime and clock skew, delete)
- OAuth applications (create, edit redirect URIs and scopes, rotate the client secret, delete)
- Enterprise connections (create SAML connections from an IdP metadata URL, edit domains, activate, delete)
- Machines for machine-to-machine tokens (create, edit, which machines each may call, rotate the secret key)
- Allowlist and blocklist entries, invitations and redirect URLs

## Connect an instance

1. In the [Clerk Dashboard](https://dashboard.clerk.com), open your application and choose the instance (Development or Production).
2. Go to **Configure > API keys**.
3. Copy the **Secret key** (`sk_live_…` for production, `sk_test_…` for development). The publishable `pk_` key won't work.

Each secret key belongs to one instance, so add a separate account for development and production.

<insert [Clerk add-account form with the Secret Key field filled in] here>

## Common tasks

- **Restrictions tab**: toggle the allowlist and blocklist, block email subaddresses and disposable email domains, apply the lists to sign-up only, turn organizations on or off with their default member limit, and switch bot protection rules.
- **Webhooks**: Clerk delivers webhooks through Svix. Click **Enable webhooks** once, then **Get credentials > Webhooks dashboard link** to open a short-lived link where you manage endpoints and event types.
- **Users**: the actions match the user's state (Ban or Unban, Lock or Unlock). **Sign out everywhere** revokes every active session, or you can revoke a single one from the list. To add a user to an organization, pick the organization and a role.
- **Organizations**: add members, change roles, invite by email and revoke pending invitations, all from pickers that list the instance's users and organization roles.
- **Domains**: each domain lists the CNAME records Clerk expects (Frontend API, Account Portal, email) and which ones are required.
- **Secrets shown once**: rotating an OAuth application's client secret or a machine's secret key shows the new value only once. Machine keys can rotate with a one-hour grace period for the old key.
- **Metrics**: the instance's Metrics tab charts new users per day and shows active users over the last day, week and month. The dashboard card shows total, active and banned users.

<insert [Clerk instance Restrictions tab showing the allowlist, blocklist and organization toggles] here>

## Tips & limits

- Webhook endpoints live in Svix, so you manage them through the dashboard link rather than here.
- OIDC enterprise connections, and SAML connections set up with raw certificates, can be listed, edited and deleted here but must be created in the Clerk Dashboard.
- Clerk API keys are scoped to individual users and organizations and aren't listed.
- There is no official Clerk Terraform provider, so Terraform export isn't available.
