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
- **Cohorts**, **insights** and **actions**: rename, change the description, or delete. Insights link to the dashboards they are on.
- **Dashboards**: create, rename, describe, pin, tag, or delete.
- **Annotations**: create a note at a point in time for one project or the whole organization (a deploy, an outage), edit it, or delete it.
- **Destinations** (Hog functions: realtime destinations, transformations, webhook sources, site apps): turn them on and off or delete them.
- **Batch exports**: destination, model, interval and the latest run. **Pause**, **Resume**, or delete.
- **Members**: change a member's level (member, admin, owner) or remove them.

PostHog never deletes flags, experiments, cohorts, dashboards, insights, actions, annotations or destinations outright: deleting one here marks it deleted, as PostHog's own UI does. Batch exports are deleted for real.

<insert [PostHog feature flag detail page showing the rollout, release conditions and the Metrics tab charting evaluations] here>

## Credentials

1. **Region**: US Cloud or EU Cloud. For self-hosted PostHog, fill in **Instance URL** under Advanced options instead.
2. **Personal API key**: in PostHog open your account settings, **Personal API keys**, **+ Create a personal API key**, limit it to your organization, and pick the scopes you need. **Check credentials** lists them; the policy generator prints the exact list. `billing:read` is needed for costs and `query:read` for HogQL and metrics.
3. **Organization**: pick it from the list once the key is entered, or leave it on the key's current organization.

<insert [PostHog Add-account form with the region picker, Personal API Key and the Organization picker filled from the key] here>

## Costs

Spend comes from PostHog's billing service (`/api/billing/spend/`), one row per day, product and project, in USD, so Costs can break PostHog down by product and project. It covers the key's current organization. Self-hosted instances have no billing service.

## Status

Open incidents on [PostHog's status page](https://www.posthogstatus.com) show on your PostHog accounts. Incidents that name the US or EU region apply to that region's projects; the rest apply to all.

## Terraform

Feature flags, dashboards, cohorts and actions export to the official `PostHog/posthog` provider, importable as `<project_id>/<id>`.

## Limits

- PostHog allows 480 management requests a minute per key; very large organizations sync more slowly.
- Experiments, cohorts, insights and actions are defined in PostHog; here you manage their lifecycle and names.
- Destination and batch export configuration (credentials, mappings) stays in PostHog.
