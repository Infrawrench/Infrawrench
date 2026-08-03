---
title: Remote Desktop (RDP)
description: Open a full Windows desktop for any Windows VM, right inside the app, with two-way file transfer.
sidebar_order: 4
---

Windows VMs get an **RDP** button on their detail page. Clicking it opens a live Windows desktop inside the app — no Microsoft Remote Desktop, no `mstsc`, no separate client to install. It works in both the **desktop app** (macOS, Windows, Linux) and the **web app**, because the RDP client is built in.

In the desktop app the RDP byte stream is tunnelled through the app's own process. In the web app it goes through a server-side proxy on Infrawrench Cloud, which resolves the machine's address from the resource you're viewing (so the browser can't point it anywhere else) and refuses internal address space.

<insert [Resource detail page for a Windows EC2 instance showing the "Open RDP tab" button] here>

## Which resources show it

The RDP button appears on VM types that can run Windows, and only when the machine actually is Windows and running:

- **AWS EC2** — instances whose platform is `windows`.
- **Azure Virtual Machines** — VMs whose OS type is Windows.
- **Google Compute Engine** — instances whose boot disk carries a Windows license.

Linux instances of the same types never show the button — they use the [SSH terminal](./ssh-terminal.md) instead. If a machine is stopped, the button is hidden until it is running again.

Infrawrench detects the OS from provider metadata (the EC2 platform attribute, the Azure OS type, the GCE boot-disk license), never from the instance name.

## Connecting

1. Click **RDP** to open the session tab.
2. Enter the username and password for the machine. Infrawrench pre-fills a sensible default username where the provider implies one (e.g. `Administrator` for EC2 Windows AMIs); change it if your machine uses a different account.
3. The desktop appears on a canvas. Keyboard, mouse, scroll wheel, and clipboard text all work.

The **password is used only for the session and is never stored.** The connection form shows every time you open an RDP tab.

<insert [RDP connect form with username and password fields] here>

Use the toolbar above the desktop to change resolution, send **Ctrl + Alt + Del**, or reconnect.

## File transfer

The RDP session moves files both ways over the remote-desktop clipboard channel:

- **Upload (local → remote):** click **Upload files**, pick files on your machine, then paste inside the remote session to drop them there.
- **Download (remote → local):** copy files inside the remote session, then click **Download files** and choose where to save them locally.

<insert [RDP toolbar showing the Upload files and Download files buttons] here>

## From the command line

`infrawrench rdp <resource-id>` opens the same session from the terminal — it resolves the machine's RDP address, checks it is a running Windows VM, and hands it to the desktop app:

```
infrawrench rdp i-0abc123:ec2-instance:i-0abc123
infrawrench rdp <resource-id> --json   # print the resolved host/username without opening
```

See the [CLI reference](./cli.md).

## Security notes

- The RDP password is never saved — it lives only in memory for the session.
- The connection uses NLA/CredSSP when the server offers it.
- **Desktop:** the RDP byte stream is tunnelled through the app's own process; the client never opens a listening network port.
- **Web:** the browser can't open TCP, so a server-side proxy on Infrawrench Cloud makes the connection. It resolves the destination from the authenticated resource — never from anything the browser supplies — and refuses loopback / link-local / metadata addresses, the same guard the SSH proxy uses.

## Not seeing the RDP button?

- The instance may be Linux — use the [SSH terminal](./ssh-terminal.md).
- The instance may be stopped — start it and the button returns.
- The machine may have no reachable address yet (still provisioning), or its firewall/security group may not allow TCP **3389**. In the desktop app, open port 3389 to your IP; in the web app, open it to Infrawrench Cloud's egress, since the proxy makes the connection.
- RDP is available in the **desktop and web apps**. The mobile app doesn't embed the RDP client.
