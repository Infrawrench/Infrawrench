---
title: Pulumi Cloud
description: Manage Pulumi Cloud stacks and their outputs, update history, drift and Pulumi Deployments with logs, ESC environments, tokens, teams, webhooks and policies, and track usage-based cost.
sidebar_order: 54
---

## What you can manage

- **Organization**: members, projects, stacks, ESC environments, resources under management, and the last 30 days of resource-hours, deployment minutes and ESC secret-hours, plus the most common resource types, packages, projects and stacks. The Metrics tab charts resources under management, resource-hours, deployment minutes and ESC secret-hours per day.
- **Projects**: each project's stacks, total resources and last update.
- **Stacks**: resources, last update, what's running now, drift status, the 15 most recent updates (kind, result, resource changes, message, duration), Pulumi Deployments settings and deployment schedules.
  - **Deploy** runs an update, preview, refresh, drift detection, drift remediation or destroy on Pulumi Deployments.
  - **Schedule** adds a cron or one-off deployment. Pause, resume or delete schedules from the table.
  - Edit the stack's deployment settings (repository, branch, directory, pre-run commands, environment variables) as JSON in the **Settings** tab.
  - **Create** a stack, **Rename** it (or move it to another project), or delete it. A stack that still has resources can't be deleted.
  - The Metrics tab charts updates, failed updates, resources created, updated and deleted, update duration and resource count.
- **Stack outputs**: every output of a stack's latest update. Other resources can reference it, so a DNS record or an exported secret follows what Pulumi last deployed. Secret outputs are decrypted when you need them, if the stack uses Pulumi Cloud's own secrets provider.
- **Deployments**: the 100 most recent Pulumi Deployments runs in the organization, with operation, status, who started them, their steps and the update they produced. The **Logs** tab shows the run's log. **Cancel** a run in progress, or **Create** one on any stack.
- **ESC environments**: who owns them, which stacks and environments use them, and their revisions. Edit the YAML in the **Definition** tab (every save is a new revision), **Roll back** to an earlier revision, **Tag revision** (for example `stable`), and **Create** or delete an environment. The opened values and the `environmentVariables` section are outputs other resources can reference.
- **Organization tokens**: name, description, admin access, last use and expiry. **Create** one (its value is kept as an output you can export as `PULUMI_ACCESS_TOKEN`) or revoke it.
- **Teams**: members, stacks and environments. **Create** a Pulumi team, **Edit** its display name and description, or delete it.
- **Webhooks**: payload URL, format (JSON, Slack or Microsoft Teams) and event groups. **Create**, **Edit**, **Enable**, **Disable**, **Send test** or delete.
- **Policy packs** and **policy groups**: versions of each pack, and each group's mode, stacks and enabled packs. Create, rename or delete a policy group and add or remove stacks. Delete a policy pack.

## Connect your organization

1. In Pulumi Cloud, create an access token:
   - A **personal token** (**Account**, **Personal access tokens**) sees every organization you belong to.
   - An **organization token** (**Organization settings**, **Access tokens**) is limited to one organization and suits shared use.

   Listing tokens, teams and webhooks and reading usage need admin access.

2. In Infrawrench, paste the token and pick the **Organization**.
3. Pick your **Pulumi Plan**. Pulumi reports usage but not your plan, and Infrawrench uses the plan's published rates to turn usage into cost.

<insert [Pulumi Cloud Add-account form with the access token filled in, the Organization picker open and the Pulumi Plan picker showing Individual, Essentials, Pro and Enterprise] here>

If you pay a negotiated price, set **Rate Overrides** under **Advanced options**. For self-hosted Pulumi Cloud, enter its **API URL** there too, plus a CA certificate if it uses a private certificate authority.

## Cost graphs

Pulumi Cloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) with daily estimated cost by service:

| Service       | Usage                                               |
| ------------- | --------------------------------------------------- |
| IaC resources | Resource-hours for every resource under management  |
| Deployments   | Pulumi Deployments compute minutes                  |
| ESC secrets   | Secret-hours for secrets stored in ESC environments |

- **These amounts are estimates.** Pulumi has no billing API, so Infrawrench prices your daily usage at the published rate for the plan on the account. Each row has a `plan` tag.
- The plan's monthly base fee and included credits aren't counted. Rows show the list value of what you used.
- History goes back up to a year, as far as Pulumi keeps usage summaries.

## Tips & limits

- Stack secrets encrypted with a passphrase or a cloud KMS key can't be read through Pulumi Cloud. Those secret outputs say so instead of showing a value.
- Opening an ESC environment to read its values is recorded in Pulumi Cloud's audit log, the same as when the CLI does it.
- Deployments need settings on the stack (or inherited from a template). Add them in the stack's **Settings** tab before you use **Deploy**.
- Pulumi Cloud has no Terraform provider, so these resources aren't part of Export to Terraform.
- Bastion egress for Pulumi Cloud accounts allows `api.pulumi.com` and a self-hosted API URL, as long as it resolves to public addresses.
