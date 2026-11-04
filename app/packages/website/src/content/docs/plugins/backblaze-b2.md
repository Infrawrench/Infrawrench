---
title: Backblaze B2
description: Browse and upload files in Backblaze B2 buckets, manage visibility, encryption, Object Lock and lifecycle, CORS, replication and event notification rules, mint bucket-scoped keys, and chart usage and estimated spend from Backblaze's daily usage reports.
sidebar_order: 50
---

Connect a Backblaze B2 account to manage its buckets and application keys, and to see what it stores and costs.

## What you can manage

- **Buckets**: every bucket with its visibility (private or public), default encryption (SSE-B2), Object Lock and default retention, default `Cache-Control`, and its S3 endpoint and region. Create buckets (choosing visibility, encryption, how many file versions to keep and Object Lock), edit visibility, encryption, retention and Cache-Control, and delete empty buckets. You can turn Object Lock on later but never off.
- **File browser**: list, upload and delete files and create folders in any bucket. Deleting a file removes every version of it, so it is really gone rather than hidden.
- **Lifecycle rules**: per file name prefix, hide files after a number of days, delete hidden versions after a number of days, and cancel abandoned large-file uploads. Create, edit and delete them from the bucket's **Rules** tab.
- **CORS rules**: allowed origins, operations (S3 and native B2), headers and preflight cache time.
- **Replication rules**: replicate a bucket to another bucket in the same account. Pick the destination, and Infrawrench creates and sets up the two application keys replication needs (read on the source, write on the destination). You can enable, disable, re-prioritise or change the prefix later.
- **Event notifications**: webhooks for object created, deleted and hidden events, with an optional prefix, batching and custom headers. The signing secret is an output you can reveal. A suspended rule shows its reason and can be re-enabled.
- **Application keys**: every key with its capabilities, bucket and prefix restrictions and expiry. Create keys with any capabilities (the secret is saved as the key's **Application Key** output so you can export it later), and delete keys.
- **Get credentials**: on a bucket, create a read/write or read-only key limited to that bucket. On the account, create one for all buckets. You get an S3-style credentials file with the endpoint and region filled in.

<insert [Backblaze B2 bucket detail page showing the Rules tab with lifecycle, CORS and replication rule tables] here>

## Connect your account

1. In the Backblaze web console, open **Application Keys** and choose **Add a New Application Key**.
2. For every feature, give it access to **All buckets** with **Read and Write** access. A key limited to one bucket only shows that bucket.
3. To create keys (Get credentials, replication), use a key that can write keys, such as the master application key.
4. Copy the **keyID** and **applicationKey**. The secret is shown only once.

The add-account checklist reads the key's capabilities and tells you what is missing for each feature.

<insert [Backblaze B2 Add-account form with the Application Key ID and Application Key fields filled in] here>

## Usage, metrics and costs

B2 has no usage or billing API for a normal account. Instead it has **usage reports**. Once Backblaze support turns them on, Backblaze writes a CSV every day to a bucket named `b2-reports-<account id>` with each bucket's stored bytes, downloads, uploads, deletions and API calls. Your key needs to be able to read that bucket.

With reports turned on:

- Buckets and the account get a **Metrics** tab with daily stored, downloaded, uploaded and deleted GB and Class B and C calls.
- The **Costs** page shows estimated spend per bucket at list price: storage at $6.95 per TB per month with the first 10 GB free, downloads beyond three times your average storage at $0.01/GB, and Class D calls beyond 2,500 a day. Class A, B and C calls are free. This is an estimate: annual commitments, B2 Overdrive and taxes aren't included.

Without reports, the Costs page tells you to ask Backblaze support to turn them on.

## Status

Active incidents and maintenance windows from [status.backblaze.com](https://status.backblaze.com) show on your B2 resources in the affected region (US West, US East, EU Central or CA East).

## Terraform

Buckets (with their lifecycle and CORS rules, encryption and Object Lock) and application keys export to the official `Backblaze/b2` provider. Replication and event notification rules aren't exported.

## Limits

- B2 only deletes empty buckets.
- A bucket can have at most two replication rules as a source, 100 CORS rules and 25 event notification rules.
- The file browser uploads each file in a single request, so use the B2 CLI or an S3 tool for very large files.
- Application keys created outside Infrawrench never reveal their secret. Replace them if you need one.
