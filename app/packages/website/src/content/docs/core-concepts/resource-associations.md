---
title: Resource Associations
description: Cross-resource relationships Infrawrench can create directly, and the association flows still planned.
sidebar_order: 5
---

Resource associations are the drag-and-drop or picker-driven relationships between existing resources, such as attaching a disk to a VM or registering a VM behind a load balancer.

## Implemented

- **AWS** — Elastic IP to EC2 instance, Elastic IP to subnet for public NAT gateway creation, EBS volume to EC2 instance, security group to EC2 instance, target group to EC2 instance, Auto Scaling group to target group, internet gateway to VPC, route table to subnet, internet gateway or NAT gateway default route to route table, Route 53 alias record to load balancer.
- **Azure** — managed disk to VM, network security group to VM primary NIC, network security group to subnet, public IP to VM primary NIC IP configuration, public IP to NAT gateway, load balancer backend pool to VM primary NIC IP configuration, application gateway backend pool to VM primary NIC IP configuration, route table to subnet, NAT gateway to subnet, private DNS zone link to virtual network.
- **Google Cloud** — persistent disk to VM instance, static external IP to VM instance, firewall rule to VM instance tags, Cloud NAT to subnet.
- **DigitalOcean** — block storage volume to Droplet, NFS share to Droplet VPC, Gradient knowledge base to AI agent.
- **Fly.io** — volume to machine, with region validation.
- **Hetzner Cloud** — volume to server, firewall to server, load balancer to server target, network to server, network to load balancer, floating IP to server, primary IP to server.
- **Scaleway** — block volume to instance, with zone validation.
- **OVHcloud** — block storage volume to Public Cloud instance, with region validation.
- **Vercel** — domain to project, deployment URL to project environment variable.
- **Netlify** — DNS zone domain to site custom domain or domain alias, deploy restore to site, build hook URL to site environment variable.
- **Cloudinary** — named transformation to upload preset.
- **Databricks** — single-task job to all-purpose cluster, single SQL-task job to SQL warehouse, pipeline to catalog/schema publishing target, serving endpoint to single Unity Catalog model version.
- **Turso** — pending organization invite create/delete, organization member role update/delete, database/group auth token invalidation helpers.
- **PlanetScale** — branch to branch deploy request creation, branch password update/delete/renew, branch promote helper, deploy-request close/apply helpers.

## Planned

These need a richer association form because the provider requires more than a source and target resource:

- **AWS** — ALB/NLB listener to target group, non-default route-table routes, Route 53 alias/record creation from arbitrary public endpoints.
- **Azure** — explicit backend-pool selection for load balancer/application gateway attachments, backend pools to private endpoints, private DNS registration-enabled links, subnet delegation/service endpoint updates.
- **Hetzner Cloud** — load balancer service creation and health-check tuning, load balancer label-selector targets, firewall label-selector application, subnet and route management inside networks.
- **Fly.io** — certificate hostname creation, shared/dedicated IPv4 allocation, app secrets to machines, service/port exposure from machine config.
- **Vercel and Netlify** — DNS record to deployment target, environment variable import from another resource output with a user-selected variable name/scope.
- **Cloudinary** — folder/tag bulk operations.
- **Databricks** — multi-task job task selection, permissions to users/groups/service principals, serving endpoint served-entity selection for multi-entity endpoints.
- **Turso and PlanetScale** — host-exposed action buttons for token rotation, branch promotion, and deploy-request state transitions where the API operation is already implemented but not yet wired into a detail-view action.

Infrawrench should only expose one-click attachment when the provider API has an unambiguous operation. If the API needs a backend pool, port, IP configuration, route destination, health check, role, or environment target, the UI should collect those fields before calling the provider.
