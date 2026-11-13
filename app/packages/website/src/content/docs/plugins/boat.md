---
title: boat
description: Create, stop, resume and fork boat sandboxes, prompt agents in them, host ports, and manage saved snapshots, environments, webhooks and API keys, with per-sandbox machine-time costs.
sidebar_order: 50
---

boat runs persistent Ubuntu sandboxes for AI agents, automation and people, billed per second while they run and nothing while they're stopped. Connect it to manage your sandboxes and everything they start from.

## What you can manage

- **Sandboxes**: create with a size picker that shows vCPUs, memory, disk and the monthly price at your account's rate, and marks sizes your plan can't create yet. Start from a fresh machine or a saved snapshot, pick an environment (or none, so nothing of yours goes in), set auto-stop, visibility, labels, extra env vars, a setup script and ports to host. Edit the name, auto-stop and subdomain. Delete removes the sandbox and its files.
- **Saved snapshots**: named, frozen copies of a sandbox that new sandboxes can start from. Create one from a sandbox picker, or from a sandbox's **Save snapshot** button, and delete it when you no longer need it.
- **Environments**: what a new sandbox carries. Create, rename, make one the default, and switch which of your logins pass in (GitHub, secrets, sandbox credentials, agent logins, the AI proxy). Set or remove env vars from the header, and **Upgrade sandboxes** moves every sandbox on it to the latest version. Infrawrench lists variable names and secret file paths, never their values.
- **Webhooks**: HTTPS endpoints boat posts sandbox lifecycle events to (`sandbox.ready`, `sandbox.error`, `sandbox.archived`, `sandbox.hydrated`, `sandbox.degraded`, `sandbox.recovered`). Create, edit and delete them, and rotate the signing secret.
- **API keys**: every key on the account, with its allowed actions, the sandboxes it's limited to, its expiry and when it was last used. Revoke one with delete. Needs a full-access key (see below).

Sizes, environments, saved snapshots and sandboxes are all pickers filled from your account, so you never type an ID.

<insert [The boat create sandbox form with the size picker open, showing small, default, large and xlarge with monthly prices and xlarge marked as needing a higher plan] here>

## Work with a sandbox

The sandbox header changes with its state:

- **Running**: **Authorize SSH key**, **Prompt agent**, **Interrupt agents**, **Host a port**, **Save snapshot**, **Fork**, **Stop** and **Force stop**. Force stop discards anything written since the last snapshot.
- **Stopped**: **Resume**, optionally on another size or with a new auto-stop, plus **Save snapshot** and **Fork**.
- **Organization sandboxes you own**: **Share with organization** or **Make private**.

**Prompt agent** sends a prompt to Claude Code, Codex, OpenCode or another agent boat supports, in the current conversation or a new one. The agent has to be set up on your boat account first. The run carries on in the sandbox after you close the dialog.

**Host a port** serves a port at `https://<subdomain>-<port>.on.boat.dev`. A private URL carries an access token, and a public one works for anyone. Ports hosted from Infrawrench are listed under **Hosted Port URLs** in the Connect section.

<insert [A running boat sandbox detail page showing size, state, environment, auto-stop and this month's cost, the Connect section with the SSH command, and the header actions] here>

## Connect to a sandbox

Use **Authorize SSH key** first: boat only accepts keys installed on that sandbox. Then the built-in terminal connects as `user`, and the Connect section shows a ready-to-run SSH command. When boat routes SSH through a relay, the command uses the relay's host and port. The desktop stream link includes its access token, so Infrawrench doesn't store it. It's fetched from boat when you open it.

## Connect an account

1. Create an API key in the boat dashboard, or run `boat api-key create infrawrench` with the boat CLI.
2. Paste it into Infrawrench.
3. If you belong to boat organizations, pick one under **Organization** to bill and list that organization's wallet. Leave it empty to use your active wallet.

A read-only key can list sandboxes, snapshots, environments and webhooks. Creating, stopping, prompting and editing need a key whose actions allow them. Only a full-access key sees the account's API keys: boat answers a scoped key with an empty list. Revoking a key needs a full-access key too, or the key itself.

<insert [The Add account form for boat with the API Key field and the Organization picker open] here>

## Cost

Infrawrench reads each sandbox's machine time per day from boat's usage meter and prices it at list, so costs break down by sandbox and by label. These are estimates:

- Machine time inside your plan's included hours is already paid for by the plan, but still shows at list price.
- The plan fee, extra saved snapshots, extra starts and the AI proxy aren't included, since boat's API doesn't report them.
- A sandbox deleted before Infrawrench's daily collection reached its last day loses that day's tail.

Each sandbox also shows its cost this calendar month. Your **wallet** balance appears as credits.

## Plan limits

The quotas page shows how many sandboxes are running against your plan's limit, starts used in the current minute and hour, included machine time used this period, and saved snapshots against the included count. Only the running-sandbox limit refuses outright. Past the others, boat bills your wallet.

## Savings and governance

- **Posture checks**: a running sandbox with auto-stop turned off, which bills until someone stops it, and a full-access API key that never expires.
- **Expiry radar**: API keys with an expiry date.
- **Provider status**: failing probes and announcements on [status.boat.dev](https://status.boat.dev) are matched to your sandboxes.

## Run CI jobs

A boat connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets a fresh sandbox, deleted when the job ends:

| `cloud.kind` | Runs on        | Default `machine` | Default `image`     |
| ------------ | -------------- | ----------------- | ------------------- |
| `vm`         | A boat sandbox | `default`         | boat's Ubuntu image |

`machine` is a sandbox size: `small`, `default`, `large` or `xlarge` (`xlarge` needs the $100 plan). `image` names a saved snapshot (or a share code) to start from, for a sandbox with your tools already on it. The job runs as root once the sandbox is ready. boat has no regions and no GPUs, so `cloud.region` means nothing here and `cloud.gpu` is refused.

The sandbox is made with nothing of your account in it: no environment variables, secret files, git or AI logins, and no in-sandbox boat API key (boat's "no env"). It is private, so members of an organization can't open it, it keeps no command output at boat, and it takes no snapshots, so stopping it erases its disk. Its auto-stop is set to the job's time limit, which ends the billing even if Infrawrench loses track of it; Infrawrench deletes it when the job ends, and again later if that fails. boat bills a sandbox by the second while it runs, and every job's sandbox counts as one start against your plan's start limits.

Use an API key with the `ci` preset: it can create sandboxes and read and delete the ones it made. Opting in checks that the key can list and delete sandboxes; boat has no call that says whether a key may create one, so that shows at the first job. A `ci` key made before boat added `sandbox.delete-own` to the preset can't delete; make a new one.

## Things to know

- Sandboxes and saved snapshots are private to whoever created them, so an account lists its key owner's sandboxes plus the organization sandboxes they can see.
- boat runs in Europe only (Germany, Finland and France), so sandboxes have no region.
- A sandbox's size only changes when it resumes or forks. Stop it and resume it on the new size.
- boat shows a webhook's signing secret once. Infrawrench keeps it for webhooks created or rotated here.
- boat doesn't publish a Terraform provider, so there's no Terraform export.
