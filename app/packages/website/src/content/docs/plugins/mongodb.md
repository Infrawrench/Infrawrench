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

![MongoDB Add-account form with connection string field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mongodb/add-account.png)

## Notable flows

- **Collection browser** — filter by a `find` query; sort and paginate.
- **Document viewer** — JSON view with copy.

## Tips & limits

- For an Atlas organization, add the [MongoDB Atlas](./mongodb-atlas.md) plugin instead: it lists every cluster, tracks Atlas spend, and opens each cluster's data here through its **MongoDB** tab without you pasting a connection string.
- Aggregation pipelines are not yet exposed in the UI — use the shell or Compass.
- MongoDB Atlas SRV URLs need DNS; desktop-firewalled environments may block this. Use the non-SRV host list as a fallback.
- In the cloud app, only username-and-password authentication is accepted (the default SCRAM mechanisms, or `PLAIN` for LDAP). Connection strings that use `MONGODB-OIDC`, `MONGODB-AWS`, `MONGODB-X509` or `GSSAPI` (Kerberos), or that name a file with `tlsCAFile`, `tlsCertificateKeyFile` or `tlsCRLFile`, are refused: those would authenticate with the shared Infrawrench server's own identity or read its files. The desktop app supports all of them, since there they use your own machine's credentials and files.
