---
title: Bitbucket
description: Manage Bitbucket Cloud projects and repositories, run and stop Pipelines with step logs, and manage variables, deployment environments, schedules, caches, branch restrictions, webhooks, deploy keys and self-hosted runners.
sidebar_order: 51
---

Connect a Bitbucket Cloud workspace to run and watch Pipelines and manage the settings around them, without clicking through each repository's settings.

## What you can manage

- **Workspace**: privacy, forking policy and member count. Workspace variables, webhooks and runners hang off it.
- **Projects**: key, name, description and privacy, with their deploy keys. **Create**, **Edit** or delete (a project must be empty first).
- **Repositories**: main branch, language, size, privacy, project, fork policy, whether Pipelines is on, clone URLs and the ten most recent pipelines. **Create** a repository, **Edit** its description, privacy, project and fork policy, **Enable** or **Disable Pipelines**, or **Clear caches**. The Metrics tab charts pipelines, failed pipelines, success rate, build minutes and duration p50 and p95 per day.
- **Pipelines** (under their repository): the ten most recent per repository with ref, commit, trigger, who started it, result, build time and duration, and each step with its image and duration. The **Logs** tab shows each step's log, opening on the failed or running step. **Stop** a running pipeline, or **Create** one to run a branch's pipeline or a named custom pipeline with variables.
- **Repository, workspace and deployment variables**: name and whether the value is secured. Values are never stored in Infrawrench. **Create**, replace the value or secure it under **Edit**, or delete.
- **Deployment environments**: type (Test, Staging, Production), whether only admins may deploy, whether a deployment is running, and recent deployments. **Create**, rename, restrict to admins, or delete. The Metrics tab charts successful and failed deployments per day.
- **Pipeline schedules**: cron, branch, which pipeline runs, whether it is enabled, and its recent runs. **Create**, **Enable**, **Disable** or delete.
- **Pipeline caches**: name, path and size. Delete one to force the next build to rebuild it.
- **Branch restrictions**: branch permissions and merge checks such as minimum approvals, passing builds, blocked force pushes and deletion. **Create**, **Edit** the pattern or required count, or delete.
- **Repository and workspace webhooks**: URL, events, whether they are active and whether deliveries are signed. **Create**, **Edit**, **Activate**, **Deactivate** or delete.
- **Deploy keys** on repositories and projects, with when each was last used. **Add**, relabel (repository keys) or remove.
- **Runners**: workspace and repository runners with status, labels, version and whether a newer version is out. **Create** one (its OAuth client ID and secret are kept as sensitive outputs for starting the runner), rename it or change labels, **Enable** or **Disable** it, or delete it.

<insert [Bitbucket pipeline detail page with the Steps table and the Logs tab open on a failed step] here>

## Credentials

1. In Bitbucket, open your avatar menu, **Personal settings**, then **Atlassian account settings**, **Security**, **Create and manage API tokens**, and choose **Create API token with scopes**. Pick **Bitbucket** as the app.
2. Select the scopes. To look around: `read:workspace:bitbucket`, `read:project:bitbucket`, `read:repository:bitbucket`, `read:pipeline:bitbucket`, `read:runner:bitbucket` and `read:webhook:bitbucket`. To make changes, add `admin:repository:bitbucket`, `admin:project:bitbucket`, `write:pipeline:bitbucket`, `admin:pipeline:bitbucket`, `write:runner:bitbucket`, `write:webhook:bitbucket` and `delete:webhook:bitbucket`; deploy keys also need `write:ssh-key:bitbucket` and `delete:ssh-key:bitbucket`.
3. In Infrawrench, enter your **Atlassian account email** (not your Bitbucket username), paste the token, and pick the **Workspace**.

<insert [Bitbucket Add-account form with the email and API token filled in and the Workspace picker open] here>

A workspace access token (Premium) also works: leave the email empty and type the workspace slug, because access tokens cannot list workspaces. App passwords stopped working in 2026 and are not supported.

## Tips & limits

- Bitbucket meters most repository requests at about 1,000 an hour per user (more on paid plans), so children (pipelines, variables, environments and so on) are listed for the 30 most recently updated repositories. Up to 500 repositories are listed in total.
- Bitbucket has no billing or usage API, so there are no costs or quotas for Bitbucket accounts. Build minutes per repository come from each pipeline's build time; check the plan's allowance under **Workspace settings**, **Plan details**.
- Pipeline schedules use seven-field Quartz cron with seconds first, in UTC: `0 0 12 * * ? *` runs at noon every day. Only the enabled flag of a schedule can be changed; to change its time or branch, create a new one.
- Secured variables can never be read back. To change whether one is secured, type its value again under **Edit**.
- Bitbucket shows a runner's OAuth credentials once. Only runners created from Infrawrench have them as outputs.
- Exempt users and groups on branch permissions are kept when you edit a rule but are managed in Bitbucket.
- [Provider status](../features/provider-status.md) follows [bitbucket.status.atlassian.com](https://bitbucket.status.atlassian.com).
- There is no official Terraform provider for Bitbucket Cloud, so these resources are not part of [Export to Terraform](../features/terraform-export.md).
- Bastion egress allows `api.bitbucket.org` and Amazon S3, where finished step logs are stored.
