---
title: Resource Associations
description: Cross-resource relationships Infrawrench can create directly, and the association flows still planned.
sidebar_order: 5
---

Resource associations are the drag-and-drop or picker-driven relationships between existing resources, such as attaching a disk to a VM or registering a VM behind a load balancer.

## Implemented

- **AWS** — Elastic IP to EC2 instance, EBS volume to EC2 instance, security group to EC2 instance, target group to EC2 instance, internet gateway to VPC.
- **Azure** — managed disk to VM, network security group to VM primary NIC, public IP to VM primary NIC IP configuration, load balancer backend pool to VM primary NIC IP configuration, application gateway backend pool to VM primary NIC IP configuration.
- **Fly.io** — volume to machine, with region validation.
- **Hetzner Cloud** — volume to server, firewall to server, load balancer to server target, network to server, network to load balancer, primary IP to server.

## Planned

These need a richer association form because the provider requires more than a source and target resource:

- **AWS** — ALB/NLB listener to target group, route table to subnet, route table route to internet/NAT gateway, NAT gateway to subnet plus Elastic IP, Route 53 alias/record to load balancer or public endpoint, Auto Scaling group to target group.
- **Azure** — explicit backend-pool selection for load balancer/application gateway attachments, backend pools to private endpoints, route table to subnet, NAT gateway to subnet, private DNS zone link to virtual network.
- **Hetzner Cloud** — load balancer service creation and health-check tuning, load balancer label-selector targets, firewall label-selector application, subnet and route management inside networks.
- **Fly.io** — certificate hostname creation, shared/dedicated IPv4 allocation, app secrets to machines, service/port exposure from machine config.
- **Vercel and Netlify** — domain to project/site, DNS record to deployment target, environment variable import from another resource output.
- **Cloudinary** — transformation to upload preset, folder/tag bulk operations.
- **Databricks** — job to cluster/SQL warehouse, permissions to users/groups/service principals, pipeline to catalog/schema, serving endpoint to model/version.
- **Turso and PlanetScale** — member/invite role changes, token/password lifecycle actions, database/branch promotion and deploy-request state transitions.

Infrawrench should only expose one-click attachment when the provider API has an unambiguous operation. If the API needs a backend pool, port, IP configuration, route destination, health check, role, or environment target, the UI should collect those fields before calling the provider.
