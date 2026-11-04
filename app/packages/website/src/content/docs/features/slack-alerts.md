---
title: Slack alerts and commands
description: Route alerts to Slack channels, approve or deny workflow and agent approvals with message buttons, and query costs and resource status with /infrawrench.
sidebar_order: 16
---

Infrawrench Cloud can post your alerts into Slack. It works alongside Twilio SMS and voice, [mobile push](./mobile-push-notifications.md) and [Microsoft Teams](./teams-alerts.md), with the same triggers and thresholds. During working hours it's usually the one people actually read.

Slack also works both ways. Approval requests arrive with working **Approve** and **Deny** buttons, and the `/infrawrench` slash command answers cost and resource status questions without leaving the channel. For both, you first need to [link your Slack account](#link-your-slack-account).

> **Cloud only.** The desktop app has no Slack connection. A workflow page there shows up as a native OS notification instead.

## Connect a workspace

1. Go to **Settings > Notifications** and open the **Channels** tab.
2. Click **Add to Slack**.
3. On Slack's approval screen, choose the workspace and confirm the permissions.

Slack sends you back to Infrawrench and the workspace shows as connected.

The install link is tied to you and your browser, and expires after 30 minutes. If you start from the desktop or mobile app, the link opens in your browser, which asks you to sign in to Infrawrench if you aren't already. Forwarding the link to someone else won't work; they need to click **Add to Slack** themselves.

![Settings > Notifications page showing the Slack section before connecting, with the Add to Slack button visible](https://agent-assets.infrawrench.com/docs-screenshots/features/slack-alerts/slack-before-connect.png)

Infrawrench asks for six scopes and nothing else:

| Scope               | Why                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `chat:write`        | Post the alert messages                                                                     |
| `chat:write.public` | Post to a public channel without having to be invited to it                                 |
| `channels:read`     | List public channels so you can pick one from a menu                                        |
| `groups:read`       | List private channels the app has been invited to                                           |
| `commands`          | Register the `/infrawrench` slash command                                                   |
| `files:write`       | Upload a [scheduled dashboard's PDF](./dashboard-pdf.md) into the delivery message's thread |

If you connected before `files:write` was added, everything keeps working, but scheduled dashboard deliveries post their summary and link without the PDF. Disconnect and reconnect Slack to grant the new scope.

Infrawrench never reads message history and never posts as you. Messages come from the Infrawrench app.

**Self-hosting?** You need a Slack app registered against your own deployment:

- Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` on the server, and set the app's redirect URL to `https://<your-host>/api/slack/oauth/callback`. Until you do, the Slack section says Slack isn't set up on this server and the button is hidden.
- For buttons and slash commands, also set `SLACK_SIGNING_SECRET`, create a slash command named `/infrawrench` pointing at `https://<your-host>/api/slack/commands`, and enable Interactivity with request URL `https://<your-host>/api/slack/interactions`. Without the secret, alerts still send but every incoming Slack request is refused.

## Choose channels

Click **Add a channel** and pick from the list. It comes straight from your workspace, so there are no channel IDs to look up. Add as many as you like.

Each channel you add is a **destination**. Which alerts reach it is up to your [alert routing rules](./alert-routing.md). That's how a `#finance` channel can get budget crossings without every sync failure, or only the crossings over $500 on the production account.

Until you write a rule, **everything except resource drift** goes to every connected channel, so a channel you add today starts getting alerts straight away. Drift is left out because it's a continuous feed rather than an occasional event. You set what counts as drift, and how often a digest can go out, in **Settings > Notifications > Resource drift alerts**.

Routing applies to the whole organization (unlike mobile push toggles, which each member sets for themselves), so changing it needs the **Organization settings** permission.

![Settings > Notifications Slack section with a workspace connected and two channels listed, above the Alert routing card that decides what reaches them](https://agent-assets.infrawrench.com/docs-screenshots/features/slack-alerts/slack-connected-channels.png)

**Private channels need an invite.** Slack won't let an app post into a private channel it isn't a member of. Invite the app first (`/invite @Infrawrench` in Slack), then add the channel here. If you skip this, delivery fails with `not_in_channel`. The **Send test message** button shows that error as is, so you can tell it apart from a real outage.

## What the messages look like

Each alert is a short block: the headline in bold and the alert text below. Budget alerts, drift digests, pages and approval requests also get a **View in Infrawrench** button that opens the budget, the change timeline, the workflow or the approvals inbox. Link previews are turned off, so an alert about a URL doesn't pull an unfurled card into the channel.

An **approval request** includes everything you need to decide without opening the app: what's being approved, the workflow and run that raised it, whether a person or a schedule started that run, and when the request expires (no decision counts as a denial). It has **Approve** and **Deny** buttons, plus a **View in Infrawrench** button that opens **Settings > Approvals**.

## Link your Slack account

Alerts go out to channels, but anything coming back, like a slash command or an Approve click, has to be tied to a specific member. You do this once by linking your Slack user to your Infrawrench account.

1. Run `/infrawrench link`. (Pressing any Approve or Deny button, or running any command, while unlinked does the same.)
2. Slack replies, only to you, with a link.
3. Open it. Sign in to Infrawrench if asked. You'll see a confirmation page naming your Slack user and the organization.
4. Click **Link account**.

The link expires after 15 minutes. Run `/infrawrench link` again for a fresh one.

<insert [Slack ephemeral message shown to an unlinked user, with the "Link your account to <org>" URL visible] here>

`/infrawrench unlink` removes the link. Links are per organization and per workspace. If someone leaves the organization, their link stops working on its own.

## Approve from Slack

Approval requests arrive with **Approve** and **Deny** buttons. That covers a workflow waiting on `infra.waitForApproval(...)` and the [AI chat agent](./ai-chat.md) waiting on a destructive tool call.

Clicking a button works exactly like deciding on the web. The first decision wins, anyone else is told it was already decided, and an expired request can't be approved. The message then updates to show who decided and how, with a threaded reply for the channel's history. This also happens when someone decides from the web instead.

<insert [A Slack approval message for a workflow run with Approve and Deny buttons, next to the same message after approval showing "Approved by <name> via Slack" and the threaded reply] here>

Who can click the buttons matches the web:

- **Workflow approvals** need the **workflows:approve** permission, the same one the approvals inbox needs. It's separate from permission to write workflows.
- **Chat agent tool approvals** can only be decided by the person who owns that conversation. Once decided from Slack, the agent carries on just as it would after a web decision.

Buttons only decide approvals that already exist. Destructive actions sit behind the same approval policy everywhere, and Slack can't create or bypass one.

## Use slash commands

Anywhere in a connected workspace, linked members can run:

- **`/infrawrench costs`**: this month's spend so far, with the total (and how it compares to the previous period) plus the top services. Same numbers as the costs dashboard. Needs **costs:read**.
- **`/infrawrench status <resource>`**: a resource's type, account, when it last synced and its most recent change, with a link to the resource. Part of a name is enough. If several resources match, you get buttons to pick one. Needs **resources:read**.
- **`/infrawrench link`** / **`/infrawrench unlink`**: manage your account link.
- **`/infrawrench help`**: the list of commands.

Replies are only visible to you, whatever channel you ask in.

<insert [Slack showing the ephemeral /infrawrench costs reply with a month-to-date total, delta vs the previous period, and top services list] here>

## Turn it off

Removing a channel stops delivery to it and leaves the others alone. **Disconnect** removes the whole workspace and stops all Slack delivery for your organization. Your channel choices are kept, so reconnecting the same workspace later restores them.

Disconnecting doesn't uninstall the app from Slack. To remove it there too, use your workspace's **Manage apps** page.

## The paging switch

Sync failure incidents follow your organization's **Paging enabled** switch on the same settings page. Turning it off silences incidents everywhere, Slack included. Budget alerts, anomalies, drift digests, pages and approval requests aren't affected, just as with mobile push.
