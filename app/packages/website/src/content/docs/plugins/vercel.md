---
title: Vercel
description: Manage Vercel projects, deployments, domains, DNS records, environment variables, webhooks, and teams.
sidebar_order: 22
---

## What you can manage

- Projects (create, edit build settings, pause, Attack Challenge Mode, Web Analytics metrics)
- Deployments (status, build logs, cancel, redeploy, promote, instant rollback)
- Domains (auto-renew, DNS configuration check)
- DNS records on domains that use Vercel's nameservers
- Environment variables (create, edit value, type, and targets)
- Webhooks
- Teams

## Connect with Vercel

1. Pick Vercel in the add-account form and click **Connect with Vercel**.
2. On Vercel's install page, choose the personal account or team, and which projects Infrawrench can reach (all, or a selection).

The Team ID is filled in for you and the account is named after the team.

- **What you're granting:** Read/Write on projects, deployments, domains, environment variables, drains, Global Config and the integration's own configuration, and Read on team, user and billing (billing only on Pro and Enterprise teams). Vercel shows the list before you install. Your team role also limits what Infrawrench can do.
- **Staying connected:** nothing to renew. The connection lasts until you remove the integration (Vercel > **Settings > Integrations > Manage > Uninstall**), which disconnects the account.
- **If the person who installed it leaves the team,** Vercel turns the integration off and every call fails with `integration_configuration_disabled` until a team owner transfers it (Vercel deletes it after 30 days). Reconnect the account as another member to fix it.
- Works in the web app and the desktop app in cloud mode. Desktop-local accounts use a pasted token.

## Use a token instead

In Vercel, go to **Account Settings > Tokens > Create**.

![Vercel Add-account form with token and optional team-ID field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/vercel/add-account.png)

If you're on a Team, enter the team ID so you see team-owned projects.

## Things you can do

- **See deploys** with status badges and links to the Vercel inspector.
- **Read build logs**: a deployment's Logs tab shows its build output (commands, stdout, stderr).
- **See traffic**: a project's Metrics tab charts its [Web Analytics](https://vercel.com/docs/analytics) traffic: page views, visitors, custom events (from `track()`), and the visitors behind those events. Ranges up to three days are hourly, longer ones daily. The default is the last week.
- **Act on deployments**: **Cancel** a build in progress, **Redeploy** from the same source and settings (production deploys stay production), **Promote to Production** for a ready preview, and **Instant Rollback** to a previous production deployment Vercel marks as a rollback candidate. Every action asks you to confirm first.
- **Change project settings**: **Edit** sets the framework preset, Node.js version (24.x, 22.x, 20.x), default function region, and the build, install, development, output and root directory settings. Clearing a command field resets it to the framework default.
- **Pause / Resume** a project (a paused project answers every request with a 503), and toggle **Attack Challenge Mode**, which puts a browser challenge in front of every visitor during an attack.
- **Manage domains** for projects and the account. The detail view checks whether the domain's DNS actually points at Vercel, and **Edit** turns auto-renew on or off for domains bought through Vercel.
- **Manage DNS records**: list, create (A, AAAA, ALIAS, CAA, CNAME, MX, TXT, NS), edit and delete records on domains that use Vercel's nameservers. Records also show up on the [Domains](../features/domains.md) page.
- **Manage environment variables**: create with a project picker, then **Edit** to replace the value, switch between encrypted, sensitive (write-only) and plain, or change the targets and branch.
- **Add webhooks**: pick the events (deployments, projects, domains, env vars, firewall, budgets) and optionally the projects. The signing secret is shown once, when you create it, and kept as the webhook's **Signing Secret** output.

<insert [Vercel deployment detail view showing the Cancel/Redeploy/Promote header actions and the Logs tab with build output] here>

<insert [Vercel project Metrics tab showing Page Views, Visitors and Custom Events charts over the last week] here>

## Tips & limits

- The Logs tab only shows build output. For request (function) logs, use the Vercel dashboard or `vercel logs`.
- Project metrics need Web Analytics turned on for the project, and only cover production traffic. Without it, the Metrics tab is empty. How far back you can look depends on your plan's Web Analytics window.
- Rollback is only offered on production deployments Vercel lists as rollback candidates. After a rollback, Vercel stops auto-promoting new production builds until you promote one.
- DNS records are only listed for domains on Vercel's nameservers. Domains pointed at Vercel from another DNS provider have no records here.
- Sensitive environment variables can never be read back, even by their owner.

## Cost graphs

Vercel teams feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs by product, region and project (projects appear as the `project` tag).

- Your access token works as long as its team role can view billing (Owner, Member, Developer, Security, Billing, or Enterprise Viewer).
- Credits show as negative amounts. Taxes and one-off purchases are included.
