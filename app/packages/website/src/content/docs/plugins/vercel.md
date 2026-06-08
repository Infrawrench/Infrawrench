---
title: Vercel
description: Manage Vercel projects, deployments, domains, environment variables, and teams.
sidebar_order: 22
---

## What you can manage

- Projects
- Deployments (view status, access URL, inspect build)
- Domains
- Environment variables
- Teams

## Credentials

Vercel → **Account Settings → Tokens → Create**.

<insert [Vercel Add-account form with token and optional team-ID field] here>

If you belong to a Team, provide the team ID so infrawrench lists team-owned projects.

## Notable flows

- **Deploy list** with status badges and links to the Vercel inspector.
- **Domain management** for project and account domains.
- **Environment variable editing** with target scoping.

## Tips & limits

- Some destructive or workflow-heavy deployment actions, such as rollback and alias promotion, are still left to Vercel until the plugin has a safer confirmation flow for them.
