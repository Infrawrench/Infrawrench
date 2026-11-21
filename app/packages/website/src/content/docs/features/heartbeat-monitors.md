---
title: Heartbeat monitors
description: Catch scheduled jobs that silently stop running. Jobs ping a secret URL when they run, and a late ping past its grace period alerts through your alert routing.
sidebar_order: 11
---

A [synthetic probe](./synthetic-probes.md) checks outward: can the internet reach this endpoint? A heartbeat monitor answers the opposite question: **did this job run when it was supposed to?** A backup, a report, a queue drain or a billing sync can stop running without anything failing loudly. With a heartbeat, the job pings a secret URL each time it runs, and if a ping is later than the schedule allows, the heartbeat goes down and alerts you.

<insert [The Heartbeats tab showing a list of heartbeats: one missed (warning indicator, "Missed" in red), several up with their cron schedule, last ping and last run duration, and one row expanded into its ping URL, the shell snippet, a run-duration chart and the ping history] here>

## Where to find it

- **Web and desktop:** **Heartbeats** in the sidebar, under Observability. On desktop, heartbeats need cloud mode.
- **Resource pages:** any scheduled job, pipeline schedule or scheduled function Infrawrench syncs gets a **Heartbeat** tab with a **Watch with a heartbeat** button (see below).
- **Mobile:** heartbeats are listed, read-only, on the Probes screen. A heartbeat alert opens it.
- **CLI:** `infrawrench heartbeats` lists them; add a name for one heartbeat's ping URL and recent runs. See [CLI](./cli.md).
- **Terraform:** the `infrawrench_heartbeat` resource. See [Terraform provider](./terraform-provider.md).

## Watch a scheduled resource

Infrawrench already knows the schedules of many of the jobs you run. Open one of them and use the **Heartbeat** tab: **Watch with a heartbeat** opens the editor with the schedule filled in from the provider, so you don't copy a cron expression out of a console. The **New heartbeat** editor offers the same list in its **Scheduled job** picker.

Schedules are read from:

| Provider       | Resource                                                    |
| -------------- | ----------------------------------------------------------- |
| AWS            | EventBridge rules (`cron(...)` and `rate(...)` expressions) |
| Google Cloud   | Cloud Scheduler jobs, with their time zone                  |
| Azure          | Container Apps jobs with a schedule trigger                 |
| Kubernetes     | CronJobs, with `spec.timeZone`                              |
| Cloudflare     | Workflows with a cron trigger                               |
| Databricks     | Jobs with a schedule, with their time zone                  |
| Snowflake      | Tasks (`USING CRON` and minute intervals)                   |
| Render         | Cron jobs                                                   |
| Railway        | Services with a cron schedule                               |
| Northflank     | Cron jobs, with their time zone                             |
| Modal          | Scheduled functions                                         |
| Hugging Face   | Scheduled jobs                                              |
| Upstash        | QStash schedules (including a `CRON_TZ=` prefix)            |
| InfluxDB Cloud | Tasks (`cron` and `every`)                                  |
| GitLab         | Pipeline schedules, with their time zone                    |
| Bitbucket      | Pipeline schedules                                          |
| CircleCI       | Scheduled triggers                                          |
| Buildkite      | Pipeline schedules                                          |
| Sentry         | Cron monitors                                               |

Providers write schedules in several dialects (AWS's six-field `cron()`, Quartz expressions with a seconds field, `@hourly`, a trailing time zone). Infrawrench converts them to standard five-field cron. When a schedule can't be converted, for example one that uses `L` or `#` day forms, the editor shows the original and asks you to write it as five-field cron.

A heartbeat created this way stays linked to the resource, and the resource's Heartbeat tab shows its ping URL.

## Create a heartbeat

You can also create one for any job, wherever it runs: a crontab on a server, a CI schedule, a script on a laptop.

- **Name:** what the alert calls it.
- **Schedule:** either a **cron** expression (five fields, such as `0 2 * * *`) with a **time zone**, or a **fixed interval** in minutes. The editor shows the next three run times for a cron schedule, so you can check the time zone.
- **Grace period:** how late a ping may be before the heartbeat goes down. Set it to cover the job's normal run time plus some slack (default 10 minutes).

<insert [The New heartbeat editor with the Scheduled job picker open, listing synced resources with their schedules, and below it the cron expression, time zone and grace period fields with the next three run times shown] here>

## Ping the URL from your job

Each heartbeat has a secret ping URL. Expand the heartbeat to copy it, or copy the ready-made shell snippet:

```sh
curl -fsS -m 10 --retry 3 -o /dev/null https://app.infrawrench.com/api/ping/<token>/start
if ./your-job.sh; then
  curl -fsS -m 10 --retry 3 -o /dev/null https://app.infrawrench.com/api/ping/<token>
else
  curl -fsS -m 10 --retry 3 -o /dev/null https://app.infrawrench.com/api/ping/<token>/fail
fi
```

The URL accepts `GET` and `POST`:

| URL                       | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `/api/ping/<token>`       | The job ran. The heartbeat is up, and the next deadline is set. |
| `/api/ping/<token>/start` | A run started. The next ping measures how long the run took.    |
| `/api/ping/<token>/fail`  | The run failed. The heartbeat goes down and alerts at once.     |

Only the plain ping is required. Sending `/start` as well gives you run durations, and `/fail` turns a failed run into an alert straight away rather than waiting for the deadline. If you `POST` a body (for example the last lines of the job's output), its first 1000 characters are kept with the ping and shown in the history.

The token in the URL is the only credential, so treat the URL like a password. If it leaks, use **Replace URL** on the heartbeat: the old URL stops working immediately, and you update the job with the new one.

## When it alerts

A new heartbeat waits for its first ping and never alerts before then, so you can create it before you add the ping to the job.

After each ping, Infrawrench works out when the next run is due from the schedule and adds the grace period. If no ping arrives by then, the heartbeat goes **down** ("Missed") and alerts. A `/fail` ping takes it down at once ("Failed"). The next successful ping brings it back up and sends a **recovered** notification.

A run that starts and never finishes is caught the same way: only the closing ping counts, so a hung job misses its next deadline.

Heartbeat alerts have their own trigger, **Heartbeats**, so you can route them like any other alert: to Slack channels, Teams, email, mobile push or a paging provider. See [Alert routing](./alert-routing.md). A down heartbeat also has a **Declare incident** button, as a down probe does. See [Incident mode](./incident-mode.md).

**Pause** stops a heartbeat from alerting, for example during planned maintenance. Pings are still recorded. **Resume** returns it to waiting for its next ping.

## Ping history and run durations

Expand a heartbeat to see its last pings (successes, starts and failures, with any body the job sent) and a chart of run durations for runs that sent `/start`. History is kept for 30 days.

## Limits

- A heartbeat accepts up to 20 pings a minute. Past that the URL answers `429` and the ping isn't recorded.
- An organization can have up to 200 heartbeats.
- An interval can be from 1 minute to 31 days, and a grace period from 1 minute to 7 days.

## Related

- [Synthetic probes](./synthetic-probes.md): check that endpoints are reachable from outside.
- [Alert routing](./alert-routing.md): decide where heartbeat alerts go.
