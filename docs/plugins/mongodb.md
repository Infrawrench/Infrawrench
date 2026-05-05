---
title: MongoDB
description: Browse MongoDB databases, collections, and documents.
sidebar_order: 17
---

## What you can manage

- Databases
- Collections
- Documents (browse with pagination)
- Basic schema inference

## Credentials

Paste a MongoDB connection string:

```
mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
mongodb://user:password@host:27017/dbname
```

<insert [MongoDB Add-account form with connection string field] here>

## Notable flows

- **Collection browser** — filter by a `find` query; sort and paginate.
- **Document viewer** — JSON view with copy.

## Tips & limits

- Aggregation pipelines are not yet exposed in the UI — use the shell or Compass.
- MongoDB Atlas SRV URLs need DNS; desktop-firewalled environments may block this. Use the non-SRV host list as a fallback.
