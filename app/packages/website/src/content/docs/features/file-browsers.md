---
title: File browsers
description: Browse, upload and download files in cloud object storage buckets and over SFTP.
sidebar_order: 6
---

You can browse, upload, download and delete files in your storage buckets and over SFTP. Open a bucket or storage account and click its **Files** tab, next to Overview and any provider-specific tabs (such as Bucket Policy on S3-compatible buckets).

![File browser tab open showing the bucket path bar with folders and files listed](https://agent-assets.infrawrench.com/docs-screenshots/features/file-browsers/s3-files-tab.png)

## Supported storage

- **Amazon S3** buckets
- **Google Cloud Storage** buckets
- **Cloudflare R2** buckets
- **Azure Blob Storage** containers
- **DigitalOcean Spaces** (S3-compatible)
- **Scaleway Object Storage** (S3-compatible)
- **SFTP** over SSH, directly on desktop and through Infrawrench Cloud on web

## Find your way around

At the top there's a **Path** box you can type into (Enter to go, Escape to undo) and a **Filter…** box. Below is one table with **Name**, **Size** and **Last modified** columns. Folders are rows marked with a chevron and listed before files, with a `..` row to go up a level. The footer counts what you're looking at.

Sorting is fixed: folders first, then files.

## Work with files

- **Open a folder** by clicking its row, or type a path.
- **Upload** with **Files**, or **Folder** where the storage supports it. Drag and drop isn't supported.
- **Create a folder** with **+ Folder**.
- **Download** a file with the download icon on its row. Tick several rows and click **Download** in the toolbar to get them as a zip. On web this opens one download per batch, so allow pop-ups. On desktop, SFTP downloads go into the folder you pick, keeping the layout of any folders you selected.
- **Delete** with the **X** icon on a row, or **Delete** in the toolbar for a selection. Both ask you to confirm.
- **Select a range** with shift-click.

### Skipped files on SFTP download

If a remote file's name contains `..`, `\`, `:` or a NUL character, it could end up outside your download folder, so it's skipped and a warning lists it. Rename it on the server to download it.

## Large uploads

- On S3, R2, GCS and Azure Blob, files over 8 MB are uploaded in parts automatically. Pausing the tab cancels the upload, and you can't resume it.
- The desktop app is usually faster, since it talks to the provider directly. The web app goes through Infrawrench's server, which adds a step.

## If something is missing

You only see what your account's credential can see. If you can list a bucket but not a particular prefix, the prefix shows up but opens empty. Check your IAM policies if something is missing.
