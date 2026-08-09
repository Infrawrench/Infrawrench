---
title: Spotlight search
description: Fuzzy-find any resource across every connected account with one shortcut.
sidebar_order: 2
---

Hit **Cmd + K** (macOS) or **Ctrl + K** (Windows / Linux) from anywhere in the app.

![Spotlight palette with a few resource matches](https://agent-assets.infrawrench.com/docs/screenshots/features/spotlight-search.png)

## What it searches

- Resource names (Droplets, pods, databases, buckets, everything).
- Account names.
- Plugin names.

Results are grouped by type and show which account each one belongs to, so two Droplets called `app-1` in different accounts do not collide.

## Actions

- **Enter** opens the resource detail page.
- **Cmd + Enter** opens it in a new tab (web only).
- Arrow keys navigate; type to filter.

## Tips

- Type part of a name — matching is fuzzy, so `app1` matches `app-1`.
- Prefix with a plugin name to narrow: `pg` or `aws` or `k8s`.
- Works offline in desktop (searches the cached resource index).
