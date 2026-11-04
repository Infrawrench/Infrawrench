---
title: Okta
description: Manage Okta users, groups, apps, authorization servers, policies, network zones, API tokens, event hooks, custom domains and trusted origins, and read the System Log.
sidebar_order: 61
---

Connect an Okta org to manage users, groups, apps and policies, read the System Log, and find seats you're paying for but nobody uses. One Okta account in Infrawrench is one Okta org. Opening it shows the org: its company details, System Log, sign-in metrics and rate-limit headroom.

## What you can manage

- The org's company details and support contacts
- Users (create, edit profile, activate, suspend, unlock, reset password or MFA, sign out everywhere, deactivate, delete, group membership)
- Groups (create, rename, add and remove members)
- Applications (rename, activate or deactivate, assign and unassign groups, delete)
- Authorization servers (create, edit audience and description, activate, rotate signing keys, add and delete custom scopes)
- Policies of every type with their rules (rename, reprioritize, activate or deactivate policies and rules)
- Network zones (create IP zones and blocklists, edit gateways and proxies, activate, delete)
- API tokens (see owner, origin and expiry, revoke)
- Event hooks (create, edit events and endpoint, verify, activate, delete)
- Custom domains (add, see the DNS records to publish, verify, delete)
- Trusted origins (create, toggle CORS and redirect, activate, delete)

## Connect your account

Enter your **Okta Org URL** (`https://acme.okta.com`), then use one of these two options.

**API token.** In the Admin Console, go to **Security > API > Tokens > Create token**. The token acts as the admin who created it. A Super Administrator token manages everything. A Read-only Administrator token can only browse.

**OAuth service app** (best for least privilege):

1. Go to **Applications > Applications > Create App Integration > API Services**.
2. On the app's **General** tab, set **Client authentication** to **Public key / Private key** and add a key. Copy the private key (Okta shows it as a JWK, and a PKCS#8 PEM also works).
3. On the **Okta API Scopes** tab, grant the scopes you need, for example `okta.users.manage`, `okta.groups.manage`, `okta.apps.manage`, `okta.authorizationServers.manage`, `okta.policies.manage`, `okta.networkZones.manage`, `okta.apiTokens.manage`, `okta.eventHooks.manage`, `okta.trustedOrigins.manage`, `okta.domains.manage`, `okta.orgs.manage` and `okta.logs.read`. Use the `.read` versions for a read-only account.
4. On the **Admin roles** tab, assign a role that covers the same objects.
5. In Infrawrench, enter the client ID and the private key. If you granted fewer scopes than the list above, list them under **Advanced options > Granted Scopes**, or Okta will reject the connection.

DPoP, which Okta turns on by default for new service apps, works without any extra setup.

<insert [Okta add-account form showing the Org URL field with the API token and service app fields] here>

## Day-to-day tasks

- **Manage the user lifecycle**: the actions you see depend on the user's status. You can activate a staged user, unlock a locked-out one, or unsuspend a suspended one. Deleting a user deactivates it first, as Okta requires.
- **Pick from lists, not ids**: add a user to a group, assign a group to an app, or add a member to a group by picking from live lists. New users can join groups when you create them.
- **Review policies**: every policy type is listed, including app sign-in (access) policies. The detail page shows the rules in priority order, and you can turn rules on or off one at a time.
- **Set up custom domains**: the detail page lists the TXT and CNAME records Okta wants published, and **Verify** checks them. The domain's certificate expiry shows on the Expiry radar, and the CNAME is checked for dangling DNS.
- **Read the System Log**: the org, users, groups, apps, policies and authorization servers each have a Logs tab filtered to that object.
- **Watch metrics**: the org's Metrics tab charts successful and failed sign-ins, app SSO, account lockouts, and rate-limit warnings and violations, plus the current rate-limit headroom.
- **Track rate limits**: Okta's per-minute rate limits for users, groups, apps, System Log and authorization servers show on the Quotas page.
- **Export to Terraform**: users, Okta-mastered groups, authorization servers, IP network zones, event hooks and custom domains, for the official `okta/okta` provider.

<insert [Okta user detail view for a locked-out user showing the Unlock, Reset password and Sign out everywhere actions and the Groups table] here>

## Seats

Every licensed Okta user shows on the **Seats** page. It flags users nobody signs in as and people holding more than one identity provider seat, and adds up what removing them would save.

- **Who counts as a seat**: a user who has been activated and not deactivated. That's active, password reset, password expired, locked out, suspended (suspending keeps app assignments, so it doesn't free the licence), and pending user action (activated but never finished setting up). Staged users (never activated) and deactivated users don't count. Okta doesn't publish which statuses it bills, so this is the rule used.
- **Activity**: Okta's **last sign-in** for the user. A user who has never signed in is called idle once their account is older than your threshold, counted from when it was activated (or created, if it never was).
- **Price**: set your contract's per-user monthly price as **Seat price** under **Advanced options** on the account. Without it, each user is estimated at Okta's lowest published Workforce Identity price, $6 per user per month for Starter (billed annually; okta.com/pricing, October 2026), and labelled as an estimate.
- **Remove** deactivates the user. This can't be undone cleanly: Okta deprovisions every app assignment, which can delete the user's data in those apps, and reactivating them later doesn't restore the assignments. The licence frees up at once, but Okta contracts are annual, so the saving shows at your next true-up or renewal.
- **Cheaper tier**: never suggested, since Okta doesn't say which suite you're on.
- **Scopes**: `okta.users.read` to read seats, `okta.users.manage` to remove them. An API token from an admin who can manage users works for both.
- [Remediation commands](../features/remediation-commands.md) for a flagged user are `curl` calls with an API token (`$OKTA_API_TOKEN`): show the user, then deactivate them.

## Tips and limits

- Create applications and policies in the Admin Console, since both need settings specific to their sign-on mode or policy type. You can rename, toggle, reassign and delete existing ones here.
- Okta never shows an event hook's auth header value. **Edit** can set a new one. Leave it blank to keep the current value. If you change the endpoint, verify the hook again.
- Okta incidents show on every Okta account, because Okta doesn't say which cell your org is in.
