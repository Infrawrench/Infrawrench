---
title: Wasabi
description: Browse and upload objects in Wasabi buckets, manage versioning, Object Lock, bucket policies, lifecycle and CORS rules, IAM users and access keys and Account Control sub-accounts, and chart daily storage and estimated spend from the Wasabi Stats API.
sidebar_order: 50
---

Connect a Wasabi account to manage its buckets, sub-users and (for Account Control customers) sub-accounts, and to see what it stores and costs.

## What you can manage

- **Buckets**: every bucket in every region, with versioning, Object Lock and its default retention, tags, and the latest stored size and object count. Create buckets in any Wasabi region (with versioning or Object Lock), change versioning (enable or suspend), default retention and tags, and delete empty buckets.
- **File browser**: list, upload and delete objects and create folders. Deleting a folder deletes everything under it.
- **Bucket policy**: edit the bucket policy with the policy editor (statement builder or raw JSON).
- **Lifecycle rules**: expire current objects, expire previous versions and abort incomplete multipart uploads after a number of days, per prefix. Create, edit, disable and delete them from the bucket's **Rules** tab.
- **CORS rules**: allowed origins, methods, headers and preflight cache time.
- **IAM users**: sub-users with their attached and inline policies, groups and access keys. Create users with Wasabi or customer policies picked from a list, change attached policies, and delete users (their keys, policies and group memberships are removed first). **Get credentials** creates a new access key.
- **Access keys**: every user's keys with status, creation and last-used dates. Activate, deactivate or delete them. They also appear on the access review.
- **Get credentials on a bucket**: creates an IAM user whose inline policy covers only that bucket (read/write or read-only) plus an access key, and gives you an S3 credentials file with the bucket's regional endpoint.
- **Sub-accounts** (Wasabi Account Control customers): list, create (paid or trial), edit quota, FTP, activation and self-delete permission, convert trials to paid, reset access keys, delete, and chart each sub-account's daily usage. Keys of sub-accounts created here are kept as outputs.

<insert [Wasabi bucket detail page showing the Rules tab with lifecycle and CORS rules and the Bucket Policy tab] here>

## Credentials

In the Wasabi console open **Access Keys** and choose **Create Access Key** for the root user, then copy the access key and the secret key. A root key gives every feature. A sub-user's key also works if its policy allows S3 and IAM; usage and costs come from the Wasabi Stats API, which accepts only root keys or keys with billing permissions.

**Account Control API key** (optional, under Advanced): only for Wasabi Account Control (WACM) control accounts. It is a separate key Wasabi issues for managing sub-accounts. Leave it empty on an ordinary account.

<insert [Wasabi Add-account form with Access Key and Secret Key filled in and the Advanced options section expanded showing the Account Control API Key field] here>

## Usage, metrics and costs

The Wasabi Stats API reports one utilization record per bucket per day. From it:

- Buckets, the account and sub-accounts get a **Metrics** tab with daily active storage, deleted storage, objects, uploaded and downloaded GiB and API calls.
- The **Costs** page shows estimated spend per bucket at pay-as-you-go list price: active storage plus "timed deleted storage" (objects deleted before the 90-day minimum), at $7.99 per TB per month from July 2026 ($6.99 before), with 1 TB = 1,024 GiB as Wasabi bills it. Wasabi charges nothing for egress or requests. Reserved Capacity Storage customers are billed differently, so treat the figure as list price.

## Status

Open incidents on [status.wasabi.com](https://status.wasabi.com) show on your Wasabi resources in the affected region.

## Limits

- Wasabi has no official Terraform provider, so Wasabi resources are not exported to Terraform.
- Versioning can be suspended but never turned off, and Object Lock can only be enabled when a bucket is created.
- Uploads from the file browser go through a single request, so very large files are better uploaded with an S3 tool.
- An IAM user can hold at most two access keys.
