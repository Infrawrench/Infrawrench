---
title: VS Code extension
description: See the live resource, drift, owning service, cost, open findings and running vulnerabilities behind every Terraform block, estimate the cost of uncommitted changes, and search your organization without leaving the editor.
sidebar_order: 40
---

The Infrawrench extension for VS Code (and editors built on it) shows what Infrawrench knows about
your infrastructure right inside the Terraform you're editing. It shows the same data you'd see in
the web app.

## Hover a resource block

Hover the first line of any `resource` block in a `.tf` file to see the live resource or resources
it manages:

- whether Terraform still **manages** it or it has **drifted** from state, and which fields differ
- the **service** that owns it, with its tier
- what it **cost over the last 30 days**, from your billing data
- the provider's **list-price estimate** per month, where available
- open **posture findings** on it, worst first
- the **[vulnerabilities](./vulnerabilities.md)** running on it, as counts per severity with how
  many are known exploited ("2 critical, 1 high (1 known exploited)"). Click them to open the
  Vulnerabilities tab. If no connected account runs a scanner, this line is left out rather than
  showing "none".

Each resource has **Open in Infrawrench**, **Copy ID** and **Copy provider ID** links. A block
used by several modules, or with `count` or `for_each`, lists every instance it manages.

<insert [A VS Code editor showing a resource "aws_instance" "web" block with the Infrawrench hover open: Drifted (2 fields), Service: Checkout (Tier 1), Cost (last 30 days): $142.18, Estimate: $138.70/month, Posture: 1 open finding, Vulnerabilities: 2 critical, 1 high (1 known exploited)] here>

The hover works from the Terraform state you uploaded on the IaC page (see
[IaC reconciliation](./iac-reconciliation.md)). If you haven't uploaded any state, the hover says
so and links to the IaC page. If a block isn't in any uploaded state (it isn't applied yet, or its
state lives elsewhere), it tells you that instead.

## CodeLens

Above each block, a CodeLens names the live resource (click to open it) and sums up its drift,
owning service, 30-day cost, findings and any critical or high vulnerabilities running on it. To
turn lenses off, set `infrawrench.codeLens.enabled` to `false`.

## Estimate the cost of your changes

Run **Infrawrench: Estimate Cost of Working Tree Changes** (also on the editor title bar of a
`.tf` file). It checks every changed Terraform, [Infrafile](./infrafile.md) and Kubernetes file in
the repository against `HEAD`, including unsaved edits, the same way a
[pull request check](./pr-checks.md) does. You get the monthly cost change per block, the blast
radius of every existing resource the change touches, and warnings for tag policy and posture
rules. The report opens as a Markdown preview.

If the repository's `origin` is a GitHub repository with pull request checks turned on, that
repository's directory filters and threshold apply, so the estimate matches the check your pull
request will get. Set `infrawrench.costEstimate.repository` to use a different repository's
settings.

<insert [The Markdown preview of a working-tree estimate: title "+$214.00/month, 3 resources touched", a table of changed blocks with before/after monthly cost, and the blast radius line] here>

## Search

**Infrawrench: Search Resources, Services and Saved Objects** searches every connected account's
resources, your workflows and your services from the command palette. It also finds the saved
objects the app's own [command palette](./spotlight-search.md) finds: cost reports, dashboards,
budgets, canvases, SLOs, runbooks, status pages, probes and more. Pick a resource to open it or
copy its id or name. Pick a saved object to open it in the web or desktop app.

## Services view

Click the Infrawrench icon in the activity bar to open the **Services** view. It lists every
[service](./services.md), sorted by tier. Expand one to see who's on call, its 30-day cost, open
posture findings, scorecard levels and its resources. Click a resource to open it.

## Sign in

Run **Infrawrench: Sign In** and choose:

- **Browser**: signs in with your Infrawrench account in your browser and lists every organization
  you belong to. Use **Infrawrench: Switch Organization** (or the status bar item) to change
  organization later.
- **API key**: paste an API key from **Settings > API keys**, then paste any Infrawrench address
  from inside the key's organization (the API keys page works) or the organization's id. A key
  belongs to one organization. To use another, sign in again with that organization's key.

Your credentials are stored in VS Code's secret storage. Browser sign-in shares a step with
`infrawrench login` in the [CLI](./cli.md), so finish one before starting the other.

### Permissions

- The hover needs `iac:read` (to read the state), `resources:read` (which also covers the
  vulnerabilities line), and `costs:read` for the cost line. Any section your key or role can't
  read is left out instead of showing an error.
- The working-tree estimate needs `iac:read`.

## Open in the desktop app

Set `infrawrench.openIn` to `desktop` to open resources, services and the Vulnerabilities tab in
the [desktop app](../core-concepts/desktop-vs-web.md) instead of the browser. The desktop app must
be signed in to the cloud and showing the same organization. A link for another organization asks
you to switch first.

## Settings

| Setting                               | Default                       | What it does                                             |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `infrawrench.cloudUrl`                | `https://app.infrawrench.com` | Your Infrawrench address.                                |
| `infrawrench.openIn`                  | `web`                         | Open resources in the web app or the desktop app.        |
| `infrawrench.codeLens.enabled`        | `true`                        | Show lenses above resource blocks.                       |
| `infrawrench.costEstimate.repository` | from `origin`                 | `owner/name` whose pull request check settings to apply. |
