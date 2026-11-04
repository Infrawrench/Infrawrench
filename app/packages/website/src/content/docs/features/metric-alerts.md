---
title: Metric alerts
description: Set threshold rules on collected metrics, like "CPU above 90% for 15 minutes", that cover resources by query and alert you through push, Slack and Microsoft Teams, with a notice when the condition clears.
---

Metric alerts turn the metrics on your dashboards into notifications. Write a rule like **"CPU % > 90 for 15 minutes"** and it watches every resource it covers. Once the condition has held for the whole window, you get a push notification, a Slack message or a Teams card (whichever you've set up). When the metric drops back, every alert you were told about is followed by a **resolved** notification, so your alert channel shows both halves of the story. (Alerts held back by the rule's cooldown also recover quietly. See below.)

<insert [The Metric alerts page showing a list of rules: one firing (warning triangle, "firing on 2 resources"), one healthy, one disabled, above the Recent firings table] here>

Find it under **Alerts** in the sidebar, next to Costs, in the web and desktop apps. The `infrawrench` [CLI](./cli.md) shows the same rules and their history with `infrawrench alerts` and `infrawrench alerts events`.

## Choose which resources a rule covers

A rule doesn't list resources one by one. Instead you describe them with any combination of:

- a **provider** (for example AWS, Hetzner, DigitalOcean),
- a **resource type** within that provider (for example EC2 instance),
- a **tag** (a key, optionally with one value, for example `env=prod`).

Coverage stays current. A VM created tomorrow with the `env=prod` tag is covered by tonight's rule without any edit. A resource that's deleted or re-tagged out of scope stops being watched, and any open alert on it resolves. Tag keys match regardless of case. Values must match exactly. Leave everything empty to cover every resource in the organization.

Below those controls, the editor shows a live preview, such as "Matches 6 resources right now", with the first few named. It updates as you narrow things down, so you can see what you'll be alerting on before you save.

## Pick a metric

The metric list shows what your resources actually reported in the last seven days, filtered to the provider and type you chose. You pick "CPU %" or "Memory used" from the list, with its unit and how many resources report it. If the list is empty, resources like that haven't reported metrics yet.

![The rule editor modal with a provider and resource type selected, the "Matches 6 resources right now" preview closing the Resources block, and the Metric picker below it open showing series labels with units and resource counts](https://agent-assets.infrawrench.com/docs-screenshots/features/metric-alerts/rule-editor-metric-picker.png)

## When a rule fires

- Each enabled rule is checked about **once a minute**, using **per-minute averages** over the rule's window.
- A rule fires on a resource only when **every reading in the window breaches the threshold**, and there are enough readings across the window to be sure. One noisy reading, or two minutes of data in a fifteen-minute window, won't trigger an alert.
- You're notified once per alert. While an alert is open for a resource, you won't get repeat notifications. It stays open until the condition clears (or the metric stops reporting), and then you get the resolved notification.
- The **cooldown** stops flapping. After you've been notified, new alerts for the same resource within the cooldown are recorded in the history but not sent, and neither are their recoveries.

The window can be from 5 minutes to 24 hours. The default is 15 minutes, with a one-hour cooldown. You can use `>`, `>=`, `<` or `<=`, so "healthy replicas below 2 for 10 minutes" works as well as "CPU above 90%".

## Where alerts go

Metric alerts use the channels you've already set up: [Slack alerts](./slack-alerts.md), [Teams alerts](./teams-alerts.md) and [mobile push](./mobile-push-notifications.md). Each Slack channel, Teams webhook and mobile user can turn the **Metric alerts** trigger on or off, in the same place as the budget, anomaly and drift toggles. New channels get metric alerts by default.

Tap a metric alert push on mobile to open the [moment view](./moment.md) around the alert, so you can see what else happened at the same time.

## Permissions

- Viewing rules and alerts needs `metric-alerts:read` (members have it by default).
- Creating, editing, enabling, disabling and deleting rules needs `metric-alerts:write` (admins and owners).

Both work with [custom roles](../team-and-billing/roles-and-permissions.md) and [API key](../team-and-billing/api-keys.md) scopes.

## Use the CLI and API

```
$ infrawrench alerts
prod-org · 3 rules · 1 firing

   rule            condition             resources                matches  firing
 ● High CPU        CPU % > 90 for 15m    aws · ec2-instance · env=prod  12       1
 ● Low disk space  Disk free % < 10 for 30m  hetzner                     4        0
 ○ Staging memory  Memory % > 95 for 15m     env=staging                 7        0

$ infrawrench alerts events --limit 20
```

Both commands take `--json` for scripts. The HTTP API offers the same under `/api/org/{orgId}/metric-alerts`. See the [OpenAPI reference](../team-and-billing/openapi.md) (`Metric alerts` tag) and the generated SDKs.
