---
title: GitHub
description: Track GitHub spend on Actions, Copilot, Codespaces, Packages, Git LFS and Advanced Security by product, SKU, repository and cost centre, and manage Copilot seats, runners, Actions caches, codespaces, budgets and cost centres.
sidebar_order: 51
---

The GitHub plugin is about what GitHub bills you for. It reads the enhanced billing platform's usage report, so the numbers are the ones on your invoice, discounts included, and it lists the things that drive that bill so you can act on them: idle Copilot seats, forgotten codespaces, oversized caches, larger runners.

It is separate from the [GitHub App](../features/workflows.md) that triggers workflows from pushes. See [Why a token and not the GitHub App](#why-a-token-and-not-the-github-app) below.

## What you can manage

An account is scoped to one **organization** or one **enterprise**, and opens straight onto its billing summary.

- **Billing account**: the organization or enterprise itself. Shows this month's gross, discount and net spend, a table of every product and SKU billed so far with quantities, premium requests and AI credits by model, Copilot seat counts (active, inactive, pending cancellation) and the total Actions cache size. The **Metrics** tab charts, by day:
  - Actions minutes by runner OS (Linux, Windows, macOS)
  - Copilot daily and weekly active users
  - premium requests and AI credits
  - Codespaces compute hours
  - net spend
- **Copilot seats**: every Business or Enterprise seat with when its user last used Copilot, in which editor, and what the seat costs. A seat with no activity for 30 days is marked **Idle** and appears in the [orphan finder](../features/orphan-finder.md). **Remove seat** sets it to cancel at the end of the billing cycle (the user keeps Copilot until then, and the seat is not billed after). **+ Create** assigns a seat to an organization member picked from a list of members who do not have one yet.
- **Larger runners**: GitHub-hosted larger runners with platform, machine size, image, runner group, concurrency limit and this month's spend on their SKU. Create one by picking an image, a machine size and a runner group from GitHub's own lists; change its name, maximum concurrent jobs or static IP; delete it.
- **Self-hosted runners**: registered runners with OS, labels, status and version. An offline runner is flagged in the orphan finder; deleting one removes its registration.
- **Actions caches**: one entry per repository with its cache count and size, and its largest caches listed. Delete a single cache from the list, or **Delete all caches** to clear the repository.
- **Codespaces**: every codespace in the organization with its owner, repository, machine type, state and last use. A stopped codespace still bills for storage, so one unused for 14 days is flagged in the orphan finder. **Stop** a running codespace, or delete it.
- **Budgets**: GitHub's own spending budgets. Create one by picking what it covers (a whole product, a single SKU, or all AI credits), what it applies to (the organization or enterprise, a repository picked from a list, a cost centre, one user, or every user), the amount, whether to stop usage when it is exceeded, and who to alert. Each budget shows this month's spend against it. Edit the amount, the stop-usage setting, the alerts and (for user budgets) the expiry; delete it.
- **Cost centres** (enterprise accounts): each cost centre with the users, organizations, repositories and enterprise teams in it, and this month's spend. Create, rename and delete them, and edit the member lists to move members in or out.

<insert [GitHub billing account page showing this month's net, gross and discount totals, the product and SKU table, and the premium requests by model table] here>

## Credentials

Three fields:

- **Personal access token**: see the next section for which kind.
- **GitHub host**: `github.com`, or for GitHub Enterprise Cloud with data residency the address you sign in at, such as `octocorp.ghe.com`. Requests then go to `api.octocorp.ghe.com`.
- **Organization or enterprise**: once the token is entered, pick from the organizations and enterprises it can see. If the token cannot list them, type the organization's login, or `enterprise:<slug>` for an enterprise.

<insert [GitHub add-account form with a token entered and the Organization or enterprise picker open, listing an enterprise and two organizations] here>

### Which token

**For an organization**, use a fine-grained personal access token with the organization as its resource owner, access to all repositories, and these permissions (read only is enough for everything except the actions in brackets):

| Capability             | Permission                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| Billing usage and cost | Organization: Administration (read)                                        |
| Budgets                | Organization: Administration (write to create, edit and delete)            |
| Copilot seats          | Organization: GitHub Copilot Business (write to assign and remove)         |
| Copilot usage metrics  | Organization: Organization Copilot metrics (read)                          |
| Larger runners         | Organization: Administration (write to create, edit and delete)            |
| Self-hosted runners    | Organization: Self-hosted runners (write to remove)                        |
| Actions caches         | Organization: Administration (read); Repository: Actions (write to delete) |
| Codespaces             | Organization: Organization codespaces (write to stop and delete)           |

A classic token works too, with `admin:org`, `manage_billing:copilot`, `repo` and `codespace`.

**For an enterprise**, use a classic token: fine-grained tokens cannot reach enterprise endpoints. It needs `manage_billing:enterprise` (billing, budgets, cost centres), `manage_billing:copilot` or `read:enterprise` (Copilot seats and metrics), and `manage_runners:enterprise` (larger runners).

Either way, the token's owner must be an organization owner or billing manager (an enterprise owner or billing manager for an enterprise). **Check credentials** probes one read per capability and its [least-privilege generator](../core-concepts/credential-preflight.md) prints the permissions for the capabilities you tick. A type the token cannot read lists empty rather than failing the account.

### Why a token and not the GitHub App

Infrawrench already has a GitHub App for git-triggered workflows and agents. This plugin deliberately does not reuse it:

- The App asks for repository contents and metadata. Billing, budgets, Copilot seats and codespaces need organization administration permissions, and adding those to the App would make every organization that installed it for workflows re-approve a far broader grant.
- Enterprise billing and cost centres cannot be read by a GitHub App installed on an organization at all.
- The App installation belongs to the web app's server, so the desktop app (and local mode) could not use it. A token works the same everywhere.

## Cost graphs

GitHub accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the usage report:

- **Daily, at the billed price.** Each line carries a gross amount, the discount applied to it and the net. The gross is recorded as usage and the discount as a separate credit, so totals equal the net bill to the cent while **Charge type** shows how much your plan's included minutes, storage and seats (and any negotiated discount) took off.
- **Breakdowns.** Spend is broken down by **product** (Actions, Copilot, Codespaces, Packages, Git LFS, Advanced Security, …) as the service, by **repository** as the resource (the same id as the repository's Actions cache entry, so its spend shows there), and by tags: `sku` (for example `actions_linux_4_core` or `copilot_for_business`), `organization` on an enterprise bill, and `costCenter` when the enterprise uses cost centres.
- **History.** Up to a year is backfilled on the first sync; months before your organization moved to the enhanced billing platform are skipped. The last four days are re-read on every collection.
- Amounts are in US dollars, the currency GitHub bills in.

<insert [Cost graph grouped by service for a GitHub account, showing Actions, Copilot and Codespaces stacked by day] here>

## Tips & limits

- **The enhanced billing platform is required.** The usage API only exists there. If your organization is still on the legacy billing pages, the account says so instead of graphing nothing.
- **Enterprise accounts cover the bill, organization accounts cover the things.** Self-hosted runners, Actions caches and codespaces are organization-level in GitHub's API, so add each organization you want to manage as its own account. Spend is not double counted as long as cost graphs are read from either the enterprise or its organizations, not both.
- **Seats from teams.** Removing a seat only works for seats assigned directly. A seat a user gets through a team needs the team changed in GitHub; the seat page says when that is the case.
- **Larger runner cost is per SKU.** GitHub reports spend by SKU, not by runner, so runners of the same size and platform share the figure shown.
- **Copilot metrics need the reports to exist.** GitHub publishes the Copilot usage reports once a day; a new organization has nothing to chart for a day or two.
- **Provider status** follows GitHub's status page; an Actions incident lines up with Actions spend.
