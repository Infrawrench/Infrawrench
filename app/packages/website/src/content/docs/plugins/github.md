---
title: GitHub
description: Track GitHub spend on Actions, Copilot, Codespaces, Packages, Git LFS and Advanced Security by product, SKU, repository and cost centre, and manage Copilot seats, runners, Actions caches, codespaces, budgets and cost centres.
sidebar_order: 51
---

Connecting GitHub shows you what GitHub bills you for, with the same numbers as your invoice (discounts included), and lets you act on what drives that bill: idle Copilot seats, forgotten codespaces, oversized caches and larger runners.

This is separate from the [GitHub App](../features/workflows.md) that triggers workflows from pushes.

## What you can manage

Each account covers one **organization** or one **enterprise**, and opens on its billing summary.

- **Billing account**: the organization or enterprise itself. You see this month's gross, discount and net spend, every product and SKU billed so far with quantities, premium requests and AI credits by model, Copilot seat counts (active, inactive, pending cancellation) and the total Actions cache size. The **Metrics** tab charts, by day:
  - Actions minutes by runner OS (Linux, Windows, macOS)
  - Copilot daily and weekly active users
  - premium requests and AI credits
  - Codespaces compute hours
  - net spend
- **Copilot seats**: every Business or Enterprise seat, with when its user last used Copilot, in which editor, and what the seat costs. Idle seats show up under **Seats** (below), measured against your organization's own inactivity threshold. **Remove seat** sets it to cancel at the end of the billing cycle: the user keeps Copilot until then, and the seat isn't billed after. **+ Create** assigns a seat to a member you pick from those who don't have one yet.
- **Larger runners**: GitHub-hosted larger runners with platform, machine size, image, runner group, concurrency limit and this month's spend on their SKU. To create one, pick an image, a machine size and a runner group from GitHub's own lists. You can change its name, maximum concurrent jobs or static IP, or delete it.
- **Self-hosted runners**: registered runners with OS, labels, status and version. Offline runners are flagged in the orphan finder. Deleting one removes its registration.
- **Actions caches**: one entry per repository with its cache count, size and largest caches. Delete a single cache, or use **Delete all caches** to clear the repository.
- **Codespaces**: every codespace in the organization with its owner, repository, machine type, state and last use. A stopped codespace still bills for storage, so one unused for 14 days is flagged in the orphan finder. **Stop** a running codespace, or delete it.
- **Budgets**: GitHub's own spending budgets. To create one, choose:
  1. What it covers: a whole product, a single SKU, or all AI credits.
  2. What it applies to: the organization or enterprise, a repository, a cost centre, one user, or every user.
  3. The amount, whether to stop usage when it's exceeded, and who to alert.

  Each budget shows this month's spend against it. You can edit the amount, the stop-usage setting, the alerts and (for user budgets) the expiry, or delete it.

- **Cost centres** (enterprise accounts): each cost centre with its users, organizations, repositories and enterprise teams, and this month's spend. Create, rename and delete them, and edit the member lists to move members in or out.

<insert [GitHub billing account page showing this month's net, gross and discount totals, the product and SKU table, and the premium requests by model table] here>

## Connect with GitHub

On github.com, **Connect with GitHub** on the add-account form signs you in to GitHub so you don't have to paste a token. It uses a dedicated Infrawrench GitHub App for billing (not the workflow App) and asks for:

- Organization: Administration (read and write), GitHub Copilot Business (read and write), Organization Copilot metrics (read), Self-hosted runners (read and write), Organization codespaces (read and write)
- Repository: Actions (read and write), for Actions caches
- Enterprise: Enterprise billing (read and write), for enterprise accounts

You still need to be an organization owner or billing manager, and the App must be installed on the organization or enterprise whose bill you want to read. After you approve, the host is set to `github.com` and the **Organization or enterprise** picker lists the installations you can see (it's filled in for you when there's only one). Write permissions are only used when you act, for example deleting a cache, removing a seat or editing a budget.

On an enterprise, the connection covers billing, budgets and cost centres. GitHub doesn't allow app connections to read enterprise Copilot seats or larger runners, so those lists stay empty. Use a classic token if you need them.

The connection renews itself. If it's revoked, or unused for six months, the account is marked **Reconnect required**, and **Reconnect** in its credentials signs you in again.

Connect with GitHub is available in the web app and in the desktop app's cloud mode. Accounts stored locally on the desktop, GHE.com data residency hosts and GitHub Enterprise Server use a token instead, as described below.

<insert [GitHub add-account form showing the Connect with GitHub button above the manual credential fields] here>

## Connect with a token

To paste a token instead, fill in three fields:

- **Personal access token**: see below for which kind.
- **GitHub host**: `github.com`, or for GitHub Enterprise Cloud with data residency, the address you sign in at, such as `octocorp.ghe.com`. Requests then go to `api.octocorp.ghe.com`.
- **Organization or enterprise**: once the token is entered, pick from the organizations and enterprises it can see. If the token can't list them, type the organization's login, or `enterprise:<slug>` for an enterprise.

A token works the same on web, desktop and local mode.

<insert [GitHub add-account form with a token entered and the Organization or enterprise picker open, listing an enterprise and two organizations] here>

### Which token to use

**For an organization**, use a fine-grained personal access token with the organization as its resource owner, access to all repositories, and these permissions. Read only is enough for everything except the actions in brackets:

| Capability             | Permission                                                                  |
| ---------------------- | --------------------------------------------------------------------------- |
| Billing usage and cost | Organization: Administration (read)                                         |
| Budgets                | Organization: Administration (write to create, edit and delete)             |
| Copilot seats          | Organization: GitHub Copilot Business (write to assign and remove)          |
| Copilot usage metrics  | Organization: Organization Copilot metrics (read)                           |
| Larger runners         | Organization: Administration (write to create, edit and delete)             |
| Self-hosted runners    | Organization: Self-hosted runners (write to remove)                         |
| Actions caches         | Organization: Administration (read); Repository: Actions (write to delete)  |
| Codespaces             | Organization: Organization codespaces (write to stop and delete)            |
| Secret scanning alerts | Repository: Secret scanning alerts (write to close alerts after a rotation) |
| Dependabot alerts      | Repository: Dependabot alerts (read)                                        |

A classic token works too, with `admin:org`, `manage_billing:copilot`, `repo` and `codespace` (plus `security_events` for Dependabot alerts).

**For an enterprise**, use a classic token, because fine-grained tokens can't reach enterprise data. It needs `manage_billing:enterprise` (billing, budgets, cost centres), `manage_billing:copilot` or `read:enterprise` (Copilot seats and metrics), and `manage_runners:enterprise` (larger runners).

Either way, the token's owner must be an organization owner or billing manager (an enterprise owner or billing manager for an enterprise). **Check credentials** tests each capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) prints the permissions for the capabilities you tick. If the token can't read something, that list shows empty and the rest of the account still works.

## Find unused Copilot seats

GitHub accounts report their **Copilot** seats to Seats, which flags seats nobody uses and people paying for both Copilot and another AI coding tool, and adds up what removing them would save.

- **What you see.** Every Copilot Business and Enterprise seat on the organization (or across the enterprise), with the user's login, name and email where GitHub shows it. If an enterprise grants a user Copilot through several organizations or teams, GitHub bills them once, so they count as one seat.
- **Activity.** GitHub's **last activity** date for Copilot, with the editor it came from. GitHub only records editor activity when the user has IDE telemetry turned on, so if there's no activity date, the last time they **authenticated** with Copilot is used instead. A seat with neither date counts as never used once it has been held longer than your threshold.
- **Price.** This month's unit price for the plan's SKU from your bill when there is one. Otherwise GitHub's published price, labelled as an estimate: $19 per user per month for Copilot Business and $39 for Copilot Enterprise (GitHub Docs, October 2026). A seat whose plan GitHub reports as unknown has no price.
- **Remove.** Sets the seat to pending cancellation. The user keeps Copilot, and the seat stays billed, until the end of the billing cycle. Seats granted through a team can't be cancelled on their own (change the team instead), and on an enterprise account, seats granted by a child organization have to be cancelled in that organization. Both show as not removable, with the reason.
- **Permissions.** The same as Copilot seats above: Organization **GitHub Copilot Business** (read to list, write to remove) on a fine-grained token, or `manage_billing:copilot` on a classic one.
- **GitHub organization seats aren't reported.** GitHub doesn't share when an organization member was last active, so an idle member could only be guessed at.
- Copilot is never suggested as a downgrade from Enterprise to Business, because nothing GitHub reports shows which users could do without the Enterprise features.

## Cost graphs

GitHub accounts feed [cost graphs & budgets](../features/cloud-costs.md):

- **Daily, at the billed price.** Totals match your net bill to the cent, and **Charge type** shows how much your plan's included minutes, storage and seats (and any negotiated discount) took off.
- **Breakdowns.** Spend is split by **product** (Actions, Copilot, Codespaces, Packages, Git LFS, Advanced Security and so on) as the service, by **repository** as the resource (it also shows on that repository's Actions cache entry), and by tags: `sku` (for example `actions_linux_4_core` or `copilot_for_business`), `organization` on an enterprise bill, and `costCenter` when the enterprise uses cost centres.
- **History.** Up to a year is loaded when you first connect. Months before your organization moved to the enhanced billing platform are skipped.
- Amounts are in US dollars, the currency GitHub bills in.

<insert [Cost graph grouped by service for a GitHub account, showing Actions, Copilot and Codespaces stacked by day] here>

## Leaked secrets

An organization account also reads the organization's [secret scanning](https://docs.github.com/en/code-security/secret-scanning) alerts every 30 minutes and shows them in [Leaked credentials](../features/leaked-credentials.md) on the Posture tab. Each leaked token is matched to the account or stored secret it belongs to, so the row can offer **Rotate** or a link to the issuing provider's key page.

- **Permissions.** A fine-grained token needs the repository permission **Secret scanning alerts**: read to list alerts, read and write to close them as revoked after a rotation (or with your dismissal reason). A classic token needs `repo` or `security_events`. The token's owner must be an organization owner or a security manager, and closing an alert also needs admin on its repository.
- **Exact matches.** A match means your stored value is byte for byte the leaked one. The leaked secret itself is never stored.
- **Enterprise accounts** scan nothing, because GitHub has no organization-wide alert list for enterprises. Connect each organization as its own account.
- GitHub's own tokens are covered too: a leaked personal access token is attributed to the GitHub account that signs in with it.

## Dependabot alerts

GitHub accounts report **open Dependabot alerts**: known advisories in the dependencies of every repository the owner has. Each finding shows the advisory (the CVE when GitHub has one, otherwise the GHSA id, with the other as an alias), GitHub's severity, CVSS score and vector, the package and its ecosystem, the first patched version, and a link to the alert. Dismissed, fixed and auto-dismissed alerts, and withdrawn advisories, are left out.

On top of the billing permissions, you need:

- The token's user must be an **organization owner or security manager**. For an enterprise, alerts come only from the organizations where the user is one of those.
- A fine-grained token needs the repository permission **Dependabot alerts (read)** on all repositories. A classic token needs `security_events` (for an enterprise, `security_events` or `repo`).
- Dependabot alerts turned on for the repositories (organization **Settings > Advanced Security**). Repositories without them have no alerts.

If the token is refused, the account shows a permission gap with the steps above, not zero vulnerabilities.

Findings belong to a **repository** (`owner/name`), not a running workload, so they appear in the vulnerability inventory without links to pods or functions. GitHub only reports the vulnerable range, not the installed version, so that column stays empty. Up to 100,000 open alerts are read per account, and past that the read fails and the alerts from the last read stay.

## Tips and limits

- **You need GitHub's enhanced billing platform.** If your organization is still on the legacy billing pages, the account tells you so instead of showing empty graphs.
- **Enterprise accounts cover the bill, organization accounts cover the things.** Self-hosted runners, Actions caches and codespaces belong to organizations in GitHub, so add each organization you want to manage as its own account. Spend isn't double counted as long as you read cost graphs from either the enterprise or its organizations, not both.
- **Seats from teams.** Removing a seat (here or from Seats) only works for seats assigned directly. A seat a user gets through a team needs the team changed in GitHub. The seat page tells you when that's the case.
- **Larger runner cost is per SKU.** GitHub reports spend by SKU, not by runner, so runners of the same size and platform share the figure shown.
- **Copilot metrics take a day or two.** GitHub publishes Copilot usage reports once a day, so a new organization has nothing to chart at first.
- **Provider status** follows GitHub's status page, so an Actions incident lines up with Actions spend.
