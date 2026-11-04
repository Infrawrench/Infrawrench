---
title: Cursor
description: Administer a Cursor team, covering members and seats with idle-seat detection and seat findings, per-user spend limits, billing and member groups, repository blocklists, usage by model and member, and daily cost from usage-based spend plus seat estimates.
sidebar_order: 50
---

The Cursor plugin is for admins of a Cursor **Teams** or **Enterprise** plan. Use it to see seats, spend and usage across your team, and to manage spend limits, groups and blocklists.

## Credentials

You need one key, plus optional seat prices.

**Admin API Key** (required). A team admin creates it in the [Cursor dashboard](https://cursor.com/dashboard) under **Settings > API Keys**. Keys start with `crsr_`.

- A **read-only** key lists everything and collects costs.
- Editing spend limits, groups and blocklists, and removing members, needs a key with the **admin** scope.
- Analytics and AI Code Tracking charts need an admin-scoped key on an **Enterprise** plan. Without one, those charts are left out.

**Seat prices** (optional). Cursor doesn't report your plan or what a seat costs, so seat costs are estimated from these fields:

- **Standard seat price**: defaults to the published Teams price of $40 per user per month. Set your annual or negotiated rate here.
- **Premium seat price**: defaults to $120.
- **Premium seat members**: the emails of members on premium seats. Everyone else with a paid seat is priced as standard. Unpaid admins are never charged.

You can change these later from the account page with **Update credentials**. The next cost collection uses the new prices.

<insert [Cursor add-account form showing the Admin API Key field and the three optional seat price fields] here>

## What you can manage

- **Team**: members, paid seats, unpaid admins, idle seats, the current billing cycle, usage-based spend this cycle and the estimated monthly seat cost. Its **Logs** tab shows the team audit log (logins, member changes, settings changes) for the last 30 days.
- **Team members**: role, seat, last activity, active days, requests and accepted lines over 30 days, most used model, client version, spend this cycle, premium requests and spend limits. **Edit** sets or clears a member's spend limit in whole dollars. **Delete** removes them from the team; Cursor keeps the seat billed until the end of the cycle.
- **Models**: every model your team used in the last 30 days, with requests (included vs usage-based), Max Mode requests, input, output and cache tokens, token cost, usage-based spend and how many members used it.
- **Billing groups**: groups that split spend by department or cost centre, with spend this cycle, daily spend and a member table. Create one with a member picker, rename it, change members, or delete it.
- **Member groups**: Cursor's directory groups, which carry a monthly spending limit per member. Create, rename, set or clear the limit, change members, or delete.
- **Repository blocklists**: glob patterns of files Cursor will never index or send to a model, per repository. Create, edit the patterns, or delete.

To change a group's members, edit the **Member emails** field. The group ends up with exactly the members you list. Every address must belong to a team member; if one doesn't, the edit is refused and the unknown addresses are named. You can also remove one member with the **Remove** button in the group's member table.

<insert [Cursor team member detail page showing an idle seat, the spend section with member, team and effective limits, and the Edit button] here>

## Seats

Every member on a paid seat appears on the **Seats** page. There you can find idle seats, people paying for Cursor and another AI coding tool, and what you'd save, based on your organization's inactivity threshold.

- **Who appears**: team members with a paid seat. Unpaid admins and removed members are left out. Members in **Premium seat members** count as Premium seats, everyone else as Standard.
- **Activity**: based on Cursor's daily usage. A member's last activity is the last day they were active in the window, which is your inactivity threshold but at least 30 and at most 90 days. With a longer threshold, Cursor seats show "activity unknown" rather than being called idle on too little data. Cursor doesn't report join dates, so the first day a member shows up counts as their join date, and someone added last week isn't called idle. A member with no usage yet shows activity unknown.
- **Price**: the seat price you set on the account. At the defaults, Teams seats are priced at the published list price ($40 Standard, $120 Premium per user per month, billed monthly) and labelled as an estimate. Enterprise pricing is custom, so an Enterprise team with no price set has its seats counted but not priced.
- **Remove** takes the member off the team. Cursor only allows this on **Enterprise** plans with an **admin**-scoped key, and always keeps at least one paid member and one admin. On Teams plans, remove members from the Members page of the Cursor dashboard instead. A member who used credits this cycle keeps the seat billed until the cycle ends.
- **Cheaper tier**: never suggested, because Cursor doesn't publish how much usage a Standard seat includes. To move someone, use the member's menu on the Members page in Cursor; the change applies at the next renewal.
- **Scopes**: a read-only key reads seats. Removal needs the admin scope and an Enterprise plan. Enterprise is only detected with an admin-scoped key, so a read-only key on Enterprise is treated as a Teams plan (list prices, no Remove).

The team page and each member also show an **idle seat** status for no activity in the last 30 days.

## Costs

Cost data lands on the Costs page every day, broken down by **service** (the model, or Standard seat / Premium seat), **resource** (the team member) and tags (`user`, `model`, `maxMode`, `seat`, `charge`).

- **Usage-based spend** counts only what Cursor billed on top of your plan. Requests from the plan's included pool cost nothing extra and are left out. The amount is what Cursor charged, including its token fee.
- **Seats** are estimated: one row per paid seat per day, at the seat price set on the account spread evenly over the year. Seat rows only cover the current billing cycle, so seat history builds up one cycle at a time.

Because seat costs are estimated, the account is labelled as an **estimate** wherever its costs appear. Usage-based spend goes back 90 days.

<insert [Costs page filtered to a Cursor account, grouped by service, showing spend per model alongside Standard seat rows] here>

## Metrics

- **Team**: active users, agent, chat, composer and Cmd+K requests, Bugbot runs, included, usage-based and own-API-key requests, lines suggested and accepted, Tab suggestions accepted and the Tab acceptance rate. On Enterprise plans the tab adds active users of the CLI, cloud agents and Bugbot, agent diffs and lines accepted, Tab lines accepted, and lines committed with and without AI.
- **Team members**: their own requests, usage-based requests and spend, tokens, and the same feature breakdown as the team.
- **Models**: requests, usage-based requests, spend and tokens for that model. On Enterprise plans, also messages across every surface and the number of members using it.
- **Billing groups**: daily spend this cycle.

## What isn't available

Cursor's public API doesn't offer these, so you won't see them here:

- Your plan, each member's seat tier, seat prices and invoices. Seat costs are estimated from the prices you enter.
- When a member joined or was removed. The Seats page infers a join date from daily usage, and the team member list shows a member added this week as idle until they use Cursor.
- Inviting members, changing a member's role, and changing the team-wide default spend limit. Do these in the Cursor dashboard. The team default limit is shown read-only on each member.
- Model access controls, which are still a preview in Cursor.

## Tips and limits

- Cursor limits most Admin API requests to 20 a minute per team, so data can take a moment to refresh.
- The model list is based on the most recent 20,000 usage events. Very large teams see totals for that sample, and the model page says so. The Costs page always counts every event.
