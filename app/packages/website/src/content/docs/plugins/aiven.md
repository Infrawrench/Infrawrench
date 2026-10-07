---
title: Aiven
description: Manage Aiven projects and services of every type, with users, databases, connection pools, Kafka topics, ACLs, connectors and schemas, integrations, VPCs, metrics, logs, costs and credits.
sidebar_order: 50
---

Connect an Aiven account to manage its projects and managed services (PostgreSQL, MySQL, Kafka, Kafka Connect, OpenSearch, ClickHouse, Valkey, Dragonfly, Grafana, Flink, Thanos and more) and to open the databases in Infrawrench's consoles.

## What you can manage

- **Projects**: default cloud, billing group, organization, estimated balance, technical contacts, active alerts and credits. Create projects (cloud and billing group from pickers), edit the technical contacts, and use **Default cloud**, **Billing group** and **Claim credit code**. The Logs tab shows the project event log.
- **Services**: every service type, with state, version, plan, cloud, nodes, CPUs, memory, disk, maintenance window and pending updates, termination protection, VPC, nodes, recent backups and active alerts. Create a service by picking the type, a plan for that type (with an approximate monthly price) and a cloud. Edit the disk size, maintenance window and termination protection. Actions: **Power off** and **Power on**, **Change plan**, **Move cloud**, **Apply maintenance now** and **Tags**. The service URI, host, port, admin user and password, default database and the project CA certificate are outputs.
- **Service users**: create users, **Set password** (or let Aiven generate one), renew Kafka access certificates and delete users. The password, certificate and key are outputs, and the certificate's expiry appears on the Expiry radar.
- **Databases** (PostgreSQL, MySQL): create and delete.
- **Connection pools** (PostgreSQL PgBouncer): create, edit the database, user, mode and size, and delete. Each pool's URI opens in the PostgreSQL console.
- **Kafka topics**: partitions, replication, retention, min in-sync replicas and cleanup policy. Create, edit and delete, and produce messages from the **Publish** tab (needs the Karapace REST proxy on the service).
- **Kafka ACLs**: create and delete.
- **Kafka connectors**: class, state and tasks, with the last task error. Create connectors from the service's available plugins, **Edit config**, **Pause**, **Resume**, **Restart**, restart single tasks, and delete.
- **Schema subjects**: the latest schema and all versions. Create subjects, **Register version** and delete.
- **Service integrations**: create (type, source and destination from pickers) and delete.
- **Project VPCs** and **VPC peerings**: create a VPC in a cloud, add peering connections to your AWS, Google Cloud, Azure or UpCloud networks, check their state and delete them.
- **Billing groups**: payment method, balance, invoices and credits, and **Claim credit code**.

<insert [Aiven service detail page for a PostgreSQL service showing the Service, Connection and Maintenance sections with the Change plan and Move cloud actions in the header] here>

## Database consoles

PostgreSQL and MySQL services (and PostgreSQL connection pools) open in the SQL editor, Valkey and Dragonfly in the key browser, and OpenSearch in the OpenSearch console. Aiven signs service certificates with a per-project CA, and Infrawrench passes that CA along, so TLS verification stays on.

Kafka services open in the Kafka console when **SASL authentication** is enabled on the service (`kafka_authentication_methods.sasl` in the advanced configuration). Services that only accept client certificates show a note explaining this instead.

## Credentials

Create a token in the [Aiven console](https://console.aiven.io/profile/auth) under **User profile → Tokens**, or use an application user's token from your organization. The token acts with that user's permissions: it sees the projects the user belongs to. Costs, invoices and credits need access to the organization's billing.

<insert [Aiven Add-account form with the API Token field filled in] here>

## Metrics and logs

The Metrics tab charts what Aiven reports for the service type (CPU, memory, disk, disk I/O, load and network for every service, plus type-specific charts). Kafka topics have their own topic-level metrics. Readings from several nodes are averaged for percentages and summed otherwise. Service logs can be filtered to warnings and errors.

## Costs and credits

Costs come from your billing groups' invoices, including the running estimate for the current month. Aiven reports each invoice line as a total for the period it covers, so Infrawrench spreads it evenly across those days. Lines are broken down by service type, cloud, project and service, and billing tags, and credit use, support and commitment fees are kept apart from usage. Unexpired credits on each billing group appear as credit balances.

## Status

Incidents on [status.aiven.io](https://status.aiven.io) show on every Aiven resource; when an incident names a cloud such as `google-europe-west1`, it is also linked to the services in that cloud.

## Terraform

**Export to Terraform** writes `aiven/aiven` provider blocks with import ids for projects, services (as `aiven_pg`, `aiven_kafka`, …), service users, databases, connection pools, Kafka topics and ACLs, integrations and VPCs. Advanced service settings (`user_config`) are not exported; `terraform plan` after import shows them.

## Quirks

- Powering a service off keeps its backups but loses anything written after the last one.
- Moving a service to another cloud or changing its plan migrates it online; Aiven reports progress in the state.
- Kafka topic partitions can only grow.
