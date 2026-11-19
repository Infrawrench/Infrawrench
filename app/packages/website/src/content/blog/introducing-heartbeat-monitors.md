---
title: "Heartbeat monitors: know when a scheduled job stops running"
description: Your jobs ping a URL when they run, and Infrawrench alerts you when a ping is late or a run fails. Schedules are read straight from AWS, Google Cloud, Kubernetes and 16 more providers.
date: 2026-11-19
author: The Infrawrench team
---

The nightly backup that stopped running in March. The invoice export that has failed quietly since a credential rotated. A cron job that dies doesn't throw an error anywhere you look, because the job is the thing that would have told you.

A [synthetic probe](/docs/features/synthetic-probes) checks outward: can the internet reach this endpoint? **Heartbeat monitors**, new in the Observability app, answer the opposite question: did this job run when it was supposed to? The job pings a secret URL each time it runs. If a ping is later than the schedule allows, the heartbeat goes down and you get an alert.

![The Heartbeats tab: Invoice export missed, four heartbeats up, and the nightly database backup expanded into its ping URL, shell snippet, run-duration chart and ping history](/blog/heartbeat-monitors/01-list.png)

## Your schedules are already here

Most heartbeat tools start with you copying a cron expression out of a console. Infrawrench already syncs the jobs you run, so it reads their schedules for you.

Open a scheduled resource and its **Heartbeat** tab has **Watch with a heartbeat**, with the schedule and time zone filled in from the provider. The **New heartbeat** editor lists the same jobs in its **Scheduled job** picker, and shows the next three runs so you can check the time zone before you save.

![The New heartbeat editor with ledger-reconcile picked from the Scheduled job picker, cron 15 3 * * * in Europe/London, the next three runs and a 10 minute grace period](/blog/heartbeat-monitors/02-editor.png)

Schedules are read from 20 kinds of scheduled resource across 19 providers:

- **Clouds:** AWS EventBridge rules, Google Cloud Scheduler jobs, Azure Container Apps jobs, Kubernetes CronJobs and Cloudflare Workflows.
- **Platforms:** Render cron jobs, Railway services, Northflank jobs, Modal scheduled functions, Hugging Face scheduled jobs and Upstash QStash schedules.
- **Data:** Databricks jobs, Snowflake tasks and InfluxDB Cloud tasks.
- **CI and monitoring:** GitLab and Bitbucket pipeline schedules, CircleCI scheduled triggers, Buildkite schedules and Sentry cron monitors.

Every provider writes cron a little differently. AWS has six fields and `rate()`, Quartz puts seconds first, some prefix `CRON_TZ=` and some append a zone. Infrawrench converts them all to standard five-field cron in the right time zone. When a schedule can't be converted safely, the editor shows the original and asks you to rewrite it rather than guessing.

## Or point it at anything

A heartbeat doesn't need a provider. A crontab on a server, a script on a laptop, a CI schedule: give it a name, a cron expression or a fixed interval, and a grace period, then add the ping to the job. Expand the heartbeat and copy the ready-made shell snippet:

```sh
curl -fsS -m 10 --retry 3 -o /dev/null https://app.infrawrench.com/api/ping/<token>/start
if ./your-job.sh; then
  curl -fsS -m 10 --retry 3 -o /dev/null https://app.infrawrench.com/api/ping/<token>
else
  curl -fsS -m 10 --retry 3 -o /dev/null https://app.infrawrench.com/api/ping/<token>/fail
fi
```

Only the plain ping is required. `/start` adds run durations, so a backup that slowly creeps from 14 minutes to 40 shows up on the chart before it collides with the next run. `/fail` alerts at once instead of waiting for the deadline. `POST` a body, such as the last lines of the job's output, and it is kept with the ping in the history.

## Alerts where your team already looks

Heartbeats alert through your existing alert routing on a trigger of their own, so they go to Slack, Teams, email, mobile push or your paging provider, with quiet hours and escalation applied like any other alert. The next good ping sends a recovery. A down heartbeat has a **Declare incident** button that opens an incident in the Incident response app.

A few details that save false alarms:

- A new heartbeat waits for its first ping and never alerts before then, so you can create it before you deploy the job change.
- A run that starts and hangs is caught too: only the closing ping counts, so it misses its next deadline.
- **Pause** stops alerts during maintenance while still recording pings.

## Everywhere you work

- **Web and desktop:** **Heartbeats** in the sidebar under Observability.
- **Mobile:** heartbeats listed on the Probes screen, and a heartbeat alert opens it.
- **CLI:** `infrawrench heartbeats` lists them, and `infrawrench heartbeats "<name>"` shows one's ping URL and recent runs, both with `--json`.
- **Terraform:** the `infrawrench_heartbeat` resource, so heartbeats can live next to the jobs they watch.

## Try it

Open **Observability**, then **Heartbeats**, and click **New heartbeat**, or open any scheduled job and use its **Heartbeat** tab. The [heartbeat monitors docs](/docs/features/heartbeat-monitors) cover the ping URLs, alerting rules and limits.
