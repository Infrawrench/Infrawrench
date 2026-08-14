---
title: SSH tunnels
description: Forward a local port through a bastion to reach a private database or service.
sidebar_order: 10
---

Many production databases are not reachable from the public internet. Open an SSH tunnel and infrawrench forwards a local port through a bastion host, so the [SQL editor](./sql-editor.md), [KV console](./kv-console.md), or your own tools can connect.

![SSH tunnel config form on the bastion's detail page, with the SSH key, username and SSH port for the bastion and the target service preset that sets the forwarded port](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-tunnels/connect-service-via-ssh.png)

## Creating a tunnel

1. Open **Tools → SSH tunnels → New**.
2. Pick a **bastion** — any SSH-capable resource you have already connected (an EC2 instance, a DO Droplet, a Hetzner server, a generic SSH host).
3. Pick a **target service** preset or choose **Custom**. Presets fill in the default port:
   - Postgres → 5432
   - MySQL → 3306
   - Redis → 6379
   - Memcached → 11211
   - Docker → 2375 / 2376
4. Set the **target host** (usually a private DNS name reachable from the bastion).
5. Set the **local port** — any free port on your machine.
6. Click **Start**.

## Using the tunnel

Once running, point any local tool at `127.0.0.1:<local port>`. Within infrawrench, you can reference the tunnel from a Postgres or Redis account so the SQL editor / KV console just work.

## Saved configurations

Save frequently used tunnels from the dialog and start them with one click from **Tools → SSH tunnels**.

## Desktop vs web

- **Desktop** — the tunnel runs inside the app on your machine. Stopping the app stops the tunnel.
- **Web** — the tunnel runs on infrawrench’s server. `127.0.0.1:<port>` refers to the server’s loopback, so it is only usable for in-app features (SQL editor, KV console) — not your local CLI.

## Troubleshooting

- **Permission denied (publickey)** — wrong key for the bastion. Re-pick in [SSH keys](../team-and-billing/ssh-keys.md).
- **Connection refused to target** — target host is wrong or the bastion’s security group does not allow it. Try `nc` from the bastion first.
- **Port already in use** — pick a different local port.
