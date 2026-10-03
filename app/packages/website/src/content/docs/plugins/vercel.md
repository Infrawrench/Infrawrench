---
title: Vercel
description: Manage Vercel projects, deployments, domains, DNS records, environment variables, webhooks, and teams.
sidebar_order: 22
---

## What you can manage

- Projects (create, edit build settings, pause, Attack Challenge Mode)
- Deployments (status, build logs, cancel, redeploy, promote, instant rollback)
- Domains (auto-renew, DNS configuration check)
- DNS records on domains that use Vercel's nameservers
- Environment variables (create, edit value, type, and targets)
- Webhooks
- Teams

## Credentials

Vercel → **Account Settings → Tokens → Create**.

![Vercel Add-account form with token and optional team-ID field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/vercel/add-account.png)

If you belong to a Team, provide the team ID so infrawrench lists team-owned projects.

## Notable flows

- **Deploy list** with status badges and links to the Vercel inspector.
- **Build logs**: a deployment's Logs tab shows its build output (commands, stdout, stderr).
- **Deployment actions**: **Cancel** a build in progress, **Redeploy** from the same source and settings (production deploys stay production), **Promote to Production** for a ready preview, and **Instant Rollback** for a previous production deployment Vercel marks as a rollback candidate. Every action asks for confirmation first.
- **Project settings**: **Edit** changes the framework preset, Node.js version (24.x, 22.x, 20.x), default function region, and the build, install, development, output, and root directory settings. Clearing a command field resets it to the framework default.
- **Pause / Resume** a project (a paused project answers every request with a 503) and toggle **Attack Challenge Mode**, which puts a browser challenge in front of every visitor during an attack.
- **Domain management** for project and account domains. The detail view checks whether the domain's DNS actually points at Vercel, and **Edit** turns auto-renew on or off for domains bought through Vercel.
- **DNS records**: list, create (A, AAAA, ALIAS, CAA, CNAME, MX, TXT, NS), edit, and delete records on domains that use Vercel's nameservers. Records also show up on the [Domains](../features/domains.md) surface.
- **Environment variables**: create with a project picker, then **Edit** to replace the value, switch between encrypted, sensitive (write-only), and plain, or change the targets and branch.
- **Webhooks**: pick the events (deployments, projects, domains, env vars, firewall, budgets) and optionally the projects, from pickers. The signing secret is shown once, at creation, and is kept as the webhook's **Signing Secret** output.

<insert [Vercel deployment detail view showing the Cancel/Redeploy/Promote header actions and the Logs tab with build output] here>

## Tips & limits

- Runtime (function) logs are a live stream in Vercel's API, so the Logs tab shows the build output only; use the Vercel dashboard or `vercel logs` for request logs.
- Rollback is offered only on production deployments Vercel lists as rollback candidates. After a rollback, Vercel stops auto-promoting new production builds until you promote one.
- DNS records are only listed for domains on Vercel's nameservers; domains pointed at Vercel from another DNS provider have no records here.
- Sensitive environment variables can never be read back, even by their owner.

## Cost graphs

Vercel teams feed [cost graphs & budgets](../features/cloud-costs.md) via the FOCUS billing-charges API: daily costs by product, region, and project (projects appear as the `project` tag).

- The existing access token works as long as its team role can view billing (Owner, Member, Developer, Security, Billing, or Enterprise Viewer).
- Credits appear as negative amounts; taxes and one-off purchases are included.
