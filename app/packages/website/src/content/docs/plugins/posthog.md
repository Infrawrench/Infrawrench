---
title: PostHog
description: Manage PostHog projects, feature flags, experiments, cohorts, dashboards, insights, actions, annotations, destinations, batch exports and members, run HogQL, chart events and flag evaluations, and track spend by product and project. US Cloud, EU Cloud and self-hosted.
sidebar_order: 50
---

Connect a PostHog organization to manage its flags, experiments and data pipelines next to the rest of your stack, and to see what PostHog costs per product and project.

## What you can manage

- **Organization**: plan, members, projects, and this billing period's spend and projection. Its Metrics tab charts daily spend by product.
- **Projects**: time zone and whether events are arriving. The project API key and host are outputs (export them as `POSTHOG_API_KEY` and `POSTHOG_HOST`). The Metrics tab charts events per hour, and the **Query** tab runs HogQL.
- **Feature flags**: create flags with a rollout percentage, edit the description, rollout and tags, **Turn on / Turn off**, **Roll out to everyone**, or delete. The Metrics tab charts how often each flag is evaluated.
- **Experiments**: **Launch**, **Pause**, **Resume**, **End** and **Archive**, edit the name and description, or delete.
- **Cohorts**, **insights** and **actions**: rename, change the description, or delete. Insights link to the dashboards they're on.
- **Dashboards**: create, rename, describe, pin, tag, or delete.
- **Annotations**: add a note at a point in time for one project or the whole organization (a deploy, an outage), edit it, or delete it.
- **Destinations** (Hog functions: realtime destinations, transformations, webhook sources, site apps): turn them on and off, or delete them.
- **Batch exports**: destination, model, interval and the latest run. **Pause**, **Resume**, or delete.
- **Members**: change a member's level (member, admin, owner) or remove them.

Deleting a flag, experiment, cohort, dashboard, insight, action, annotation or destination here marks it deleted, just like PostHog's own UI. Batch exports are deleted for real.

<insert [PostHog feature flag detail page showing the rollout, release conditions and the Metrics tab charting evaluations] here>

## Connect with PostHog

For PostHog Cloud, click **Connect with PostHog** on the add-account form to sign in instead of creating a personal API key. If you're signed in to one region, PostHog uses it. Otherwise it asks whether your organization is on US or EU Cloud.

On the consent screen, choose the organization (or project) Infrawrench may use and approve the scopes it asks for. They match the personal API key list below: read and write for feature flags, experiments, dashboards, insights, cohorts, actions, annotations, destinations, batch exports and members, plus `query:read` for HogQL and metrics and `billing:read` for costs. Nothing changes unless you act in Infrawrench.

Once you approve, the **Region** and **Organization** are filled in and the account is named after the organization. Grant a whole organization, not a single project, since projects, members and costs are all read at organization level.

The connection renews itself. If you revoke Infrawrench in PostHog, or don't use the account for about a month, it shows **Reconnect required**. Click **Reconnect** in its credentials to sign in again.

Connect with PostHog works in the web app, in the desktop app's cloud mode, and for accounts stored locally on the desktop (which sign in through your browser). Self-hosted PostHog uses a personal API key, as below.

<insert [PostHog add-account form showing the Connect with PostHog button above the Region and Personal API Key fields] here>

## Use a personal API key instead

1. **Region**: US Cloud or EU Cloud. For self-hosted PostHog, fill in **Instance URL** under Advanced options instead.
2. **Personal API key**: in PostHog, open your account settings, then **Personal API keys**, then **+ Create a personal API key**. Limit it to your organization and pick the scopes you need. **Check credentials** lists them, and the policy generator prints the exact list. You need `billing:read` for costs and `query:read` for HogQL and metrics.
3. **Organization**: pick it from the list once the key is in, or leave it on the key's current organization.

<insert [PostHog Add-account form with the region picker, Personal API Key and the Organization picker filled from the key] here>

## Costs

You see spend per day, product and project, in USD, so Costs can break PostHog down by product and project. It covers the key's current organization. Self-hosted instances have no billing data.

## Status

Open incidents on [PostHog's status page](https://www.posthogstatus.com) show on your PostHog accounts. Incidents that name the US or EU region apply to that region's projects. The rest apply to all.

## Terraform

Feature flags, dashboards, cohorts and actions export to the official `PostHog/posthog` provider, importable as `<project_id>/<id>`.

## Limits

- PostHog allows 480 management requests a minute per key, so very large organizations update more slowly.
- You define experiments, cohorts, insights and actions in PostHog. Here you manage their lifecycle and names.
- Destination and batch export configuration (credentials, mappings) stays in PostHog.
