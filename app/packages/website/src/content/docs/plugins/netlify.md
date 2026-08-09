---
title: Netlify
description: Manage Netlify sites, deploys, forms, DNS zones, and environment variables.
sidebar_order: 21
---

## What you can manage

- Sites
- Deploys (view status, trigger via build hooks)
- Forms and submissions
- DNS zones and records
- Environment variables (with context scoping: production / deploy-preview / branch-deploy)
- Build hooks

## Credentials

Netlify → **User settings → Applications → Personal access tokens → New access token**.

<insert [Netlify Add-account form with PAT field] here>

## Notable flows

- **Deploy triggering** — fire a build hook from the UI.
- **Env var editing** with per-context values.
- **DNS records** — shared rendering helpers with the other DNS plugins.

## Tips & limits

- Team vs personal scope is based on the PAT; switching context is done from the Netlify UI.
- Form submissions are paginated; very busy forms can take a moment to load.
