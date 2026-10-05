---
title: Remediation commands
description: Every savings finding comes with the provider CLI commands that fix it, filled in with the real resource ids, region and target size, ready to copy, plus a Terraform hint when the resource is managed by IaC.
sidebar_order: 14
---

A savings finding tells you what is wasteful: an unattached volume, a machine twice the size it needs, a commitment nobody is using. Plenty of teams don't act on findings by clicking a button. Changes go through a terminal, a runbook, a change ticket or Terraform. So every finding also carries the exact commands that fix it, written for the provider's own CLI and filled in with the resource's real id, region and target size.

## Where to find it

Open **Costs** and look for **Remediate** on a row in any of these sections:

- **[Potential savings](./orphan-finder.md)**: commands that clean up an orphaned or idle resource.
- **[Oversized](./right-sizing.md)**: the resize, step by step, next to the one-click **Apply resize** button.
- **[Sleep schedules](./sleep-schedules.md)**: the stop and start commands, for when the schedule is paused and you want to do it by hand, or want the same window in your own cron.
- **Efficiency alerts** (idle commitments): the provider's commands for inspecting the commitment and acting on it, as far as the provider allows.

Click **Remediate** to open the panel. Every command has its own **Copy** button, and **Copy all** copies the whole sequence as a script, with each step's description as a comment.

<insert [Costs page, Potential savings section, with the Remediate panel open under an unattached EBS volume: the snapshot, wait and delete-volume commands with their Copy buttons, the Destructive badge on delete-volume, and the AWS_PROFILE note] here>

## What the commands look like

The commands run in the order shown. For example, an unattached EBS volume gets a snapshot first, then a wait for the snapshot to finish, then the delete:

```sh
aws ec2 create-snapshot --volume-id vol-0a1b2c3d4e5f67890 --description 'Pre-delete snapshot of data' --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=data-pre-delete-20261004}]' --region eu-west-1 --profile "$AWS_PROFILE"
aws ec2 wait snapshot-completed --filters Name=volume-id,Values=vol-0a1b2c3d4e5f67890 Name=tag:Name,Values=data-pre-delete-20261004 --region eu-west-1 --profile "$AWS_PROFILE"
aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f67890 --region eu-west-1 --profile "$AWS_PROFILE"
```

A few rules hold for every provider:

- **Destructive steps are marked.** Anything that deletes data or releases something you can't get back (a volume, a reserved IP, a load balancer) has a **Destructive** badge. Where the provider can back the resource up, a snapshot or backup command comes first. Where it can't (Hetzner volumes, an Oracle Autonomous Database, Crusoe disks), the description says so.
- **Resizes include every step the provider needs.** AWS and GCP need a stopped machine, so you get stop, wait, resize, start. Hetzner needs the server powered off. DigitalOcean powers the Droplet off itself, and Azure resizes in place but restarts the VM. The descriptions point out which steps cause downtime.
- **Account-level values are shell variables.** Some values belong to your account rather than the resource, such as the AWS CLI profile, the GCP project or the Azure subscription. Those are written as `"$AWS_PROFILE"`, `"$GCP_PROJECT"`, `"$AZURE_SUBSCRIPTION_ID"` and so on, and the panel lists the ones to set before you run anything. CLIs that read their own config (doctl, hcloud, scw, linode-cli) need nothing extra.
- **Names are quoted safely.** Resource names come from the provider and can contain anything. Every value is quoted for the shell, so a name like `prod; rm -rf ~` reaches the CLI as a single argument.
- **No guessing.** If a resource is missing the id a command needs, it gets no commands at all rather than a broken one. When a provider has no way to undo something (a GCP committed-use discount, an RDS reservation), the description says so instead of inventing a command.

## Managed by Terraform?

If you've uploaded a Terraform state on the [IaC page](./iac-reconciliation.md) and it says a flagged resource is managed by Terraform, the panel puts a Terraform hint first. Running the CLI commands against a managed resource works, but the next `terraform apply` puts it back.

- **For a resize**, the hint names the block (for example `aws_instance.api`) and the attribute to change, such as `instance_type = "m5.large"`, then gives the `terraform plan -target=…` to review. The attribute comes from the same mapping that [eject to Terraform](./terraform-export.md) uses, so the two always agree.
- **For an orphan**, it gives `terraform plan -destroy -target=…` as a preview, and recommends deleting the block from your configuration so the code stays the source of truth.

The hint uses the newest state uploaded for the resource's own account, or else the newest one uploaded for the whole organization, never another account's. With no state uploaded, there is simply no hint.

## Which providers have commands

Commands are written by each provider's plugin, so they use the CLI you'd use for that provider:

| Provider        | Tool         | Findings covered                                                                                                                                                                                                                                            |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS             | `aws`        | EC2 resize, stop/start; RDS stop/start; EBS volume and Elastic IP cleanup; Reserved Instances (modify, exchange, Marketplace listing), RDS reservations, Savings Plans (return within AWS's window)                                                         |
| Google Cloud    | `gcloud`     | Compute Engine resize, stop/start; disk and static IP cleanup; committed-use discounts (describe, turn off auto-renew)                                                                                                                                      |
| Azure           | `az`         | VM resize, deallocate/start; stop/start for App Service, Functions, Container Instances, Container Apps, AKS, Application Gateway, MySQL and PostgreSQL flexible servers; App Service plan cleanup; reservations and savings plans (scope, renewal, refund) |
| DigitalOcean    | `doctl`      | Droplet resize, power off/on; volume, reserved IP, load balancer and firewall cleanup                                                                                                                                                                       |
| Hetzner Cloud   | `hcloud`     | Server type change, power off/on; volume, floating IP, primary IP and certificate cleanup                                                                                                                                                                   |
| Scaleway        | `scw`        | Instance type change, stop/start; flexible IP cleanup                                                                                                                                                                                                       |
| Akamai / Linode | `linode-cli` | Linode resize, shutdown/boot; database suspend/resume; volume, offline Linode, reserved IP and NodeBalancer cleanup                                                                                                                                         |
| OVHcloud        | `ovhcloud`   | Instance stop/start; volume cleanup                                                                                                                                                                                                                         |
| Oracle Cloud    | `oci`        | Shape change, stop/start; instance, boot volume, block volume, reserved IP, load balancer and Autonomous Database cleanup                                                                                                                                   |
| Crusoe          | `crusoe`     | VM stop/start; VM and disk cleanup                                                                                                                                                                                                                          |

| CoreWeave | `kubectl` | Node pool scale to zero and back |
| Confluent Cloud | `confluent` | Kafka cluster CKU shrink (one step at a time); idle cluster, connector and network cleanup |
| MongoDB Atlas | `atlas` | Cluster tier change, pause/resume; paused cluster, online archive and private endpoint cleanup |
| Snowflake | `snow sql` | Warehouse auto-suspend and suspend/resume; task suspend/resume |
| Databricks | `databricks` | Cluster, SQL warehouse and app stop/start |
| Anyscale | `anyscale` | Idle workspace terminate; workspace terminate/start on a schedule |
| Fly.io | `fly` | Machine stop/start |
| Together AI | `together` | Dedicated endpoint stop/start |
| GitHub | `gh` | Idle Copilot seat, offline runner and stale codespace cleanup |
| Twilio | `twilio` | Unused phone number release |
| Neon, ClickHouse Cloud, Cursor, Redis Cloud, UploadThing, Baseten | `curl` | Endpoint suspend/start, service stop/start, idle seat removal, database backup and delete, failed upload cleanup, idle deployment scale-to-zero and deactivate/activate, through each provider's documented API |

## Everywhere else findings go

- **Mobile**: each row on the Costs tab has a **Remediation commands** disclosure with copy buttons. Nothing runs from the phone; it only copies.
- **CLI**: `infrawrench orphans`, `infrawrench oversized` and `infrawrench schedules` print a Remediation section under the table. With `--json`, every finding carries a `remediation` object. See [CLI](./cli.md).
- **MCP and AI chat**: `list_orphaned_resources`, `list_oversized_resources`, `list_schedules` and `list_efficiency_alerts` return the same `remediation` object, so an agent can hand you the exact command rather than paraphrasing one. See [MCP](./mcp.md).
- **Jira and Linear**: when you file a finding as an issue, the description includes a Remediation section with one code block per command. See [Jira](./jira.md).
- **GitHub issues**: an issue filed by hand or by the automatic savings scan carries the commands under **Remediation** as one shell block, Terraform first when it manages the resource. See [GitHub issues](./github-issues.md).
- **API**: `remediation` is on `OrphanedResource`, `OversizedResource`, `SleepSchedule` and `EfficiencyAlertEvent` (API 1.47.0 and later). Each entry in `remediation.commands` has `tool`, `command`, `description` and `destructive`, and `remediation.iac` is non-null when Terraform manages the resource.

Always read a command before running it, and confirm a resource really is unused before deleting it. The findings are heuristics over the state your accounts last synced.
