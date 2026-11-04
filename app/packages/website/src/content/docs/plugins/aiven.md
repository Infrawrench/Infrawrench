---
title: Aiven
description: Manage Aiven projects and services of every type, with users, databases, connection pools, Kafka topics, ACLs, connectors and schemas, integrations, VPCs, metrics, logs, costs and credits.
sidebar_order: 50
---

Connect an Aiven account to manage its projects and managed services (PostgreSQL, MySQL, Kafka, Kafka Connect, OpenSearch, ClickHouse, Valkey, Dragonfly, Grafana, Flink, Thanos and more), and to open your databases in Infrawrench's consoles.

## What you can manage

- **Projects**: default cloud, billing group, organization, estimated balance, technical contacts, active alerts and credits. Create projects (pick the cloud and billing group from lists), edit technical contacts, and use **Default cloud**, **Billing group** and **Claim credit code**. The Logs tab shows the project event log.
- **Services**: every service type, with state, version, plan, cloud, nodes, CPUs, memory, disk, maintenance window and pending updates, termination protection, VPC, recent backups and active alerts. To create a service, pick the type, a plan (with an approximate monthly price) and a cloud. You can edit the disk size, maintenance window and termination protection. Actions: **Power off** and **Power on**, **Change plan**, **Move cloud**, **Apply maintenance now** and **Tags**. The service URI, host, port, admin user and password, default database and the project CA certificate are outputs.
- **Service users**: create users, **Set password** (or let Aiven generate one), renew Kafka access certificates and delete users. The password, certificate and key are outputs, and the certificate's expiry shows on the Expiry radar.
- **Databases** (PostgreSQL, MySQL): create and delete.
- **Connection pools** (PostgreSQL PgBouncer): create, edit the database, user, mode and size, and delete. Each pool opens in the PostgreSQL console.
- **Kafka topics**: partitions, replication, retention, min in-sync replicas and cleanup policy. Create, edit and delete topics, and produce messages from the **Publish** tab (needs the Karapace REST proxy on the service).
- **Kafka ACLs**: create and delete.
- **Kafka connectors**: class, state and tasks, with the last task error. Create connectors from the service's available plugins, **Edit config**, **Pause**, **Resume**, **Restart**, restart single tasks, and delete.
- **Schema subjects**: the latest schema and all versions. Create subjects, **Register version** and delete.
- **Service integrations**: create (pick the type, source and destination from lists) and delete.
- **Project VPCs** and **VPC peerings**: create a VPC in a cloud, add peering connections to your AWS, Google Cloud, Azure or UpCloud networks, check their state and delete them.
- **Billing groups**: payment method, balance, invoices and credits, and **Claim credit code**.

<insert [Aiven service detail page for a PostgreSQL service showing the Service, Connection and Maintenance sections with the Change plan and Move cloud actions in the header] here>

## Open a database console

PostgreSQL and MySQL services (and PostgreSQL connection pools) open in the SQL editor, Valkey and Dragonfly in the key browser, and OpenSearch in the OpenSearch console. TLS verification stays on, using your project's CA certificate.

Kafka services open in the Kafka console when **SASL authentication** is enabled on the service (`kafka_authentication_methods.sasl` in the advanced configuration). Services that only accept client certificates show a note explaining this instead.

## Connect your account

Create a token in the [Aiven console](https://console.aiven.io/profile/auth) under **User profile > Tokens**, or use an application user's token from your organization. The token has that user's permissions, so it sees the projects the user belongs to. Costs, invoices and credits need access to the organization's billing.

<insert [Aiven Add-account form with the API Token field filled in] here>

## Metrics and logs

The Metrics tab charts what Aiven reports for the service type: CPU, memory, disk, disk I/O, load and network for every service, plus charts specific to each type. Kafka topics have their own topic-level metrics. You can filter service logs to warnings and errors.

## Costs and credits

Costs come from your billing groups' invoices, including the running estimate for the current month. Each invoice line is spread evenly across the days it covers. Costs are broken down by service type, cloud, project, service and billing tags, with credit use, support and commitment fees shown apart from usage. Unexpired credits on each billing group show as credit balances.

## Status

Incidents on [status.aiven.io](https://status.aiven.io) show on every Aiven resource. When an incident names a cloud such as `google-europe-west1`, it's also linked to your services in that cloud.

## Export to Terraform

**Export to Terraform** writes `aiven/aiven` provider blocks with import ids for projects, services (as `aiven_pg`, `aiven_kafka`, …), service users, databases, connection pools, Kafka topics and ACLs, integrations and VPCs. Advanced service settings (`user_config`) aren't exported. Run `terraform plan` after import to see them.

## Things to know

- Powering a service off keeps its backups, but you lose anything written after the last one.
- Moving a service to another cloud or changing its plan migrates it online. Aiven shows progress in the service state.
- Kafka topic partitions can only grow.
