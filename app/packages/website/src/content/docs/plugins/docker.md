---
title: Docker
description: Control containers on a local or remote Docker host.
sidebar_order: 23
---

See [Docker controls](../features/docker-controls.md) for the feature page. This page covers setup.

## What you can manage

- Containers (start / stop / restart / remove)
- Inspect data and logs

## Credentials

A single **Docker Host** field — the address of the Docker daemon to talk to. Two common shapes:

- **Local Unix socket** (desktop only): `unix:///var/run/docker.sock`
- **Remote TCP**: `tcp://host:2376` (TLS) or `tcp://host:2375` (plaintext, insecure)

Control of a Docker engine amounts to administrator access on the machine that runs it, so the desktop app asks in a system dialog before it saves a Docker host. After that, the saved account connects without asking. A host reached through the account's SSH tunnel never asks. If the dialog appears when you didn't just add or open a Docker account, choose **Cancel**.

![Docker Add-account form with the single Docker Host field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/docker/add-account.png)

## Notable flows

- **Container lifecycle actions** inline in the list.
- **Log view** on container detail pages.

## Tips & limits

- Plaintext TCP (2375) is insecure. Use TLS (2376) with client certs in anything that resembles production.
- Compose and image builds are out of scope; keep using your CLI for those.
