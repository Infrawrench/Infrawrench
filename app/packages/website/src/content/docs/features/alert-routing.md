---
title: Alert routing rules
description: Route each alert to the right channel by condition, hold alerts during quiet hours, and escalate the ones nobody acknowledges.
sidebar_order: 14
---

Routing rules decide where your alerts go. Every alert Infrawrench raises (a sync failure, a budget crossing, a cost anomaly, a probe going down) is checked against your organization's rules. A rule says which alerts it covers, where they go, whether to hold them at night, and what to do if nobody responds.

> **Where to edit rules.** Rules belong to your organization in the cloud. Edit them from the web app, or from the desktop app's Settings tab while signed in to your organization. Both edit the same rules. There's no rules editor on mobile. The mobile app has your personal push mutes instead.

Routing is for people. To send the same events to your own systems as versioned JSON (a SIEM, an event bus, a ticketing tool), use [event subscriptions](./event-subscriptions.md) instead. They work independently of these rules.

## How a rule works

A rule has four parts:

| Part            | What it says                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**        | Conditions the alert must meet. All of them must match. For "or", write a second rule.                                                                                       |
| **Send to**     | Slack channels, Teams channels, mobile push, on-call rotations, GitHub issues, [email](./email-alerts.md) and [paging providers](./on-call.md#paging-providers), in any mix. |
| **Quiet hours** | Optional. A recurring local-time window when matching alerts are held instead of sent.                                                                                       |
| **Escalation**  | Optional. Extra destinations to notify if nobody acknowledges within N minutes.                                                                                              |

Rules are a **list, checked top to bottom**, and the first one that matches decides where the alert goes. That makes the common setup easy:

1. **Big anomalies on prod.** Trigger is `Anomalies`, amount at least `$500`, account is `prod`. Send to `#incidents`.
2. **Everything else.** Send to `#infra-noise`.

The first rule takes the expensive ones, and everything else falls through to the second.

A rule can also copy alerts without stopping them. Untick _Stop here_ and checking continues to the rules below. That's how an audit channel can get every alert without hiding anything from the other rules.

![The Alert routing card on the Routing tab of Settings > Notifications, showing two rules, a narrow "anomalies over $500 on prod to #incidents" above a broad "everything to #infra-noise", with the first rule expanded to show its conditions](https://agent-assets.infrawrench.com/docs-screenshots/features/alert-routing/two-rules.png)

### GitHub issues

The **GitHub issues** destination files the alert's finding as an issue in the repository your [GitHub issue settings](./github-issues.md) send it to, one issue per finding. Only alerts with a finding (savings findings, anomalies, idle commitments) are filed. Other alerts skip this destination.

### Savings findings and leaked credentials

The **Savings findings** trigger sends one alert per new orphaned or oversized resource. It's left out of the default rule and muted on phones, so it only goes where you route it.

The **Leaked credentials** trigger fires when a secret scanner finds a credential committed to code (see [Leaked credentials](./leaked-credentials.md)). It's **critical** by default, part of the default rule, and not muted on phones, so a new leak pages like any critical alert. Each scan sends one alert covering everything new it found. When there's exactly one match, the alert carries the account and the token's provider, so you can use **Account** and **Provider** conditions to route it to the team that owns the key.

### PagerDuty and incident.io

Connect a [PagerDuty](../plugins/pagerduty.md) or [incident.io](../plugins/incident-io.md) account and **Send to** gets a picker for each. Choose a PagerDuty service or an incident.io HTTP alert source by name, and matching alerts open an alert there. You never paste a routing key.

The alert stays in step with Infrawrench:

- When a probe recovers, a metric alert clears, a declared incident is resolved, a sync failure heals or a page is cleared, the upstream alert is **resolved**. This happens whichever rule opened it and whatever your rules say now.
- Mitigating a declared incident, or pressing **Acknowledge** on an escalating alert in Infrawrench, **acknowledges** it in PagerDuty. (An incident.io alert source only knows firing and resolved.)
- Acknowledging in PagerDuty, or responding to an incident.io escalation, settles the Infrawrench escalation for that alert, so nobody gets escalated to about a page someone already took. This needs inbound mirroring turned on for the account. See [On-call](./on-call.md#paging-providers).
- A repeat of the same alert (the same probe, the same budget) re-triggers the open upstream alert instead of opening a second incident.

The same picker also offers **whoever is on call** on a PagerDuty schedule or escalation policy, or an incident.io schedule or escalation path. Infrawrench looks up who is on call when the alert fires, matches them to your members by email, and delivers it like an [on-call rotation](./on-call.md): one push per person, never twice to someone who is also on an Infrawrench rotation.

If a send fails because the provider is down or rate limited, it's retried in the background. If it's refused (a deleted service, a revoked key), Infrawrench stops trying and shows it under **Settings > On-call > Paging providers**.

<insert [The Send to section of an alert routing rule with a PagerDuty service and an incident.io on-call schedule added from the paging provider picker] here>

## Conditions

| Condition         | Matches on                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Trigger**       | What kind of alert it is: sync failures, budgets, anomalies, drift, pages, probes, declared incidents, leaked credentials, and so on |
| **Severity**      | `info`, `warning` or `critical`, in that order, so "at least warning" is a floor, not an exact match                                 |
| **Account**       | The account the alert is about                                                                                                       |
| **Provider**      | The provider, for example to route AWS incidents to the team that runs on AWS                                                        |
| **Resource type** | The kind of resource, for alerts about one                                                                                           |
| **Amount**        | Money at stake, for budgets and cost anomalies                                                                                       |
| **Name**          | The alert's name: an anomaly's service, a probe's name, a metric rule's name                                                         |
| **Message text**  | Text in the alert's title or body, for anything the fields above don't cover                                                         |

One thing to know: **a condition about something the alert doesn't have never matches**, either way. An account condition won't match an alert that isn't about an account, with `is one of` or with `is not one of`. A provider status incident covers your whole organization, so a rule about one account won't catch it. To catch organization-wide alerts, leave the account condition off.

## Hold alerts during quiet hours

A rule can have a recurring window, say 22:00 to 08:00 in `Europe/Berlin` on weekdays, when its alerts are **held, not dropped**. A held alert keeps its original text and goes out as soon as the window ends. It arrives at breakfast instead of at 3am.

Set **Send anyway when severity is at least** to let urgent alerts through. `Critical` is the usual choice: sleep through budget warnings, wake up for a page.

Some alerts ignore quiet hours, because holding them would change what they mean:

- **Pages** raised by `infra.page(...)`. Their whole job is to interrupt.
- **Approval requests.** A run is waiting on the answer, and no answer counts as a denial, so holding one until morning would quietly deny it.
- **The weekly digest.** It already goes out at a time you chose.

The **Recent held and escalating alerts** list at the bottom of the card shows what's waiting and when it will send.

## Escalate unacknowledged alerts

Give a rule an escalation policy and every alert it sends has an **Acknowledge** button on its Slack message. If nobody presses it within the set number of minutes, the alert goes out again, retitled _Unacknowledged: …_, to the escalation destinations.

Only one person's acknowledgement counts, even if two people press at the same moment. An alert that has already escalated can't be silenced afterwards.

Escalation goes **one step**. There's no chain, so an alert can't bounce between two channels forever.

Two limits to know before you rely on it:

- **Acknowledging needs Slack** (or the alert's PagerDuty or incident.io incident, if the rule also sends there). An alert sent only to Teams or mobile push can't be acknowledged, so it always escalates. Send escalating alerts to at least one Slack channel or paging provider.
- **An alert that reached nobody doesn't escalate.** There's nothing to escalate from.

## Mobile push stays personal

`Mobile push` as a destination means "the organization's phones", but each member's own mute list still applies. A routing rule decides whether the organization is told. Each member decides whether their own phone rings. An admin can't unmute someone else's notifications, so those toggles live in [the push settings](./mobile-push-notifications.md), not in the rules.

## If you haven't written any rules

With no saved rules, your organization behaves as if it had one: **everything except resource drift, to every connected channel and to mobile push**. So connecting a Slack channel works on day one without opening the rules editor.

Press **Start from the default and edit it** to turn that into a real rule you can change. While you're on the default, new channels are added automatically. Once you've saved rules, you need to add a new channel to a rule yourself.

## Permissions

Editing routing rules needs the **Organization settings** permission (`org:settings:write`), since a rule decides who hears about an incident. Your own push mutes need no permission.

## From the CLI

```bash
infrawrench routing              # the rules, in evaluation order
infrawrench routing queue        # alerts held for quiet hours or awaiting acknowledgement
infrawrench routing --json       # the same, as JSON
```

`routing` is the quickest way to answer "why did that page reach me" (or why it didn't). It prints each rule as a sentence, in the order they're checked.

## Empty rules

Two kinds of rule look like mistakes but aren't:

- **A rule with no conditions** matches every alert. Handy as the last rule in the list.
- **A rule with no destinations** swallows the alerts it matches. Because it still counts as a match, the rules below never see them. Use it to say "never tell anyone about these". The editor warns you about a rule like this, since a half-finished rule looks the same.
