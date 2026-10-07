---
title: Backblaze B2
description: Browse and upload files in Backblaze B2 buckets, manage visibility, encryption, Object Lock and lifecycle, CORS, replication and event notification rules, mint bucket-scoped keys, and chart usage and estimated spend from Backblaze's daily usage reports.
sidebar_order: 50
---

Connect a Backblaze B2 account to manage its buckets and application keys and to see what it stores and costs.

## What you can manage

- **Buckets**: every bucket with its visibility (private or public), default encryption (SSE-B2), Object Lock and default retention, default `Cache-Control`, and its S3 endpoint and region. Create buckets (choosing visibility, encryption, how many file versions to keep and Object Lock), edit visibility, encryption, retention and Cache-Control, and delete empty buckets. Object Lock can be turned on later but never off.
- **File browser**: list, upload and delete files and create folders in any bucket. Deleting a file removes every version of it, so it is really gone rather than hidden.
- **Lifecycle rules**: per file name prefix, hide files after a number of days, delete hidden versions after a number of days, and cancel abandoned large-file uploads. Create, edit and delete them from the bucket's **Rules** tab.
- **CORS rules**: allowed origins, operations (S3 and native B2), headers and preflight cache time.
- **Replication rules**: replicate a bucket to another bucket in the same account. Pick the destination; Infrawrench creates the two application keys B2 replication needs (read on the source, write on the destination) and wires them up. Enable, disable, re-prioritise or change the prefix later.
- **Event notifications**: webhooks for object created, deleted and hidden events, with an optional prefix, batching and custom headers. The signing secret is an output you can reveal. A suspended rule shows its reason and can be re-enabled.
- **Application keys**: every key with its capabilities, bucket and prefix restrictions and expiry. Create keys with any capabilities (the secret is kept as the key's **Application Key** output so you can export it later), and delete keys.
- **Get credentials**: on a bucket, mint a read/write or read-only key limited to that bucket; on the account, one for all buckets. You get an S3-style credentials file with the endpoint and region filled in.

<insert [Backblaze B2 bucket detail page showing the Rules tab with lifecycle, CORS and replication rule tables] here>

## Credentials

In the Backblaze web console open **Application Keys** and choose **Add a New Application Key**. For every feature, give it access to **All buckets** with **Read and Write** access; a key limited to one bucket only shows that bucket. Creating keys (Get credentials, replication) needs a key that can write keys, such as the master application key. Copy the **keyID** and **applicationKey**; the secret is shown once.

The add-account checklist reads the key's capabilities and tells you what is missing for each feature.

<insert [Backblaze B2 Add-account form with the Application Key ID and Application Key fields filled in] here>

## Usage, metrics and costs

B2 has no usage or billing API for a normal account. What it has is **usage reports**: once Backblaze support enables them, Backblaze writes a CSV every day to a bucket named `b2-reports-<account id>` with each bucket's stored bytes, downloads, uploads, deletions and API calls. Infrawrench reads those files, so the key needs to be able to read that bucket.

With reports enabled:

- Buckets and the account get a **Metrics** tab with daily stored, downloaded, uploaded and deleted GB and Class B and C calls.
- The **Costs** page shows estimated spend per bucket at list price: storage at $6.95 per TB per month with the first 10 GB free, downloads beyond three times your average storage at $0.01/GB, and Class D calls beyond 2,500 a day. Class A, B and C calls are free. It is an estimate: annual commitments, B2 Overdrive and taxes are not reflected.

Without reports the Costs page tells you to ask Backblaze support to turn them on.

## Status

Active incidents and maintenance windows from [status.backblaze.com](https://status.backblaze.com) show on your B2 resources in the affected region (US West, US East, EU Central or CA East).

## Terraform

Buckets (with their lifecycle and CORS rules, encryption and Object Lock) and application keys export to the official `Backblaze/b2` provider. Replication and event notification rules are not exported.

## Limits

- B2 only deletes empty buckets.
- A bucket can have at most two replication rules as a source, 100 CORS rules and 25 event notification rules.
- Uploads from the file browser go through a single request, so very large files are better uploaded with the B2 or an S3 tool.
- Application keys created outside Infrawrench never reveal their secret; replace them if you need one.
