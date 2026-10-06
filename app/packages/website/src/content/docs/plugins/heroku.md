---
title: Heroku
description: Manage Heroku apps, dynos and formation scaling, releases and rollbacks, config vars, add-ons, domains and SSL, pipelines, review apps, log drains and Private Spaces, with logs, invoices and credits.
sidebar_order: 21
---

## What you can manage

- **Apps**: create (personal or team, Common Runtime region or a Private Space, stack), rename, maintenance mode, next build stack, Automated Certificate Management, delete. Restart all dynos, clear the build cache, run a one-off dyno, and roll back to an earlier release.
- **Process types (formation)**: dyno count and size, restart, stop (scale to zero) and start.
- **Dynos**: state, size, command and release; restart or stop one dyno.
- **Releases** (the ten most recent per app): status, description and who made them; roll back to any eligible release.
- **Config vars**: add, change and remove, with the add-on that set each one.
- **Add-ons**: add (Heroku Postgres, Key-Value Store, Kafka and Scheduler plans are listed with prices; any other `service:plan` can be typed), rename, change plan, remove.
- **Domains**: add a hostname, see the DNS target to point it at and the certificate status, choose which uploaded certificate serves it.
- **SSL certificates (SNI endpoints)**: upload, replace and remove.
- **Log drains**: add and remove syslog or HTTPS drains.
- **Pipelines**: create, rename, delete; add apps to stages and move them between stages; promote from development or staging to every app in the next stage; review app settings; list and delete review apps.
- **Private Spaces**: create (team, region, Shield), rename, delete.
- **Teams**: rename, set your default team, and see members with their role and two-factor status.

## Credentials

Heroku dashboard → avatar menu → **Account settings → API Key → Reveal**, or create a long-lived token with `heroku authorizations:create`. Keys start with `HRKU-` and act with your account's access to every personal and team app.

After pasting the key, the **Team** picker lists your teams. Pick one to limit the account to that team's apps, or leave **Personal and all teams**.

<insert [Heroku Add-account form with the API Key field filled in and the Team picker open, listing two teams] here>

## Notable flows

- **Scaling**: **Edit** on a process type sets the dyno count and size; **Stop** scales it to zero and **Start** brings it back with one dyno, which is what sleep schedules use.
- **Rollback**: **Roll Back** on an app (or **Roll Back to This Release** on a release) creates a new release with that release's code and config vars. Add-ons are not changed.
- **Logs** for apps, process types and dynos come from a Heroku log session (up to 1,500 lines), filterable to app, Heroku system or router logs.
- **Pipelines**: **Promote** copies the source app's current slug to every app in the next stage; config vars stay per app.
- **Costs**: invoices are imported per month, split into platform, add-on and data charges for team invoices, with credits as their own line. The current month appears once Heroku issues its invoice.
- **Credits**: unexpired account credits feed credit burndown.

<insert [Heroku app detail view showing the Restart All Dynos, Run One-Off Dyno and Roll Back header actions, the Formation table and Recent Releases] here>

<insert [Heroku pipeline detail view showing the Stages table and the Promote dialog with the source app selected] here>

## Status, DNS and Terraform

- **Status**: incidents from status.heroku.com are matched to your resources by geography (North America, Europe, Asia Pacific tags map to the Heroku regions in each) and by system (Apps or Data). Scheduled maintenance counts once it is under way.
- **DNS**: CNAMEs pointing at a `herokuapp.com` hostname are matched to the app, so a record left behind after deleting an app is flagged.
- **Expiry**: uploaded SSL certificates show their expiry on the expiry radar.
- **Savings**: an add-on not attached to any app is listed as an orphan.
- **Export to Terraform** writes `heroku_app`, `heroku_formation`, `heroku_addon`, `heroku_domain`, `heroku_pipeline`, `heroku_pipeline_coupling`, `heroku_space` and `heroku_drain` blocks for the official `heroku/heroku` provider, each with its import id. Config vars and certificates are not included.

## Tips & limits

- Heroku allows 4,500 API requests an hour per user. Dynos, releases, config vars, domains and drains are read per app, so accounts with many apps sync those more slowly.
- The Platform API exposes no dyno metrics, so there is no Metrics tab; use a log drain or Heroku's own metrics.
- Changing a config var restarts the app's dynos, as it does in the dashboard.
- Review apps need a source tarball to create, so they are created by Heroku from your pipeline settings rather than from Infrawrench.
