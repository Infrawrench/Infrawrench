---
title: Docker controls
description: Start, stop and restart containers on a local or remote Docker host.
sidebar_order: 7
---

The Docker plugin lets you see and control containers on any Docker host you point it at: the local Unix socket (desktop only) or a remote TCP endpoint.

![Docker container list in the sidebar with the open container's Start / Stop / Restart buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/docker-controls/container-actions.png)

## Connect to a host

- **Desktop**: uses the local Unix socket by default. To use a remote TCP endpoint instead, change it in the account form.
- **Web**: remote TCP only. Make sure the endpoint is reachable and secured. TLS with client certificates is recommended; plain port 2375 is not.

## See your containers

For each container you see its name, image, status, ports, networks and volumes. Click one to open its detail page with logs and inspect data.

## Start, stop or restart a container

The list has no buttons on each row, so open the container first. Its detail page has a **Container Actions** panel with three buttons:

- **Start**
- **Stop**
- **Restart**

Each one runs right away and shows the result underneath (for example `Start succeeded`, or the error). The buttons are disabled while an action is running. The status in the list updates on its next refresh.

## Remove a container

Use the normal resource delete. It always force-removes, so it works even if the container is running.

## What this isn't for

This is for controlling containers, not a full Docker UI. For image builds, compose stacks and buildx, keep using the Docker CLI. Use Infrawrench when you want to see container state across hosts at a glance.
