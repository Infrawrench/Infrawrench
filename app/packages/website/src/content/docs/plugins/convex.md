---
title: Convex
description: Manage Convex projects and deployments, their environment variables, deploy keys, custom domains, log streams and usage limits, plus team members, invitations, custom roles and access tokens.
sidebar_order: 50
---

Connect a Convex team to manage its projects and deployments from Infrawrench.

## What you can manage

- **Projects**: create (optionally with a first production or development deployment, region and class), rename, change the slug and delete. Each project lists its deployments, default environment variables and preview deploy keys.
- **Deployments**: production, development, preview and custom deployments with their region, class, reference, last deploy time and URLs. Create deployments, change the type, class, reference, default-production flag, dashboard edit confirmation, client log forwarding and expiry date, **Pause** and **Unpause**, and delete. The Metrics tab records today's and this month's usage for every metric Convex reports (function calls, database I/O, egress, compute, search, AI Gateway spend). Deployments can be put on a sleep schedule with pause and unpause.
- **Environment variables**: per deployment. Add, change and delete; the value is an output you can export to Kubernetes or a server.
- **Default environment variables**: project-level values new deployments of the chosen types (dev, preview, prod, custom) start with.
- **Deploy keys** and **preview deploy keys**: create them with exactly the permissions they need and an optional expiry, see when each was last used, and delete them. The key itself is shown once, when it is created.
- **Custom domains**: point a domain at a deployment's client API (`convex.cloud`) or HTTP actions (`convex.site`), see whether it has verified, and remove it.
- **Log streams**: send a deployment's logs to a webhook, Datadog, Axiom, Sentry or PostHog, choose topics, see the stream's status, edit the destination, rotate a webhook's signing secret and delete the stream.
- **Usage limits**: warn or disable a deployment when a metric crosses a daily or monthly limit. Create, edit (metric, window, limit, action, enabled) and delete them; each shows its current usage.
- **Team**: members (change a member between admin and developer), invitations (invite, resend, cancel), custom roles (create from a permission picker, rename, delete) and the team access tokens you created (delete).

<insert [Convex deployment detail page showing the Usage table and the Pause and Unpause actions] here>

## Credentials

Use a **team access token**. In the Convex dashboard, open **Team Settings → Access Tokens** (`dashboard.convex.dev/team/settings/access-tokens`) and create one. The token acts with your role on the team, so use an admin's token to manage members, roles and production deployments. Convex recommends a separate service-account member for tokens, because dev deployments created with a token belong to its owner and are deleted if that member leaves the team.

Deploy keys and project tokens are rejected: they cannot see the team.

<insert [Convex Add-account form with the Team Access Token field filled in and the permission checklist below it] here>

## Quotas

Every enabled usage limit appears on the quota radar with the deployment's current usage against the limit, so you see a deployment approaching a disable limit before Convex pauses it.

## Costs

Convex has no billing API, so Infrawrench does not collect Convex spend. The Usage table on each deployment and the usage limits are the closest equivalent.

## Status

Incidents from `status.convex.dev` are shown for all Convex resources: the status page groups by plan tier rather than region, so an incident cannot be narrowed to particular deployments.

## Limits and quirks

- Convex does not report whether a deployment is paused, so the detail page offers both Pause and Unpause.
- Transferring a deployment to another project, data export and import, and backups are not exposed by the public APIs Infrawrench uses.
- There is no official Terraform provider for Convex, so there is no Terraform export.
