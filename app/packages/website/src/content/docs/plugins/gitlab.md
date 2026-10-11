---
title: GitLab
description: Manage GitLab.com or self-managed GitLab groups, projects, CI/CD pipelines with job logs, runners, environments and deployments, protected branches, CI/CD variables, schedules, registries, deploy keys and tokens, webhooks, releases and members.
sidebar_order: 51
---

Connect GitLab.com or your own GitLab instance to run and watch pipelines, manage CI/CD settings and keep an eye on runners and usage, without clicking through each project's settings.

## What you can manage

- **Groups**: plan, seats in use, billable members, projects, compute minutes used this period and storage by kind (repositories, artifacts, packages, container registry and more). The Metrics tab charts compute minutes per month. **Edit** the name, description and visibility.
- **Projects**: clone URLs, default branch, visibility, open merge requests and issues, storage and the ten most recent pipelines. **Edit** the name, description, visibility, default branch and CI/CD config path, or **Archive** and **Unarchive**. The Metrics tab charts pipelines per day, failed pipelines, success rate, job duration p50 and p95, and queue time p50 and p95 (how long jobs waited for a runner).
- **Pipelines** (under their project): the ten most recent per project with ref, commit, source, who triggered it, duration and queue time, and every job with **Retry**, **Cancel** or **Run** (for manual jobs). The **Logs** tab shows each job's log, opening on the failed or running job. **Cancel**, **Retry failed jobs** or delete a pipeline, and **Create** one to run a pipeline on a branch or tag with variables.
- **Environments**: tier, external URL, state, auto-stop time and the last deployment, with recent deployments. **Approve** or **Reject** a deployment waiting for approval, **Stop** the environment, edit it, create one, or delete a stopped one. The Metrics tab charts successful and failed deployments per day.
- **Protected branches**: who may push and merge, force push and code owner approval. **Create**, **Edit** or unprotect.
- **Project and group CI/CD variables**: type, environment scope, and whether each is protected, masked, hidden or raw. Values are never stored in Infrawrench. **Create**, change settings or replace the value under **Edit**, or delete.
- **Pipeline schedules**: cron, time zone, ref, owner, next run and the last pipeline's status. **Create**, **Edit**, **Activate** or **Deactivate**, **Run now**, **Take ownership** or delete.
- **Container repositories**: image location, tag count and size, with every tag's digest, size and date under **Artifacts**. **Clean up old tags** (deletes tags older than 30 days, keeping the newest 10) or delete the repository.
- **Packages**: npm, Maven, PyPI, NuGet, Helm, Go, Conan, Composer, generic and Terraform module packages, with their files under **Artifacts**. Delete a package.
- **Deploy keys**: fingerprint, write access and expiry. **Create**, rename or change write access, or remove.
- **Project and group deploy tokens**: scopes, username and expiry. **Create** one and its token is kept as a sensitive **Token** output you can reference from Kubernetes secrets or other resources. Revoke it by deleting.
- **Project and group webhooks**: URL, events, branch filter, TLS verification, whether GitLab disabled it after failures, and the last week's deliveries. **Create**, **Edit**, **Send test push** or delete.
- **Releases**: tag, name, release date, author, commit, milestones and assets. **Create** (tagging a branch if the tag is new), **Edit** the name, notes and date, or delete.
- **Project and group members**: role, custom role and access expiry. **Add** someone by username, change their role or expiry, or remove them.
- **Runners**: group and project runners with status, tags, version, platform and last contact, and their recent jobs. **Create** a runner (its authentication token is kept as a sensitive output), **Pause** or **Resume** it, edit its tags and settings, use **Get credentials** to reset its token, or delete it. The Metrics tab charts jobs, failures, job duration and queue time per day.

<insert [GitLab project detail page showing the Recent pipelines table and the Metrics tab with pipeline success rate and queue time charts] here>

## Credentials

1. In GitLab, create an access token:
   - **Personal access token**: avatar menu, **Edit profile**, **Access tokens**, **Add new token**.
   - **Group access token**: the group's **Settings**, **Access tokens** (Premium on GitLab.com).
2. Give it the **api** scope to make changes, or **read_api** to only look. Add **create_runner** if you want to register runners from Infrawrench.
3. In Infrawrench, enter your **GitLab URL** (leave `https://gitlab.com` for GitLab.com), paste the token, and optionally pick a **Group** to limit the account to that group and its subgroups. With no group, the account shows every project you are a member of.

<insert [GitLab Add-account form with the URL, token and the Group picker open on the list of groups] here>

Your GitLab role decides what you see: CI/CD variables, webhooks, deploy keys and deploy tokens need **Maintainer** on the project; group runners, group variables and group settings need **Owner**. Projects where you have less are still listed, just without those children. **Check credentials** on the account shows which of the token's scopes are present.

For a self-managed instance with its own certificate authority, paste the CA certificate under **Advanced options**.

## Tips & limits

- Children (pipelines, variables, environments and so on) are listed for the 100 most recently active, non-archived projects, to keep a sync on a large instance to a bounded number of requests. Up to 500 projects are listed in total.
- GitLab only shows the compute minutes quota to instance administrators, so the [quota radar](../features/quota-radar.md) only shows compute minutes when the token belongs to one. Namespace storage appears when GitLab enforces a storage limit on the group.
- Changing who may push or merge to a protected branch removes and re-adds the protection with the new levels, because GitLab only edits levels in place on Premium. Rules for specific users, groups or deploy keys are Premium and Ultimate features.
- A CI/CD variable that is masked and hidden can never be read back. To change its other settings, type the value again under **Edit**.
- GitLab shows deploy tokens and runner tokens once. Only tokens created (or reset) from Infrawrench are kept as outputs.
- Instance runners are not listed for a group account: on GitLab.com they are GitLab's own fleet.
- [Provider status](../features/provider-status.md) follows [status.gitlab.com](https://status.gitlab.com), which only covers GitLab.com.
- [Export to Terraform](../features/terraform-export.md) writes `gitlabhq/gitlab` resources for groups, projects, variables, schedules, protected branches, deploy keys and tokens, environments, webhooks, releases and memberships, with variable values and public keys as Terraform variables.
- Bastion egress allows `gitlab.com` only. A self-managed instance's address is yours, so accounts for one cannot be routed through a bastion yet.
