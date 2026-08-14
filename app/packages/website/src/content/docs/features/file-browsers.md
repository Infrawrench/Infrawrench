---
title: File browsers
description: Browse, upload, and download objects in cloud object storage and over SFTP.
sidebar_order: 6
---

Several plugins expose a file-browser panel on any resource that holds files. It appears as a **Files** tab on bucket and storage-account resources, alongside Overview and any provider-specific editors (e.g. Bucket Policy on S3-compatible buckets).

![File browser tab open showing the bucket path bar with folders and files listed](https://agent-assets.infrawrench.com/docs-screenshots/features/file-browsers/s3-files-tab.png)

## Supported backends

- **Amazon S3** buckets
- **Google Cloud Storage** buckets
- **Cloudflare R2** buckets
- **Azure Blob Storage** containers
- **DigitalOcean Spaces** (S3-compatible)
- **Scaleway Object Storage** (S3-compatible)
- **SFTP** over SSH — **desktop only**

## What you can do

- Navigate folders and preview common file types (text, images, PDFs).
- **Upload** from your machine — drag onto the pane or click **Upload**.
- **Create folder** (for object stores, this creates a zero-byte `.keep`-style marker).
- **Download** — single files or a selection. Batch downloads stream as a zip.
- **Delete** with a confirm step.
- **Copy public URL** for objects that have one.

## Large uploads

- S3, R2, GCS, Azure Blob: multipart uploads are used automatically for files over 8 MB. Pausing a tab cancels the upload; there is no resume.
- Desktop is generally faster — it talks direct to the provider. The web app proxies through infrawrench’s server, which adds a round-trip.

## Permissions gotchas

The browser only shows what your account’s credential can see. If you can list a bucket but not a particular prefix, the prefix shows up but opens empty. Check your IAM policies if something is missing.
