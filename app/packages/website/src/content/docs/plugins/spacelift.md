---
title: Spacelift
description: Manage Spacelift spaces, stacks and outputs, trigger and approve runs with phase logs, drift detection, scheduled runs, contexts, policies, modules and worker pools.
sidebar_order: 55
---

## What you can manage

- **Account**: the billing period, seats and run minutes in your plan, run minutes used on public and private workers this period, the public worker pool's parallelism and queue, and how many stacks, spaces and worker pools you have.
- **Spaces**: **Create**, **Edit** (name, description, labels, entity inheritance) or delete.
- **Stacks**: tool and version (OpenTofu, Terraform, Pulumi, Kubernetes, Ansible, CloudFormation, Terragrunt), repository, branch, tracked commit, state, worker pool, whether the stack is locked, disabled or blocked by a dependency, attached contexts, drift detection, scheduled runs and the 15 most recent runs.
  - **Trigger run** (tracked or proposed, optionally at a commit).
  - **Lock** with a note, or **Unlock**. **Enable** or **Disable**.
  - Set up **Drift detection** (cron schedules, time zone, whether to reconcile) and **Schedule run**.
  - **Edit** the description, branch, project root, labels, autodeploy, autoretry, deletion protection and runner image.
  - **Create** a stack, or delete it. Deleting a stack never destroys its resources.
  - **Get credentials** downloads the state of stacks whose state Spacelift manages.
  - The Metrics tab charts runs, failed, tracked and drift detection runs, and resources to add, change and delete.
- **Stack outputs**: every output of a stack's last tracked run. Other resources can reference its value. Sensitive outputs only have a value if the stack uploads sensitive outputs.
- **Runs**: the 50 most recent runs in the account, with type, state, commit and planned changes. The **Logs** tab shows each phase's log (initializing, planning, applying...) or all of them together. **Confirm** or **Discard** an unconfirmed run, **Cancel** a queued one, **Stop** a running one, or **Retry**. **Create** a run to trigger one on any stack.
- **Contexts** and their **variables**: environment variables and mounted files shared across stacks. **Create**, **Edit** or delete a context, **Attach to stack** with a priority or **Detach**, and create, replace or delete its variables. Plain values are outputs other resources can reference. Secret ones are write-only.
- **Policies**: Rego policies of every type. Edit the body in the **Policy** tab and the name, description and labels under **Edit**. **Attach to stack** or **Detach**, **Create** or delete.
- **Modules**: modules in Spacelift's private registry. **Edit** the description, labels and branch, **Enable**, **Disable** or delete.
- **Worker pools**: each private pool's workers and whether they're busy. **Edit** the name, description and labels, **Cycle workers**, **Drain** or **Undrain** a worker, or delete the pool.

You can export stacks, spaces, contexts, context environment variables, policies and modules to Terraform for the official `spacelift-io/spacelift` provider.

## Connect your account

1. In Spacelift, open **Organization settings**, then **API keys**, and **Create API key** with type **Secret**. Give it the spaces it should manage. Admin on the `root` space manages the whole account. Spacelift downloads a file with the key ID and secret.
2. In Infrawrench, enter your **Account** (`acme` for `acme.app.spacelift.io`, or the hostname for the US region or a self-hosted install), then the **API Key ID** and **API Key Secret** from that file.

<insert [Spacelift Add-account form with the account name, API key ID and API key secret filled in] here>

Spacelift bills API keys like users: a key used during a billing period counts as a seat.

## Quotas

If your plan includes a set number of run minutes, the [quota radar](../features/quota-radar.md) tracks the minutes used this billing period against it.

## Check state against your cloud

For OpenTofu and Terraform stacks whose state Spacelift manages, download the state with **Get credentials** and upload it under [IaC](../features/iac-reconciliation.md). You'll see which of your cloud resources the stack manages, which have drifted and which were created by hand.

## Tips & limits

- Spacelift has no billing API, so Spacelift accounts don't feed cost graphs. The account page shows your plan's seats, run minutes and prices.
- For very long phases, the run log shows the last part.
- New worker pools need a certificate signing request generated on your own machine, so create them in Spacelift and manage them here.
- Bastion egress for Spacelift accounts allows `*.spacelift.io` and Amazon S3, where state downloads come from. A self-hosted Spacelift hostname isn't on that list.
