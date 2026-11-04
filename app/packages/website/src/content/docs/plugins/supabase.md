---
title: Supabase
description: Manage Supabase organizations, projects, branches, Edge Functions and secrets, Storage buckets, API keys, Auth settings, SSO, read replicas and backups, run SQL, and read logs, metrics and advisors.
sidebar_order: 50
---

Connect a Supabase account to manage every project you can reach, without opening the Supabase dashboard for routine work.

## What you can manage

- **Organizations**: plan, project count and members, including who hasn't set up MFA.
- **Projects**: status, region, Postgres version, compute size, disk, add-ons and their list prices, backups, network settings, service health, custom domain and upgrade eligibility.
  - Create projects (organization, region and compute size are picked from lists) and rename them.
  - Change the **compute size**, **point-in-time recovery** window, **dedicated IPv4** add-on, **disk size, type, IOPS and throughput**, **SSL enforcement**, the **allowed IPv4/IPv6 ranges**, the dedicated pooler's mode and pool size, and whether the legacy `anon`/`service_role` keys still work.
  - Actions: **Pause**, **Restore**, **Restart**, **Reset database password**, **Upgrade Postgres** (when Supabase says the project is eligible), **Allow writes for 15 minutes** (when a full disk put it into read-only mode), **Re-verify** and **Activate** a custom domain, and **Unban all IPs**.
- **Configuration tab**: a settings form for Postgres parameters (max connections, statement timeout, worker and WAL settings), the connection pooler, the Data API (exposed schemas, max rows, pool size), Storage (upload limit, image transformations, S3 protocol) and Realtime (limits, presence, private channels).
- **Advisors tab**: Supabase's security and performance advisors for the project, with a link to each fix guide.
- **Branches**: preview and persistent branches, with Git branch and pull request. Create, rename, change persistence, **Push migrations**, **Merge into production**, **Reset**, cancel a scheduled deletion and delete.
- **Edge Functions**: version, status and URL. Create a function by writing its `index.ts` in the editor (it deploys straight away), rename it, toggle JWT verification and delete it. To ship new code for an existing function, create it again with the same slug.
- **Edge Function secrets**: add, change (write-only) and delete. You can't read a secret's value back.
- **Storage buckets**: public or private, file size limit and allowed MIME types. Create, edit, **Empty** and delete buckets, and browse, upload and delete objects in the file browser.
- **API keys**: publishable and secret keys, plus the legacy JWT keys. Create, edit the description and delete. The key value is an output.
- **Auth**: an **Auth Settings** tab for sign-in providers and their client IDs, redirect URLs, sign-ups, passwords, sessions, MFA, CAPTCHA, rate limits and custom SMTP.
- **SSO providers** (SAML), **third-party auth** integrations (Clerk, Auth0, Firebase, Cognito, WorkOS and any OIDC issuer or JWKS URL) and **JWT signing keys**, including rotating a standby key in and revoking an old one.
- **Read replicas**: add a replica in another region and remove it.
- **Backups**: the daily backups Supabase keeps for each project.

<insert [Supabase project detail page showing the Overview, Security, Backups and Disk sections with the Pause and Reset database password actions] here>

## Connect with Supabase

Click **Connect with Supabase** on the add-account form to sign in instead of creating a token. On the consent screen, pick the organization to connect. Supabase lists what Infrawrench may do there: read and write projects, branches, Edge Functions, secrets and API keys, database settings and SQL, Storage, Auth and custom domains, and read organizations and logs. Write access is only used for actions you take, and you never get more than your Supabase role allows. The account is named after the organization.

The connection covers one organization. To manage another, connect it as a second account (or use a classic token, below).

The connection renews itself. If you revoke Infrawrench's access in your Supabase organization settings, the account shows **Reconnect required**. Click **Reconnect** in its credentials to sign in again.

Connect with Supabase works in the web app and in the desktop app's cloud mode. Accounts stored locally on the desktop use a token.

<insert [Supabase add-account form showing the Connect with Supabase button above the Access Token field] here>

## Use a token instead

Create a **personal access token** in the Supabase dashboard under **Account > Access Tokens** (`supabase.com/dashboard/account/tokens`). Tokens start with `sbp_`.

- A **classic** token works with every organization you belong to and can do anything your role allows.
- A **scoped** token is safer. Give it `organizations:read` and `projects:read` at minimum, and add the read/write scopes for what you want to manage here: `environment` (branches), `secrets` (API keys, signing keys, and Storage), `edge_functions`, `database` (SQL and database settings), `storage`, `auth`, `domains` and `analytics` (logs and metrics).

When you add the account, the permission checklist tests each of these and tells you which are missing.

<insert [Supabase Add-account form with the Access Token field filled in and the permission checklist below it] here>

## Connection strings and the SQL editor

Supabase never shows a project's `postgres` password after the project is created. For projects you create in Infrawrench, the password is stored encrypted, so the **Direct**, **Pooler** and **Session pooler** connection strings work straight away. For a project created elsewhere, use **Reset database password** once (or the button on the PostgreSQL tab). Anything still using the old password will stop connecting. Branch connection strings work without a reset.

The project's **SQL** tab works without the password and through any firewall. The **PostgreSQL** tab connects with the stored password and adds the table browser.

The project also offers **supabase-js client** (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) and **Database URL** secret templates for exporting to Kubernetes or a server.

## Logs and metrics

The project's **Logs** tab shows the last 24 hours of logs from the API gateway, Postgres, Auth, Data API, Storage, Realtime, Edge Functions, pooler and cron. Edge Functions have their own Logs tab with console output and request logs.

The **Metrics** tab charts REST, Auth, Storage and Realtime request counts, and records disk, memory, load, connection count and database size each time you open it. Edge Functions chart invocations, execution time, memory and errors. Supabase limits these to a few dozen requests a minute, so open them when you need them instead of leaving many tabs refreshing.

## Costs

Supabase has no billing API. Infrawrench estimates each project's daily spend from the add-ons it runs (compute, PITR, IPv4, custom domain, log drains and the rest) at Supabase's list prices. The estimate leaves out your plan fee, the compute credit, and usage charges such as egress, storage and monthly active users, so check the **Billing & usage** link on the organization for the real bill.

## Quotas

The quota radar tracks each running project's database disk usage against its provisioned size. A project whose disk fills up goes read-only, so this warns you first.

## Status

Supabase incidents show against your projects by region, and against Auth, Storage and Edge Functions resources by service.

## Terraform

Projects, branches and API keys export to the official `supabase/supabase` provider. Each project gets its own sensitive database-password variable. Edge Functions aren't exported, since the provider deploys them from files on disk.

## Limits and quirks

- Pausing is only available on the Free plan. Paid projects return an error.
- Disks can only grow, and only once every six hours.
- Paused projects still show up, but their functions, keys, buckets and Auth settings are hidden until you restore them.
- SSO providers, read replicas and the backup schedule depend on your plan.
