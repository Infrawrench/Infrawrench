---
title: Netlify
description: Manage Netlify sites, deploys, forms, DNS, environment variables, notifications, snippets, and Netlify DB databases.
sidebar_order: 21
---

Connect Netlify to deploy and roll back sites, manage env vars, DNS and forms, and run Netlify DB databases.

Netlify renamed "sites" to "projects" in its dashboard in 2025. The API still calls them sites, and so does Infrawrench.

## What you can manage

- Sites (create, edit build settings, trigger and roll back deploys)
- Deploys (status, cancel, publish, lock and unlock publishing)
- Forms and their recent submissions
- DNS zones and records
- Environment variables, scoped by context: production, deploy-preview, branch-deploy, dev
- Build hooks
- Deploy notifications (email, Slack, or an HTTP POST on deploy events)
- Snippets added to every page
- Netlify DB databases

## Connect with Netlify

1. Pick Netlify in the add-account form and click **Connect with Netlify**.
2. Sign in to Netlify and click **Authorize**.

The account is named after your Netlify user.

- **What you're granting:** Netlify sign-in has no scopes, so the token can do everything your Netlify user can, across every team you belong to. Infrawrench only reads unless you act.
- **No refresh needed:** Netlify tokens don't expire. Resetting your Netlify password cancels them (and all personal access tokens), so reconnect afterwards. You can revoke Infrawrench any time under **User settings > Applications > Authorized applications**.
- **SAML teams:** a team that enforces SAML SSO may refuse tokens that weren't granted access to it. If a team's sites are missing, sign in to that team with SSO and reconnect.
- **Where it works:** the web app and the desktop app in cloud mode. Desktop-local accounts use a pasted token instead.

## Paste a token instead

In Netlify, go to **User settings > Applications > Personal access tokens > New access token**, then paste it into the form.

![Netlify Add-account form with PAT field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/netlify/add-account.png)

## Deploy and manage sites

- **Site actions**:
  - **Trigger Deploy** builds the production branch.
  - **Clear Cache and Deploy** does the same from a clean build cache.
  - **Roll Back** republishes the previous production deploy.
  - **Purge CDN Cache** drops every cached response.
  - **Renew Certificate** asks Netlify to set up the site's TLS certificate again. The detail view shows the certificate's state, covered domains and expiry.
- **Site settings**: **Edit** renames the site and changes the production branch, build command, publish and functions directories, Force SSL, and whether Git pushes trigger builds.
- **Deploy actions**: **Cancel** a deploy that's still building, **Publish** a ready deploy to production, or **Lock Publishing** to pin production to one deploy while new builds keep running. **Unlock Publishing** turns auto publishing back on.

## Manage env vars, hooks and notifications

- **Environment variables**: create a variable with its contexts, scopes, and whether it holds secret values. Then use **Edit** to set a new value for one context.
- **Build hooks**: create one from a site picker, then **Edit** the title or branch.
- **Deploy notifications**: pick the event and how it's delivered (email, Slack incoming webhook or HTTP POST). If Netlify disabled a notification after repeated failures, you can **Re-enable** it.
- **Snippets**: add HTML (analytics tags, widgets) before `</head>` or before `</body>` on every page, and edit it in place.

## Use Netlify DB, forms and DNS

- **Netlify DB**: create a serverless Postgres database for a site. See its production branch state, size and autoscaling, list every branch and snapshot, and take a snapshot on demand. The **Connection String** output opens in the PostgreSQL tab and exports as `DATABASE_URL`.
- **Form submissions**: a form's detail view lists its 20 most recent submissions.
- **DNS records**: view and manage records like in the other DNS plugins.

<insert [Netlify site detail view showing the Trigger Deploy, Roll Back, and Purge CDN Cache header actions and the TLS certificate rows] here>

## Tips and limits

- Whether you see team or personal resources depends on the token. Switch context in the Netlify UI.
- Secret environment variable values are write-only, need a specific deploy context rather than "All contexts", and can't be used in the local development context.
- Netlify DB is created in the site's functions region.
- Netlify's API can't read build logs, so deploy logs stay in the Netlify dashboard.
