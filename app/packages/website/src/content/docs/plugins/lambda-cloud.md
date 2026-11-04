---
title: Lambda Cloud
description: Launch, restart and terminate Lambda Cloud GPU instances with live capacity and price pickers, and manage filesystems, firewall rulesets and SSH keys.
sidebar_order: 50
---

Lambda Cloud rents on-demand GPU instances by the hour. Connect it to launch and manage your instances and everything they depend on.

## What you can manage

- **Instances**: launch with an instance type picker that shows vCPUs, memory, local storage, GPU and the monthly list price, and marks types Lambda has no capacity for right now. The region picker only offers regions with capacity for the type you picked. Choose an SSH key, image (Lambda Stack by default), filesystem, firewall ruleset, hostname, tags and cloud-init user data. Restart from the header, terminate with delete, and edit the name and tags.
- **Filesystems**: persistent storage in one region. Create, delete, and see whether an instance mounts it and roughly how much it holds.
- **Firewall rulesets**: per-region inbound rules attached to instances. Create, rename, and edit the rules.
- **Global firewall rules**: the inbound rules Lambda applies to every instance. Edit them here.
- **SSH keys**: add (paste a public key or pick one from your machine) and delete.

Every instance type, region, SSH key, image, filesystem and ruleset in the launch form is a picker filled from your account, so you never type an ID.

<insert [The Lambda Cloud launch instance form with the instance type picker open, showing GPU types with monthly prices and one marked as having no capacity] here>

## Edit firewall rules

Firewall rules are plain text, one rule per line: `protocol ports source description`. Ports is a single port, a `min-max` range, or `-` for every port (ICMP takes `-`). For example:

```text
tcp 22 0.0.0.0/0 SSH
tcp 8000-8100 10.0.0.0/8 internal APIs
icmp - 0.0.0.0/0 ping
```

## Connect to an instance

Running instances show a ready-to-run `ssh ubuntu@<ip>` command, and the built-in terminal connects as `ubuntu`. The JupyterLab link includes its login token, so Infrawrench doesn't store it. It's fetched from Lambda when you open it.

<insert [A Lambda Cloud instance detail page showing the instance type, GPU, region and price, the Connect section with the SSH command, and the Restart button in the header] here>

## Connect an account

1. In the Lambda Cloud dashboard, open **API keys** and click **Generate API key**.
2. Give it a name and copy the key. Lambda only shows it once.
3. Paste it into Infrawrench.

API keys belong to your Lambda team and have full access to it. Lambda has no read-only keys.

<insert [The Add account form for Lambda Cloud with the API Key field] here>

## Cost

Lambda Cloud has no billing or usage API, so Infrawrench doesn't report spend. Each instance shows its hourly list price, and the launch form gives a monthly estimate from it. Filesystem storage is billed separately and isn't in the estimate.

## Savings and governance

- **Orphan finder**: filesystems no instance mounts, which keep billing for their stored data.
- **Posture checks**: a firewall ruleset, or the global rules, that allow SSH (TCP 22) from `0.0.0.0/0`.
- **Provider status**: incidents on [status.lambda.ai](https://status.lambda.ai) are matched to the regions they name and to your instances and filesystems.

## Things to know

- Lambda instances can't be stopped, only restarted or terminated. Terminating deletes the instance's local storage, so keep data on a filesystem.
- An instance can only mount filesystems and use firewall rulesets from its own region.
- Lambda limits the API to about one request per second, and launches to one every 12 seconds.
- Lambda doesn't publish an official Terraform provider, so there's no Terraform export.
