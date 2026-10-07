---
title: Vast.ai
description: Rent Vast.ai GPU instances from a live offer search, start, stop and rebid them, manage templates, volumes, SSH keys, Serverless endpoints and account environment variables, and track billed charges and credit.
sidebar_order: 50
---

Vast.ai is a GPU marketplace: independent hosts and data centers list machines, and you rent them by the hour. The plugin covers renting and running instances, the things they are launched from, and what they cost.

## What you can manage

- **Instances**: rent one by picking a machine from a live offer search (verified, rentable hosts, best first), grouped by GPU model with each offer's location, host reliability and hourly price. Choose on-demand or interruptible pricing (with an optional bid; the offer's minimum is used otherwise), a template or image, disk size, launch mode, environment variables, ports, an on-start script and an existing volume. Start, stop, reboot (restart the container, keeping the GPU) and recycle (recreate the container from a fresh image) from the header; edit the label and, for interruptible instances, the bid; destroy with delete.
- **Templates** you created: create with an image, tag, launch mode, disk, environment variables, ports, on-start script and visibility; edit the name, image, description and recommended disk; delete.
- **Volumes**: rent a local volume on a host picked from a live volume offer search, and delete it. Each volume lists the instances using it.
- **SSH keys**: add, replace and delete. Vast adds new keys to your running instances.
- **Serverless endpoints** and their **workergroups**: create, edit the scaling targets (max and cold workers, minimum load, target utilization), start and stop an endpoint that has a deployment, and delete. Workergroups pick their template from your templates and Vast's recommended ones.
- **Account environment variables**: the encrypted variables Vast injects into your instances. Create, replace the value and delete. Only names are synced; values never leave Vast.

<insert [The Vast.ai create instance form with the Machine Offer picker open, showing offers grouped by GPU model with location, reliability and hourly price] here>

Each instance shows its GPU, VRAM, vCPUs, RAM, disk, hourly price, host location and reliability, and, while it runs, GPU and CPU utilization, GPU temperature and disk usage. Connect with the `ssh -p <port> root@<proxy>` command shown on the instance, or the direct command when the launch mode publishes SSH on the host's IP.

<insert [A running Vast.ai instance detail page showing GPU, price, utilization and the Connect section with both SSH commands, and the Stop, Reboot and Recycle buttons] here>

## Credentials

On the Vast.ai console's **Keys** page (cloud.vast.ai/manage-keys), click **+New**, name the key and copy it; Vast shows it once.

The default key has full access, which covers every feature here. A scoped key needs `instance_read`, `instance_write`, `user_read`, `user_write` and `misc` for resources, and `billing_read` for spend.

<insert [The Add account form for Vast.ai with the API Key field] here>

## Cost

Spend comes from Vast's charge history, the same data as the console's Billing page: GPU time, storage and bandwidth per instance, and volume storage, in USD. Vast reports each charge with the time span it covers, and the plugin spreads it across the days in that span. Charges are tagged with the instance label and, for Serverless workers, the endpoint.

Your **credit balance** appears in the [credit burndown](../features/credit-burndown.md) section. The create instance form also quotes a monthly estimate from the offer's hourly price.

<insert [The Costs panel for a Vast.ai account grouped by service, showing GPU, Storage and Bandwidth] here>

## Savings and governance

- **Orphan finder**: stopped instances, which keep billing for disk, and volumes no instance uses.
- **Sleep schedules**: instances can be stopped and started on a schedule.
- **Expiry radar**: each instance's host contract end, after which the host can reclaim the machine.

## Quirks

- Stopping an instance releases its GPU to other renters, so starting it again can wait until the host's GPU is free. Reboot and recycle keep the GPU.
- Interruptible instances pause when someone outbids you; raise the bid to resume.
- Volumes are local to one host machine; an instance can only use a volume on the machine it runs on.
- Vast has no regions, only host locations, and no machine-readable incident feed, so there is no provider status matching.
- Vast does not publish a Terraform provider, so there is no Terraform export.
