---
title: Docker
description: Control containers on a local or remote Docker host.
sidebar_order: 23
---

This page covers setup. For the feature itself, see [Docker controls](../features/docker-controls.md).

## What you can manage

- Containers: start, stop, restart and remove
- Inspect data and logs

## Connect a Docker host

There is one field, **Docker Host**: the address of the Docker daemon. It usually looks like one of these:

- **Local Unix socket** (desktop only): `unix:///var/run/docker.sock`
- **Remote TCP**: `tcp://host:2376` (TLS) or `tcp://host:2375` (plaintext, insecure)

Controlling a Docker engine is the same as having admin access to the machine it runs on, so the desktop app asks you to confirm in a system dialog before it saves a Docker host. After that, the saved account connects without asking. A host you reach through the account's SSH tunnel never asks. If the dialog shows up when you didn't just add or open a Docker account, choose **Cancel**.

![Docker Add-account form with the single Docker Host field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/docker/add-account.png)

## Work with containers

- Start, stop, restart or remove a container straight from the list.
- Open a container to see its logs.

## CI jobs

A Docker daemon can run [cloud jobs](../features/ci.md#cloud-jobs) of two kinds:

- `container`: the job runs in a container from `image` (default `buildpack-deps:noble-curl`), not privileged, with no mounts and no access to the daemon.
- `build`: the job runs in `docker:29-dind` with a Docker daemon of its own, so `docker build` and `docker push` work without the job reaching yours. A daemon inside a container needs it **privileged**, which is as good as root on the daemon's machine. Only opt this kind in on a daemon you'd give a job that much.

```yaml
jobs:
  image:
    cloud: docker/build
    run: docker build -t registry.example.com/app:${{ github.sha }} . && docker push registry.example.com/app:${{ github.sha }}
```

- `machine` is CPUs and memory, like `2vcpu-4gb` (the default). `gpu: nvidia:1` asks for GPUs through the NVIDIA runtime (`container` only).
- Every container is labelled `infrawrench-ci` and removed when it stops. Docker has no time limit of its own, so a watchdog in the container stops the job once its time is up.
- Jobs run from the cloud need a daemon Infrawrench can reach over TCP or an SSH tunnel; a local socket only works from the desktop app.

## Tips and limits

- Plaintext TCP (2375) is insecure. Use TLS (2376) with client certs for anything close to production.
- Compose and image builds aren't covered here. Keep using your CLI for those.
