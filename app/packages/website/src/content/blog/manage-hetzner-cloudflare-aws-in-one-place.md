---
title: "Manage Hetzner, Cloudflare and AWS in one place: servers, SSH, DNS and costs"
description: "Connect Hetzner Cloud, Cloudflare and AWS to one workspace so you can see every server, open SSH terminals, edit DNS and track costs without switching between three consoles. Covers the exact tokens and permissions each provider needs."
date: "2026-11-15"
kind: guide
---

A common small-team setup is servers on Hetzner, DNS and Workers on Cloudflare, and a few managed services on AWS. Each provider has its own console, its own CLI and its own billing page, so a simple question like "which box is that IP, and what does it cost?" means three logins. This guide connects all three to Infrawrench so you can browse every resource, SSH into servers, edit DNS records and see spend in one place. Most of the work is creating the right credential on each provider, so that is where the detail is.

Prerequisites: an owner or admin login on each provider, and Infrawrench. The [desktop app](/) for macOS, Windows and Linux is free, needs no account and keeps everything on your machine. If you want the same view on the web or for a teammate, the hosted Free plan covers one user and three connected accounts, which is exactly this setup. Placeholders used throughout: PROJECT_NAME and ACCOUNT_NAME.

## Step 1: Connect Hetzner Cloud

Hetzner API tokens belong to one project, so you add one Infrawrench account per Hetzner project.

1. In Hetzner Console, select PROJECT_NAME.
2. Go to **Security > API tokens > Generate API token**.
3. Give it **Read + write** access, so you can act on servers as well as view them.
4. In Infrawrench, add a Hetzner account and paste the token.

The same token covers Hetzner Cloud, Hetzner DNS and Storage Boxes, so you don't need a second credential. If you have several projects, repeat this for each one. Full details are on the [Hetzner Cloud docs page](/docs/plugins/hetzner).

## Step 2: Connect Cloudflare with an API token

Use an API token rather than signing in with Cloudflare. Cloudflare's OAuth can't grant billing access, so an account connected that way has no cost graphs.

1. In Infrawrench, start adding a Cloudflare account.
2. Click **Create a token with these scopes** next to the API token field. Cloudflare's token creator opens with the scopes Infrawrench uses already selected.
3. Check that **Billing Read** is included if you want Cloudflare spend, then create the token.
4. Copy the token and paste it in. Cloudflare only shows it once.

The form checks the token and shows what it can reach for each capability, so a missing permission shows up before you rely on it. See the [Cloudflare docs page](/docs/plugins/cloudflare) for scoping a token by hand.

## Step 3: Connect AWS with least privilege

1. In the AWS console, go to **IAM > Users > Security credentials > Create access key** for a user with the permissions you need.
2. For browsing, the `ReadOnlyAccess` managed policy is usually enough. To create or change resources, add the matching write permissions.
3. For cost data, add `ce:GetCostAndUsage`. It is not part of `ReadOnlyAccess`, and it is the check that most often fails.
4. In Infrawrench, add an AWS account and paste the access key.

The [AWS docs page](/docs/plugins/aws) lists the exact permissions behind each feature.

## Step 4: See every server together

With all three connected, resources are discovered automatically. Hetzner servers, EC2 instances, Cloudflare zones and Workers all sit in the same workspace, each with its own detail page, actions, logs and metrics where the provider exposes them. Hetzner servers show CPU, disk and network metrics. Their header has power, reboot, snapshot and backup actions.

## Step 5: SSH without hunting for IPs

Any VM, a Hetzner server or an EC2 instance alike, has an **Open SSH tab** button on its detail page. The first time you connect to a host you pick a key. On desktop that can be a key from `~/.ssh/`, a saved key, or the 1Password SSH agent. Infrawrench remembers the choice for that host, so after that it is one click. See [SSH terminal](/docs/features/ssh-terminal).

## Step 6: Edit DNS next to the servers it points at

Open a Cloudflare zone and its records appear as a table with type, name, content, proxy status and TTL. When you create an A, AAAA or CNAME record you can point it at one of your resources, such as a server, instead of pasting its IP by hand. Route 53 hosted zones work the same way, and Hetzner DNS zones are editable from their own zone pages. See [DNS records](/docs/features/dns-records).

## Step 7: Read costs honestly

Costs from all three accounts show up together, but they are not all the same kind of number:

- **AWS** comes from AWS's own cost data, through the `ce:GetCostAndUsage` permission from Step 3.
- **Cloudflare** comes from its billing data, once the token has Billing Read.
- **Hetzner** is an estimate. Hetzner Cloud has no billing API, so Infrawrench prices everything in the project against Hetzner's published rate card and labels it **estimated**. Expect it to read low: anything deleted mid-month is missing, every rate is list price, and credits, tax and one-off charges never appear.

Check each provider's docs page before reconciling a number against an invoice. The [cloud costs docs](/docs/features/cloud-costs) explain estimated accounts in full.

## Other ways to do this

If you only need to look, not act, [Steampipe](https://steampipe.io/) can query all three providers with SQL from your terminal using its AWS, Hetzner and Cloudflare plugins. You'd still use `hcloud`, `wrangler` and the `aws` CLI to change anything, and SSH and DNS editing stay separate. Terraform or OpenTofu remains the right place to define infrastructure as code. A workspace like this sits beside it for day-to-day operations.

## Conclusion

Three providers is where console switching starts to cost real time. Create a Hetzner project token, a Cloudflare API token with Billing Read and an AWS access key with `ce:GetCostAndUsage`, connect them, and you get one list of servers, one-click SSH, DNS editing that knows your servers, and costs side by side, with Hetzner clearly marked as an estimate.

Infrawrench is one platform made of apps that all read the same connected accounts: the Infrastructure app for resources, SSH, SQL and DNS, and the Costs app for spend, budgets and anomalies. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Hetzner Cloud in Infrawrench](/docs/plugins/hetzner)
- [Cloudflare in Infrawrench](/docs/plugins/cloudflare)
- [AWS in Infrawrench](/docs/plugins/aws)
- [Cloud costs](/docs/features/cloud-costs)
- [Hetzner Cloud API tokens](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/)
- [Cloudflare: create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [AWS Cost Explorer API permissions](https://docs.aws.amazon.com/cost-management/latest/userguide/billing-permissions-ref.html)
