---
title: Clerk
description: Manage Clerk users, sessions, organizations, domains, JWT templates, OAuth applications, enterprise SSO, machines, allow and block lists, invitations and sign-up restrictions.
sidebar_order: 63
---

One Clerk account in Infrawrench is one Clerk instance: a development or production environment of a Clerk application. Opening the account shows the instance itself, with its user counts, sign-up restrictions and webhooks.

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

## Credentials

In the [Clerk Dashboard](https://dashboard.clerk.com), open your application, choose the instance (Development or Production) and go to **Configure → API keys**. Copy the **Secret key** (`sk_live_…` for production, `sk_test_…` for development). The publishable `pk_` key will not work.

Each secret key belongs to one instance, so add a separate account for development and production.

<insert [Clerk add-account form with the Secret Key field filled in] here>

## Notable flows

- **Restrictions tab**: toggle the allowlist and blocklist, block email subaddresses and disposable email domains, apply the lists to sign-up only, turn organizations on or off with their default member limit, and switch bot protection rules.
- **Webhooks**: Clerk delivers webhooks through Svix. **Enable webhooks** creates the Svix app once, then **Get credentials → Webhooks dashboard link** opens a short-lived link to manage endpoints and event types.
- **Users**: actions follow the user's state (Ban or Unban, Lock or Unlock). **Sign out everywhere** revokes every active session, or revoke a single one from the list. Add the user to an organization by picking the organization and a role.
- **Organizations**: add members, change roles, invite by email and revoke pending invitations, all with pickers fed by the instance's users and organization roles.
- **Domains**: each domain lists the CNAME records Clerk expects (Frontend API, Account Portal, email) and which are required.
- **Secrets shown once**: rotating an OAuth application's client secret or a machine's secret key shows the new value once. Machine keys can rotate with a one-hour grace period for the old key.
- **Metrics**: the instance's Metrics tab charts new users per day and shows active users over the last day, week and month. The dashboard card shows total, active and banned users.

<insert [Clerk instance Restrictions tab showing the allowlist, blocklist and organization toggles] here>

## Tips & limits

- Clerk has no analytics API; user metrics come from Clerk's user count queries, one per day in the chart window.
- Webhook endpoints themselves live in Svix, so they are managed through the dashboard link rather than listed here.
- OIDC enterprise connections and SAML connections set up with raw certificates are listed, edited and deleted here but created in the Clerk Dashboard.
- API keys are scoped to individual users and organizations in Clerk and are not listed.
- There is no official Clerk Terraform provider, so Terraform export is not available.
