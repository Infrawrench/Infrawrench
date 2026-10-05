---
title: Single sign-on and directory sync
description: Sign in to Infrawrench through your identity provider with SAML or OIDC, require it for your domains, keep membership in step with your directory over SCIM, and map directory groups to roles.
sidebar_order: 2
---

Single sign-on lets your team sign in to Infrawrench through your company's identity provider (Okta, Microsoft Entra ID, Google Workspace, OneLogin, JumpCloud, or any SAML 2.0 or OpenID Connect provider). Directory sync (SCIM) adds people to the organization when your IT team adds them in the identity provider, and takes their access away the moment they are removed. Group to role mappings decide which role each person gets.

It lives at **Settings → Single Sign-On**. Reading the page needs `team:read`; every change needs `org:settings:write`, which only owners hold by default. Single sign-on is available on the paid plan.

<insert [Settings → Single Sign-On with a verified domain, an active Okta SAML connection, enforcement on with one break-glass owner ticked, and two group to role mappings] here>

## How it fits together

Infrawrench uses WorkOS for sign-in. The parts that belong to your identity provider (the SAML or OIDC connection and the SCIM directory) are set up by your IT admin in the **WorkOS Admin Portal**, a guided setup with instructions for each provider. You never paste a metadata URL or a SCIM token into Infrawrench. The Single Sign-On page opens the Admin Portal for you with a link that expires after five minutes, so you can finish the setup yourself or forward the link.

What Infrawrench keeps is everything your identity provider cannot know: which domains are enforced, who can still get in if the identity provider is down, and what each group means here.

## Set it up

1. Click **Set up single sign-on**. Nothing changes for anyone yet.
2. **Add your domain** (for example `acme.com`) and create the DNS TXT record shown, then click **Check DNS**. Or click **Let your IT admin verify** to hand domain verification to the Admin Portal. Only verified domains are enforced or provisioned.
3. Click **Connect an identity provider** and follow the Admin Portal for your provider. The connection shows as `active` when it is done.
4. To sync people from your directory, click **Connect a directory** and follow the Admin Portal again.

Once a connection is active, people with an email in your verified domains are sent to your identity provider when they sign in.

## Require single sign-on

Tick **Require single sign-on for verified domains** to make your identity provider the only way in for anyone whose email is in a verified domain. Password, magic-link and social sign-ins stop working for them in this organization, including sessions that were already open: the next request from such a session is refused, and the web app sends the person back through your identity provider. The desktop app and mobile app open sign-in at your identity provider automatically, and the CLI prints the `infrawrench login sso <org_…>` command to run.

People whose email is outside your verified domains (a contractor with their own address, say) are not affected. API keys are not affected either: enforcement governs how a person signs in, and a key has no sign-in. Directory deprovisioning revokes the keys of someone who leaves.

The checkbox is refused until every way back in exists:

- at least one domain is verified,
- a connection is active,
- at least one **break-glass owner** is chosen, and
- your own current session would still be let in (you signed in through the identity provider, you are a break-glass owner, or your email is outside the enforced domains).

### Break-glass owners

Break-glass owners are owners who can still sign in without SSO, for the day your identity provider is down or misconfigured. Choose up to five. They must hold the owner role at the moment they sign in; an owner who is demoted stops being exempt. Every session that gets in this way is written to the [audit log](./audit-log.md) as an SSO bypass.

Anyone else who needs in without SSO can ask through [break-glass access](./break-glass-access.md) for the `sso:bypass` permission. Only owners can approve it (admins do not hold it), and like every break-glass grant it lapses on its own. While enforcement blocks someone, they can still open the Break-glass Access page to file and follow their request.

## Directory sync

With a directory connected, tick **Provision and deprovision members from the directory** to let it change who is in the organization. Until you do, the directory is only observed, so you can preview the mappings below before anything happens.

When provisioning is on:

- **Added in the directory**: the person becomes a member, with the role the mappings give them. They do not need an invitation.
- **Removed or deactivated in the directory**: their membership ends immediately, every API key they created in this organization is revoked, and if this was their only organization their sessions are signed out.
- **Moved between groups**: their role follows at the next sync and at their next sign-in.

A few rules keep the directory from doing something you would not:

- Only emails in your **verified domains** are provisioned. Anyone else in the directory is listed as "Email outside verified domains" and left alone.
- The directory never removes the **last owner**. That person is listed as "Kept (last owner)" and the refusal is audit-logged.
- No seat is bought unless you tick **Add a seat when the plan is full**. Otherwise people past your seat count wait as "Waiting for a seat" until a seat is free and you sync again.
- Deleting a whole directory in WorkOS does not remove anyone. Reconnecting a directory should not empty the organization.

Changes arrive as they happen through a signed webhook. **Sync now** walks the whole directory, which also catches anything a webhook missed.

<insert [The Directory sync card with an active Okta SCIM directory, provisioning on, the default role picker, and the result of Sync now] here>

## Group to role mappings

Map a directory group to any role except owner: pick the group (the list comes from your directory) and the role. Mappings are applied on every directory sync and at each sign-in, to people the directory added or linked.

- **First match wins.** Mappings are evaluated top to bottom; use the arrows to reorder. Someone in two mapped groups gets the role of the higher one, and the preview flags them as a conflict.
- **No match falls back to the default role** (Member unless you choose another under Directory sync). Removing someone from your "Platform admins" group therefore takes the admin role away here too.
- **Owners are never changed** by the directory, and no group can grant the owner role. Owners are appointed by hand on the [Team page](./organizations-and-invites.md).
- You can only map a group to a role whose permissions you hold yourself, the same rule as assigning a role by hand.

Click **Preview** to see, for every person in the directory, their current role, the role the mappings would give them, and which groups matched.

<insert [The group to role mapping preview table with one row flagged as a conflict and two rows showing a role change] here>

## Audit log

Every part of this is recorded in the [audit log](./audit-log.md): setting up, adding, verifying and removing domains, opening the Admin Portal, settings changes, mapping changes, each sync, every member the directory adds or removes and every role it changes, refused deprovisions, connection and directory changes, and every SSO bypass.

## Manage it as code

The settings and the group to role mappings are Terraform resources, `infrawrench_sso_settings` and `infrawrench_sso_group_role_mapping`, with the `infrawrench_sso_directory_groups` data source to look a group up by name. See the [Terraform provider](../features/terraform-provider.md). To check the setup from a terminal, run `infrawrench access sso` (add `--json` for scripts).

## Self-hosting

The webhook endpoint is `/api/v1/webhooks/workos`. Create it in the WorkOS dashboard under **Webhooks**, subscribe it to the `dsync.*`, `connection.*` and `organization_domain.*` events, and set its signing secret as `WORKOS_WEBHOOK_SECRET`. Without it, directory changes only land when someone clicks **Sync now** or at a member's next sign-in.
