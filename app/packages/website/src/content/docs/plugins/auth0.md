---
title: Auth0
description: Manage Auth0 applications, APIs, connections, users, roles, organizations, Actions, log streams, custom domains, tenant settings, branding and attack protection.
sidebar_order: 62
---

Each Auth0 account you add is one Auth0 tenant. Open the account to see the tenant itself: its settings, Universal Login branding, attack protection, tenant logs and daily sign-in stats.

## What you can manage

- Tenant settings (name, support contacts, default audience and directory, session lifetimes, languages) and Universal Login branding (colors, logo, favicon)
- Attack protection (brute-force protection and threshold, breached password detection, suspicious IP throttling) and common tenant flags
- Applications (create, edit URLs and origins, rotate the client secret, delete)
- APIs (create, edit token settings and RBAC, edit permissions, delete)
- Connections (create database connections, enable or disable for applications, edit display options, delete)
- Users (create in a database connection, edit, block, resend verification, reset MFA, password reset links, roles, delete)
- Roles (create, edit, add and remove API permissions)
- Organizations (create, edit branding, members, invitations, enabled connections)
- Actions (create, edit code, deploy, add to or remove from the trigger's flow, delete)
- Log streams (create HTTP, Datadog, Splunk and Sumo Logic streams; pause, resume, rename, delete)
- Custom domains (add, see the records to publish, verify, edit TLS and client IP header, delete)

## Connect a tenant

You connect with a Machine to Machine application authorized for the Auth0 Management API.

1. In the Auth0 dashboard, go to **Applications > Applications > Create Application**. Choose **Machine to Machine Applications** and pick **Auth0 Management API**.
2. Select the scopes. For full management, grant the `read:`, `create:`, `update:` and `delete:` scopes for clients, resource servers, connections, users, roles, organizations (plus members, connections and invitations), actions, log streams and custom domains. Also grant `read:tenant_settings`, `update:tenant_settings`, `read:branding`, `update:branding`, `read:attack_protection`, `update:attack_protection`, `create:user_tickets`, `read:client_keys`, `update:client_keys`, `read:logs` and `read:stats`. A read-only account needs only the `read:` scopes.
3. In Infrawrench, enter the tenant's canonical domain (for example `acme.us.auth0.com`, even if you use a custom domain), the application's **Client ID** and its **Client Secret**.

<insert [Auth0 add-account form showing the Tenant Domain, Client ID and Client Secret fields] here>

## Common tasks

- **Actions**: **Edit code** opens a code editor and can deploy the new version in one step. **Add to flow** adds the action to the end of its trigger's flow (post-login, pre-registration, and so on) without disturbing the actions already there. **Remove from flow** takes it out.
- **Pick instead of typing ids**: you pick role permissions from every API's permissions, roles for users, users, connections and applications for organizations, and the applications to enable for a connection.
- **Custom domains**: the detail page lists the verification record and the CNAME to Auth0's edge. **Verify** checks them. The certificate's renewal date shows on the Expiry radar, and the CNAME is checked for dangling DNS.
- **Application secrets**: the client secret is an output, fetched when you ask for it and never stored. **Rotate secret** issues a new one.
- **Logs**: the tenant, applications, connections, users and organizations each have a Logs tab filtered to that object, with Auth0's event codes spelled out.
- **Metrics**: the tenant's Metrics tab charts daily logins, signups and leaked-password detections. The dashboard card shows active users over the last 30 days.
- **Rate limit**: the Management API's rate-limit bucket, as Auth0 reports it, appears on the Quotas page.
- **Terraform export** for the tenant, applications, APIs, roles, organizations, Actions and custom domains, using the official `auth0/auth0` provider.

<insert [Auth0 Action detail view showing the code section and the Edit code, Deploy and Add to flow actions] here>

## Tips & limits

- Social and enterprise connections need provider credentials and options, so you can only create database connections here. You can enable any connection for applications, edit it and delete it.
- Log streams to EventBridge, Event Grid, Segment and Mixpanel are listed and can be paused, resumed and deleted, but you create them in the Auth0 dashboard.
- Auth0 has no billing or usage API beyond active users and daily stats.
- Infrawrench follows Auth0's US public cloud status feed, so incidents are matched to US tenants only.
- Auth0's user search returns at most 1,000 users. For a bigger tenant, Infrawrench also runs one of Auth0's bulk user exports, at most every 6 hours, and lists every user from it. The newest 1,000 users refresh on every sync. The rest keep their last values until the next export finishes, so a new tenant's older users can take a few minutes to appear. Auth0's Free plan has no exports, so there the Users section [keeps the rows it already has and says why](../core-concepts/resources-and-accounts.md#when-a-list-cant-be-read-whole). A tenant with more than 100,000 users can't be listed.
