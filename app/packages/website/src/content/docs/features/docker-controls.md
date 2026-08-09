---
title: Docker controls
description: Start, stop, and restart containers on a local or remote Docker host.
sidebar_order: 7
---

The Docker plugin lists containers on any Docker host you point it at — local Unix socket (desktop only) or a remote TCP endpoint.

<insert [Docker container list with start / stop / restart buttons] here>

## What you see

For each container: name, image, status, ports, and create time. Click one to open its detail page with logs and inspect data.

## Actions

- **Start**
- **Stop** (with grace period)
- **Restart**
- **Remove** — asks for confirmation; force flag available

Actions fire immediately against the host. Status in the list updates on the next refresh tick.

## Connecting to a host

- **Desktop** — the default is the local Unix socket. Change to a remote TCP endpoint in the account form.
- **Web** — only remote TCP. Make sure the endpoint is reachable and secured (TLS + client certs recommended; plaintext 2375 is not).

## Not a replacement for…

This is a control surface, not a full Docker UI. For image builds, compose stacks, and buildx, keep using the CLI. Use infrawrench when you want to see container state across hosts at a glance.
