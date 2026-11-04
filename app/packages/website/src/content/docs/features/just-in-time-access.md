---
title: Just-in-time access
description: Time-boxed cloud roles. Ask for a role on an account for a set time with a reason, an approver says yes, the provider grants it, and Infrawrench removes it again when the time is up.
sidebar_order: 13
---

Just-in-time access lets people borrow a powerful cloud role for a short time instead of holding it all the time. Without it, teams tend to grant the wide role "just in case", and that's how an AWS organization ends up with forty people holding `AdministratorAccess` and nobody able to say why.

Here's how it works:

1. An admin writes a **policy**: which cloud roles can be requested, on which account, for how long, and who approves.
2. When someone needs a role, they **request** it with a reason.
3. An approver says yes, and Infrawrench asks the provider to grant the role.
4. When the time is up, Infrawrench removes it from the provider again.

This is for roles **inside your clouds**. [Break-glass access](../team-and-billing/break-glass-access.md) is the same idea for **Infrawrench's own** permissions and never touches a cloud.

<insert [The Just-in-time access workspace tab with one pending request at the top (Approve and Deny buttons visible), one active grant with its countdown under "Granted now", and a few ended requests in History] here>

## Supported providers

Grants are made through the provider's own API. Three providers support it today:

| Provider                               | What a grant is                                                                                        | Scope                             | Role                                                          | Expiry enforced by the provider?                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [AWS](../plugins/aws.md)               | An IAM Identity Center account assignment: the permission set, for the user, on that AWS account       | An AWS account in your org        | A permission set                                              | No. Infrawrench removes the assignment at expiry                              |
| [Google Cloud](../plugins/gcp.md)      | A project IAM binding carrying a time-bound IAM Condition (`request.time < …`)                         | A project                         | A predefined or custom IAM role (not Owner, Editor or Viewer) | **Yes.** Google stops honouring the binding on time even if nothing else runs |
| [Kubernetes](../plugins/kubernetes.md) | A RoleBinding in the namespace, or a ClusterRoleBinding for the whole cluster, named after the request | A namespace, or the whole cluster | A ClusterRole, or a Role in that namespace                    | No. Infrawrench deletes the binding at expiry                                 |

Each provider's page lists the permissions the connected credentials need. Every scope and role is a picker filled from the provider, so nobody types an ARN, a role name or a namespace.

Standing access is never touched. If the person already holds the role some other way when the request is approved (on AWS, where an assignment can't be told apart from a standing one), nothing is created and nothing is removed at the end. The request says so.

## Write a policy

Policies live in **Settings > Just-in-time Access** and need `org:settings:write`.

<insert [Settings, Just-in-time Access, with the policy editor open: an AWS account selected, two targets added (AdministratorAccess on production, ReadOnlyAccess on staging), a longest window of 2h, approvers set to an on-call rotation and a team role, and the incident self-approval box ticked] here>

A policy sets:

- **An account**: a connected AWS, Google Cloud or Kubernetes account.
- **What can be requested**: one or more scope and role pairs, each picked from the provider. People can only ask for exactly these.
- **Longest window**: up to 12 hours. Extensions count too: it's a limit on the whole window, not on each piece.
- **Default window**, and **how long an undecided request waits** before it times out. No decision counts as a denial.
- **Who can request**: members and team roles. Leave both empty to let any member with the `access:request` permission ask.
- **Approvers**: members, team roles and **on-call rotations**. A rotation means whoever is on call when the request is decided, so a policy written today still reaches the right person after Monday's handover. You need at least one approver.
- **Self-approval during an incident** (off by default): while a [declared incident](./incident-mode.md) is open, an approver can approve their own request, for themselves only. It's recorded as self-approved, with the incident, on the request and in the audit log.
- **Require a reason** (on by default, at least 10 characters) and **require a ticket**.

You can also manage policies with the `infrawrench_jit_access_policy` resource in the [Terraform provider](./terraform-provider.md).

Deleting a policy doesn't cut anyone off early: grants it already made still end on time. Its pending requests lose their approvers and time out.

## Request access

Open **Just-in-time access** from the sidebar and choose **Request access**.

<insert [The request form: a policy selected, the role and scope picked, the 1h duration chip pressed, "Granted to" showing the resolved Identity Center user, and a reason and ticket filled in] here>

1. Pick a policy and one of its roles.
2. Pick how long you need it.
3. Check **Granted to**. Infrawrench finds you in the provider by your email address: your Identity Center user, your Google account or your Kubernetes user name. If the provider knows you by a different name, pick yourself from the provider's list. Approvers are told when you weren't matched by your own email.
4. Give a reason (and a ticket, if the policy asks for one) and send it.

You can **cancel** a pending request at any time.

## Approve a request

Approvers hear about a request as soon as it's raised:

- **Slack**, with **Approve** and **Deny** buttons. Once someone decides, every copy of the message updates to say who decided and where. Slack users need to [link their account](./slack-alerts.md) once.
- **Microsoft Teams**, with a link to the request (Teams channel cards can't take a decision directly).
- **Mobile push**, with **Approve** and **Deny** on the notification. Tapping one opens the app on a confirmation that names who, what, where and for how long, so a lock-screen tap never hands out cloud access on its own.
- **In the app**, at the top of the Just-in-time access tab.

These follow your org's **Pages** notification setting, like workflow approvals and break-glass requests, and arrive even during quiet hours.

When you approve, the role is granted straight away and the request moves to **Granted now** with a countdown. You can **extend** an active grant (up to the policy's longest window in total) or **revoke** it early. The holder can always revoke their own grant, and so can anyone with `org:settings:write`.

### Who can decide

These rules apply wherever the decision comes from: the web, the desktop app, Slack, the phone or the CLI.

- You must be one of the policy's approvers **at that moment**: named directly, through your team role, or because you're on call on one of its rotations.
- You can't decide your own request (cancel it instead), except under the incident self-approval rule above.
- A request whose policy was deleted or turned off has no approvers.
- If two people decide at once, only one decision counts. The other person is told it was already decided.
- [API keys](../team-and-billing/api-keys.md) can't request, approve, deny, extend, cancel or revoke. They can read the queue and manage policies.

## When the time is up

Within about a minute of a grant's window ending, Infrawrench removes it from the provider and checks that it's gone.

If removal fails, or the provider still shows the grant, the request is marked **Revoke failed**. Infrawrench keeps retrying, eventually once an hour, and never gives up, because giving up would leave someone with access nobody approved. A revoke failure is also:

- raised as a **critical alert** through your [alert routing](./alert-routing.md) (the security findings trigger), on the first failure and roughly daily after that
- written to the audit log on every attempt
- flagged in the [access review](./access-review.md), along with any grant still marked as held more than ten minutes past its window

If the account has been disconnected, Infrawrench can't reach the provider, so the grant is flagged instead of forgotten. Remove it in the provider's console.

On Google Cloud, the binding's own IAM Condition has already ended the access by then, whatever happens to the revoke.

## Audit trail

Every step is in the [audit log](../team-and-billing/audit-log.md) under `jit_access.*`: requested, approved (with `selfApproved` and the incident when it applies), denied, cancelled, timed out, granted, already held, extended, revoked, expired, grant failed and every failed revoke. Each entry names the account, scope, role and principal, and where the action came from. Policy changes are logged as `jit_access.policy.create`, `.update` and `.delete`.

## Mobile

The [mobile app](./mobile-app.md) can do everything except write policies: request access (from a policy, with chips for the role and duration), approve, deny, extend, revoke and cancel. Find it under **Settings > Just-in-time access**. Tapping a request notification opens that request.

<insert [The mobile Just-in-time access screen with a pending request card highlighted as "From your notification", showing the reason and the Approve and Deny buttons] here>

## CLI

`infrawrench jit` covers the queue and every action, and all of them take `--json`. (`infrawrench access` is break-glass.)

```sh
infrawrench jit                         # the queue, live grants and failed revokes
infrawrench jit --holding               # only what may be held upstream right now
infrawrench jit policies                # what you can request, and under which policy
infrawrench jit request --policy prod --role AdministratorAccess --for 2h \
  --reason "Restoring the orders table, INC-4417" --ticket INC-4417
infrawrench jit approve 3f2504e0        # an id prefix is enough
infrawrench jit deny 3f2504e0 --note "Use the read-only role"
infrawrench jit extend 3f2504e0 --by 30m
infrawrench jit revoke 3f2504e0
```

## Permissions

| Action                    | Needs                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| See requests and policies | `access:read`                                                                    |
| Request                   | `access:request`, and to be allowed by the policy                                |
| Approve, deny, extend     | `access:read`, and to be one of the policy's approvers at that moment            |
| Revoke                    | Being the holder, one of the policy's approvers, or holding `org:settings:write` |
| Write policies            | `org:settings:write`                                                             |

`access:read` and `access:request` are in the built-in Member role. Approving isn't a permission: you get it by being named as an approver in a policy.
