---
title: Cloudinary
description: Manage Cloudinary media assets, folders, upload presets, transformations, upload mappings and webhook notifications, and track plan usage.
sidebar_order: 25
---

## What you can manage

- **Product environment**: plan, monthly credit usage, storage, bandwidth, asset counts, folder mode and the per-file upload limits
- **Media assets**: browse, copy delivery URLs, and edit display name, asset folder and tags
- **Folders**: create, rename or move, delete
- **Upload presets**: create and edit mode, target folder, tags, allowed formats, incoming transformation and whether a public ID may be passed
- **Transformations**: create named transformations, change their definition, and allow them under strict transformations
- **Upload mappings**: map a folder name to a remote URL prefix for auto-upload
- **Webhook notifications**: create, edit and delete the product environment's notification triggers

## Credentials

Cloudinary console → **Settings → Access Keys**. Paste:

- **Cloud name**
- **API key**
- **API secret**

![Cloudinary Add-account form with cloud name / key / secret fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cloudinary/add-account.png)

## Notable flows

- **Asset browser** with thumbnails, delivery URLs, and metadata.
- **Edit an asset** to change its display name, move it to another asset folder, or replace its tags. Moving an asset does not change its public ID or its delivery URL.
- **Rename or move a folder** by editing its path. This only works in dynamic folder mode, which every account created since June 2024 uses; the product environment's detail page shows which mode yours is in.
- **Upload presets** pick their target folder from your folders and their incoming transformation from your named transformations, so you never type a `t_` reference by hand. Every setting stays editable afterwards.
- **Change a named transformation's definition** with **New Definition**. Cloudinary applies it only to assets derived from then on; already-derived assets keep the old result until they are invalidated.
- **Webhook notifications** pick from every documented event type (uploads, deletes, renames, tag and metadata changes, folder moves and more), choose the signature scheme (default, legacy HMAC or EdDSA v2), and can carry a JSONLogic **filter** so only matching assets notify, plus a Mustache **payload template** for a custom body. Clearing the filter on edit removes it.
- **Upload mappings** turn a folder name into a lazy importer: the first request for `<folder>/<path>` fetches `<prefix><path>` and stores it.

## Usage and quotas

The product environment reports what Cloudinary's usage API says for the current billing cycle. On the [Quota radar](../features/quota-radar.md) surface each used/limit pair becomes a reading: monthly credits on credit-based plans, transformation, storage and bandwidth limits on older plans, every add-on allowance the environment has (AI tagging, background removal and so on), and the Admin API's hourly request budget.

## Metrics

- **Product environment**: daily storage, bandwidth, transformations, credits used, requests, and original and derived asset counts, over the last 14 days by default. Each day is one call to Cloudinary's usage report for that date, which only reaches three months back; ranges longer than 30 days are sampled down to 30 evenly spaced days. Storage and asset counts are the total as of that day; the other figures are what the report gives for that date.
- **Video assets**: views and watch time from Cloudinary's Video Analytics API, over the last 7 days by default. Views are only recorded when the video is played through the Cloudinary Video Player (1.9.9 or later) or a player wired up with the `cloudinary-video-analytics` library, so a video served any other way charts nothing. Images and raw files have no view data. Up to 5,000 views are read per chart; past that, the chart starts at the oldest view read.

## Tips & limits

- Large libraries paginate; search is server-side.
- The event type of a webhook notification can't be changed after it is created; delete it and create a new one instead.
- Cloudinary refreshes usage figures roughly daily, so a large upload can take a while to show up in the credit count.
