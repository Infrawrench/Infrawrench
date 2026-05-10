---
title: OVHcloud
description: Manage OVH public cloud projects and services.
sidebar_order: 7
---

## What you can manage

- Public Cloud instances
- Managed Kubernetes
- Object Storage
- Load Balancers

## Credentials

OVH uses a three-part credential: **Application Key**, **Application Secret**, and **Consumer Key**. Generate them at the [OVH API token page](https://www.ovh.com/auth/api/createToken) with the scopes you need.

<insert [OVH Add-account form with the three credential fields] here>

## Notable flows

- **SSH terminal** on public cloud instances.
- **File browser** on Object Storage.

## Tips & limits

- OVH’s API is organized by region (eu, us, ca). Make sure the token has scope for every region you plan to use.
- Consumer keys can be time-limited — pay attention to expiry when creating.
