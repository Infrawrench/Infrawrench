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

## Tips and limits

- Plaintext TCP (2375) is insecure. Use TLS (2376) with client certs for anything close to production.
- Compose and image builds aren't covered here. Keep using your CLI for those.
