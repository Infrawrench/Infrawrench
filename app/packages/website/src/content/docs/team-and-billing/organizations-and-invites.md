---
title: Organizations and invites
description: Share a workspace with teammates.
sidebar_order: 1
---

> The desktop app in local-only mode is single-user by design. Signed in to a cloud organization, the desktop app manages the same team from its Settings tab.

An **organization** is a shared workspace. Accounts, resources, dashboards, SSH keys, API keys, and audit logs all live under exactly one organization. You can belong to many organizations and switch between them from the workspace picker in the top-left.

<insert [Workspace switcher dropdown with two organizations listed] here>

## Invite a teammate

1. Go to **Settings → Team**.
2. Click **Invite member**.
3. Enter an email address, pick a role (see [Roles and permissions](./roles-and-permissions.md)).
4. Send.

The invitee gets an email with a link. They sign up (or sign in), and the org appears in their workspace picker.

Inviting teammates requires the paid plan — the [free plan](./billing-and-plans.md) is a single user, and the invite form will prompt you to upgrade.

On the paid plan, every member and pending invite occupies a [seat](./billing-and-plans.md) — counting both your monthly seats and any [prepaid capacity slots](./billing-and-plans.md#prepaid-capacity-slots). If all seats are taken, you'll be asked to confirm adding one (billed pro-rata) before the invite is sent — this needs billing permission, so a member who can invite but can't manage billing will be asked to get a billing admin to add the seat first.

If your capacity is entirely prepaid slots there is no monthly seat to add, so the prompt instead points you at **Settings → Billing** to buy another slot.

<insert [Invite form showing the "All seats are in use. Add a seat for $20/month and send the invitation?" confirmation prompt] here>

## Pending invitations

Pending invites show in **Settings → Team** with a **Resend** and **Revoke** button. Invites expire after 7 days.

## Removing a member

Owners can remove members from **Settings → Team**. Resources and accounts they created stay with the organization.

## Leaving an org

From the workspace picker, switch to the org, then **Settings → Leave organization**. You cannot leave if you are the last owner — promote someone else first.

## Renaming

Owners can rename the organization in **Settings → Organization**. URLs do not change; the name is for display only.
