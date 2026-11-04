---
title: Email alerts
description: Email budget, anomaly, cost change, commitment and any other alert to org members or approved addresses, with a link back to Infrawrench and one-click unsubscribe.
sidebar_order: 18
---

Infrawrench Cloud can send its alerts by email, alongside [Slack](./slack-alerts.md), [Microsoft Teams](./teams-alerts.md), [mobile push](./mobile-push-notifications.md) and Twilio SMS. Use it to reach people who live in their inbox: a finance team watching a budget, an engineering manager who wants to hear about commitment renewals, or a `finance@` alias with no Infrawrench login.

> **Cloud only.** Alerts are sent from Infrawrench Cloud. When you're signed in to your organization, the desktop app edits the same settings.

## Choose who gets emailed

**On the alert itself.** Budgets, [cost change alerts](./cost-change-alerts.md), [cost anomaly detection](./cost-anomaly-alerts.md) and the [commitment and unit-cost alert settings](./commitment-and-unit-cost-alerts.md) each have an **Email recipients** field. Everyone listed there is emailed every time that alert fires, **in addition to** whatever your routing rules do. Routing rules and quiet hours don't apply to these recipients, so a rule that mutes budget alerts doesn't silence the budget's own recipient list.

<insert [The budget editor with the Email recipients field filled in: two members picked from the member list and one extra address (finance@acme.com) as chips, under the alert thresholds] here>

**Through alert routing.** Every [alert routing rule](./alert-routing.md) can send to email, for any trigger: sync failures, probes, metric alerts, incidents and everything else. Under a rule's **Send to** checkboxes, pick members or add addresses. Email destinations follow the rule like any other destination: quiet hours hold them, and they can be an escalation target. Email has no acknowledge button, so a rule that only sends to email always escalates, the same as Teams and push.

If both name the same person, they get one copy.

## Members and extra addresses

- **Members** are picked from your organization's member list. Emails go to their current sign-in address, so someone who changes their email keeps getting alerts, and someone who leaves the organization stops getting them as soon as their membership ends. Former members are marked in the editor, and if you save a routing rule that still names one, you're asked to remove them.
- **Extra addresses** are for anyone without a login. They're checked against your organization's external-address policy (below) when you save and again every time an email is sent.

Typing a member's own address adds the member rather than the address.

## Control which extra addresses are allowed

By default, an extra address must be on a domain one of your members signs in with. If your members sign in as `@acme.com`, then `finance@acme.com` is allowed and `someone@gmail.com` is refused. Alert emails include spend figures, so this stops anyone who can edit a budget from sending your costs to any inbox.

An admin can change this under **Settings > Notifications > Channels > Email**:

- **Only our own domains** (the default), optionally with extra **allowed domains**, such as a finance agency you work with. Subdomains aren't included automatically: allowing `acme.com` doesn't allow `mail.acme.com`.
- **Any address.**

Tightening the policy never edits a recipient list. An address that no longer qualifies just stops getting emails, and starts again if you loosen the policy.

<insert [Settings → Notifications with the Email connection selected: the "Only our own domains" option chosen, one allowed domain chip, and the Unsubscribed list with one address and its Resume email button] here>

## What the email looks like

Each recipient gets their own email (never one email with everyone on it), in plain text and HTML:

- a subject such as `[Acme] Warning: Budget "Production" at 80%`, with the severity first so filters can sort on it
- the alert's title and full text, with a coloured severity badge
- a **View in Infrawrench** button that opens the budget, alert or page the email is about
- a footer naming the address it went to and why (for example, "you are on the recipient list of the budget "Production""), with a **Manage alert email** link and an **Unsubscribe** link

<insert [An example budget alert email in a mail client: the Warning badge, the title, the alert text, the View in Infrawrench button and the footer with Manage alert email and Unsubscribe links] here>

## Unsubscribe

Every email has an unsubscribe link, and mail apps that support one-click unsubscribe (Gmail, Outlook, Apple Mail) show their own Unsubscribe button. Unsubscribing stops **all** alert email from that organization to that address, whichever budget, alert or rule names it. It doesn't affect other organizations or the [weekly digest](./weekly-digest.md), which has its own recipient list.

Unsubscribed addresses are listed under **Settings > Notifications > Channels > Email**, where an admin can resume delivery. Only do that for someone who asked for it.

## Requirements

Infrawrench Cloud sends email out of the box. If you self-host, email uses the same Mailgun settings as the weekly digest (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `EMAIL_FROM`, and optionally `MAILGUN_API_BASE` for EU accounts) and `APP_URL` for the links. Without them, you can still save recipient lists, the editors tell you nothing is being sent yet, and every other channel keeps working.

## Permissions

| What                                     | Permission            |
| ---------------------------------------- | --------------------- |
| A budget's recipients                    | Budgets (write)       |
| A cost change alert's recipients         | Costs (write)         |
| Anomaly and commitment alert recipients  | Costs (write)         |
| Email destinations on routing rules      | Organization settings |
| External-address policy and unsubscribes | Organization settings |

## Mobile

The mobile app's budget editor has the same Email recipients field (tap members, type extra addresses). On mobile, cost change alerts show how many people each one emails. The routing rules editor and the external-address policy are web and desktop only.

## From the CLI, MCP and Terraform

`infrawrench routing` shows email destinations in each rule, and `infrawrench routing email` prints the external-address policy and who has unsubscribed (add `--json` for scripts). See [the CLI](./cli.md).

The MCP and chat tools `create_budget`, `update_budget` and `create_cost_alert` accept `emailRecipients`, and `list_alert_email_options` lists the members and policy to pick from.

In the [Terraform provider](./terraform-provider.md), `infrawrench_budget`, `infrawrench_cost_alert`, `infrawrench_anomaly_settings` and `infrawrench_efficiency_alert_settings` take `email_member_ids` and `email_addresses`; `infrawrench_alert_routing` destinations take the `email-member` and `email-address` kinds; `infrawrench_alert_email_settings` manages the policy; and the `infrawrench_members` data source looks up member ids by email.
