---
title: Bitbucket
description: Manage Bitbucket Cloud projects and repositories, run and stop Pipelines with step logs, and manage variables, deployment environments, schedules, caches, branch restrictions, webhooks, deploy keys and self-hosted runners.
sidebar_order: 51
---

Connect a Bitbucket Cloud workspace to run and watch Pipelines and manage the settings around them, without clicking through each repository's settings.

## What you can manage

- **Workspace**: privacy, forking policy and member count. Workspace variables, webhooks and runners live here.
- **Projects**: key, name, description and privacy, with their deploy keys. **Create**, **Edit** or delete (a project must be empty first).
- **Repositories**: main branch, language, size, privacy, project, fork policy, whether Pipelines is on, clone URLs and the ten most recent pipelines. **Create** a repository, **Edit** its description, privacy, project and fork policy, **Enable** or **Disable Pipelines**, or **Clear caches**. The Metrics tab charts pipelines, failed pipelines, success rate, build minutes and duration p50 and p95 per day.
- **Pipelines** (under their repository): the ten most recent per repository with ref, commit, trigger, who started it, result, build time and duration, and each step with its image and duration. The **Logs** tab shows each step's log, opening on the failed or running step. **Stop** a running pipeline, or **Create** one to run a branch's pipeline or a named custom pipeline with variables.
- **Repository, workspace and deployment variables**: name and whether the value is secured. Values are never stored in Infrawrench. **Create**, replace the value or secure it under **Edit**, or delete.
- **Deployment environments**: type (Test, Staging, Production), whether only admins may deploy, whether a deployment is running, and recent deployments. **Create**, rename, restrict to admins, or delete. The Metrics tab charts successful and failed deployments per day.
- **Pipeline schedules**: cron, branch, which pipeline runs, whether it's enabled, and its recent runs. **Create**, **Enable**, **Disable** or delete.
- **Pipeline caches**: name, path and size. Delete one to force the next build to rebuild it.
- **Branch restrictions**: branch permissions and merge checks such as minimum approvals, passing builds, blocked force pushes and deletion. **Create**, **Edit** the pattern or required count, or delete.
- **Repository and workspace webhooks**: URL, events, whether they're active and whether deliveries are signed. **Create**, **Edit**, **Activate**, **Deactivate** or delete.
- **Deploy keys** on repositories and projects, with when each was last used. **Add**, relabel (repository keys) or remove.
- **Runners**: workspace and repository runners with status, labels, version and whether a newer version is out. **Create** one (its OAuth client ID and secret are kept as sensitive outputs so you can start the runner), rename it or change labels, **Enable** or **Disable** it, or delete it.

<insert [Bitbucket pipeline detail page with the Steps table and the Logs tab open on a failed step] here>

## Connect with Bitbucket

**Connect with Bitbucket** on the add-account form signs you in to Bitbucket instead of using an API token. Bitbucket shows what Infrawrench asks for before you grant access: reading your account and workspace membership, and reading and administering projects, repositories, Pipelines (including variables), runners and webhooks. The write access lets you run and stop pipelines and edit variables, environments, deploy keys, branch restrictions, webhooks and runners from Infrawrench. Nothing changes unless you act. You still only see what your Bitbucket permissions allow.

After you grant access, the account is named after you. The **Workspace** is filled in if you belong to just one; otherwise pick it from the list. No email is needed.

The connection renews itself. If you revoke Infrawrench in Bitbucket (**Personal settings**, **App authorizations**), or the account goes unused for three months, it's marked **Reconnect required**. Click **Reconnect** in its credentials to sign in again.

Connect with Bitbucket is available on the web app and in the desktop app's cloud mode. Accounts stored locally on the desktop use an API token, as below.

<insert [Bitbucket add-account form showing the Connect with Bitbucket button above the email and API token fields] here>

## Connect with an API token

1. In Bitbucket, open your avatar menu, **Personal settings**, then **Atlassian account settings**, **Security**, **Create and manage API tokens**, and choose **Create API token with scopes**. Pick **Bitbucket** as the app.
2. Select the scopes. To look around: `read:workspace:bitbucket`, `read:project:bitbucket`, `read:repository:bitbucket`, `read:pipeline:bitbucket`, `read:runner:bitbucket` and `read:webhook:bitbucket`. To make changes, add `admin:repository:bitbucket`, `admin:project:bitbucket`, `write:pipeline:bitbucket`, `admin:pipeline:bitbucket`, `write:runner:bitbucket`, `write:webhook:bitbucket` and `delete:webhook:bitbucket`. Deploy keys also need `write:ssh-key:bitbucket` and `delete:ssh-key:bitbucket`.
3. In Infrawrench, enter your **Atlassian account email** (not your Bitbucket username), paste the token, and pick the **Workspace**.

<insert [Bitbucket Add-account form with the email and API token filled in and the Workspace picker open] here>

A workspace access token (Premium) also works. Leave the email empty and type the workspace slug, since access tokens can't list workspaces. App passwords stopped working in 2026 and aren't supported.

## Tips & limits

- Bitbucket limits most repository requests to about 1,000 an hour per user (more on paid plans). So pipelines, variables, environments and other per-repository items are listed for the 30 most recently updated repositories. A repository past that keeps what was last read, which refreshes once it is updated again. Up to 500 repositories are listed in total.
- Bitbucket has no billing or usage API, so there are no costs or quotas for Bitbucket accounts. Build minutes per repository come from each pipeline's build time. Check your plan's allowance under **Workspace settings**, **Plan details**.
- Pipeline schedules use seven-field Quartz cron with seconds first, in UTC: `0 0 12 * * ? *` runs at noon every day. You can only turn a schedule on or off. To change its time or branch, create a new one.
- Secured variables can never be read back. To change whether one is secured, type its value again under **Edit**.
- Bitbucket shows a runner's OAuth credentials once. Only runners created from Infrawrench have them as outputs.
- Exempt users and groups on branch permissions are kept when you edit a rule, but you manage them in Bitbucket.
- [Provider status](../features/provider-status.md) follows [bitbucket.status.atlassian.com](https://bitbucket.status.atlassian.com).
- There's no official Terraform provider for Bitbucket Cloud, so these resources aren't part of [Export to Terraform](../features/terraform-export.md).
- Bastion egress allows `api.bitbucket.org` and Amazon S3, where finished step logs are stored.
