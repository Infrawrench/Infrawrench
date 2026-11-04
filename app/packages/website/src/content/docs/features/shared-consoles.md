---
title: Shared consoles
description: Put a colleague on a live SSH session with one driver at a time, observers who can't type, a short-lived invite, and an audit entry for every join and handover.
sidebar_order: 7
---

Debugging production is often a two-person job, but rarely a two-terminal one. **Shared consoles** let you put someone else on a session you already have open. They see the same terminal live, and you can hand them the keyboard when it's easier for them to type than to dictate.

![The web SSH terminal with the Share panel open: the invite link field, the participant list showing one driver and one observer with their role badges, and the Revoke share button](https://agent-assets.infrawrench.com/docs-screenshots/features/shared-consoles/share-panel.png)

## Share a session

1. Open an [SSH terminal](./ssh-terminal.md) in the web app and wait for the shell.
2. Click **Share** in the bar above it.
3. Choose whether to **Allow handing over the keyboard**:
   - **On** (the default): you can pass control to a guest, and take it back at any time.
   - **Off**: a strictly read-only share. Nobody but you can ever type into this session, and the server enforces it.
4. Copy the invite link and send it to your colleague however you normally would.

## Join a session

The link opens a join screen showing the host, who's sharing, and whether you'd be able to type. You always join as an **observer**.

![The shared-console join screen showing the host and username, who is sharing, and the "Join as observer" button](https://agent-assets.infrawrench.com/docs-screenshots/features/shared-consoles/join-screen.png)

Once you're in, you see the terminal live. If handover is on, click **Ask for keyboard**. The driver or the sharer can grant it. Nothing changes until one of them does.

## Who can join and type

This hands someone a shell on a production machine, so here's exactly what protects you.

**The invite link isn't access.** It only points to the session. To join, you must be signed in, be a member of that organization, and have the same permission (`resources:execute`) you'd need to open a terminal on that resource yourself. A link forwarded to someone outside the organization, or to a member who can't open terminals, does nothing. Remove `resources:execute` from a role and you remove both direct terminals and shared consoles at once.

**Observers can't type.** Their keystrokes are dropped by the server before they reach the host. It isn't just a disabled input box, so a modified client gets the same result.

**One person drives at a time.** If two people accept a handover at the same moment, only one gets the keyboard and the other is told it already moved.

**Permissions are re-checked during the session.** If someone's role is narrowed, their [break-glass elevation](../team-and-billing/break-glass-access.md) runs out, or they're removed from the organization while on a shared shell, they're disconnected within about thirty seconds.

**Invites are short-lived and single-use.** A link lasts fifteen minutes by default (up to two hours) and is used up by the first person it lets in. To invite a second guest, create a second link. You can withdraw an unused invite at any time without affecting anyone already on the console. People already on the console can reload or reconnect without a new link.

**Revoking cuts the connection.** Revoking the share disconnects every guest. Removing one participant disconnects that person and stops their terminal feed. Your own session keeps running either way. This takes effect within about two seconds.

**You're not the only one who can revoke.** Anyone with `org:settings:write` can revoke a share too, so your security team can always stop a live session.

**Everything is logged.** Every share, join, leave, handover, removal and revocation goes into the [audit log](../team-and-billing/audit-log.md) with the host, the resource and both people involved.

**API keys can't share or join.** Only people can. An API key can list which sessions are currently shared, but it can't use an invite.

## Recording

If your organization has [SSH session recording](./session-recording.md) turned on, a shared session is recorded just like a solo one, and the recording knows everyone who was on it.

- The recording lists every participant and the highest role they held, so it still names people after they leave the organization.
- The `.cast` file has asciinema **marker** events on the timeline: when each person joined, when the keyboard moved and to whom, when someone left, and when the share was revoked. It still plays in `asciinema play` and any other viewer.

So the recording answers not just "who opened this session" but "whose hands were on this machine".

## Terminal size

The terminal has one size, and that's **the driver's**. Everyone else sees the driver's screen scaled to fit their window, with bars at the edges, never reflowed. That way observers see exactly what the driver sees, and nobody watching can shrink the driver's terminal. When the keyboard moves, the terminal resizes to the new driver's window.

## Where this works

Shared consoles are **cloud only, and web only for now**. Desktop sessions against a local account connect straight from your machine, so they can't be shared. Desktop cloud mode terminals aren't supported yet. The mobile app doesn't offer shared consoles; see the [mobile app](./mobile-app.md) page for what it leaves out.

## Limits

- **You can share once the shell is open.** The **Share** button is disabled until the terminal connects.
- **A share belongs to one live session.** Closing the terminal ends the share. Reopen it and you'll need to share again with a new link.
- **A guest whose connection can't keep up is dropped**, so the person fixing production is never slowed down by someone watching on hotel wifi.
- **If a guest sees "this session is being served by a server instance we could not reach"**, ask the sharer to reopen the terminal and send a new link. This can occasionally happen, for example during a deploy.

## What this isn't

Shared consoles don't inspect what the driver types or block anything based on it. There's no "are you sure you want to run that" check. If you need one person's actions checked by another, use a read-only share (nobody but the sharer can type) or [break-glass access](../team-and-billing/break-glass-access.md) (a second person approves the elevation before the session starts).
