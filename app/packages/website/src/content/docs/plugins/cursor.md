---
title: Cursor
description: Administer a Cursor team, covering members and seats with idle-seat detection, per-user spend limits, billing and member groups, repository blocklists, usage by model and member, and daily cost from usage-based spend plus seat estimates.
sidebar_order: 50
---

The Cursor plugin is for admins of a Cursor **Teams** or **Enterprise** plan. It reads Cursor's Admin API, plus the Analytics and AI Code Tracking APIs when your plan includes them, and turns them into seats, spend and usage you can act on.

## Credentials

Cursor needs one key, plus optional seat prices.

**Admin API Key** (required). A team admin creates it in the [Cursor dashboard](https://cursor.com/dashboard) under **Settings → API Keys**. Keys start with `crsr_`.

- A **read-only** key lists everything and collects costs.
- Editing spend limits, groups and blocklists, and removing members, needs a key with the **admin** scope.
- The Analytics and AI Code Tracking series need an admin-scoped key on an **Enterprise** plan. Without one those charts are simply left out.

**Seat prices** (optional). Cursor's API does not report which plan you are on or what a seat costs, so seat costs are estimated from these fields:

- **Standard seat price**: defaults to the published Teams price of $40 per user per month. Set your annual or negotiated rate here.
- **Premium seat price**: defaults to $120.
- **Premium seat members**: the emails of members on premium seats. Everyone else with a paid seat is priced as standard. Unpaid admins are never charged.

Change any of these later from the account page with **Update credentials**. The next cost collection uses the new prices.

<insert [Cursor add-account form showing the Admin API Key field and the three optional seat price fields] here>

## What you can manage

- **Team**: members, paid seats, unpaid admins, idle seats, the current billing cycle, usage-based spend this cycle and the estimated monthly seat cost. Its **Logs** tab shows the team audit log (logins, member changes, settings changes) for the last 30 days.
- **Team members**: role, seat, last activity, active days, requests and accepted lines over 30 days, most used model, client version, spend this cycle, premium requests and spend limits. **Edit** sets or clears a member's spend limit in whole dollars. **Delete** removes them from the team; Cursor keeps the seat billed until the end of the cycle.
- **Models**: every model your team used in the last 30 days, with requests (included vs usage-based), Max Mode requests, input, output and cache tokens, token cost, usage-based spend and how many members used it.
- **Billing groups**: groups that split spend by department or cost centre, with spend this cycle, daily spend and a member table. Create one with a member picker, rename it, change members, or delete it.
- **Member groups**: Cursor's directory groups, which carry a monthly spending limit per member. Create, rename, set or clear the limit, change members, or delete.
- **Repository blocklists**: glob patterns of files Cursor will never index or send to a model, per repository. Create, edit the patterns, or delete.

To change a group's members, edit the **Member emails** field: the group ends up with exactly the members you list. Every address has to belong to a team member, and the edit is refused with the unknown addresses named if one does not. You can also remove a single member with the **Remove** button in the group's member table.

<insert [Cursor team member detail page showing an idle seat, the spend section with member, team and effective limits, and the Edit button] here>

## Idle seats

A member on a paid seat with no editor, agent or Bugbot activity in the last 30 days is an **idle seat**. Idle seats are flagged on the team page and appear in **Potential savings** under Costs, with the seat's cost over the last 30 days next to each one. Unpaid admins and removed members are never flagged.

## Costs

Cost data lands on the Costs page every day, broken down by **service** (the model, or Standard seat / Premium seat), **resource** (the team member) and tags (`user`, `model`, `maxMode`, `seat`, `charge`).

- **Usage-based spend** is read event by event from Cursor's usage events, and only events Cursor billed on top of the plan count. Requests drawn from the plan's included pool cost nothing extra and are left out. The amount is what Cursor charged, including its token fee.
- **Seats** are estimated: one row per paid seat per day, at the seat price set on the account spread evenly over the year. Seat rows are only written for days in the current billing cycle, because the member list is a snapshot of today and would otherwise put today's seats on months before those people joined. History builds up one cycle at a time.

Because seat costs are derived, the account is labelled as an **estimate** wherever its costs appear. Collection reaches back 90 days for usage-based spend.

<insert [Costs page filtered to a Cursor account, grouped by service, showing spend per model alongside Standard seat rows] here>

## Metrics

- **Team**: active users, agent, chat, composer and Cmd+K requests, Bugbot runs, included, usage-based and own-API-key requests, lines suggested and accepted, Tab suggestions accepted and the Tab acceptance rate, all from Cursor's daily usage data. On Enterprise plans the tab adds active users of the CLI, cloud agents and Bugbot, agent diffs and lines accepted, Tab lines accepted, and lines committed with and without AI from AI Code Tracking.
- **Team members**: their own requests, usage-based requests and spend, tokens, and the same feature breakdown as the team.
- **Models**: requests, usage-based requests and spend and tokens for that model. On Enterprise plans, messages across every surface and the number of members using it.
- **Billing groups**: daily spend this cycle.

## What Cursor's API does not offer

These are not in Cursor's public API, so the plugin does not show them:

- Your plan, the seat tier of each member, seat prices and invoices. Seat costs are estimated from the prices you enter.
- When a member joined or was removed, so a member added this week is flagged idle until they use Cursor.
- Inviting members, changing a member's role, and changing the team-wide default spend limit. Do these in the Cursor dashboard; the team default limit is shown read-only on each member.
- Model access controls are a preview API and are not managed here yet.

## Tips and limits

- Cursor rate-limits most Admin API endpoints to 20 requests a minute per team. The plugin caches its reads for a minute and retries when Cursor asks it to slow down.
- Daily usage, analytics and audit log requests cover at most 30 days each; longer chart ranges are split into 30-day requests.
- The model list reads the most recent 20,000 usage events. Very large teams see totals for that sample, and the model page says so; the Costs page always reads every event.
