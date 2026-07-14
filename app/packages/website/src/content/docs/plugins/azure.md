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

- **Create resources in-app** — 25 resource types can be provisioned from the create form: resource groups, VMs (the form auto-creates the VNet, NIC, public IP, and an NSG if you don't pick an existing one), managed disks, VNets (with a default subnet), NSGs, public IPs, load balancers, AKS clusters, storage accounts, SQL Database (on a new or existing server), Cosmos DB, PostgreSQL and MySQL flexible servers, Redis Cache, App Service, Function Apps, container instances, container registries, Key Vaults, Service Bus and Event Hub namespaces, Log Analytics workspaces, managed identities, DNS zones, and Entra ID app registrations (which also mint the matching service principal).
- **SSH terminal** on Linux VMs.
- **SQL editor** on Azure SQL Database.
- **File browser** on Blob Storage.
- **Secret export to K8s** for SQL Database and Storage accounts.
- **Read-only manifest view** on every resource.
- **Send test messages** to queues or topics inside a Service Bus namespace, and events into hubs inside an Event Hub namespace, from a **Send** tab on the detail page — see [Send test messages](../features/send-test-message.md). The service principal needs the **Azure Service Bus Data Sender** or **Azure Event Hubs Data Sender** role on the namespace.

## Tips & limits

- One account ties to one subscription. For multi-subscription tenants, add one infrawrench account per subscription.
- Key Vault access requires the principal to have an access policy or RBAC role on the vault — the subscription role is not enough.
