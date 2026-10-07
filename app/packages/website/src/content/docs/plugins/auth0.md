---
title: Auth0
description: Manage Auth0 applications, APIs, connections, users, roles, organizations, Actions, log streams, custom domains, tenant settings, branding and attack protection.
sidebar_order: 62
---

One Auth0 account in Infrawrench is one Auth0 tenant. Opening the account shows the tenant itself: its settings, Universal Login branding, attack protection, tenant logs and daily sign-in stats.

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

## Credentials

Infrawrench uses a Machine to Machine application authorized for the Auth0 Management API:

1. In the Auth0 dashboard go to **Applications → Applications → Create Application**, choose **Machine to Machine Applications**, and pick **Auth0 Management API**.
2. Select the scopes. For full management grant the `read:`, `create:`, `update:` and `delete:` scopes for clients, resource servers, connections, users, roles, organizations (plus members, connections and invitations), actions, log streams and custom domains, together with `read:tenant_settings`, `update:tenant_settings`, `read:branding`, `update:branding`, `read:attack_protection`, `update:attack_protection`, `create:user_tickets`, `read:client_keys`, `update:client_keys`, `read:logs` and `read:stats`. A read-only account needs only the `read:` scopes.
3. In Infrawrench, enter the tenant's canonical domain (for example `acme.us.auth0.com`, even if you use a custom domain), the application's **Client ID** and its **Client Secret**.

<insert [Auth0 add-account form showing the Tenant Domain, Client ID and Client Secret fields] here>

## Notable flows

- **Actions**: **Edit code** opens a code editor and can deploy the new version in one step. **Add to flow** appends the action to its trigger's flow (post-login, pre-registration, and so on) without disturbing the actions already there; **Remove from flow** takes it out.
- **Pickers instead of ids**: role permissions are picked from every API's permissions, users pick roles, organizations pick users, connections and applications, and connections pick the applications to enable.
- **Custom domains**: the detail page lists the verification record and the CNAME to Auth0's edge; **Verify** checks them. The certificate's renewal date feeds the Expiry radar and the CNAME is checked for dangling DNS.
- **Application secrets**: the client secret is an output, read on demand and never stored in the inventory. **Rotate secret** issues a new one.
- **Logs**: the tenant, applications, connections, users and organizations each have a Logs tab filtered to that object, with Auth0's event codes spelled out.
- **Metrics**: the tenant's Metrics tab charts daily logins, signups and leaked-password detections; the dashboard card shows active users over the last 30 days.
- **Rate limit**: the Management API's rate-limit bucket, as reported by Auth0, appears on the Quotas surface.
- **Terraform export** for the tenant, applications, APIs, roles, organizations, Actions and custom domains with the official `auth0/auth0` provider.

<insert [Auth0 Action detail view showing the code section and the Edit code, Deploy and Add to flow actions] here>

## Tips & limits

- Social and enterprise connections need provider credentials and options, so only database connections are created here; all connections can be enabled for applications, edited and deleted.
- Log streams to EventBridge, Event Grid, Segment and Mixpanel are listed and can be paused, resumed and deleted, but are created in the dashboard.
- Auth0 has no billing or usage API beyond active users and daily stats.
- Auth0's status page publishes a separate feed per environment. Infrawrench follows the US public cloud feed, so incidents are matched to US tenants only.
- The Management API caps user listing at 1,000 users per query; very large tenants show the most recently created 1,000.
