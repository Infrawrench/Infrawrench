---
title: Azure
description: Manage VMs, AKS, App Service, SQL Database, CosmosDB, and storage.
sidebar_order: 2
---

## What you can manage

- **Compute** — Virtual Machines, App Service, Function Apps.
- **Kubernetes** — AKS clusters (links to the [Kubernetes plugin](./kubernetes.md)).
- **Databases** — SQL Database, CosmosDB.
- **Storage** — Storage accounts (Blob, File, Queue, Table).
- **Networking** — VNets, Subnets, NSGs, Load Balancers, Public IPs.
- **Security** — Key Vault (keys, secrets, certificates).

## Credentials

Create a service principal (Azure Portal → Microsoft Entra ID → App registrations → New registration → Certificates & secrets → New client secret). Grant it the roles it needs on the subscription. Paste:

- **Tenant ID**
- **Client ID**
- **Client secret**
- **Subscription ID**

<insert [Azure Add-account form with tenant / client / secret / subscription fields] here>

## Notable flows

- **SSH terminal** on Linux VMs.
- **SQL editor** on Azure SQL Database.
- **File browser** on Blob Storage.
- **Secret export to K8s** for SQL Database and Storage accounts.
- **Read-only manifest view** on every resource.

## Tips & limits

- One account ties to one subscription. For multi-subscription tenants, add one infrawrench account per subscription.
- Key Vault access requires the principal to have an access policy or RBAC role on the vault — the subscription role is not enough.
