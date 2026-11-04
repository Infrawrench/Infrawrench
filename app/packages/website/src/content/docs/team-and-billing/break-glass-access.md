---
title: Break-glass access
description: Ask for extra Infrawrench permissions for a set number of minutes, with a reason. Someone else approves, and the access ends on its own.
sidebar_order: 4
---

This page covers **Infrawrench's own** permissions. For temporary roles **inside your clouds** (an AWS permission set, a GCP IAM role, a Kubernetes ClusterRole), see [Just-in-time access](../features/just-in-time-access.md).

Most people need a narrower everyday role than the widest thing they'll ever have to do. Break-glass access covers the gap without making everyone an admin. You ask for **specific permissions**, for a **set number of minutes**, with a **reason**. Someone else approves, and the access ends on its own.

![The Break-glass Access settings page showing the request form open: permission checkboxes with several already-held ones greyed out, a filled-in reason field, and the duration presets with "1h" selected](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/break-glass-access/request-form.png)

## Request access

Go to **Settings > Break-glass Access > Request access** and fill in three fields:

- **Permissions:** chosen from the same list as the [role editor](./roles-and-permissions.md). Permissions you already have are greyed out. A request made only of permissions you already hold is refused with an explanation.
- **Why:** at least a sentence. The approver reads it now, and a reviewer may read it months later. It's required.
- **For how long:** from 15 minutes up to 8 hours. Break-glass is for the incident in front of you. If someone needs access for longer, it's time to talk about their role.

The request goes to everyone your organization has [notifications](../features/slack-alerts.md) set up for: mobile push, Slack (with Approve and Deny buttons in the message) and Microsoft Teams, under the same **Pages** setting that carries workflow approvals. If nobody decides within an hour, the request expires and counts as a refusal.

You can withdraw your own pending request at any time. That's recorded as a withdrawal, not a denial, so a later review can tell the difference.

## Approve or deny a request

Anyone with `access:approve` sees the queue and can approve or deny, either from the settings page or straight from the Slack message.

Two rules always apply:

1. **You can't decide your own request.**
2. **You can't grant a permission you don't have yourself.** You can still deny a request for permissions above yours, so it never gets stuck.

If two people click Approve at the same moment, only one decision counts and the other person is told it was already decided.

## While access is active

An approved request shows under **Active elevations** with a countdown. The person has the extra permissions everywhere for that window: the web and desktop apps, the [HTTP API](./openapi.md) under their session, [SSH and other terminal sessions](../features/ssh-terminal.md), [AI chat](../features/ai-chat.md) and [MCP](../features/mcp.md) tools. There's no special mode to switch into.

The access stops exactly when the window ends.

**End now** removes active access immediately. Anyone with `access:approve` can use it, and so can the person holding the access, so giving it back never needs an approver.

![The Break-glass Access page with one live elevation at the top showing "Live, expires in 42m" and an "End now" button, and two rows in History beneath](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/break-glass-access/live-elevation-and-history.png)

## API keys don't get the extra access

Break-glass access is given to a **person**. [API keys](./api-keys.md) that person created only ever use their normal role and never pick up the extra permissions. The same goes for [custom graphs](../features/custom-graphs.md), which run on their author's behalf.

## Permissions

| Permission       | What it allows                               | In the Member role |
| ---------------- | -------------------------------------------- | ------------------ |
| `access:read`    | See the queue, live elevations and history   | Yes                |
| `access:request` | Raise and withdraw your own requests         | Yes                |
| `access:approve` | Approve, deny, and revoke anyone's elevation | No                 |

`access:approve` is not included in `team:role:write`. Changing someone's role and approving access during an incident are different jobs, so you can give people one without the other.

## Audit trail

Every step is in the [audit log](./audit-log.md): `access_request.create`, `.approve`, `.deny`, `.withdraw` and `.revoke`. Each entry includes the permissions, the duration, the reason and who decided. Denials and withdrawals are logged just like approvals.

## From the CLI

```
infrawrench access            # every request, with live elevations first
infrawrench access active     # only what is in force right now
infrawrench access --json
```

The CLI is read-only. Use it to answer the question you'll actually type at 3am: who has extra access right now? Raise and decide requests in the app.
