---
title: MongoDB
description: Browse MongoDB databases, collections, and documents.
sidebar_order: 17
---

Connect a MongoDB database to browse its collections and documents.

## What you can manage

- Databases
- Collections
- Documents (browse with pagination)
- Basic schema inference

## Connect a database

Paste a MongoDB connection string:

```
mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
mongodb://user:password@host:27017/dbname
```

![MongoDB Add-account form with connection string field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mongodb/add-account.png)

## Browse your data

- **Collection browser**: filter with a `find` query, then sort and paginate.
- **Document viewer**: a JSON view you can copy from.

## Tips and limits

- For an Atlas organization, add the [MongoDB Atlas](./mongodb-atlas.md) plugin instead. It lists every cluster, tracks Atlas spend, and opens each cluster's data here from its **MongoDB** tab, so you don't have to paste a connection string.
- Aggregation pipelines aren't in the UI yet. Use the shell or Compass.
- Atlas SRV URLs need DNS, which some firewalled desktop setups block. If so, use the non-SRV host list instead.
- In the cloud app, only username and password sign-in works (the default SCRAM mechanisms, or `PLAIN` for LDAP). Connection strings that use `MONGODB-OIDC`, `MONGODB-AWS`, `MONGODB-X509` or `GSSAPI` (Kerberos), or that point to a file with `tlsCAFile`, `tlsCertificateKeyFile` or `tlsCRLFile`, are refused, because they would sign in with the shared Infrawrench server's identity or read its files. The desktop app supports all of them, using your own machine's credentials and files.
