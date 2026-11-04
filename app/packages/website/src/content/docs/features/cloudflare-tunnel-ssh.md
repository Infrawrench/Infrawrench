---
title: Expose a service over a Cloudflare Tunnel
description: Drag a Cloudflare Tunnel onto a server to expose HTTP, HTTPS, SSH or TCP through Cloudflare, with no inbound ports open.
sidebar_order: 9
---

You can publish a service on one of your servers (HTTP, HTTPS, SSH or TCP) through a [Cloudflare Tunnel](../plugins/cloudflare.md) by dragging the tunnel onto the server. The tunnel and the server can be in different accounts and even different providers. Infrawrench sets up the tunnel routing and installs `cloudflared` on the server for you.

## Set up a tunnel to a server

1. In the sidebar, find a **Tunnel** in your Cloudflare account.
2. Drag it onto any server that supports SSH, such as an EC2 instance, a DigitalOcean droplet, a Hetzner server, an Azure VM or a GCE instance.
3. The **Set up SSH over tunnel** form opens. Fill in:
   - the **service** to expose (HTTP, HTTPS, SSH or TCP) and its **local port**, for example `http://localhost:8080` or `ssh://localhost:22`
   - a **public hostname**, for example `app.example.com`
   - the **zone** it belongs to, picked from your Cloudflare zones
   - the **SSH username and key** Infrawrench uses to log in and install `cloudflared`. This key is only for the install. It isn't necessarily the service you're exposing.
4. Check the install script, which the form shows before you run it.
5. Click **Run**.

Infrawrench then:

1. points the tunnel's ingress at the service you chose (for example `http://localhost:8080`)
2. creates a proxied DNS `CNAME` that routes the hostname to the tunnel
3. logs in to the server over SSH, then installs and starts `cloudflared` with the tunnel token

You see the result of each step (ingress, DNS, install) when it finishes.

![Dragging a Cloudflare Tunnel onto a server resource in the sidebar, showing the "Set up SSH tunnel" drop hint](https://agent-assets.infrawrench.com/docs-screenshots/features/cloudflare-tunnel-ssh/drag-drop-hint.png)

![The Set up SSH over tunnel modal with hostname, zone, SSH username, SSH key fields and the install-script preview](https://agent-assets.infrawrench.com/docs-screenshots/features/cloudflare-tunnel-ssh/expose-over-tunnel-modal.png)

## Connect to the service

- **HTTP or HTTPS:** open `https://app.example.com` in a browser. Cloudflare handles TLS, so you don't need a client.
- **SSH:** `ssh -o ProxyCommand="cloudflared access ssh --hostname app.example.com" user@app.example.com`
- **TCP:** `cloudflared access tcp --hostname app.example.com --url localhost:<port>`

## Requirements

- **The server must be reachable over SSH right now**, because Infrawrench logs in to install `cloudflared`. A common approach is to set up the tunnel while the server still has a public IP or open port 22, then lock it down once the tunnel works.
- **Linux with sudo.** The install script downloads `cloudflared` and registers a systemd service, so the SSH user needs sudo. Windows hosts aren't supported.
- **You need to be signed in to an organization.** Setup uses your organization's stored SSH keys, so it runs in cloud mode. In local-only desktop mode you're asked to sign in to an organization first.
- **The tunnel token stays on the server side.** It's passed straight to the host during setup and is never shown in your browser.
