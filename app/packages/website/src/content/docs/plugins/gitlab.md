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

## Secret detection

With GitLab **Ultimate**, the account reads the secret detection findings from the vulnerability report of its 100 most recently active projects, every 30 minutes, into [Leaked credentials](../features/leaked-credentials.md) on the Posture tab. Projects on other tiers are skipped.

- **Permissions.** Reading findings needs `read_api` and the Developer role on the project. Resolving a finding after a rotation, or dismissing it with your reason, needs `api` and the Maintainer role (or Security Manager).
- **Matched by token type.** GitLab never returns the secret itself, only which rule found it (`gitlab_personal_access_token`, `AWS` and so on). Infrawrench matches the finding to your accounts on the provider that issues that kind of token; with exactly one such account it is shown as probably that account, with several they are listed as candidates. Either way it may be another key from the same provider.
- On rotation the finding is resolved in GitLab; a dismissal maps **False positive** and **Used in tests** to GitLab's reasons of the same name and **Won't fix** to Acceptable risk.

## Vulnerability findings

GitLab accounts report the open entries of the **vulnerability report** that come from **dependency scanning** and **container scanning** (including container scanning for the registry): known CVEs in packages and images. Findings in the Detected or Confirmed state are read; dismissed and resolved ones, and those GitLab marks as resolved on the default branch, are left out. SAST, DAST, secret detection and fuzzing findings are not included, as they are about code rather than known advisories.

Each finding carries the advisory (the CVE when there is one, else the GHSA id), GitLab's severity, the CVSS score and vector, the package and installed version, whether GitLab has a remediation, whether the CVE is in the CISA known-exploited list, and a link to the vulnerability.

What it needs:

- **GitLab Ultimate** on the group or project (GitLab.com, Self-Managed or Dedicated). The vulnerability report does not exist on Free or Premium, or on Community Edition.
- The token's user (or the group access token's role) must be **Developer** or above, or **Security Manager**, on the group or projects.
- The **read_api** or **api** scope, which the account already has.

When none of the account's projects can show the report, the account says so as a tier or role gap rather than reporting zero vulnerabilities. A project in a namespace without Ultimate is skipped when others are readable.

**What it joins to.** A container-scanning finding names the scanned image (for example `registry.gitlab.com/acme/web/app`, with its digest when the scan recorded one), so it matches every running pod, task or service from any provider that runs that image. A dependency-scanning finding is about the **project** and attaches to the project in your inventory.

**Bounds.** A group-scoped account reads the group's report (subgroups included) up to 5,000 findings. Without a group, the report of each of the 100 most recently active projects is read, up to 1,000 findings each. The list is marked partial because these bounds can bite on a large instance.

## Seats

GitLab.com accounts report their subscription seats to Seats, which flags members nobody uses, people paying for GitLab and another source control tool, and adds up what removing them would save.

- **What is read.** The billable members of every paid top-level group in scope: the top-level group above the account's **Group**, or, with no group picked, every top-level group the token's user owns. Groups on the Free plan, a trial, or a free program (open source and similar) have no paid seats and are skipped. Members waiting for approval do not take a seat and are left out. Email addresses appear when the member made theirs public or is an enterprise user of the group.
- **Activity.** GitLab's **last activity** date for the user, which counts any activity on GitLab.com, not only in your group. A member who has never been active is treated as idle once their account is older than your threshold (GitLab gives no date for when they joined the group).
- **Price.** GitLab's published Premium price, $29 per user per month billed annually (about.gitlab.com/pricing, October 2026), labelled as an estimate. Ultimate is priced per contract, so Ultimate seats are counted but have no price.
- **Remove.** Removes the user from the top-level group and all its subgroups and projects; GitLab finishes it in the background within a few minutes. The seat frees up for someone else, but seats already bought stay billed until the subscription renews. A member billed only because a group or project was shared with another group cannot be removed this way and is shown as not removable.
- **Permissions.** The **Owner** role on the top-level group, and a token with **read_api** to list or **api** to remove. **Check credentials** tests this with a one-member read.
- **Self-managed and Dedicated instances are not reported.** They are licensed per instance rather than per group subscription, so there is no group seat or plan price to read.

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
