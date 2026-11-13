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
- **Templates** you created: create with an image, tag, launch mode, disk, environment variables, ports, on-start script and visibility. Edit the name, image, description and recommended disk, or delete. Vast.ai makes each edit a new version with its own id, so the page moves to the new version when you save, and its dashboard pins, stars, owner and service membership move with it. Its change history stays with the version it happened to.
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

## Run CI jobs

A Vast.ai connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job rents the cheapest verified on-demand offer that fits and destroys the instance when the job ends:

| `cloud.kind` | Runs on     | Default `machine` | Default `image`                               |
| ------------ | ----------- | ----------------- | --------------------------------------------- |
| `container`  | An instance | `4vcpu-16gb`      | `docker.io/library/buildpack-deps:noble-curl` |

Every Vast.ai offer comes with GPUs. `cloud.gpu` names the GPU and how many, as Vast names them (`RTX_4090`, `h100_sxm:8`, `RTX A6000:2`); a type Vast spells differently is matched by name against the cheapest offers. Without `cloud.gpu`, the job gets the cheapest single GPU. A `machine` is the least the offer must have, as `<vCPUs>vcpu-<GB>gb`, or a GPU type. `cloud.region` is a country code such as `US` or `DE`. The instance has 32 GB of disk.

The instance runs in Vast's entrypoint mode: the image's own entrypoint, if it has one, receives the job's command as arguments, so pick an image without one or one that runs its arguments.

Vast bills compute by the second while an instance runs and storage for as long as it exists, stopped or not, so only destroying it ends the bill. The instance holds none of the connection's credentials. Vast gives every instance a key that can only start, stop, destroy or show that instance (`CONTAINER_API_KEY`); the job's command takes it out of the job's environment and uses it to destroy its own instance when the job ends or its time is up. A job running as root can still read that key, which lets it do no more than the instance already does to itself. Infrawrench also destroys it when the job ends, and again later if that fails. Vast instances have no tags, so a CI instance's label is `iwci-` and the job's key, and its tags are in its `INFRAWRENCH_CI_TAGS` environment variable.

Vast copies the environment variables you set for the whole account (Account, Environment Variables) into every instance it starts, and those are usually secrets a CI job should never get. So a Vast.ai account can't run CI jobs while it has any: opting it in fails naming them (never their values), and every job checks again before it rents anything, since they can be added later. Remove them, or connect a separate Vast.ai account just for CI.

Opting a connection in also reads the instance list and tries to destroy an instance that does not exist, since a key cannot say what it may do. A scoped key needs `instance_read`, `instance_write` and `user_read` (which reads the environment variables). An account with no credit fails the check, because Vast stops instances at zero.

## Quirks

- Stopping an instance releases its GPU to other renters, so starting it again may mean waiting for the host's GPU to free up. Reboot and recycle keep the GPU.
- Interruptible instances pause when someone outbids you. Raise the bid to resume.
- Volumes are local to one host machine. An instance can only use a volume on the machine it runs on.
- Vast has no regions, only host locations, and no machine-readable incident feed, so there's no provider status.
- Vast doesn't publish a Terraform provider, so there's no Terraform export.
