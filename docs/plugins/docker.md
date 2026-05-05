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

Two modes:

- **Local Unix socket** — desktop only. Defaults to `/var/run/docker.sock`.
- **Remote TCP** — host + port, optional TLS client certs. Works on desktop and web.

<insert [Docker Add-account form with mode toggle and TLS fields] here>

## Notable flows

- **Container lifecycle actions** inline in the list.
- **Log view** on container detail pages.

## Tips & limits

- Plaintext TCP (2375) is insecure. Use TLS (2376) with client certs in anything that resembles production.
- Compose and image builds are out of scope; keep using your CLI for those.
