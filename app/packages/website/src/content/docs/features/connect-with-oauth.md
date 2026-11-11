---
title: Connect with OAuth
description: Add a provider account by signing in to the provider and approving access, instead of creating and pasting a token. Infrawrench keeps the token fresh for you.
sidebar_order: 2
---

For many providers, you don't need to create a token in the provider's console and paste it. The add-account form shows a **Connect with &lt;Provider&gt;** button instead. You sign in to the provider, approve the access Infrawrench asks for, and the form fills itself in.

You end up with an ordinary account. It lists the same resources, runs the same actions, and sits in the sidebar next to accounts you added with a token. The only difference is where the token came from, and that Infrawrench keeps it fresh for you.

<insert [Add-account modal with a provider selected, showing the Connect with button at the top, the "or enter credentials manually" divider, and the manual token form below it] here>

## Connect an account

1. Click **Manage accounts** in the sidebar, then **Add account**, and pick the provider.
2. Click **Connect with &lt;Provider&gt;**. A sign-in window opens at the provider.
3. Sign in if you need to, check what Infrawrench is asking for, and approve it. Some providers ask you to pick an organization, team or workspace on the consent screen. The account covers what you pick there.
4. The window closes and you're back on the form. The token field now shows a **Connected to &lt;Provider&gt;** chip. Anything Infrawrench could work out from the connection (the account or team id, the region, the organization) is already filled in. If you haven't typed a display name, one is suggested from the provider account's name.
5. Check the remaining fields, change any picker you want, and click **Save**.

On the web and in the desktop app's cloud mode, you have 30 minutes between approving and saving. After that the connection expires and you need to connect again.

On the web, the sign-in window is a popup. If your browser blocks it, allow pop-ups for the Infrawrench site and click the button again. Closing the window, or clicking **Cancel** on the form, abandons the attempt without saving anything.

<insert [Add-account form after a successful connection: the token field replaced by a "Connected to" chip, the display name prefilled, and a team picker already set] here>

### What you're granting

Each provider's page describes exactly what Infrawrench asks for, why, and what the provider issues in return. Follow the links in the [supported providers](#supported-providers) table. Infrawrench asks for what its features for that provider need. If you can create, edit or delete a provider's resources from Infrawrench, it asks for write access, since those actions would fail without it.

### Providers that only offer full access

Some providers have no narrower permission to ask for. The only token they issue can do everything you can. For those, the form tells you before you click (for example, "Netlify only offers full-access tokens. Infrawrench only reads unless you act."). Infrawrench still only changes something when you take an action. If you'd rather use a token with narrower permissions, use the manual form with a token you created yourself, where the provider offers one.

## Web and desktop

- **Web app**: every provider in the table below with "Yes" in the Web column.
- **Desktop app, cloud mode**: the same list as the web app. Sign-in opens your default browser, and the browser hands the result back to the desktop app when you approve.
- **Desktop app, local accounts**: accounts stored only on your computer also sign in through your default browser. The result comes straight back to the app on your computer (on `http://127.0.0.1:43118`, or `localhost` for a few providers), and nothing passes through Infrawrench's servers. Not every provider supports this kind of sign-in, so some show the button on the web but not for local accounts. Those providers still work locally with a pasted token.

[CircleCI](../plugins/circleci.md) is the reverse. It only allows sign-in to an app on your own computer, so it's offered for local desktop accounts and not on the web or in cloud mode.

If the button is missing for a provider in the table, the deployment you use hasn't set up sign-in for that provider. See [Self-hosting](#self-hosting).

## Stay connected

Most providers issue a short-lived access token along with a refresh token. Infrawrench refreshes the access token for you before it expires. You never need to do anything.

- **Cloud accounts** are refreshed by the Infrawrench server only.
- **Local desktop accounts** are refreshed by the desktop app on your computer only, and their refresh token never leaves it. If you sync local accounts to your organization, the cloud copy gets only the current access token, not the ability to refresh it. For a provider with short-lived tokens, that copy stops working once the token expires. To use such an account in the cloud, connect it in cloud mode instead.

A few providers issue a long-lived token with no refresh token. It keeps working until you revoke it at the provider or it reaches its own expiry. The provider pages say which.

## Fix "Reconnect needed"

Sometimes a connection stops working for good. You revoked Infrawrench's access at the provider, an organization admin removed the app, you changed your password at a provider that invalidates tokens when you do, or the refresh token expired. When that happens, the account is marked **Reconnect needed**:

- the account shows a badge in the sidebar,
- its account page shows a banner saying the connection was revoked or expired and the account can't sync until you reconnect,
- the [mobile app](./mobile-app.md) shows the same state, read-only.

To fix it, click **Reconnect** on the badge or the banner, sign in to the provider again, and approve. The account picks up the new connection right away. Its resources, pins, dashboards and history stay as they were. You can also open **Update credentials** on the account page, where the token field shows **Connected via OAuth** with a **Reconnect** button.

<insert [Account page for a connected account in the Reconnect needed state, showing the warning banner with the Reconnect and Update credentials buttons, and the sidebar badge next to the account name] here>

Reconnect signs in as whoever clicks it. If you reconnect an account someone else connected, the account now uses your access at the provider.

## Switch between a connection and a token

For every provider that offers a connection, you can use either a connection or a token, and switch at any time without removing the account.

- **From a connection to a token**: open **Update credentials**, click **Use a token instead**, paste a token, and save. The connection is dropped and the account works exactly like one you added with a token.
- **From a token to a connection**: open **Update credentials**, click **Connect with &lt;Provider&gt;**, then save.

Editing other fields of a connected account (a team picker, a region) keeps the connection. Only replacing the token ends it. Accounts you added with a token before this feature existed are untouched.

<insert [Update credentials modal for a connected account, showing the Connected via OAuth chip with the Reconnect and Use a token instead buttons above the remaining fields] here>

## Supported providers

The **Web** column covers the web app and the desktop app in cloud mode. **Desktop (local)** covers accounts stored only on your computer. **Access** is what the granted token can do. **Read and write** means the permissions Infrawrench's features for that provider need. **Full** means the provider offers nothing narrower.

| Provider                                  | Web | Desktop (local) | Access         |
| ----------------------------------------- | --- | --------------- | -------------- |
| [Bitbucket](../plugins/bitbucket.md)      | Yes | No              | Read and write |
| [CircleCI](../plugins/circleci.md)        | No  | Yes             | Read and write |
| [Cloudinary](../plugins/cloudinary.md)    | Yes | Yes             | Full           |
| [Convex](../plugins/convex.md)            | Yes | No              | Full           |
| [GitHub](../plugins/github.md)            | Yes | No              | Read and write |
| [Hugging Face](../plugins/huggingface.md) | Yes | Yes             | Read and write |
| [Netlify](../plugins/netlify.md)          | Yes | No              | Full           |
| [OpenRouter](../plugins/openrouter.md)    | Yes | Yes             | Full           |
| [PagerDuty](../plugins/pagerduty.md)      | Yes | Yes             | Read and write |
| [PlanetScale](../plugins/planetscale.md)  | Yes | No              | Read and write |
| [PostHog](../plugins/posthog.md)          | Yes | Yes             | Read and write |
| [Railway](../plugins/railway.md)          | Yes | Yes             | Read and write |
| [Resend](../plugins/resend.md)            | Yes | Yes             | Full           |
| [Sentry](../plugins/sentry.md)            | Yes | Yes             | Read and write |
| [Supabase](../plugins/supabase.md)        | Yes | No              | Read and write |
| [Vercel](../plugins/vercel.md)            | Yes | No              | Read and write |

For some providers, a connection covers less than a token can. A few endpoints only accept a token created in the provider's console, and self-hosted editions (Sentry self-hosted, PostHog self-hosted, GitHub Enterprise Server) keep the token form. The provider pages list these gaps.

## Self-hosting

On a self-hosted deployment, a provider's **Connect** button appears once you register an OAuth app with that provider (some providers call it a client or an integration) and give the server its credentials. Until then, that provider just shows the token form.

1. Register an app in the provider's developer settings. Use this redirect (callback) URL, where `<your-app>` is the public origin you set as `APP_URL`, and `<id>` is the plugin id from the provider page's URL (for example `github`):

   ```
   https://<your-app>/api/provider-oauth/<id>/callback
   ```

2. If the provider sets permissions on the app rather than at sign-in, configure them to match what the provider page lists.
3. Set two environment variables on the server. `<ID>` is the plugin id in upper case, with any character that isn't a letter or number replaced by `_`:

   ```
   PROVIDER_OAUTH_<ID>_CLIENT_ID=...
   PROVIDER_OAUTH_<ID>_CLIENT_SECRET=...
   ```

   For example, `PROVIDER_OAUTH_GITHUB_CLIENT_ID` and `PROVIDER_OAUTH_GITHUB_CLIENT_SECRET`.

Some providers need less. [OpenRouter](../plugins/openrouter.md) needs no app registration, so its button is always available. Providers that only accept public clients (no secret) need only the client id.

Local sign-in in the desktop app uses a separate client per provider, set when the desktop app is built (`MAIN_VITE_PROVIDER_OAUTH_<ID>_CLIENT_ID`, with the redirect `http://127.0.0.1:43118/oauth/callback`). A desktop build without one for a provider doesn't offer local sign-in for it. CircleCI and OpenRouter need none.
