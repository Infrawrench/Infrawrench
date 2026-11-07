---
title: Heroku
description: Manage Heroku apps, dynos and formation scaling, releases and rollbacks, config vars, add-ons, domains and SSL, pipelines, review apps, log drains and Private Spaces, with logs, invoices and credits.
sidebar_order: 21
---

Connect Heroku to scale and roll back apps, manage config vars, add-ons, domains and pipelines, and read logs and invoices.

## What you can manage

- **Apps**: create (personal or team, Common Runtime region or a Private Space, stack), rename, maintenance mode, next build stack, Automated Certificate Management, delete. Restart all dynos, clear the build cache, run a one-off dyno, and roll back to an earlier release.
- **Process types (formation)**: dyno count and size, restart, stop (scale to zero) and start.
- **Dynos**: state, size, command and release. Restart or stop one dyno.
- **Releases** (the ten most recent per app): status, description and who made them. Roll back to any eligible release.
- **Config vars**: add, change and remove, with the add-on that set each one.
- **Add-ons**: add, rename, change plan, remove. Heroku Postgres, Key-Value Store, Kafka and Scheduler plans are listed with prices, and you can type any other `service:plan`.
- **Domains**: add a hostname, see the DNS target to point it at and the certificate status, and choose which uploaded certificate serves it.
- **SSL certificates (SNI endpoints)**: upload, replace and remove.
- **Log drains**: add and remove syslog or HTTPS drains.
- **Pipelines**: create, rename, delete. Add apps to stages and move them between stages, promote from development or staging to every app in the next stage, change review app settings, and list and delete review apps.
- **Private Spaces**: create (team, region, Shield), rename, delete.
- **Teams**: rename, set your default team, and see members with their role and two-factor status.

## Connect your account

1. Get an API key. In the Heroku dashboard, open your avatar menu and go to **Account settings > API Key > Reveal**. Or create a long-lived token with `heroku authorizations:create`. Keys start with `HRKU-` and have your account's access to every personal and team app.
2. Paste the key. The **Team** picker then lists your teams.
3. Pick a team to limit the account to that team's apps, or leave **Personal and all teams**.

<insert [Heroku Add-account form with the API Key field filled in and the Team picker open, listing two teams] here>

## Day-to-day tasks

- **Scale**: **Edit** on a process type sets the dyno count and size. **Stop** scales it to zero, and **Start** brings it back with one dyno. Sleep schedules do the same.
- **Roll back**: **Roll Back** on an app (or **Roll Back to This Release** on a release) creates a new release with that release's code and config vars. Add-ons don't change.
- **Read logs**: apps, process types and dynos show up to 1,500 recent lines. Filter to app, Heroku system or router logs.
- **Promote in a pipeline**: **Promote** copies the source app's current build to every app in the next stage. Config vars stay per app.
- **Track costs**: invoices are imported per month. Team invoices are split into platform, add-on and data charges, with credits as their own line. The current month shows once Heroku issues its invoice.
- **Track credits**: unexpired account credits show in credit burndown.

<insert [Heroku app detail view showing the Restart All Dynos, Run One-Off Dyno and Roll Back header actions, the Formation table and Recent Releases] here>

<insert [Heroku pipeline detail view showing the Stages table and the Promote dialog with the source app selected] here>

## Status, DNS and Terraform

- **Status**: incidents from status.heroku.com show on your resources by region (North America, Europe, Asia Pacific) and by system (Apps or Data). Scheduled maintenance counts once it's under way.
- **DNS**: CNAMEs pointing at a `herokuapp.com` hostname are matched to the app, so a record left behind after you delete an app is flagged.
- **Expiry**: uploaded SSL certificates show their expiry on the expiry radar.
- **Savings**: an add-on that isn't attached to any app is listed as an orphan.
- **Export to Terraform** writes `heroku_app`, `heroku_formation`, `heroku_addon`, `heroku_domain`, `heroku_pipeline`, `heroku_pipeline_coupling`, `heroku_space` and `heroku_drain` blocks for the official `heroku/heroku` provider, each with its import id. Config vars and certificates aren't included.

## Tips and limits

- Heroku allows 4,500 API requests an hour per user. Infrawrench leaves 1,000 of them for your own tools, so on an account with many apps each sync reads process types, dynos, releases, config vars, domains, certificates, log drains, pipeline stages and review apps for as many apps and pipelines as fit, starting somewhere different each time. The rest keep their last values until their turn comes. The desktop app reads them all each time.
- There's no Metrics tab, because Heroku's API doesn't share dyno metrics. Use a log drain or Heroku's own metrics.
- Changing a config var restarts the app's dynos, just like in the dashboard.
- Review apps are created by Heroku from your pipeline settings, not from Infrawrench.
