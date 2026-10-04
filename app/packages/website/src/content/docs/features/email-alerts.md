---
title: Email alerts
description: Email budget, anomaly, cost change, commitment and any other alert to org members or approved addresses, with a link back to Infrawrench and one-click unsubscribe.
sidebar_order: 18
---

Infrawrench Cloud can email its alerts. Email sits beside [Slack](./slack-alerts.md), [Microsoft Teams](./teams-alerts.md), [mobile push](./mobile-push-notifications.md) and Twilio SMS as a delivery channel, and reaches people who live in their inbox: a finance team watching a budget, an engineering manager who wants to hear about commitment renewals, or a `finance@` alias with no Infrawrench login.

> **Cloud only.** Alerts are sent by the cloud's background poller as costs are collected and evaluated. The desktop app edits the same cloud configuration when signed in to your organization.

## Two ways to address an email

**On the alert itself.** Budgets, [cost change alerts](./cost-change-alerts.md), [cost anomaly detection](./cost-anomaly-alerts.md) and the [commitment and unit-cost alert settings](./commitment-and-unit-cost-alerts.md) each have an **Email recipients** field. Whoever is listed there is emailed every time that alert fires, **in addition to** whatever your routing rules do. These recipients are not subject to the rules: a rule that swallows budget alerts does not silence the budget's own recipient list, and quiet hours do not hold it. The person who put an address on a budget asked for exactly that budget's alerts at that address.

<insert [The budget editor with the Email recipients field filled in: two members picked from the member list and one extra address (finance@acme.com) as chips, under the alert thresholds] here>

**Through alert routing.** Every [alert routing rule](./alert-routing.md) can send to email, for any trigger: sync failures, probes, metric alerts, incidents, the lot. Under a rule's **Send to** checkboxes, pick members or add addresses. Email destinations follow the rule like any other destination: quiet hours hold them, and they can be an escalation target. Email has no acknowledge button, so a rule routed only to email always escalates, the same as Teams and push.

When both name the same person, they get one copy.

## Members and extra addresses

- **Members** are picked from your organization's member list. Infrawrench stores the member, not the address, and reads their current sign-in address at send time: someone who changes their email keeps receiving alerts, and someone who leaves the organization stops the moment their membership ends. A former member shows as such in the editor, and saving a routing rule that still names one asks you to remove them.
- **Extra addresses** are for anyone without a login. They are checked against your organization's external-address policy (below) when you save and again every time an email is sent.

Typing a member's own address adds the member rather than the address.

## Who extra addresses can be

By default an extra address must be on a domain one of your members signs in with. If your members sign in as `@acme.com`, `finance@acme.com` is fine and `someone@gmail.com` is refused. This matters because anyone who can edit a budget or cost alert can add recipients, and alert emails carry spend figures; without the check, that permission would be a way to send your costs to any inbox.

An admin can change this under **Settings → Notifications → Email**:

- **Only our own domains** (the default), optionally with extra **allowed domains**, such as a finance agency you work with. Subdomains are not included automatically: allowing `acme.com` does not allow `mail.acme.com`.
- **Any address.**

Tightening the policy never edits a recipient list. An address that no longer qualifies just stops receiving, and starts again if the policy is loosened.

<insert [Settings → Notifications with the Email connection selected: the "Only our own domains" option chosen, one allowed domain chip, and the Unsubscribed list with one address and its Resume email button] here>

## What the email looks like

Each alert is one email per recipient (never one email with everyone on it), with a plain-text part and an HTML part:

- a subject such as `[Acme] Warning: Budget "Production" at 80%`, with the severity first so filters can sort on it
- the alert's title and full text, with a coloured severity badge
- a **View in Infrawrench** button that opens the budget, alert or page the email is about
- a footer naming the address it went to and why (for example, "you are on the recipient list of the budget "Production""), with a **Manage alert email** link and an **Unsubscribe** link

<insert [An example budget alert email in a mail client: the Warning badge, the title, the alert text, the View in Infrawrench button and the footer with Manage alert email and Unsubscribe links] here>

## Unsubscribing

Every email has an unsubscribe link, and mailbox providers that support one-click unsubscribe (Gmail, Outlook, Apple Mail) show their own Unsubscribe button. Unsubscribing stops **all** alert email from that organization to that address, whichever budget, alert or rule names it. It does not affect other organizations or the [weekly digest](./weekly-digest.md), which has its own recipient list.

Unsubscribed addresses are listed under **Settings → Notifications → Email**, where an admin can resume delivery. Only do that for someone who asked for it.

## Requirements

Email needs a mail provider configured on the deployment. Infrawrench Cloud has one. A self-hosted deployment uses the same Mailgun settings as the weekly digest (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `EMAIL_FROM`, and optionally `MAILGUN_API_BASE` for EU accounts) and `APP_URL` for the links. Without them, recipient lists can still be saved, the editors say that nothing is sent yet, and every other channel keeps working.

## Permissions

| What                                     | Permission            |
| ---------------------------------------- | --------------------- |
| A budget's recipients                    | Budgets (write)       |
| A cost change alert's recipients         | Costs (write)         |
| Anomaly and commitment alert recipients  | Costs (write)         |
| Email destinations on routing rules      | Organization settings |
| External-address policy and unsubscribes | Organization settings |

## Mobile

The mobile app's budget editor has the same Email recipients field (tap members, type extra addresses). Cost change alerts on mobile show how many people each one emails. The routing rules editor and the external-address policy are web and desktop only, like the rest of alert routing.

## From the CLI, MCP and Terraform

`infrawrench routing` shows email destinations in each rule, and `infrawrench routing email` prints the external-address policy and who has unsubscribed (add `--json` for scripts). See [the CLI](./cli.md).

The MCP and chat tools `create_budget`, `update_budget` and `create_cost_alert` accept `emailRecipients`, and `list_alert_email_options` lists the members and policy to pick from.

In the [Terraform provider](./terraform-provider.md), `infrawrench_budget`, `infrawrench_cost_alert`, `infrawrench_anomaly_settings` and `infrawrench_efficiency_alert_settings` take `email_member_ids` and `email_addresses`; `infrawrench_alert_routing` destinations take the `email-member` and `email-address` kinds; `infrawrench_alert_email_settings` manages the policy; and the `infrawrench_members` data source looks up member ids by email.
