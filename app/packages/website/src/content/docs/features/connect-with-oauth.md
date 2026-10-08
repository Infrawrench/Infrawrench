---
title: Connect with OAuth
description: Add a provider account by signing in to the provider and approving access, instead of creating and pasting a token, with refresh handled for you.
sidebar_order: 2
---

For many providers, adding an account no longer means opening the provider's console, creating a token with the right scopes, and pasting it. The add-account form shows a **Connect with &lt;Provider&gt;** button instead: you sign in to the provider, approve the access Infrawrench asks for, and the form fills itself in.

The result is an ordinary account. It lists the same resources, runs the same actions, and sits in the sidebar beside accounts you added with a pasted token. The only differences are where the token came from, and that Infrawrench keeps it fresh for you.

<insert [Add-account modal with a provider selected, showing the Connect with button at the top, the "or enter credentials manually" divider, and the manual token form below it] here>

## Connecting an account

1. Click **Add account** in the sidebar and pick the provider.
2. Click **Connect with &lt;Provider&gt;**. A sign-in window opens at the provider.
3. Sign in if you need to, check what the provider says Infrawrench is asking for, and approve it. Some providers ask you to pick an organization, team or workspace on the consent screen; the account covers what you pick there.
4. The window closes and you are back on the form. The token field now shows a **Connected to &lt;Provider&gt;** chip instead of an input, and anything Infrawrench could work out from the connection (the account or team id, the region, the organization) is already filled in. The display name is suggested from the provider account's name if you have not typed one.
5. Check the remaining fields, change any picker you want to, and click **Save**.

On the web and in the desktop app's cloud mode, you have 30 minutes between approving and saving. After that the connection expires and you connect again.

The sign-in window is a popup on the web. If your browser blocks it, allow pop-ups for the Infrawrench site and click the button again. Closing the window, or clicking **Cancel** on the form, abandons the attempt without saving anything.

<insert [Add-account form after a successful connection: the token field replaced by a "Connected to" chip, the display name prefilled, and a team picker already set] here>

### What the consent grants

Each provider's page describes exactly what Infrawrench asks for, why, and what the provider issues in return. Follow the links in the [supported providers](#supported-providers) table. Infrawrench asks for what its features for that provider need: a provider whose resources you can create, edit or delete from Infrawrench is asked for write access, because those actions would fail without it.

### Full-access providers

Some providers have no narrower permission to ask for: the only token they issue can do everything you can. For those, the form says so before you click (for example, "Heroku only offers full-access tokens. Infrawrench only reads unless you act."). Infrawrench still only changes something when you take an action, but if you would rather hand over a token with narrower permissions, use the manual form with a token you created yourself, where the provider offers one.

## Web and desktop

- **Web app**: every provider in the table below with a check in the web column.
- **Desktop app, cloud mode**: the same list as the web app. Your accounts live in your Infrawrench organization, so the desktop asks the Infrawrench server to run the sign-in. It opens your default browser, and the browser hands the result back to the desktop app when you approve.
- **Desktop app, local accounts**: accounts stored only on your computer sign in through your default browser too, but the result comes straight back to the app on your computer (on `http://127.0.0.1:43118`, or `localhost` for a few providers) and nothing passes through Infrawrench's servers. Only providers that support this kind of sign-in for an app on your own computer offer it, so some providers show the button on the web and not for local accounts. Those providers still work locally with a pasted token.

[CircleCI](../plugins/circleci.md) is the reverse: it only allows a sign-in that returns to an app on your own computer, so it is offered for local desktop accounts and not on the web or in cloud mode.

If the button is missing for a provider in the table, the deployment you use has not set up that provider's sign-in. See [Self-hosting](#self-hosting).

## Staying connected

Most providers issue a short-lived access token together with a refresh token. Infrawrench refreshes the access token a few minutes before it expires, whenever the account is used, and stores the new one. You never see this happen.

- **Cloud accounts** are refreshed by the Infrawrench server only.
- **Local desktop accounts** are refreshed by the desktop app on your computer only, and their refresh token never leaves it. If you sync local accounts to your organization, the copy in the cloud receives the current access token only, not the ability to refresh it, so a provider with short-lived tokens stops working there once that token expires. To use such an account in the cloud, connect it in cloud mode instead.

A few providers issue a long-lived token and no refresh token at all; it keeps working until you revoke it at the provider or it reaches its own expiry. The provider pages say which.

## Reconnect needed

A refresh can fail for good: you revoked Infrawrench's access at the provider, an organization admin removed the app, you changed your password at a provider that invalidates tokens on a password change, or the refresh token reached its own expiry. When that happens the account is marked **Reconnect needed**:

- the account shows a badge in the sidebar,
- its account page shows a banner explaining that the connection was revoked or expired and that the account cannot sync until you reconnect,
- the [mobile app](./mobile-app.md) shows the same state, read-only.

Click **Reconnect** on the badge or the banner, sign in to the provider again, and approve. The account picks up the new connection immediately; its resources, pins, dashboards and history stay as they were. You can also open **Update credentials** on the account page, where the token field shows **Connected via OAuth** with a **Reconnect** button.

<insert [Account page for a connected account in the Reconnect needed state, showing the warning banner with the Reconnect and Update credentials buttons, and the sidebar badge next to the account name] here>

Reconnect signs in as whoever clicks it. If you reconnect an account someone else connected, the account now uses your access at the provider.

## Switching between a connection and a token

Both ways in are always available, for every provider that offers a connection, and you can switch at any time without removing the account.

- **From a connection to a token**: open **Update credentials**, click **Use a token instead**, paste a token, and save. The connection is dropped and the account behaves exactly like one you added with a token.
- **From a token to a connection**: open **Update credentials** and click **Connect with &lt;Provider&gt;**, then save.

Editing other fields of a connected account (a team picker, a region) keeps the connection; only replacing the token ends it. Accounts you added with a token before this feature existed are untouched.

<insert [Update credentials modal for a connected account, showing the Connected via OAuth chip with the Reconnect and Use a token instead buttons above the remaining fields] here>

## Supported providers

The **Web** column covers the web app and the desktop app in cloud mode. **Desktop (local)** covers accounts stored only on your computer. **Access** is what the granted token can do: **read and write** means the permissions Infrawrench's features for that provider need, and **full** means the provider offers nothing narrower.

| Provider                                      | Web | Desktop (local) | Access         |
| --------------------------------------------- | --- | --------------- | -------------- |
| [Bitbucket](../plugins/bitbucket.md)          | Yes | No              | Read and write |
| [CircleCI](../plugins/circleci.md)            | No  | Yes             | Read and write |
| [Cloudflare](../plugins/cloudflare.md)        | Yes | Yes             | Read and write |
| [Cloudinary](../plugins/cloudinary.md)        | Yes | Yes             | Full           |
| [Convex](../plugins/convex.md)                | Yes | No              | Full           |
| [DigitalOcean](../plugins/digitalocean.md)    | Yes | Yes             | Read and write |
| [GitHub](../plugins/github.md)                | Yes | No              | Read and write |
| [GitLab](../plugins/gitlab.md)                | Yes | Yes             | Read and write |
| [Heroku](../plugins/heroku.md)                | Yes | No              | Full           |
| [Hugging Face](../plugins/huggingface.md)     | Yes | Yes             | Read and write |
| [Linode (Akamai Cloud)](../plugins/linode.md) | Yes | No              | Read and write |
| [Netlify](../plugins/netlify.md)              | Yes | No              | Full           |
| [OpenRouter](../plugins/openrouter.md)        | Yes | Yes             | Full           |
| [PagerDuty](../plugins/pagerduty.md)          | Yes | Yes             | Read and write |
| [PlanetScale](../plugins/planetscale.md)      | Yes | No              | Read and write |
| [PostHog](../plugins/posthog.md)              | Yes | Yes             | Read and write |
| [Railway](../plugins/railway.md)              | Yes | Yes             | Read and write |
| [Resend](../plugins/resend.md)                | Yes | Yes             | Full           |
| [Sentry](../plugins/sentry.md)                | Yes | Yes             | Read and write |
| [Supabase](../plugins/supabase.md)            | Yes | No              | Read and write |
| [Vercel](../plugins/vercel.md)                | Yes | No              | Read and write |

Some providers' connections cover less than a token can: a few endpoints only accept a token created in the provider's console, and self-hosted editions (GitLab self-managed, Sentry self-hosted, PostHog self-hosted, GitHub Enterprise Server) keep the token form. The provider pages list these gaps.

## Self-hosting

On a self-hosted deployment, each provider's **Connect** button appears once you register an OAuth app (or client, or integration, depending on the provider's term) with that provider and give the server its credentials. Until then the provider simply offers the token form; nothing else changes.

1. Register an app in the provider's developer settings. Use this redirect (callback) URL, where `<your-app>` is the public origin you set as `APP_URL`, and `<id>` is the plugin id from the provider page's URL (for example `digitalocean`):

   ```
   https://<your-app>/api/provider-oauth/<id>/callback
   ```

2. Configure the app's permissions to match what the provider page lists, where the provider sets them on the app rather than at sign-in.
3. Set two environment variables on the server, with `<ID>` as the plugin id in upper case (non-alphanumeric characters become `_`):

   ```
   PROVIDER_OAUTH_<ID>_CLIENT_ID=...
   PROVIDER_OAUTH_<ID>_CLIENT_SECRET=...
   ```

   For example `PROVIDER_OAUTH_DIGITALOCEAN_CLIENT_ID` and `PROVIDER_OAUTH_DIGITALOCEAN_CLIENT_SECRET`.

A few providers need less. [OpenRouter](../plugins/openrouter.md) has no app registration at all, so its button is always available. Providers that only accept public clients (no secret) need only the client id.

The desktop app's local sign-in uses a separate client per provider, compiled into the desktop build (`MAIN_VITE_PROVIDER_OAUTH_<ID>_CLIENT_ID` when building the app, with the redirect `http://127.0.0.1:43118/oauth/callback`). A desktop build without one for a provider does not offer local sign-in for it; CircleCI and OpenRouter need none.
