---
title: Resource Associations
description: Link existing resources together in Infrawrench, like attaching a disk to a VM or a VM to a load balancer, and see which associations are still planned.
sidebar_order: 5
---

Associations let you link resources you already have, by drag and drop or with a picker. Attach a disk to a VM, put a VM behind a load balancer, point a domain at a project.

## What you can link today

- **AWS**: Elastic IP to EC2 instance, Elastic IP to subnet for public NAT gateway creation, EBS volume to EC2 instance, security group to EC2 instance, target group to EC2 instance, Auto Scaling group to target group, internet gateway to VPC, route table to subnet, internet gateway or NAT gateway default route to route table, Route 53 alias record to load balancer.
- **Azure**: managed disk to VM, network security group to VM primary NIC, network security group to subnet, public IP to VM primary NIC IP configuration, public IP to NAT gateway, load balancer backend pool to VM primary NIC IP configuration, application gateway backend pool to VM primary NIC IP configuration, route table to subnet, NAT gateway to subnet, private DNS zone link to virtual network.
- **Google Cloud**: persistent disk to VM instance, static external IP to VM instance, firewall rule to VM instance tags, Cloud NAT to subnet.
- **DigitalOcean**: block storage volume to Droplet, NFS share to Droplet VPC, Gradient knowledge base to AI agent.
- **Fly.io**: volume to machine (regions must match).
- **Hetzner Cloud**: volume to server, firewall to server, load balancer to server target, network to server, network to load balancer, floating IP to server, primary IP to server.
- **Scaleway**: block volume to instance (zones must match).
- **OVHcloud**: block storage volume to Public Cloud instance (regions must match).
- **Vercel**: domain to project, deployment URL to project environment variable.
- **Netlify**: DNS zone domain to site custom domain or domain alias, deploy restore to site, build hook URL to site environment variable.
- **Cloudinary**: named transformation to upload preset.
- **Databricks**: single-task job to all-purpose cluster, single SQL-task job to SQL warehouse, pipeline to catalog/schema publishing target, serving endpoint to single Unity Catalog model version.
- **Turso**: create or delete pending organization invites, update or remove an organization member's role, invalidate database or group auth tokens.
- **PlanetScale**: create a deploy request from one branch to another, update, delete or renew branch passwords, promote a branch, close or apply deploy requests.

## Planned

These aren't available yet, because the provider needs more than a source and a target (a port, backend pool, route destination, health check, role and so on), and Infrawrench will ask for those details before making the change:

- **AWS**: ALB/NLB listener to target group, non-default route-table routes, Route 53 alias/record creation from arbitrary public endpoints.
- **Azure**: choosing a specific backend pool for load balancer or application gateway attachments, backend pools to private endpoints, private DNS links with registration enabled, subnet delegation and service endpoint updates.
- **Hetzner Cloud**: load balancer service creation and health-check tuning, load balancer label-selector targets, applying firewalls by label selector, subnet and route management inside networks.
- **Fly.io**: certificate hostname creation, shared or dedicated IPv4 allocation, app secrets to machines, service and port exposure from machine config.
- **Vercel and Netlify**: DNS record to deployment target, importing an environment variable from another resource's output with a variable name and scope you choose.
- **Cloudinary**: bulk folder and tag operations.
- **Databricks**: picking tasks in multi-task jobs, permissions for users, groups and service principals, choosing the served entity on multi-entity serving endpoints.
- **Turso and PlanetScale**: action buttons on the detail page for token rotation, branch promotion and deploy-request state changes.
