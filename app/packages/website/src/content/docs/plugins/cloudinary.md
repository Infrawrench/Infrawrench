---
title: Cloudinary
description: Manage Cloudinary media assets, folders, upload presets, transformations, upload mappings and webhook notifications, and track plan usage.
sidebar_order: 25
---

Connect Cloudinary to browse and organize your media, manage upload settings and webhooks, and keep an eye on plan usage.

## What you can manage

- **Product environment**: plan, monthly credit usage, storage, bandwidth, asset counts, folder mode and the per-file upload limits
- **Media assets**: browse, copy delivery URLs, and edit display name, asset folder and tags
- **Folders**: create, rename or move, delete
- **Upload presets**: create and edit mode, target folder, tags, allowed formats, incoming transformation and whether a public ID may be passed
- **Transformations**: create named transformations, change their definition, and allow them under strict transformations
- **Upload mappings**: map a folder name to a remote URL prefix for auto-upload
- **Webhook notifications**: create, edit and delete the product environment's notification triggers

## Connect with Cloudinary

1. Pick Cloudinary in the add-account form and click **Connect with Cloudinary**.
2. Sign in, choose the product environment (cloud) and approve.
3. The cloud name is filled in when Cloudinary provides it. Otherwise, type it in.
4. Leave **API Key** empty. The connection replaces the key and secret.

Good to know:

- **What you grant:** the Upload and Asset Management scopes (Cloudinary has no read-only scope), plus offline access so the connection keeps working. Your role in Cloudinary still limits what you can do. Infrawrench only reads unless you act.
- **Expiry:** a connection you don't use for three months expires and needs reconnecting.
- **Beta:** Cloudinary's self-service OAuth is in beta. If a feature misbehaves on a connected account, add the account with an API key and secret instead.
- Works from the web app, the desktop app in cloud mode and desktop-local accounts.

## Connect with API keys

In the Cloudinary console, go to **Settings > Access Keys** and paste:

- **Cloud name**
- **API key**
- **API secret**

![Cloudinary Add-account form with cloud name / key / secret fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudinary/add-account.png)

## Common tasks

- **Browse assets** with thumbnails, delivery URLs and metadata.
- **Edit an asset** to change its display name, move it to another asset folder, or replace its tags. Moving an asset doesn't change its public ID or its delivery URL.
- **Rename or move a folder** by editing its path. This only works in dynamic folder mode, which every account created since June 2024 uses. The product environment's detail page shows which mode you're in.
- **Upload presets** let you pick the target folder from your folders and the incoming transformation from your named transformations, so you never type a `t_` reference by hand. Every setting stays editable afterwards.
- **Change a named transformation** with **New Definition**. Cloudinary only applies it to assets derived from then on. Already-derived assets keep the old result until they are invalidated.
- **Webhook notifications**: pick from every documented event type (uploads, deletes, renames, tag and metadata changes, folder moves and more) and choose the signature scheme (default, legacy HMAC or EdDSA v2). Add a JSONLogic **filter** so only matching assets notify, and a Mustache **payload template** for a custom body. Clearing the filter on edit removes it.
- **Upload mappings** import on first request: the first request for `<folder>/<path>` fetches `<prefix><path>` and stores it.

## Usage and quotas

The product environment shows Cloudinary's usage for the current billing cycle. On the [Quota radar](../features/quota-radar.md), each used/limit pair becomes a reading: monthly credits on credit-based plans, transformation, storage and bandwidth limits on older plans, every add-on allowance you have (AI tagging, background removal and so on), and the Admin API's hourly request budget.

## Metrics

- **Product environment**: daily storage, bandwidth, transformations, credits used, requests, and original and derived asset counts. The default range is the last 14 days. Data goes back three months, and ranges longer than 30 days show 30 evenly spaced days.
- **Video assets**: views and watch time, over the last 7 days by default. Views only count when the video plays through the Cloudinary Video Player (1.9.9 or later) or a player set up with the `cloudinary-video-analytics` library, so a video served any other way shows nothing. Images and raw files have no view data. A chart reads up to 5,000 views.

## Tips & limits

- You can't change a webhook notification's event type after creating it. Delete it and create a new one.
- Cloudinary updates usage figures roughly daily, so a large upload can take a while to show in the credit count.
