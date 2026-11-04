---
title: Organizations and invites
description: Share an Infrawrench organization with teammates, manage invites, and remove or leave members.
sidebar_order: 1
---

> The desktop app in local-only mode is single-user. When signed in to a cloud organization, the desktop app manages the same team from its Settings tab.

An **organization** is a shared workspace. Accounts, resources, dashboards, SSH keys, API keys and audit logs each belong to one organization. You can be in several organizations and switch between them from the workspace picker in the top left.

![Workspace switcher dropdown with two organizations listed](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/organizations-and-invites/workspace-switcher.png)

## Invite a teammate

1. Go to **Settings > Team**.
2. Click **Invite member**.
3. Enter their email address and pick a role (see [Roles and permissions](./roles-and-permissions.md)).
4. Click **Send**.

They get an email with a link. Once they sign up or sign in, the organization shows up in their workspace picker.

Inviting teammates needs the paid plan. The [free plan](./billing-and-plans.md) is for a single user, and the invite form will prompt you to upgrade.

You can only invite someone into a role whose permissions you already have yourself, and only an owner can invite another owner. If the role picker won't let you choose a role, ask an owner to send that invite.

### Seats

On the paid plan, every member and pending invite takes a [seat](./billing-and-plans.md). That includes both monthly seats and any [prepaid capacity slots](./billing-and-plans.md#prepaid-capacity-slots).

If all your seats are taken, you're asked to confirm adding one (billed pro-rata) before the invite is sent. This needs billing permission, so if you can invite but can't manage billing, ask a billing admin to add the seat first.

If all your capacity is prepaid slots, there's no monthly seat to add. The prompt sends you to **Settings > Billing** to buy another slot instead.

<insert [Invite form showing the "All seats are in use. Add a seat for $20/month and send the invitation?" confirmation prompt] here>

## Pending invitations

Pending invites are listed under **Pending invitations** in **Settings > Team**, with the email, the role offered and when the invite expires. Invites expire after 7 days.

The only action is **Revoke**, and only members who can invite see it. There's no resend button, so to re-send a lapsed invite, revoke it and send a new one.

## Remove a member

Owners can remove members from **Settings > Team**. Any resources and accounts the member created stay with the organization.

## Leave an organization

Switch to the organization from the workspace picker, then go to **Settings > Leave organization**. If you're the last owner, you can't leave until you make someone else an owner.

## Rename an organization

Owners can rename the organization in **Settings > Organization**. URLs don't change, since the name is only for display.
