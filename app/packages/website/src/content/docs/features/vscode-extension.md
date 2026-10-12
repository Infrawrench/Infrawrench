---
title: VS Code extension
description: See the live resource, drift, owning service, cost, open findings and running vulnerabilities behind every Terraform block, estimate the cost of uncommitted changes, and search your organization without leaving the editor.
sidebar_order: 40
---

The Infrawrench extension for VS Code (and editors built on it) brings what Infrawrench knows
about your infrastructure into the Terraform you are editing. It talks to the same API as the
web app, so everything it shows is what the web app would show you.

## What it does

### Hover a resource block

Hover the header line of any `resource` block in a `.tf` file to see the live resource or
resources it manages:

- whether Terraform still **manages** it or it has **drifted** from state, and which fields differ
- the **service** that owns it, with its tier
- what it **cost over the last 30 days**, from your billing data
- the provider's **list-price estimate** per month, where the plugin can price it
- open **posture findings** on it, worst first
- the **[vulnerabilities](./vulnerabilities.md)** running on it, as counts per severity with how
  many are known exploited ("2 critical, 1 high (1 known exploited)"); click them to open the
  Vulnerabilities tab. When no connected account runs a scanner the line is left out, since
  "none" would claim a scan that never happened.

Each resource has **Open in Infrawrench**, **Copy ID** and **Copy provider ID** links. A block
used by several modules, or with `count` or `for_each`, lists every instance it manages.

<insert [A VS Code editor showing a resource "aws_instance" "web" block with the Infrawrench hover open: Drifted (2 fields), Service: Checkout (Tier 1), Cost (last 30 days): $142.18, Estimate: $138.70/month, Posture: 1 open finding, Vulnerabilities: 2 critical, 1 high (1 known exploited)] here>

Blocks are tied to live resources through [IaC reconciliation](./iac-reconciliation.md): the
Terraform state you uploaded on the IaC page records each block's address, and Infrawrench has
already matched those entries to your synced resources. If no state is uploaded, the hover says
so and links to the IaC page; if a block is not in any uploaded state (not applied yet, or its
state lives elsewhere), it says that instead.

### CodeLens

Above each block, a CodeLens names the live resource (click to open it) and summarises its
drift, owning service, 30-day cost, findings and any critical or high vulnerabilities running on
it. Turn lenses off with
`infrawrench.codeLens.enabled`.

### Estimate the cost of your changes

Run **Infrawrench: Estimate Cost of Working Tree Changes** (also on the editor title bar of a
`.tf` file). It takes every changed Terraform, [Infrafile](./infrafile.md) and Kubernetes file
in the repository against `HEAD`, including edits you have not saved, and runs them through the
same analysis as a [pull request check](./pr-checks.md): the monthly cost delta per block, the
blast radius of every existing resource the change touches, and warnings for tag policy and
posture rules. The report opens as a Markdown preview.

When the repository's `origin` is a GitHub repository with pull request checks enabled, that
repository's directory filters and threshold apply, so the estimate matches the check the pull
request will get. Set `infrawrench.costEstimate.repository` to override which repository is
used.

<insert [The Markdown preview of a working-tree estimate: title "+$214.00/month, 3 resources touched", a table of changed blocks with before/after monthly cost, and the blast radius line] here>

### Search

**Infrawrench: Search Resources and Services** searches every connected account's resources,
your workflows and your services from the command palette. Pick a resource to open it, or copy
its id or name.

### Services view

The Infrawrench icon in the activity bar opens a **Services** view: every
[service](./services.md), sorted by tier, each expanding into who is on call, its 30-day cost,
open posture findings, scorecard levels and its member resources. Click a resource to open it.

## Signing in

Run **Infrawrench: Sign In** and choose:

- **Browser**: signs in with your Infrawrench account in your browser and lists every
  organization you belong to. **Infrawrench: Switch Organization** (or the status bar item)
  changes organization later.
- **API key**: paste an API key from **Settings > API keys**, then paste any Infrawrench address
  from inside the organization the key belongs to (the API keys page works) or its id. A key
  belongs to one organization; to use another, sign in again with that organization's key.

Credentials are kept in VS Code's secret storage. The browser sign-in uses the same local
callback as `infrawrench login` in the [CLI](./cli.md), so finish one before starting the other.

The hover needs `iac:read` (to read the state), `resources:read` (which also covers the
vulnerabilities line), and `costs:read` for the cost line; a section the key or your role cannot read is left out rather than shown as an
error. The working-tree estimate needs `iac:read`.

## Opening in the desktop app

Set `infrawrench.openIn` to `desktop` to open resources, services and the Vulnerabilities tab in the
[desktop app](../core-concepts/desktop-vs-web.md) instead of the browser. The desktop app must
be signed in to the cloud and showing the same organization; a link for another organization
asks you to switch first.

## Settings

| Setting                               | Default                       | What it does                                             |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `infrawrench.cloudUrl`                | `https://app.infrawrench.com` | Your Infrawrench address.                                |
| `infrawrench.openIn`                  | `web`                         | Open resources in the web app or the desktop app.        |
| `infrawrench.codeLens.enabled`        | `true`                        | Show lenses above resource blocks.                       |
| `infrawrench.costEstimate.repository` | from `origin`                 | `owner/name` whose pull request check settings to apply. |
