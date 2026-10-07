---
title: HCP Terraform
description: Manage HCP Terraform and Terraform Enterprise projects, workspaces, variables, runs with logs, state outputs, drift, variable sets, agent pools, policy sets, teams, run tasks and the private registry.
sidebar_order: 53
---

The HCP Terraform plugin works with HCP Terraform (including HCP Europe) and with Terraform Enterprise on your own hostname.

## What you can manage

- **Organization**: plan, workspaces, projects, resources under management, drifted workspaces and workspaces failing checks, users against the plan's user limit, active runs and the next invoice. **Edit** the notification email, default execution mode, cost estimation, enforced health assessments and force-delete permission. The Metrics tab charts runs, errored and applied runs, run duration (p50 and p95) and resources added, changed and destroyed across the organization.
- **Projects**: **Create**, **Edit** (name, description, default execution mode, auto-destroy after inactivity) or delete.
- **Workspaces**: Terraform version, execution mode, VCS repository and branch, resource count, current run, drift and failing checks from health assessments, the 15 most recent runs and the latest state versions. **Create** one (in a project, optionally connected to a VCS repository or an agent pool), **Edit** its settings, **Queue run** (plan and apply, plan only, refresh state or destroy, with optional targets and replacements), **Lock**, **Unlock** or **Force unlock**, **Move to project**, change the **Execution** mode and agent pool, or delete it. Deleting uses safe delete, so a workspace that still manages resources is refused. **Get credentials** downloads the current state as a `.tfstate` file or as `terraform show -json` output. The Metrics tab charts the workspace's runs.
- **Runs**: the 50 most recent runs in the organization with status, trigger, and resources to add, change, destroy and import. The **Logs** tab shows the plan and apply logs. **Apply**, **Discard**, **Cancel** (each with an optional comment) or **Force cancel**. **Create** a run to queue one on any workspace.
- **Variables**: Terraform and environment variables on each workspace. **Create**, **Edit** or delete. Sensitive values are write-only; non-sensitive values are outputs other resources can reference.
- **State outputs**: every output in a workspace's current state. Its value, including sensitive outputs, is an output other resources can reference, so a DNS record or an exported secret follows what Terraform last applied.
- **Variable sets** and their variables: **Create**, **Edit** or delete, and apply a set to (or remove it from) a workspace or project.
- **Agent pools**, their **agents** and **agent tokens**: **Create**, rename, scope or delete a pool, remove an exited agent, create a token (its value is kept as an output you can export as `TFC_AGENT_TOKEN`), revoke a token, or use **Get credentials** on the pool to mint one.
- **Policy sets** (Sentinel or OPA): **Create** one (optionally from a VCS repository), **Edit** or delete it, and attach it to a workspace or project.
- **Teams**: **Create**, **Edit** (name, visibility and organization permissions) or delete.
- **Run tasks**: **Create**, **Edit** (URL, description, HMAC key, enabled) or delete.
- **Private registry modules and providers**: versions, status, VCS source and no-code readiness; delete from the registry.

Workspaces, projects, variables, variable sets and their variables, agent pools, teams and run tasks can be exported to Terraform for the official `hashicorp/tfe` provider.

## Credentials

1. Create an API token:
   - A **user token** (**Account settings**, **Tokens**, **Create an API token**) acts as you and sees what you can.
   - A **team token** (**Organization settings**, **Teams**, pick the team, **Team API token**) suits automation.
   - An **organization token** cannot queue runs or read state outputs, so prefer one of the others.
2. In Infrawrench, paste the token. Leave **Hostname** as `app.terraform.io`, change it to `app.eu.terraform.io` for HCP Europe, or enter your Terraform Enterprise hostname.
3. Pick the **Organization** from the list of organizations the token can see. For Terraform Enterprise with a private certificate authority, paste the CA certificate under **Advanced options**.

<insert [HCP Terraform Add-account form with the API token filled in, the hostname left at app.terraform.io and the Organization picker open] here>

Tokens carry no scopes: the plugin can do whatever the token's user or team is allowed to do, and actions that need more fail with a permission error.

## Cost graphs

Organizations billed by credit card in HCP Terraform feed [cost graphs & budgets](../features/cloud-costs.md) from their invoices: one row per invoice on the day it was issued, tagged with the invoice number. Organizations billed through an HCP contract, and Terraform Enterprise, have no invoices in this API, so they show no cost.

## Quotas

The [quota radar](../features/quota-radar.md) tracks users, policy sets, policies and run tasks against the limits your plan states. Limits the plan leaves open are not shown.

## Using state with IaC reconciliation

Download a workspace's state with **Get credentials** and upload it under [IaC](../features/iac-reconciliation.md) to see which of your synced cloud resources that workspace manages, which have drifted and which were created by hand.

## Tips & limits

- Drift, check results and resources under management come from HCP Terraform's explorer, which is open to the owners team, teams that can read all workspaces or projects, and organization tokens. Other tokens still list workspaces, without those columns.
- Health assessments only run on workspaces that have them turned on (or when the organization enforces them); turn them on with **Edit**.
- Features outside your plan (agents, policies, run tasks, the private registry) simply list nothing.
- HCP Terraform allows 30 API requests a second per user.
- Provider status comes from HashiCorp's status page, filtered to incidents about HCP Terraform. Terraform Enterprise has no public status.
- Bastion egress for HCP Terraform accounts allows `app.terraform.io` and other `terraform.io` hosts, which serve run logs and state downloads. A Terraform Enterprise hostname is your own and is not on that list.
