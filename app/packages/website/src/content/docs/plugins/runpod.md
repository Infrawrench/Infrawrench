---
title: Runpod
description: Manage Runpod GPU and CPU pods, Serverless endpoints, templates, network volumes, registry credentials and SSH keys, and track billed spend, balance, savings plans and account limits.
sidebar_order: 50
---

Runpod is a GPU cloud with on-demand pods and autoscaling Serverless endpoints. The plugin covers both, the storage and templates behind them, and the money they cost, read from Runpod's own billing history.

## What you can manage

- **Pods** (GPU and CPU): create with a GPU type picker that shows each GPU's VRAM, Secure and Community Cloud prices, spot price and current stock; choose Secure or Community Cloud, on-demand or spot, a data center (filtered to the ones that have the chosen GPU free), a template or image, disks, ports, a network volume and registry credentials. Start, stop, restart, reset, lock and unlock from the header; edit the name, image, disk sizes, mount path, ports and lock; terminate with delete.
- **Serverless endpoints**: create from a Serverless template with a GPU type or CPU flavor, worker counts, idle timeout and FlashBoot; edit worker counts, scaling, timeouts and FlashBoot; purge the queue from the header. Each endpoint shows its live queue (jobs waiting, running, completed and failed) and worker counts, and exposes its run URLs and OpenAI-compatible base URL.
- **Templates** (your own, for pods or Serverless): create and edit the image, disks, ports, start command, visibility and readme.
- **Network volumes**: create in any data center that supports network storage, rename, grow, delete. The volume lists the pods and endpoints that mount it.
- **Container registry credentials**: add (name, username, password or token) and delete. Runpod never returns the password.
- **SSH keys**: the public keys in your Runpod account settings, which Runpod installs on every new pod. Add and delete them here.

Pods with SSH show a ready-to-run `ssh` command through Runpod's SSH proxy, and the built-in terminal connects through the same proxy. Pods that expose `22/tcp` also get a direct command over the public IP and mapped port, which supports SCP and SFTP.

<insert [The Runpod account page listing Pods, Serverless Endpoints and Network Volumes, with one running GPU pod selected and its Stop, Restart, Reset and Lock buttons visible in the header] here>

<insert [The Runpod create pod form with the GPU type picker open, showing VRAM, Secure and Community prices and stock for several GPUs] here>

## Credentials

In the Runpod console open **Settings**, then **API Keys**, and click **Create API Key**.

- Choose **All** permission to create, change and delete resources. A **Read Only** key lists everything and reads billing, balance and limits, but every change fails.
- A **Restricted** key scoped to individual Serverless endpoints cannot list pods or read billing, so it is not enough for this plugin.
- The key is shown once; copy it before closing the dialog. Keys start with `rpa_`.

<insert [The Add account form for Runpod with the API Key field] here>

## Cost

Spend is read from Runpod's billing history, not estimated:

- **Pods**: per pod and per day, including GPU or CPU time and the pod's disks, with the hours billed.
- **Serverless**: per endpoint and per day.
- **Network volumes** and **high-performance storage**: per day across the account.

Amounts are in USD. Pods that have since been terminated keep their billing history, under their pod ID.

Your **account balance** appears in the [credit burndown](../features/credit-burndown.md) section, and active **savings plans** appear in [commitments](../features/commitments.md) with their upfront cost and effective hourly rate.

The create pod form also quotes a monthly estimate from the GPU's list price for the cloud and pricing you picked. Disk storage is billed on top and is not in the estimate.

<insert [The Costs panel for a Runpod account grouped by service, showing Pods, Serverless and Network Volumes] here>

## Savings and governance

- **Orphan finder**: stopped pods, which stop billing for GPU time but keep billing for their pod volume, and network volumes no pod or endpoint mounts.
- **Sleep schedules**: pods can be stopped and started on a schedule.
- **Quota radar**: your hourly spend limit against your current spend rate, and your Serverless worker quota against the sum of max workers across your endpoints. Both rise with your account balance.
- **Provider status**: incidents on [uptime.runpod.io](https://uptime.runpod.io) are matched to the data centers your pods and volumes run in, and to Serverless and the SSH proxy.
- **Terraform export**: pods, Serverless endpoints, templates, network volumes and registry credentials export to Runpod's `runpod/runpod` provider. That provider cannot import existing objects, so applying an export creates new ones.

## Quirks

- Runpod reports only a pod's desired state. A pod that should be running but has not started its container yet shows as starting.
- Stopping a pod wipes its container disk and keeps its pod volume. Starting it again needs a free GPU on the same host, which is not guaranteed; a network volume avoids that dependency.
- A locked pod cannot be stopped or reset until it is unlocked.
- Network volumes and pod volumes can only grow.
- Environment variables are not synced, only their names, so secrets in them never leave Runpod.
- Utilization (GPU, GPU memory, CPU, memory) is a snapshot taken at each sync, not a time series: Runpod's public API has no metrics history.
