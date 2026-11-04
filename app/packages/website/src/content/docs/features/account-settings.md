---
title: Account settings
description: Change your name, email and password, set up two-factor authentication, manage active sessions, or delete your account from Settings > General.
---

**Settings > General** is for your personal account, not your organization. Changes here follow you into every organization you belong to. Change your name or turn on two-factor here and it applies everywhere you sign in.

Your sign-in is handled by WorkOS. Infrawrench never stores your password.

![Settings → General showing the Profile, Password, Two-factor authentication, and Active sessions cards](https://agent-assets.infrawrench.com/docs-screenshots/features/account-settings/general-cards.png)

## Confirm it's you

Some actions need a **recent sign-in**, not just a valid session: changing your email, getting a password link, adding or removing two-factor, and signing out your other devices. If you last signed in more than ten minutes ago, you're sent through sign-in first and then brought back to the same page. Nothing you typed is submitted until you're back.

Sessions last a long time, and each of these actions could hand over your account for good, so a laptop left open shouldn't be enough. Everything else in settings works with any valid session.

## Update your profile

Edit your **first name** and **last name** and click **Save changes**. Your name appears in [team lists](../team-and-billing/organizations-and-invites.md), the [audit log](../team-and-billing/audit-log.md), and anywhere a resource records who changed it.

If your email shows as **Unverified**, click **Resend verification email** for a new link.

If you signed in with Google, Microsoft, GitHub, Apple or Salesforce, it shows under **Connected accounts**, and your starting email is the one that provider gave us.

### Change your email

Your email is what you sign in with, so changing it takes two steps.

1. Click **Change email** next to your address.
2. Enter the new address and click **Send confirmation code**.
3. Get the code from the **new** mailbox and enter it.

Nothing changes until you enter that code. If you close the dialog, mistype the address or never get the code, your account stays as it was, so you can't lock yourself out with an address you can't read. The code expires after a few minutes. Start again for a new one.

If the new address already belongs to another Infrawrench account, the first step fails and tells you.

> **If you sign in with Google or SSO**, changing your address here doesn't change it with that provider. You'll keep signing in through the provider as before. This only changes the address Infrawrench has for you. Make sure you can still get in before relying on it.

## Change your password

**Change password** opens a one-time link to a password page where you set a new one.

You can also use this to _add_ a password to an account that has only ever signed in with Google or SSO. That gives you a fallback if the identity provider is down. The link works once and expires, and you can get a new one any time.

## Set up two-factor authentication

Add a code from an authenticator app (TOTP) as a second step when you sign in.

1. Go to **Settings > General > Add authenticator app**.
2. Scan the QR code with your authenticator app, or copy the setup key and enter it by hand.
3. Type the six-digit code the app shows and click **Turn on two-factor**.

![Add authenticator app dialog showing the QR code, manual setup key, and six-digit code field](https://agent-assets.infrawrench.com/docs-screenshots/features/account-settings/add-authenticator-app.png)

Two-factor only turns on once you enter a valid code. If you close the dialog before that, it's discarded. You can add more than one app (say, a phone and a desktop client) so losing one device doesn't lock you out.

To remove an app, click **Remove** next to it. Removing your last one turns two-factor off.

> Whether two-factor is _required_ at sign-in, for you or for your whole organization, is a policy set in the WorkOS dashboard by whoever manages your authentication. Adding an app here makes two-factor available, but doesn't force it on its own.

## Manage active sessions

This lists everywhere you're signed in: the web app, the [desktop app](../core-concepts/desktop-vs-web.md), the [CLI](./cli.md) and [mobile](./mobile-app.md). Each row shows the browser or app, IP address, sign-in method and when the session started. The one you're using now is marked **This device**.

- **Sign out** on a row ends that session.
- **Sign out other sessions** ends every session except this one. It's the fastest thing to do if you lose a laptop or phone.

A signed-out session stops working immediately and that device has to sign in again. To end your _current_ session, use the normal sign-out in the app menu.

## Delete your account

**Delete account** is at the bottom of **Settings > General**. It permanently removes your account, your [SSH keys](../team-and-billing/ssh-keys.md), your [API keys](../team-and-billing/api-keys.md), your push devices, your chat history and your membership of every organization. It can't be undone, and it needs a recent sign-in.

What happens to your organizations depends on who else is in them. The page tells you before you confirm:

- **You're the only member:** the organization is deleted with your account, along with every account, resource, dashboard and workflow in it. Any active subscription is cancelled.
- **Others are in it and there's another owner:** you leave. The organization carries on.
- **Others are in it and you're the only owner:** the **Delete account** button is disabled and those organizations are listed. Make someone else an owner in [**Settings > Team**](../team-and-billing/roles-and-permissions.md) first. Nothing is deleted until then, and there's no override.

Clicking the button doesn't delete anything yet. It opens a dialog where you type **your email address** exactly, and only then does the dialog's own **Delete account** button become clickable.

Your entries in an organization's [audit log](../team-and-billing/audit-log.md) stay, because they belong to that organization, but they no longer show your name. The deletion is recorded in every organization you were in.

![Settings → General Delete account card showing the "you are the only member of this organization, so it will be deleted too" warning above the Delete account button](https://agent-assets.infrawrench.com/docs-screenshots/features/account-settings/delete-account-card.png)

## On mobile

The mobile app has all of this under **Settings > (your email)**: profile, password reset, two-factor, sessions and account deletion. Deleting your account there signs you out and takes you back to the sign-in screen.

## API

The same actions are available under `/api/profile`. See the [OpenAPI reference](../team-and-billing/openapi.md). They act on your user, so they authenticate with a session cookie or a WorkOS access token, not an organization [API key](../team-and-billing/api-keys.md).
