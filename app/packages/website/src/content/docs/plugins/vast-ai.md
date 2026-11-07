---
title: Vast.ai
description: Rent Vast.ai GPU instances from a live offer search, start, stop and rebid them, manage templates, volumes, SSH keys, Serverless endpoints and account environment variables, and track billed charges and credit.
sidebar_order: 50
---

Vast.ai is a GPU marketplace: independent hosts and data centers list machines, and you rent them by the hour. Use this plugin to rent and run instances, manage what they launch from, and see what they cost.

## What you can manage

- **Instances**: rent one by picking a machine from a live offer search (verified, rentable hosts, best first), grouped by GPU model with each offer's location, host reliability and hourly price.
  - Choose on-demand or interruptible pricing (with an optional bid; otherwise the offer's minimum), a template or image, disk size, launch mode, environment variables, ports, an on-start script and an existing volume.
  - Start, stop, reboot (restart the container, keeping the GPU) and recycle (recreate the container from a fresh image) from the header.
  - Edit the label and, for interruptible instances, the bid. Delete to destroy.
- **Templates** you created: create with an image, tag, launch mode, disk, environment variables, ports, on-start script and visibility. Edit the name, image, description and recommended disk, or delete. Vast.ai makes each edit a new version with its own id, so the page moves to the new version when you save.
- **Volumes**: rent a local volume on a host picked from a live volume offer search, and delete it. Each volume lists the instances using it.
- **SSH keys**: add, replace and delete. Vast adds new keys to your running instances.
- **Serverless endpoints** and their **workergroups**: create, edit the scaling targets (max and cold workers, minimum load, target utilization), start and stop an endpoint that has a deployment, and delete. Workergroups pick their template from your templates and Vast's recommended ones.
- **Account environment variables**: the encrypted variables Vast adds to your instances. Create, replace the value and delete. Only names are shown here, and values stay in Vast.

<insert [The Vast.ai create instance form with the Machine Offer picker open, showing offers grouped by GPU model with location, reliability and hourly price] here>

Each instance shows its GPU, VRAM, vCPUs, RAM, disk, hourly price, host location and reliability. While it runs, you also see GPU and CPU utilization, GPU temperature and disk usage. Connect with the `ssh -p <port> root@<proxy>` command shown on the instance, or the direct command if the launch mode publishes SSH on the host's IP.

<insert [A running Vast.ai instance detail page showing GPU, price, utilization and the Connect section with both SSH commands, and the Stop, Reboot and Recycle buttons] here>

## Connect your account

On the Vast.ai console's **Keys** page (cloud.vast.ai/manage-keys), click **+New**, name the key and copy it. Vast shows it once.

The default key has full access, which covers everything here. A scoped key needs `instance_read`, `instance_write`, `user_read`, `user_write` and `misc` for resources, and `billing_read` for spend.

<insert [The Add account form for Vast.ai with the API Key field] here>

## Cost

You see the same charges as the console's Billing page: GPU time, storage and bandwidth per instance, and volume storage, in USD. Each charge is spread across the days it covers, and tagged with the instance label and, for Serverless workers, the endpoint.

Your **credit balance** appears in the [credit burndown](../features/credit-burndown.md) section. The create instance form also shows a monthly estimate from the offer's hourly price.

<insert [The Costs panel for a Vast.ai account grouped by service, showing GPU, Storage and Bandwidth] here>

## Savings and governance

- **Orphan finder**: stopped instances, which keep billing for disk, and volumes no instance uses.
- **Sleep schedules**: stop and start instances on a schedule.
- **Expiry radar**: each instance's host contract end, after which the host can reclaim the machine.

## Quirks

- Stopping an instance releases its GPU to other renters, so starting it again may mean waiting for the host's GPU to free up. Reboot and recycle keep the GPU.
- Interruptible instances pause when someone outbids you. Raise the bid to resume.
- Volumes are local to one host machine. An instance can only use a volume on the machine it runs on.
- Vast has no regions, only host locations, and no machine-readable incident feed, so there's no provider status.
- Vast doesn't publish a Terraform provider, so there's no Terraform export.
