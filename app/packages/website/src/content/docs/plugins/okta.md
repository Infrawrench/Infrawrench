---
title: Okta
description: Manage Okta users, groups, apps, authorization servers, policies, network zones, API tokens, event hooks, custom domains and trusted origins, and read the System Log.
sidebar_order: 61
---

One Okta account in Infrawrench is one Okta org. Opening the account shows the org itself: its company details, System Log, sign-in metrics and rate-limit headroom.

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

## Credentials

Infrawrench accepts either of Okta's two ways in. Enter your **Okta Org URL** (`https://acme.okta.com`), then one of:

**API token.** In the Admin Console go to **Security → API → Tokens → Create token**. The token acts as the admin who created it: a Super Administrator token manages everything, a Read-only Administrator token can only browse.

**OAuth service app** (recommended for least privilege):

1. **Applications → Applications → Create App Integration → API Services**.
2. On the app's **General** tab, set **Client authentication** to **Public key / Private key** and add a key. Copy the private key (Okta shows it as a JWK; a PKCS#8 PEM also works).
3. On the **Okta API Scopes** tab, grant the scopes you need, for example `okta.users.manage`, `okta.groups.manage`, `okta.apps.manage`, `okta.authorizationServers.manage`, `okta.policies.manage`, `okta.networkZones.manage`, `okta.apiTokens.manage`, `okta.eventHooks.manage`, `okta.trustedOrigins.manage`, `okta.domains.manage`, `okta.orgs.manage` and `okta.logs.read`. Use the `.read` variants for a read-only account.
4. On the **Admin roles** tab, assign a role that covers the same objects.
5. In Infrawrench, enter the client ID and the private key. If you granted fewer scopes than the default list, list them under **Advanced options → Granted Scopes**, because Okta rejects a token request that asks for a scope it did not grant.

DPoP, which Okta turns on by default for new service apps, is handled automatically.

<insert [Okta add-account form showing the Org URL field with the API token and service app fields] here>

## Notable flows

- **User lifecycle**: the actions shown follow the user's status. A staged user can be activated, a locked-out user unlocked, a suspended one unsuspended. Deleting a user deactivates it first, as Okta requires.
- **Pickers instead of ids**: add a user to a group, assign a group to an app, or add a member to a group by picking from live lists. New users can join groups at creation.
- **Policies**: every policy type is listed, including app sign-in (access) policies. The detail page shows the rules in priority order, and rules can be activated or deactivated individually.
- **Custom domains**: the detail page lists the TXT and CNAME records Okta wants published, and **Verify** checks them. The domain's certificate expiry feeds the Expiry radar, and the CNAME is checked for dangling DNS.
- **System Log**: the org, users, groups, apps, policies and authorization servers each have a Logs tab filtered to that object.
- **Metrics**: the org's Metrics tab charts successful and failed sign-ins, app SSO, account lockouts, and rate-limit warnings and violations from the System Log, plus the current rate-limit headroom.
- **Rate limits as quotas**: Okta reports per-minute rate limits on every response. Infrawrench samples the users, groups, apps, System Log and authorization server families and tracks them on the Quotas surface.
- **Terraform export** for users, Okta-mastered groups, authorization servers, IP network zones, event hooks and custom domains with the official `okta/okta` provider.

<insert [Okta user detail view for a locked-out user showing the Unlock, Reset password and Sign out everywhere actions and the Groups table] here>

## Tips & limits

- Creating applications and policies is left to the Admin Console: both need sign-on-mode or policy-type specific settings. Existing ones can be renamed, toggled, reassigned and deleted here.
- Okta never returns an event hook's auth header value. **Edit** can set a new one; leave it blank to keep the current value. Changing the endpoint means verifying the hook again.
- Okta's status page is not machine readable; incidents come from Okta's Atom feed and are shown against every Okta account because the API does not say which cell an org is in.
