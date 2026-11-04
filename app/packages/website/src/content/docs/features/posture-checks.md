---
title: Posture checks
description: Security checks across your connected accounts, such as public buckets, world-open firewall rules, unencrypted disks and stale credentials, ranked by severity, with alerts on the worst of it.
sidebar_order: 11
---

The bucket that quietly allows public access, the firewall rule someone opened to `0.0.0.0/0` "just for a minute", the volume that was never encrypted, the console password nobody has used since spring: each one hides on a different console page at a different provider. Posture checks put them in one list, with every security finding across every connected account ranked by severity, and alerts when something critical shows up.

Like the [orphan finder](./orphan-finder.md) and the [expiry radar](./expiry-radar.md), it costs nothing to have on. Findings use data your accounts already sync, so there are no extra provider API calls and nothing counts against your rate limits. Checks cover every provider that supports them.

## What it checks

Each finding explains why it matters. The main categories are:

- **Public exposure:** a Redshift cluster reachable from outside its VPC, an EC2 instance with SSH open to the world, a GCP firewall rule allowing ingress from `0.0.0.0/0`, a Cloud SQL instance with a public IP, a GCS bucket without public-access prevention, an OpenSearch domain with no VPC attachment, a Hetzner server with no firewall attached, a paused Cloudflare zone exposing its origin.
- **Encryption:** unencrypted EBS volumes, RDS/Neptune/DocumentDB cluster storage, EFS file systems, Redshift clusters and Azure managed disks; an Azure storage account allowing plain-HTTP transfer; an Azure Redis cache with its non-TLS port enabled.
- **Credential age:** an IAM user whose console password hasn't been used in over 90 days.
- **Data protection:** a CloudTrail trail without log-file validation, an Azure key vault without purge protection, a DigitalOcean Droplet with backups disabled.

**Dangling DNS** (`dns-dangling-target`) flags a DNS record still pointing at a provider name nothing in your workspace claims, the classic subdomain takeover risk. It comes from the [Domains](./domains.md) page and alerts like every other finding.

**Leaked credentials** have their own section at the top of the Posture tab. When a GitHub or GitLab account scans your code for committed secrets, each finding is matched to the account or stored secret it belongs to and can be rotated from the row. They refresh every 30 minutes and have their own alert trigger. See [Leaked credentials](./leaked-credentials.md).

Every finding has a severity: **critical**, **high**, **medium** or **low**. Critical and high findings trigger alerts. Medium and low are hygiene work that stays on the screen.

## The Posture screen

Web, desktop and mobile all have a **Posture** screen: severity totals at the top, then findings grouped by severity, category or account. Each row names the resource, the check that matched and the reason. Click the resource name (or select it with the keyboard) to open the resource and fix it.

![Web Posture screen showing the severity summary chips (critical / high / medium / low counts) and findings grouped by severity, with a publicly accessible Redshift cluster at the top marked critical](https://agent-assets.infrawrench.com/docs-screenshots/features/posture-checks/posture-screen.png)

On desktop, it works in both modes. Signed in to Infrawrench Cloud, you see your organization's findings. In local-only mode, you see findings for the workspace on your machine.

<insert [Mobile Posture screen with severity chips and grouped finding rows, one "No firewall attached" high finding visible with its reason text] here>

## Dismiss a finding

Some findings are true and intentional. The bucket really is a public static site, or the key really is rotated by a process Infrawrench can't see. Click **Dismiss** on the row, optionally say why, and the finding leaves the list and stops triggering alerts.

![Web Posture screen with the Dismiss reason box open on a "Bucket allows public access" row, showing the optional "Why is this acceptable?" input with Confirm and Cancel](https://agent-assets.infrawrench.com/docs-screenshots/features/posture-checks/dismiss-reason.png)

Dismissing hides a finding, it doesn't delete it, and it stays visible:

- Dismissed findings that still apply are listed under **Dismissed (N)** at the bottom of the screen, with who dismissed them, when, and their note. **Restore** puts one back.
- If you fix or delete the resource, the dismissal disappears from that list.
- The severity chips include a **Dismissed** count, so "clean" never gets mistaken for "someone silenced it".
- Dismissing and restoring are both recorded in the [audit log](../team-and-billing/audit-log.md) (`posture.finding.dismissed` / `posture.finding.restored`).

![Web Posture screen with the "Dismissed (2)" section expanded, showing two accepted risks with their author, date and reason, each with a Restore button](https://agent-assets.infrawrench.com/docs-screenshots/features/posture-checks/dismissed-list.png)

Dismissing needs `resources:write` (owners and admins by default). Members can see the Posture screen but don't see the dismiss buttons.

A dismissal covers one check on one resource. Dismissing "bucket is public" on one bucket doesn't affect any other bucket, or that bucket's other findings. You can't dismiss a check everywhere at once.

On desktop, cloud mode records the dismissal for the whole organization, and local-only mode keeps it in the workspace on your machine. On mobile you can dismiss and restore, but without a note.

## Alerts

When critical or high findings exist, your organization gets one summary alert, with counts per severity and the worst findings, through Slack channels, Microsoft Teams webhooks and mobile push. The **Posture** trigger is on by default. Turn it on or off per channel and per user in **Settings > Notifications** (or on the mobile notifications screen). You get at most one alert per organization per day, and medium and low findings never alert anyone.

You can switch posture alerts off for your organization through the posture settings (`PUT /posture/settings`) while keeping the screen.

**The weekly digest** includes a "Posture" line whenever critical or high findings are open, so even with alerts muted you hear about it once a week.

## Use the CLI

`infrawrench posture` prints the same findings, worst first. Use `--json` for scripts and `--local` for the desktop workspace on your machine:

```
$ infrawrench posture
Acme Corp · 6 findings  1 critical · 2 high · 3 medium

severity   resource        type               account    finding
critical   analytics       Redshift Cluster   Prod AWS   Cluster publicly accessible
high       web-1           Server             Hetzner    No firewall attached
high       logs-bucket     GCS Bucket         Data GCP   Public access prevention not enforced
medium     scratch-vol     EBS Volume         Prod AWS   Volume not encrypted
```

Dismissed findings are listed under the table, and you can dismiss or restore from the terminal too:

```
$ infrawrench posture dismiss cdn-assets gcs-bucket-public --reason "public static site"
Dismissed cdn-assets · gcs-bucket-public
Accepted for Acme Corp. It leaves the posture list and the daily alerts until `posture restore`.

$ infrawrench posture restore cdn-assets gcs-bucket-public
```

Get both ids from `infrawrench posture --json` (`resourceId` and `ruleId` on each finding). `--local` dismisses in the desktop workspace instead. Close the desktop app first when using it.

## Use it from an AI agent

The `list_posture_findings` MCP tool gives AI agents your findings, filterable by severity and category. An agent asked "is anything exposed?" can answer with your real posture, and an agent about to open a port knows what's already open. It always reports how many findings are dismissed, and returns the dismissals (with author, date and note) when asked.

`dismiss_posture_finding` and `restore_posture_finding` let an agent dismiss or restore a finding you've told it is intentional. Both need `resources:write` and both are audited.

## Limits

- Checks can only use data the provider reports. S3 bucket public-access blocks, AWS security-group CIDRs, RDS instance public accessibility and IAM access-key ages aren't available today, so those checks don't exist yet. A finding is never a guess.
- Findings reflect the last sync. Something you just fixed clears on the next sync, not instantly.
- The dangling DNS check stays quiet when it can't be sure. It only checks a provider when you have that provider connected and at least one of its resources has synced. [Domains](./domains.md) explains this and lists what was skipped.
- You can't edit or add checks. What's up to you is which findings you accept (see [Dismiss a finding](#dismiss-a-finding)).
- Dismissals never expire. They hold until someone restores them, so it's worth looking at the **Dismissed** list now and then.

## File a finding as an issue

Posture findings are work for someone. With [Jira](./jira.md) or [Linear](./linear.md) connected, each finding row has a link that opens an issue prefilled with the resource, account, rule id, severity, category and explanation. Once filed, the row shows its issue key, so two people don't open the same ticket.
