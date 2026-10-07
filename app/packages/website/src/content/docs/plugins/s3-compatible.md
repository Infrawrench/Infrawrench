---
title: S3-Compatible Storage
description: Connect any S3-compatible object store (MinIO, Ceph RGW, Garage, SeaweedFS and more) to browse objects and manage buckets, policies, versioning, Object Lock, tags, lifecycle and CORS rules, plus MinIO cluster health.
sidebar_order: 50
---

Use this plugin for object storage that speaks the S3 API but has no dedicated plugin: a MinIO cluster, Ceph's RADOS Gateway, Garage, SeaweedFS, or an appliance with an S3 endpoint.

## What you can manage

- **Endpoint**: which server software answers (detected from the S3 `Server` header) and how many buckets it holds.
- **Buckets**: region, creation date, versioning, Object Lock and default retention, tags and whether a bucket policy is set. Create buckets (with versioning or Object Lock), enable or suspend versioning, change default retention and tags, and delete empty buckets.
- **File browser**: list, upload and delete objects and create folders. Deleting a folder deletes everything under it in batches.
- **Bucket policy**: edit with the policy editor (statement builder or raw JSON).
- **Lifecycle rules**: expire current objects and previous versions and abort incomplete uploads after a number of days, per prefix.
- **CORS rules**: on servers that support bucket CORS (Ceph and Garage do; MinIO does not, so the list stays empty there).

### MinIO extras

When the endpoint is MinIO and the key may read server info (the root user can; otherwise a policy with `admin:ServerInfo`):

- The endpoint shows the deployment mode, version, deployment ID, object count, used, free and total capacity, and how many servers and drives are online.
- **MinIO servers** appear as their own resources with state, version, uptime, pool and every drive's state and usage. An offline server shows red.
- Buckets show their size and object count.
- A **Metrics** tab charts used and free capacity, objects, servers online and offline drives on the endpoint, drive usage per server, and size and objects per bucket, sampled each time Infrawrench syncs.

<insert [S3-compatible endpoint detail page for a MinIO cluster showing the MinIO cluster section with servers and drives online] here>

## Credentials

- **Endpoint URL**: the S3 API address with its port, for example `https://minio.example.com:9000` (MinIO's API port, not its console port) or your Ceph RADOS Gateway URL.
- **Region**: what the server signs for. MinIO and Garage use `us-east-1` unless configured otherwise; Ceph uses its zonegroup name.
- **Access key** and **secret key**: on MinIO create an access key in the console under **Access Keys** (or with `mc admin user svcacct add`); on Ceph use `radosgw-admin user create`.
- Under **Advanced options**: **Addressing** (path-style, the default, or virtual-hosted), a **Session token** for temporary STS credentials, and a **CA certificate** for servers with a private or self-signed certificate.

The endpoint must be reachable from wherever Infrawrench runs. For a server on a private network, use the desktop app on a machine that can reach it; bastion routing does not cover user-supplied endpoints yet.

<insert [S3-compatible Add-account form with Endpoint URL, Region, Access Key and Secret Key filled in and Advanced options expanded showing Addressing and CA Certificate] here>

## Limits

- There is no cost data: self-hosted storage has no bill to read.
- The MinIO admin API keeps no history, so MinIO metrics start when the account is added.
- Uploads from the file browser go through a single request, so very large files are better uploaded with an S3 tool.
- Versioning can be suspended but never turned off, and Object Lock can only be enabled when a bucket is created.
