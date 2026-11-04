---
title: Weekly digest
description: A scheduled summary of last week's spend, top movers, sync incidents, and resource churn, delivered to Slack, Microsoft Teams, and email.
sidebar_order: 19
---

The weekly digest is a once-a-week recap, not an alert. Infrawrench Cloud sends one message per organization summing up the week that just ended. It goes to the same [Slack](./slack-alerts.md) and [Microsoft Teams](./teams-alerts.md) channels you already use for alerts, and can also go to an email list.

## What's in it

Each digest covers the last complete Monday-to-Sunday week:

- **Total spend** for the week, with the change from the week before, in amount and percentage. Organizations with more than one currency get a line per currency.
- **Top movers**: the three providers and three services whose spend changed most week over week, from your [cloud costs](./cloud-costs.md).
- **Sync incidents** opened during the week.
- **Resources added and removed** during the week.
- **Projected spend**: what those additions and removals do to your _monthly run rate_, using the same [cost estimates](./cost-estimates.md) as the create form. This is separate from the spend total, since a cluster started last Sunday barely shows in last week's bill but is most of next month's. Left out when nothing that changed could be priced.
- **Biggest cost move**: the single change that moved the run rate most, from [cost per change](./cost-per-change.md), with the charge type and the period it was measured over. This is what your provider's own daily billing says one specific change did. Left out when nothing in the week could be measured (which doesn't mean nothing moved).
- **Seats**: how many paid SaaS seats are inactive, duplicated across tools, or on a pricier tier than needed, and what they'd save each month. See [SaaS seats](./saas-seats.md). Left out when there are none.
- **Realized savings**: what your optimization actions actually saved last week and so far this year, next to what they were expected to save, and how many are falling short. See [Realized savings](./realized-savings.md). Left out until something has been realized.
- **Delivery**: last week's [DORA metrics](./dora-metrics.md) for production: deploy count (next to the week before), median lead time, change failure rate and median time to restore. Figures that couldn't be measured are left out rather than shown as zero. The line is skipped if you deployed nothing in either week, and you can turn it off in the Delivery settings.
- Optionally, an **AI-written opening paragraph** summing up what changed (off by default, see below).

Weeks with no cost data say so instead of showing zeros. That usually means you haven't connected an account with cost collection yet.

> **Cloud only.** The desktop app doesn't send digests.

## Turn it on

1. Go to **Settings > Notifications** and open the **Alerts & digest** tab.
2. In the Weekly digest section, tick **Send a weekly digest**.

The first digest arrives at the next scheduled time. Turning it on mid-week doesn't send an old one straight away. To see one now, press **Send now**. It sends last week's digest immediately, which is also the quickest way to check everything is set up.

![Settings > Notifications Alerts & digest tab showing the Weekly digest section: the enable checkbox ticked, the send day / hour / time zone controls, the AI summary checkbox, the email recipient list, and the last-attempt status line](https://agent-assets.infrawrench.com/docs-screenshots/features/weekly-digest/digest-settings.png)

These settings apply to your whole organization and need the **Organization settings** permission, the same as Slack and Teams routing.

## Choose when it arrives

Pick a **day of the week**, an **hour** and a **time zone**. The default is Monday at 07:00 UTC.

The time zone also sets where your week starts and ends. The digest always covers the last full Monday-to-Sunday week **in that zone**, so an organization on `Asia/Tokyo` gets its week several hours before one on `America/Los_Angeles`.

Daylight saving changes are handled for you, and the digest keeps its local send time:

- If your send hour is skipped when clocks go forward, the digest goes out at the next hour instead (up to an hour late, never skipped).
- When clocks go back, the repeated hour doesn't send a second digest.

A later send day doesn't change what counts as a week. A Wednesday digest still covers the previous Monday to Sunday, not the last seven days, so it matches the cost dashboards.

Cost data is recorded per day, so if you're far from UTC, a few hours of spend may land in the neighbouring week. Both weeks are still reported in full, and nothing is lost.

If the digest couldn't go out at its scheduled time, it's sent as soon as possible, still covering the last full week, rather than skipped. You never get the same week twice, and changing the schedule never resends a week that already went out.

## Choose where it goes

### Slack and Teams

The digest follows your [alert routing](./alert-routing.md) under the **Weekly digest** trigger. To send it somewhere specific (say `#finance` gets the digest and budget alerts while `#ops` only gets sync failures):

1. In **Settings > Notifications**, go to the **Alert routing** section.
2. Add a rule whose **Trigger** condition is **Weekly digest**.
3. Pick the Slack channels or Teams webhooks under **Send to**.

<insert [The Alert routing section with a rule whose Trigger condition is Weekly digest and two Slack channels ticked under Send to] here>

Until you add rules, every trigger except Drift goes to every connected channel, so a new organization's digest reaches all of them. Nothing sends until you turn the digest on.

Two things don't follow routing:

- **Mobile push isn't a destination.** The digest only goes to channels and email, and a rule that sends it to push drops it.
- **Quiet hours never hold it back.** It already runs on its own schedule.

### Email

The Weekly digest section also has an **email recipient list**. These addresses get the same digest as a formatted email.

The list is for the whole organization, not per person, so an address doesn't need to belong to an Infrawrench user. A `finance@` alias or a mailing list works fine and reaches people who never sign in.

![The email recipient list in the Weekly digest section with two addresses listed and the add-recipient field below](https://agent-assets.infrawrench.com/docs-screenshots/features/weekly-digest/email-recipients.png)

If your deployment has no mail provider set up, the section says so and email recipients get nothing.

**Self-hosting:** email goes out through [Mailgun](https://www.mailgun.com/), so set `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` and `EMAIL_FROM` on the server, plus `MAILGUN_API_BASE` if your Mailgun account is in the EU region. Without them, email is skipped and the digest still reaches Slack and Teams.

## Add an AI summary paragraph

Tick **Add an AI-written summary paragraph** to put a short, plain opening above the numbers: two or three sentences on what moved and which provider or service explains it.

It's off by default, so none of your data goes to a model unless you choose it. Only the digest's own content is sent: currency totals, week-over-week changes, mover names with their spend, and the three counts. Resource details, account metadata and credentials never leave your deployment.

If the summary can't be written (for example, the deployment has no AI key set up), the digest still sends without it.

<insert [A weekly digest message rendered in Slack with the AI summary paragraph on top, followed by the spend total with delta, top movers by provider and service, and the reliability and resources lines] here>

## Fix a digest that didn't arrive

The Weekly digest section shows how the most recent attempt went, so you can spot a digest that stopped arriving:

| Status                         | What it means                                                                    | What happens next                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivered to every destination | Everything landed.                                                               | Nothing to do.                                                                                                                             |
| Only partly delivered          | Some destinations took it, some rejected it.                                     | **Not retried automatically**, since that would post it twice where it already landed. Fix the failing destination and press **Send now**. |
| Failed to send                 | Nothing landed anywhere.                                                         | Retried automatically a few times. If those all fail, it waits until next week and the reason stays on screen.                             |
| Nowhere to go                  | The digest is enabled but no channel is ticked and no email recipient is listed. | Add a destination.                                                                                                                         |

The status line also shows when the last attempt ran, which week it covered, and when the next retry is due if one is pending.

## On your phone

In the [mobile app](./mobile-app.md), **Settings > Notifications** has the on/off switch, the **AI summary paragraph** option, **Send now**, and the same last-attempt status. The schedule and email recipient list are shown read-only. Change the send day, hour, time zone or recipients on the web app.
