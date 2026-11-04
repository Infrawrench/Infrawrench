---
title: Fan-out SSH
description: Run one command across many hosts at once, with identical output collapsed and the odd one out diffed.
sidebar_order: 4
---

The [SSH terminal](./ssh-terminal.md) gives you one shell on one box. **Fan-out SSH** helps you find _which of these thirty boxes is the odd one out_.

Pick a set of hosts, type one command, and Infrawrench runs it on all of them at once. Hosts with identical output are collapsed into one block, and anything different is shown as a diff against what most hosts said. Finding the machine still on the old kernel takes a glance.

Open **Fan-out** from the sidebar, on web or desktop.

![The Fan-out screen with a host list filtered to one provider, several hosts checked, and a command typed in the box](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-fanout/compose-filtered-hosts.png)

## Pick hosts

The host list includes everything Infrawrench can already SSH into:

- **SSH accounts:** hosts added through the [SSH plugin](../plugins/ssh.md). They have their own credentials, so nothing else is needed.
- **VMs:** any resource with an **SSH** button on its detail page (EC2 instances, Droplets, Hetzner and Scaleway servers, GCP instances and so on).

Filter the list by search text, provider, resource type or tag, then click **Toggle all shown** to select everything that matches. Stopped VMs are listed but can't be selected.

For VMs, pick one of your organization's [SSH keys](../team-and-billing/ssh-keys.md) for the whole run, and optionally override the username. SSH accounts ignore both and use their own credentials.

## Run a command

Fan-out always asks before running. The confirmation shows the number of hosts (**"Run on 14 hosts?"**), the command and the first few host names. You can't fire a fleet-wide command with one click.

Limits:

- Up to **100 hosts** per run.
- Up to **8 connections at once** by default, configurable up to 16.
- Up to two minutes per host.
- Up to 256 KiB of output per stream.

A run counts as a change, so it respects [change freezes](../team-and-billing/change-freeze.md). During a freeze the run is blocked, and members with the freeze-override permission see an **Override freeze and run** button instead.

Every run, block and override is recorded in the [audit log](../team-and-billing/audit-log.md) as `ssh.fanout.run`, with the first 200 characters of the command, the host count and how many hosts failed.

## Read the results

Results are grouped by output, not listed per host:

- The largest successful group is labelled **majority**: the answer most of your fleet gave.
- Every other group is an **outlier**, shown as a diff against the majority. Green lines are what only these hosts said. Red lines are what the majority said and these didn't. Long runs of identical lines are collapsed.
- Groups where the command couldn't run are labelled **failed**, with the reason: connection refused, an untrusted host key, a stopped host, or an address Infrawrench won't connect to.

Exit codes count too. Hosts that printed the same text but exited non-zero form their own group. Each host chip shows its exit code when it isn't zero, and **Show output** expands a group's full text.

![Results view with a majority group of 29 hosts collapsed and one outlier host showing a red/green kernel-version diff](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-fanout/results-majority-and-outlier.png)

## Save snippets

Save commands you run often with a name. Snippets are shared across your organization, so if you save `uname -r` once, everyone gets it from the **Insert snippet…** dropdown on web, desktop and the CLI.

## Use the CLI

The [CLI](./cli.md) has the same feature, with the same confirmation and the same grouped, diffed output:

```
# what can I fan out to?
infrawrench ssh-fanout --list --plugin hetzner

# run a command; you'll be asked "Run on 14 hosts?" first
infrawrench ssh-fanout "uname -r" --tag env:prod --key ops

# a saved snippet, unattended, as JSON
infrawrench ssh-fanout --snippet kernel --hosts web- --key ops --yes --json

# the organization's saved commands
infrawrench ssh-fanout snippets
```

Useful flags:

- `--hosts <text>` matches a host name, address or tag.
- `--plugin` and `--tag` narrow the list further.
- `--key <id|name>` sets the org SSH key VM hosts need.
- `--user` overrides the username.
- `--concurrency <n>` changes how many connections run at once.
- `-y/--yes` skips the confirmation, for scripts.
- `--json` prints the raw per-host results.

The CLI only works with cloud accounts. For SSH accounts that exist only on your machine, use the desktop app's Fan-out screen, which connects from your own computer.

## Security

- Host keys are checked just like in a single terminal. A host whose key is unknown or has changed fails with a trust error instead of connecting. See [Security notes](./ssh-terminal.md#security-notes).
- You can only use SSH keys you own. You can't fan out with a teammate's private key.
- Infrawrench won't connect to hosts that resolve to internal addresses. Those hosts are reported as blocked.
- One bad host never fails the whole run. Unreachable machines show up as their own failure group next to everyone else's results.
