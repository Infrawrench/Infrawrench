---
title: SaaS seats
description: Find paid seats on GitHub Copilot, Cursor, GitLab, Okta, Claude Enterprise, Docker Hub and Tailscale that nobody uses, that duplicate another tool, or that sit on a pricier tier, and remove them.
sidebar_order: 15
---

Per-person licences are billed every month whether anyone uses them or not. A Copilot seat for someone who moved to Cursor, a GitLab member who left in the spring, an Okta user nobody deactivated: each one is small, but together they're often one of the bigger lines a team can cut without touching infrastructure.

Each finding also appears in the [savings findings](./savings-findings.md) list at the top of the Savings tab, where it gets a status (Ready for review, In progress, Completed, Archived), a detected date, and a place in saved views.

Infrawrench checks the paid seats on your connected accounts once a day and lists:

- **Inactive** seats: nobody used the seat for the number of days you choose (30 by default).
- **Duplicate** seats: the same person (matched by email) pays for two tools that do the same job, such as GitHub Copilot and Cursor. The seat they used most recently is kept, and the other is flagged.
- **Downgrade** suggestions: a seat on a pricier tier than the person's usage needs, when the provider reports enough to tell.

Each finding shows its monthly saving, the commands to fix it from a terminal and, where the provider allows it, a **Remove seat** button.

## Find unused seats

Open **Costs** in the sidebar, go to the **Savings** tab, and find **Seats**. A line at the top totals what the findings would save and what all your seats cost. Each row shows who holds the seat, the product and tier, the account, why it was flagged, when the seat was last used and how that was worked out, and the monthly saving. **Show all seats** lists every seat Infrawrench found, flagged or not.

<insert [Costs page Savings tab showing the Seats section: the "To save $327/mo · Seats cost $2,140/mo" line, an inactive Copilot Business row "No use in 30+ days" with $19/mo list price and Remediate / Remove seat buttons, a duplicate Cursor row "Also has GitHub Copilot on acme-org, used more recently", and the "Flag seats unused for 30 days" control] here>

You can also see the list:

- in the mobile app's Costs tab (under **Savings**, read-only, with the commands to copy)
- with `infrawrench seats` in the [CLI](./cli.md)
- through the `list_seat_findings` [MCP tool](./mcp.md)

Seats need Infrawrench Cloud, so on desktop the section appears when you're signed in to an organization.

## Supported providers

| Provider                               | What counts as a seat                                                     | How activity is determined                                                             | Price                                                          | Remove seat does                                                          |
| -------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [GitHub](../plugins/github.md)         | Copilot Business and Enterprise seats                                     | Copilot's last activity (last authentication when IDE telemetry is off)                | This month's billed seat price, else list price ($19 / $39)    | Cancels the seat; GitHub bills it to the end of the cycle                 |
| [Cursor](../plugins/cursor.md)         | Paid team members (unpaid admins are left out)                            | Daily usage, read as far back as your threshold (up to 90 days)                        | The price set on the account, else list price                  | Removes the member (Enterprise plans only)                                |
| [GitLab](../plugins/gitlab.md)         | Billable members of a GitLab.com top-level group on a paid plan           | GitLab's last activity date                                                            | Premium list price ($29); Ultimate has no published price      | Removes the member from the group, its subgroups and projects             |
| [Okta](../plugins/okta.md)             | Users in a licence-consuming status (not staged or deprovisioned)         | Last sign-in                                                                           | The contract price set on the account, else Starter list price | Deactivates the user, which removes their app assignments                 |
| [Anthropic](../plugins/anthropic.md)   | Claude Enterprise members (Console organizations have no per-seat charge) | Claude Enterprise Analytics last activity, when an Analytics key is set on the account | Enterprise list price ($20, usage billed separately)           | Removes the member; lower the seat count to stop paying for the seat      |
| [Docker Hub](../plugins/docker-hub.md) | Organization members (pending invites are left out)                       | Last sign-in or last seen, which Docker reports only with Business Insights            | The price set on the account, else Team list price             | Removes the member; lower the seat count in Billing to stop paying for it |
| [Tailscale](../plugins/tailscale.md)   | Active and idle tailnet members (shared and suspended users are left out) | Last seen on the tailnet                                                               | The price set on the account, else Standard list price         | Suspends the user, which frees the seat                                   |

Every price shows where it came from:

- **billed** or **provider price** when the provider reports it
- **your price** when you set one on the account (the credential settings have a seat price field for providers that don't report one)
- **list price** for the published price

Negotiated and annual prices differ from list price, so set your own price on the account if that matters to you. A seat with no reliable price shows as **not priced** and is left out of the totals, never counted as free.

Not included, and why: GitHub organization member seats (GitHub doesn't report when a member was last active), OpenAI (API organization members aren't billed per seat, and ChatGPT workspace seats have no API we could verify), Grafana Cloud (it only bills users who were active that month), Sentry and Netlify (not billed per seat), and Vercel, PagerDuty, incident.io and Bitbucket (no activity data over their APIs).

## How "inactive" is decided

A seat is only flagged when the provider's data covers your whole threshold and shows no use:

- A seat used within the threshold is **active**.
- A seat assigned more recently than the threshold and not used yet is **new**, never inactive.
- A seat whose provider reports no activity at all, or only a shorter window than your threshold (Cursor's usage history, for example), is **activity unknown**, never inactive. These are counted separately so "we found nothing" and "we couldn't check" never look the same.
- A seat already being removed at the provider shows as **being removed** and isn't counted.

Change the threshold with **Flag seats unused for N days** at the bottom of the section (7 to 365 days, needs `costs:write`), or with the [Terraform provider](./terraform-provider.md)'s `infrawrench_seat_settings` resource. For providers with daily usage, the threshold also sets how far back the next check looks.

## Remove a seat

**Remove seat** appears on inactive and duplicate findings when the provider allows removal through its API. It asks you to confirm, needs `resources:write`, is blocked during a [change freeze](../team-and-billing/change-freeze.md), and is recorded in the [audit log](../team-and-billing/audit-log.md). The row tells you what the provider does next, for example that GitHub keeps billing the seat until the end of the cycle.

Prefer the terminal? **Remediate** shows the same action as ready-to-run commands (`gh api`, `glab api`, or `curl` against the provider's admin API), with the token as a shell variable to export first.

## Realized savings and the digest

A removed seat counts toward [realized savings](./realized-savings.md) under **SaaS seats**, whether you removed it with the button, from the CLI, or in the provider's own console. The saving is recorded once, estimated from the seat's price.

When there are seats worth reviewing, the [weekly digest](./weekly-digest.md) includes a **Seats** line with how many there are and what they'd save each month.

## Permissions

- Viewing seats needs `costs:read`, the same as the rest of the Costs page.
- Removing a seat needs `resources:write`.
- People limited to part of the organization's costs only see the accounts their scope fully grants.
