---
title: SSH tunnels
description: Reach a database or service that only listens on a bastion's loopback, by connecting to it through SSH.
sidebar_order: 10
---

Lots of production databases aren't reachable from the internet. They only listen on the loopback interface of a host you can SSH into. Infrawrench can connect to them through that host, so the [SQL editor](./sql-editor.md), [KV console](./kv-console.md) and the rest of the app work as if the service were local.

You don't create a tunnel on its own. You connect a **service** through a host, and you get a normal account in the sidebar that reaches its database over SSH.

![The Connect to service via SSH modal on a bastion's detail page, with the SSH key, username and SSH port fields above the target-service preset grid](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-tunnels/connect-service-via-ssh.png)

## Connect a service

1. Open the detail page of the host you want to go through. Any SSH-capable resource works: an EC2 instance, a DO Droplet, a Hetzner server, a generic SSH host.
2. Click **Connect service via SSH**.
3. Pick an **SSH Key**. On web, these are the keys saved in [SSH keys](../team-and-billing/ssh-keys.md). On desktop, you can also pick keys from `~/.ssh`, the 1Password agent and Pageant.
4. Check the **Username** (taken from the key, default `root`) and the **SSH Port** (`22`).
5. Choose a **Target Service**: **Docker** `2375`, **PostgreSQL** `5432`, **MySQL** `3306`, **Redis** `6379`, **Memcached** `11211`, or **Custom…**. Only **Custom…** asks for a **Remote Port**.
6. Click **Connect**.

Infrawrench tests the connection before saving anything. If it works, you get a new account named after what you connected (for example "PostgreSQL on 10.0.1.7") and land on its page. If the host key is new or has changed, you'll be asked to trust it first.

## What the tunnel reaches

The tunnel always ends at **`127.0.0.1` on the host you connected through**, so there's no target-host field. To reach a service on a _different_ private machine, connect to that machine instead. If it has no public address, use [jumpbox routing](./ssh-jumpbox.md).

There's no local-port field either. Infrawrench picks a local port for you, so you just open the SQL editor on the account and it works.

## Desktop vs web

- **Desktop:** the tunnel runs in the app on your machine, so local tools like `psql` can use it too. Quitting the app closes every tunnel.
- **Web:** the tunnel runs on Infrawrench's server. You can use it from in-app features (SQL editor, KV console, workflows), but not from tools on your laptop.

Desktop has two extra ways to start:

- Right-click a resource in the sidebar and choose **Connect to service via SSH…**.
- Drag a Docker, Postgres, MySQL, Redis or Memcached account onto an SSH-capable resource. The same dialog opens with that preset already chosen.

## Close a tunnel

There's no stop button. The tunnel opens when something needs it. To remove it for good, delete the account it belongs to.

## Troubleshooting

- **Permission denied (publickey):** wrong key for the host. Reconnect and pick another one in [SSH keys](../team-and-billing/ssh-keys.md).
- **Connection refused to target:** nothing is listening on that port on the host's loopback. SSH in and check with `ss -ltn`, then try again.
- **The key isn't in the list:** on web, you can only use keys **generated** in Infrawrench, because with an imported key the private half stays with you. See [SSH keys](../team-and-billing/ssh-keys.md).
