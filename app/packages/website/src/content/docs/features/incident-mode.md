---
title: Incident mode
description: Declare an incident once to freeze changes, pin the moment, tell your org and post a public status update, then get the timeline assembled and the postmortem pre-filled.
sidebar_order: 12
---

At 03:14, declaring an incident means six chores. Someone freezes deploys. Someone posts in the channel. Someone updates the status page. Someone starts a doc. Someone notes the time. Three days later, someone rebuilds the timeline from scrollback.

Incident mode does all six from one place. It uses the change freeze, [Moment view](./moment.md), [alert routing rules](./alert-routing.md) and [status page](./status-pages.md) you've already set up, not separate copies.

> **Two different things are called "incidents".** This page is about incidents **your organization declares**. A **provider's** outage, taken from their status page and matched against your resources, is covered in [provider status correlation](./provider-status.md). It only shows up here as evidence on your timeline. That's also why the CLI command for declared incidents is `infrawrench declared-incidents`: `infrawrench incidents` is for provider incidents.

![The Incidents workspace tab showing a list with one open SEV1 and two resolved incidents, severity chips visible](https://agent-assets.infrawrench.com/docs-screenshots/features/incident-mode/incidents-list.png)

## Declare an incident

Open **Incidents** from the sidebar and click **Declare incident**. Or start from where you noticed the problem: a down probe on the **Probes** tab and a firing rule on the **Alerts** tab both have a **Declare incident** button. It opens the same form with the title, summary, affected resource and start time already filled in.

The form asks for a title, a severity (SEV1 to SEV4, default SEV2) and an optional summary. Under **And do this** you choose what else happens:

| Action              | Default | What it does                                                                                                                                                                                                                         |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Announce it**     | on      | Sends through your existing alert routing rules under the **Incidents** trigger, so it reaches whichever Slack channels, Teams webhooks and phones your rules already name, following quiet hours and escalation.                    |
| **Pin the moment**  | on      | Records when the incident started, so "what changed around then" stays one click away for the whole investigation.                                                                                                                   |
| **Freeze changes**  | off     | Opens an org-wide change freeze for the duration, blocking destructive actions. Lifted automatically when the incident resolves.                                                                                                     |
| **Tell the public** | off     | A dropdown of your status pages, defaulting to **Don't post publicly**. Pick one to post an update there, with toggles for which components are affected. Closed automatically when you resolve. Hidden if you have no status pages. |

The two actions that are off by default affect things beyond the incident itself. The two that are on only help.

![The Declare incident modal with a title filled in, SEV1 selected, and the four actions visible: three checkboxes plus the "Tell the public" status-page picker](https://agent-assets.infrawrench.com/docs-screenshots/features/incident-mode/declare-incident-modal.png)

### If something fails, you still have the incident

The incident is always created first, and each action is tried after that. If Slack is down, you lose the announcement, never the incident.

Anything that didn't happen is listed in a red box on the incident page, with the reason. For example: "No alert routing rule matches the Incidents trigger, so nobody was told", or "Opening a change freeze needs the freezes:write permission". Click **Retry these** to run only the failed actions again.

Resolving can fail too. If lifting the freeze or closing the public update fails, it shows as **still open**, because the freeze really is still on and the status page really is still showing an outage. **Retry these** then tries the closing step again, without opening a second freeze or posting a duplicate notice.

Retrying a status page update publishes it again for **the components you originally picked**, not the whole page.

### Incidents from PagerDuty and incident.io

If you've connected a [paging provider](./on-call.md#paging-providers) account that brings its incidents into Infrawrench, its open incidents are listed at the top of the Incidents tab, above the ones your organization declared. **Acknowledge** and **Resolve** update the provider too. **Declare incident** on one of them opens the form with its title and start time filled in, for when a page turns out to be an outage worth a freeze, an announcement and a status page notice.

When an alert routing rule sends declared incidents to a paging provider, declaring opens an incident there, mitigating acknowledges it and resolving resolves it.

## The timeline

The timeline pulls together everything Infrawrench recorded between the incident's start and its resolution. It's always up to date, so a correction made elsewhere shows here on the next refresh.

It includes:

- resource changes from the [change timeline](./change-timeline.md)
- deployments and workflow runs
- [cost anomalies](./cost-anomaly-alerts.md)
- [provider status incidents](./provider-status.md) during the window
- audit entries and change freezes starting or ending
- [synthetic probes](./synthetic-probes.md) going up or down
- [metric alerts](./metric-alerts.md) firing and recovering
- the incident's own events and actions, including failed ones
- **notes** you write as you go

You can set a note's time separately from when you wrote it, so a note written at 04:00 about something that happened at 03:14 shows in the right place.

If one of these sources is unavailable, or you don't have permission to see it, a small chip says so and the rest of the timeline still shows.

![An incident detail view showing the merged timeline with a note, a deploy, a probe going down and a failed Slack artefact](https://agent-assets.infrawrench.com/docs-screenshots/features/incident-mode/incident-detail-timeline.png)

## Resolve and write the postmortem

Mark an incident **mitigated** to stop the paging without closing it. This is what lets you measure time to mitigate. **Resolve** closes it and undoes exactly what this incident set up: its own change freeze (not any other freeze that happens to be on) and the status page update it posted.

Then click **Postmortem** to get a markdown document with the facts already filled in: the window, the duration, the time to mitigate, the affected resources, the whole timeline as a table, and every note. The analysis sections (impact, root cause, what went well, action items) are left blank for you. Copy it into your tracker and finish it there.

## Permissions

- `incidents:read`: see incidents and their timelines. Members have it.
- `incidents:write`: declare, add notes, change state and resolve. **Members have this too**, because the person who notices an outage at 03:14 is rarely an admin.

Each action still needs its own permission. A change freeze needs `freezes:write`. If someone without it declares an incident, the freeze shows as a failed action naming the permission, and the incident still stands.

## On your phone and in the terminal

The [mobile app](./mobile-app.md) covers what you need away from a laptop: **declare**, **read the timeline** and **add a note**. Declaring on the phone asks only for a title and severity and uses the safe defaults, so you won't freeze your whole organization from a lock screen. Editing, retrying failed actions and the postmortem export are on web and desktop.

The [CLI](./cli.md) can read incidents:

```bash
infrawrench declared-incidents              # the list
infrawrench declared-incidents "checkout"   # one incident's assembled timeline
infrawrench declared-incidents --json
```

## Status page updates

When an incident posts to a status page, visitors see a sentence from a person above the component list, using the usual stages: investigating, identified, monitoring, resolved. Resolving the incident closes it.

The public page shows the notice's title, text, state, times and which components on that page it affects. It does **not** show the incident's id, who declared it or anything else about your organization, the same as the rest of [the public page](./status-pages.md).
