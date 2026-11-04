---
title: Neon
description: Manage Neon projects, branches, databases, snapshots, object storage, functions, and auth; get connection strings as outputs.
sidebar_order: 12
---

Connecting Neon lets you manage your projects and branches, browse branch storage, and use each branch's connection string from the rest of Infrawrench.

## What you can manage

- Projects, including their restore window
- Branches (create, edit, delete, set as default, reset, restore to a point in time)
- Compute endpoints, with autoscaling and scale-to-zero settings
- Databases within a branch
- Connection strings (as outputs you can reference from the [Postgres plugin](./postgres.md))
- [Snapshots](#snapshots): point-in-time copies of a branch
- [Object storage](#object-storage) buckets, with a file browser
- [Credentials](#service-credentials) scoped to a branch's services
- [Functions](#functions): Node.js compute deployed onto a branch
- [AI Gateway](#ai-gateway) endpoints
- [Neon Auth](#neon-auth), including OAuth providers and trusted domains

## Connect your account

In the Neon console, go to **Account > API keys > New API key**, then paste the key into the add-account form.

![Neon Add-account form with API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/neon/add-account.png)

## Projects and branches

- **Create a project**: pick a region from the ones Neon currently offers, a Postgres version (18 by default), and optionally the restore window. **Edit** renames a project or changes its restore window (how far back branches can be restored; your plan caps it).
- **Create a branch**: pick the branch to fork from (or the project's default), whether to copy schema and data or schema only, an optional earlier moment to branch from, an automatic deletion time (at most 30 days ahead), and protection.
- **Edit a branch**: rename it, protect it, or set or clear its expiry.
- **Branch actions**:
  - **Set as Default** makes a branch the project's default.
  - **Reset from Parent** throws away a child branch's changes and resets it to its parent's latest state.
  - **Restore to Point in Time** rewinds a branch to an earlier moment inside the restore window, and keeps its current state as a separate branch you can name.
- **Compute endpoints**: create read-write or read-only computes with autoscaling limits and a scale-to-zero delay, and change them later with **Edit**. Autoscaling covers 0.25 to 16 CU, with at most 8 CU between the minimum and maximum. Larger sizes are fixed. Active computes also have **Restart**, which applies pending configuration changes.
- **Database owner**: **Edit** on a database hands it to another role on the branch.
- **Kubernetes secrets**: branches can export their connection strings as Kubernetes secrets.
- **SQL editor**: each branch gets one, through the Postgres plugin's output reference.

## Usage and logs

- **Metrics tab**: projects and branches chart compute (CU-hours), root, child and instant-restore storage, and public and private network transfer. Branches use their own history where Neon provides it, otherwise the project's. The project chart also includes snapshot storage and extra branch-months, which Neon only reports per project. Organizations still on a legacy plan see active time, compute time and data written instead.
- **Logs tab**: a branch shows the last 24 hours of logs from its Postgres computes, Object Storage and Functions, with a picker to narrow to one source. Neon's logs are in Private Beta, so a branch without access, or one not collecting telemetry, says so in the tab.

## Beta and Private Beta services

Several Neon services are still in beta, and access works differently for each:

| Service                               | Stage        | Who can use it                         |
| ------------------------------------- | ------------ | -------------------------------------- |
| Snapshots, Data API, Neon Auth        | Beta         | Anyone with an API key                 |
| Object Storage, Functions, AI Gateway | Private Beta | Only orgs with the entitlement enabled |

Private Beta services are enabled per organization and limited to certain regions. If your org doesn't have access, those resources just don't appear, with no error. If your buckets or functions are missing, that's usually why. Request access in the Neon console under **Settings > Early Access**.

## Snapshots

Snapshots are point-in-time copies of a branch. Create one from a branch, and it's listed with its size, source branch and expiry.

**Restore** creates a _new_ branch from the snapshot and leaves it unfinalized, so you can check the restored data before moving any computes onto it. Finalize it in the Neon console.

![Neon snapshot detail view with the Restore button visible](https://agent-assets.infrawrench.com/docs-screenshots/plugins/neon/snapshot-detail.png)

## Object storage

Buckets belong to a branch and fork with it: branch your database and its files branch too. Each bucket has a file browser for uploading, creating folders and deleting objects.

File uploads go straight to Neon, so file contents never pass through Infrawrench.

If you point an S3 SDK at Neon's S3 endpoint yourself, it needs **path-style addressing**. Set `ForcePathStyle` (or your SDK's equivalent) to true, or requests will fail.

![Neon bucket detail view showing the file browser with a few objects](https://agent-assets.infrawrench.com/docs-screenshots/plugins/neon/bucket-file-browser.png)

## Service credentials

A Neon API key manages your account. A **credential** is what your application uses to reach a branch's storage, functions or AI gateway at runtime. You pick the access you want, such as "Object Storage: read & write" or "AI Gateway: invoke models", instead of writing scope strings.

> **Neon shows a credential's token and S3 secret only once, when you create it.** There is no
> way to read them back. Export or copy them right away. If you lose them, create a new
> credential and revoke the old one.

Deleting a credential in Infrawrench revokes it.

## Functions

Functions are Node.js compute deployed onto a branch. You can't create one from a form: a function is created when you deploy a zip with your `neon.ts` config and the Neon CLI. Infrawrench lists your functions, shows their invocation URL and latest deployment status, and lets you rename or delete them. Deploy them from your repo.

## AI Gateway

The AI Gateway gives you one OpenAI-compatible API for models from Anthropic, OpenAI, Google and others. Neon offers no settings for it (no model routing, logging or cost controls), so it's read-only here: you get the base URL to point an SDK at. Turn it on with `aiGateway: true` in your `neon.ts`.

For the API key, use a credential with **AI Gateway: invoke models** access.

## Neon Auth

Neon Auth is managed [Better Auth](https://www.better-auth.com/) backed by your branch's own database. Turning it on from Infrawrench creates the `neon_auth` schema. Turning it off leaves your auth tables in place.

You can manage:

- **OAuth providers**: Google, GitHub, Microsoft and Vercel. Leave the client ID and secret blank to use Neon's shared development credentials, and fill them in for production.
- **Trusted domains**: the domains allowed as redirect targets after sign-in.

The auth resource also shows the JWKS URL, which you can export to verify JWTs (for example, from Postgres row-level security policies).

Neon doesn't offer a way to list auth users, so there's no user list here. Manage users from the Neon console.

![Neon Auth detail view showing the JWKS URL and child OAuth providers](https://agent-assets.infrawrench.com/docs-screenshots/plugins/neon/auth-detail.png)

## Cost graphs

Neon organizations feed [cost graphs & budgets](../features/cloud-costs.md) with daily usage per project (compute, storage, network, branches), priced at Neon's published per-plan rates.

- Works on paid plans only (Neon doesn't share usage history on Free). An org-scoped API key covers all projects.
- Figures are **estimates**: metered usage times list rates, without subtracting what your plan includes. History goes back 60 days, as far as Neon keeps it.

## Tips and limits

- Free tier Neon projects have branch limits, so watch for quota warnings.
- New branches take a few seconds to be ready before they show in the sidebar.
- Object storage, functions and the AI gateway belong to a branch, so the same bucket name can exist on two branches independently.
