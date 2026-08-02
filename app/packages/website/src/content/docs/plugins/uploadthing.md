---
title: UploadThing
description: Browse, upload, rename, re-permission, and delete the files in an UploadThing app, and watch its storage quota.
sidebar_order: 49
---

## What you can manage

- The **app** — its ID, region, default ACL, and storage quota
- **Files** — browse, upload, rename, change access, delete

An UploadThing API key is scoped to a single app, so one Infrawrench account is
one UploadThing app. Add a second account for a second app.

## Credentials

UploadThing dashboard → **API Keys**. Paste **either** value into the single
field — Infrawrench works out which one you gave it:

- the **V7 token** (`UPLOADTHING_TOKEN`), which is what the copy button hands
  out — base64-encoded JSON holding the key, the app ID, and the region
- a raw **`sk_live_…` secret key**, if your app still uses one

<insert [UploadThing Add-account form showing the single API Key or Token field] here>

## Notable flows

- **File browser** on the app page — upload from your machine, download, and
  delete, backed by UploadThing's own listing.
- **Upload from URL** — the Files table's create button takes a public URL,
  downloads it, and pushes the bytes to UploadThing. Optionally set a custom ID
  and, where the app allows it, the file's access level.
- **Make public / Make private** on a file, when the app allows per-file ACL
  overrides. These buttons are hidden when it does not, because the API rejects
  the change rather than ignoring it — flip the app-wide default in the
  UploadThing dashboard instead.
- **Signed URL** is a resolvable output on every file. That is how a private
  file is read: the public `https://<app-id>.ufs.sh/f/<key>` URL only works for
  files whose ACL is `public-read`.
- **Failed uploads** show up on the Potential savings page — an upload that
  never completed cannot be served and is safe to delete.

<insert [UploadThing app detail page showing the storage quota section and the Files table] here>

## Tips & limits

- Infrawrench syncs the first **2,000 files** as individual resources. The app
  page says so explicitly when there are more, and shows the real total from
  UploadThing's own counter. The Files browser is subject to the same cap.
- On the free tier the storage quota is shared across every free app on the
  account, so "storage used by this app" and "counted against quota" can differ.
  The app page shows both when they do.
- UploadThing stores files in a **flat namespace** — there are no folders, and
  the browser's search box filters on file name.
- **Content type** is only available on a file's own page. UploadThing's file
  listing does not include it, so it is fetched separately when you open a file.
- Files cannot be moved between apps, and a file's key is assigned at upload
  and never changes. Renaming changes the display name only.
