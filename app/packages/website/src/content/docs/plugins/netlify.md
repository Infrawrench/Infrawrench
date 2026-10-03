---
title: Netlify
description: Manage Netlify sites, deploys, forms, DNS, environment variables, notifications, snippets, and Netlify DB databases.
sidebar_order: 21
---

Netlify renamed "sites" to "projects" in its dashboard in 2025. The API still calls them sites, and so does infrawrench.

## What you can manage

- Sites (create, edit build settings, trigger and roll back deploys)
- Deploys (status, cancel, publish, lock and unlock publishing)
- Forms and their recent submissions
- DNS zones and records
- Environment variables (with context scoping: production / deploy-preview / branch-deploy / dev)
- Build hooks
- Deploy notifications (email, Slack, or an HTTP POST on deploy events)
- Snippets injected into every page
- Netlify DB databases

## Credentials

Netlify → **User settings → Applications → Personal access tokens → New access token**.

![Netlify Add-account form with PAT field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/netlify/add-account.png)

## Notable flows

- **Site actions**: **Trigger Deploy** builds the production branch, **Clear Cache and Deploy** does the same from a clean build cache, **Roll Back** republishes the previous production deploy, **Purge CDN Cache** drops every cached response, and **Renew Certificate** asks Netlify to provision the site's TLS certificate again. The detail view shows the certificate's state, covered domains, and expiry.
- **Site settings**: **Edit** renames the site and changes the production branch, build command, publish and functions directories, Force SSL, and whether Git pushes trigger builds.
- **Deploy actions**: **Cancel** a deploy that is still building, **Publish** a ready deploy to production, and **Lock Publishing** to pin production to a deploy while new builds keep running (**Unlock Publishing** resumes auto publishing).
- **Env var editing** with per-context values: create a variable with its contexts, scopes, and whether it contains secret values, then **Edit** to set a new value for one context. Env vars use Netlify's account-level environment variable API.
- **Build hooks**: create from a site picker, then **Edit** the title or branch.
- **Deploy notifications**: pick the event (the list comes from Netlify's hook types) and the delivery (email, Slack incoming webhook, or HTTP POST). A notification Netlify disabled after repeated failures can be **Re-enabled**.
- **Snippets**: add HTML (analytics tags, widgets) before `</head>` or before `</body>` on every page, and edit it in place.
- **Netlify DB**: create a serverless Postgres database for a site, see its production branch state, size, and autoscaling, list every branch and snapshot, and take a snapshot on demand. The **Connection String** output opens in the PostgreSQL tab and exports as `DATABASE_URL`.
- **Form submissions**: a form's detail view lists its 20 most recent submissions.
- **DNS records**: shared rendering helpers with the other DNS plugins.

<insert [Netlify site detail view showing the Trigger Deploy, Roll Back, and Purge CDN Cache header actions and the TLS certificate rows] here>

## Tips & limits

- Team vs personal scope is based on the PAT; switching context is done from the Netlify UI.
- Secret environment variable values are write-only, need an explicit deploy context rather than "All contexts", and cannot be used in the local development context.
- Netlify DB is created in the site's functions region.
- Netlify's API has no endpoint for reading build logs, so deploy logs stay in the Netlify dashboard.
