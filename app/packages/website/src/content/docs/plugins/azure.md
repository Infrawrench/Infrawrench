---
title: Azure
description: Manage VMs, AKS, App Service, SQL Database, CosmosDB, and storage.
sidebar_order: 2
---

## What you can manage

- **Compute** — Virtual Machines, App Service, Function Apps, App Service Plans.
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

## App Service Plans

App Service Plans are listed read-only — Infrawrench does not create them. Each plan shows its SKU, tier and size, the instance count it is scaled to, whether its workers are Linux or Windows, and how many apps are assigned to it. Plans are the billing unit for App Service and Functions, so a dedicated plan with zero apps assigned is flagged by the [orphan finder](../features/orphan-finder.md). Free and Functions consumption tiers bill per execution rather than per instance, so they are never flagged.

Web apps and function apps link to the plan they run on in the [dependency graph](../features/dependency-graph.md), so opening a plan shows everything it hosts.

A **Metrics** tab reports the plan-wide CPU and memory percentage, disk and HTTP queue length, and data in/out — these are the numbers to scale on, since an individual app's metrics don't show plan-level saturation.

<insert [Azure App Service Plan detail page showing the SKU/tier/instances fields and the dependency graph with two web apps pointing at the plan] here>

## Tips & limits

- One account ties to one subscription. For multi-subscription tenants, add one infrawrench account per subscription.
- Key Vault access requires the principal to have an access policy or RBAC role on the vault — the subscription role is not enough.

## Cost graphs

Azure subscriptions feed [cost graphs & budgets](../features/cloud-costs.md) via the Cost Management Query API, collected daily with service and region breakdowns (13 months of history).

- The service principal needs the **Cost Management Reader** role on the subscription — plain **Reader** is not enough.
