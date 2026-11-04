---
title: Convex
description: Manage Convex projects and deployments, their environment variables, deploy keys, custom domains, log streams and usage limits, plus team members, invitations, custom roles and access tokens.
sidebar_order: 50
---

Connect a Convex team to manage its projects and deployments from Infrawrench.

## What you can manage

- **Projects**: create (optionally with a first production or development deployment, region and class), rename, change the slug and delete. Each project lists its deployments, default environment variables and preview deploy keys.
- **Deployments**: production, development, preview and custom deployments with their region, class, reference, last deploy time and URLs. Create deployments, change the type, class, reference, default-production flag, dashboard edit confirmation, client log forwarding and expiry date, **Pause** and **Unpause**, and delete. The Metrics tab records today's and this month's usage for every metric Convex reports (function calls, database I/O, egress, compute, search, AI Gateway spend). You can put deployments on a sleep schedule that pauses and unpauses them.
- **Environment variables**: per deployment. Add, change and delete. The value is an output you can export to Kubernetes or a server.
- **Default environment variables**: project-level values that new deployments of the chosen types (dev, preview, prod, custom) start with.
- **Deploy keys** and **preview deploy keys**: create them with exactly the permissions they need and an optional expiry, see when each was last used, and delete them. The key itself is shown once, when you create it.
- **Custom domains**: point a domain at a deployment's client API (`convex.cloud`) or HTTP actions (`convex.site`), see whether it has verified, and remove it.
- **Log streams**: send a deployment's logs to a webhook, Datadog, Axiom, Sentry or PostHog, choose topics, see the stream's status, edit the destination, rotate a webhook's signing secret and delete the stream.
- **Usage limits**: warn or disable a deployment when a metric crosses a daily or monthly limit. Create, edit (metric, window, limit, action, enabled) and delete them. Each shows its current usage.
- **Team**: members (change a member between admin and developer), invitations (invite, resend, cancel), custom roles (create from a permission picker, rename, delete) and the team access tokens you created (delete).

<insert [Convex deployment detail page showing the Usage table and the Pause and Unpause actions] here>

## Connect with Convex

The quickest way in is **Connect with Convex** on the add-account form. It signs you in to Convex instead of making you create a token.

1. Click **Connect with Convex**.
2. On the consent screen, pick the team to connect.

The account is named after the team. Its access can create projects and deployments and read and write data and functions on every project of the team, limited to your own role. Convex offers no narrower or read-only option, and the form tells you so before you continue. Infrawrench still only changes something when you act.

The connection doesn't expire. If you revoke Infrawrench's access in the Convex dashboard, the account stops working. Use **Reconnect** in its credentials to sign in again.

Members, invitations and custom roles can't be managed through this kind of connection. To manage those, use a team access token instead (below).

Connect with Convex works in the web app and in the desktop app's cloud mode. Accounts stored locally on the desktop use a token.

<insert [Convex add-account form showing the Connect with Convex button above the Team Access Token field] here>

## Connect with a token

1. In the Convex dashboard, open **Team Settings > Access Tokens** (`dashboard.convex.dev/team/settings/access-tokens`) and create a **team access token**.
2. Paste it into the **Team Access Token** field.

The token acts with your role on the team, so use an admin's token to manage members, roles and production deployments. Convex recommends a separate service-account member for tokens, because dev deployments created with a token belong to its owner and are deleted if that member leaves the team.

Deploy keys and project tokens won't work, because they can't see the team.

<insert [Convex Add-account form with the Team Access Token field filled in and the permission checklist below it] here>

## Quotas

Every enabled usage limit appears on the quota radar with the deployment's current usage against the limit. You see a deployment getting close to a disable limit before Convex pauses it.

## Costs

Convex has no billing API, so Convex spend isn't shown. The Usage table on each deployment and the usage limits are the closest thing.

## Status

Incidents from `status.convex.dev` are shown for all Convex resources. The status page groups by plan tier rather than region, so an incident can't be narrowed to particular deployments.

## Limits

- Convex doesn't report whether a deployment is paused, so the detail page offers both Pause and Unpause.
- Moving a deployment to another project, data export and import, and backups aren't available here.
- There is no official Terraform provider for Convex, so there is no Terraform export.
