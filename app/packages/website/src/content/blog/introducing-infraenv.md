---
title: "Introducing .infraenv: commit the recipe for your .env"
description: Keep environment variable definitions in Git and pull the values from Infrawrench when you need them, without committing secrets.
date: 2026-11-21
author: The Infrawrench team
---

A pull request can add `DATABASE_URL` to `.env.example`. It still leaves the next developer guessing which database to use. The answer belongs in the repo. The connection string doesn't.

We built `.infraenv` to separate the two. You commit a file that names the variables your app needs and says where to get each value. Infrawrench resolves those references when you pull a local `.env` or load the environment into a Node process.

## What goes in the file

Here's a storefront with separate Neon branches for development and production. Both environments use the same variable names. Switching the environment changes which branch and Stripe secret the references point to.

```ini
[vars]
stage = dev

[env]
NODE_ENV = development
DATABASE_URL = resource("neon/neon-branch", "storefront / ${stage}", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_${stage}_SECRET_KEY")

[vars.production]
stage = prod

[env.production]
NODE_ENV = production
```

You can review that production points at `storefront / prod` without putting the connection string in the diff. Use literals for settings like `NODE_ENV`, and references for credentials.

## Start from a repo you already have

Open **Environment files** in Infrawrench to pick resource outputs and commit the definition to a branch or open a pull request. If you're starting from an existing `.env`, `infrawrench env init --from .env` creates a reference for each key without copying its value. Then use `infrawrench env pull` to write the resolved `.env` locally. Optional Git hooks can refresh it when the definition changes or the local file is missing.

![Production environment overrides in the Infrawrench Environment files tab, shown with sample data](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/v2-tab-production.png)

For Node projects, [`@infrawrench/infraenv`](https://www.npmjs.com/package/@infrawrench/infraenv) can also load variables into `process.env`. The [environment files docs](/docs/features/env-files) have complete examples for the file format, Git hooks and Node setup. There's also an [infraenv skill for coding agents](/skills/infraenv.md) that explains how to write and check the file without putting secret values in it.

One more tooling note: you can now get the Infrawrench CLI as a standalone download or through npm. We also publish the Infrawrench VS Code extension.
