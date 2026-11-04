---
title: UploadThing
description: Browse, upload, rename, re-permission, and delete the files in an UploadThing app, and watch its storage quota.
sidebar_order: 49
---

## What you can manage

- The **app**: its ID, region, default ACL and storage quota
- **Files**: browse, upload, rename, change access, delete

An UploadThing API key belongs to a single app, so one Infrawrench account is one UploadThing app. Add a second account for a second app.

Opening the account takes you straight to the app page, and the sidebar expands the account directly to its files. See [providers with a single root](../core-concepts/resources-and-accounts.md#providers-with-a-single-root).

## Connect your app

In the UploadThing dashboard, open **API Keys**. Paste **either** value into the single field, and Infrawrench works out which one it is:

- the **V7 token** (`UPLOADTHING_TOKEN`), which is what the copy button gives you
- a raw **`sk_live_…` secret key**, if your app still uses one

![UploadThing Add-account form showing the single API Key or Token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/uploadthing/add-account.png)

## Things you can do

- **Browse files** on the **Files** tab: upload from your machine, download (one file, or a zip of several), and delete.
- **Upload from URL**: give a public URL and Infrawrench downloads it and uploads it to UploadThing. You can set a custom ID, whether browsers show the file inline or download it as an attachment, and, if the app allows it, the file's access level.
- **Make public / Make private** on a file, if the app allows per-file access overrides. If it doesn't, these buttons are hidden. Change the app-wide default in the UploadThing dashboard instead.
- **Read private files** with the **Signed URL** output on every file. The public `https://<app-id>.ufs.sh/f/<key>` URL only works for files whose ACL is `public-read`.
- **Clean up failed uploads**: uploads that never finished can't be served and are safe to delete. They show on the Potential savings page, and **Delete failed uploads** on the app page clears them all at once.
- **Watch storage quota** on the [Quota radar](../features/quota-radar.md): storage counted against the app's quota is tracked over time, with an alert before uploads start failing.
- **See upload activity** on the app's **Metrics** tab: uploads, bytes uploaded, failed uploads, and the running total of stored bytes, over the last 30 days by default. These are worked out from the files currently in the app, so deleted files don't appear. The charts show how the app's current contents arrived, not a full storage history.

![UploadThing app detail page showing the storage quota section, with the file listing on its own Files tab](https://agent-assets.infrawrench.com/docs-screenshots/plugins/uploadthing/app-detail-storage.png)

## Tips & limits

- **Every file is listed**, with no cap, so a very large app takes longer to refresh.
- On the free tier, the storage quota is shared across every free app on your account, so "storage used by this app" and "counted against quota" can differ. The app page shows both when they do.
- UploadThing has **no real folders**. Uploading a folder uploads its **contents**, keeping the folder's relative path in each file's name (`photos/sub/a.png`).
- **The file browser shows those names as folders**, splitting on `/`. Deleting a folder deletes every file under it, and you can't create an _empty_ folder.
- **The page is titled with your account name**, since UploadThing doesn't share an app name. Rename the account to rename the page. The app ID is still shown, and you can copy it.
- **Content type** only shows on a file's own page.
- **Downloading a private file works**, even though its plain `ufs.sh` URL returns 403, because each download gets a short-lived signed URL first.
- You can't move files between apps, and a file's key never changes. Renaming only changes the display name.
