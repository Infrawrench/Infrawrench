---
title: Jumpbox routing
description: Route SSH connections through one or more SSH jump hosts (ProxyJump), set up from the app.
sidebar_order: 5
---

When a server sits on a private network, you usually reach it through a jump host (a "bastion") on the network edge. Infrawrench lets any SSH account connect through another SSH account, one hop or several. It works the same on desktop, desktop cloud mode and the web app, including host-key checks and agent forwarding.

## How it works

A jumpbox is just an [SSH plugin](../plugins/ssh.md) account. To use one, set another SSH account's **Connect through** field to it:

- Account **A** has no **Connect through**, so it connects directly.
- Account **B** has **Connect through** set to A. It connects to A first, then on to B.
- Account **C** has **Connect through** set to B. It goes A, then B, then C.

A chain can have up to 8 hops. Loops are rejected, so a bad setup fails with an error instead of hanging.

## Route an SSH account through a jumpbox

1. In the sidebar, choose **Add account** > **SSH**.
2. In the credential form, pick a jump host from the **Connect through** dropdown. It lists your other SSH accounts.
3. Save. Every terminal and SFTP session for this account now goes through the jump host.

![AddAccountModal showing the SSH credential form with the "Connect through" dropdown expanded to show another SSH account](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-jumpbox/connect-through-expanded.png)

## Route a cloud VM through a jumpbox

Any cloud VM with an SSH endpoint (EC2 instance, GCE instance, Droplet, Hetzner server, Scaleway instance, OVH instance, Azure VM) has a **Connect through jumpbox…** button next to its SSH/SFTP actions.

1. Click **Connect through jumpbox…**.
2. Pick the SSH account to use as the jumpbox.
3. Choose the VM's **public** or **private** address.
4. Name the new SSH target.
5. Confirm. The SSH **Add account** form opens with the host, port, username and jumpbox filled in.
6. Add the private key and save.

The new SSH target appears in the sidebar, already set up to go through your jumpbox.

![EC2 instance detail page with the "Connect through jumpbox…" button in the action row, and the picker dialog open over it](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-jumpbox/connect-through-jumpbox-dialog.png)

## Public or private address

When a VM has both a public and a private IP, the dialog picks the private one. Usually the jump host is on the same VPC or private network as the target, and the internal address is faster and safer. Switch to public only when the jump host isn't on the same network.

If a VM only has a public address, you won't see the choice.

## Add more hops

To put another hop in front of an existing chain, edit the **jump host** account (not the final target) and set its **Connect through** to a third account. For example:

```
edge → jump → target
```

Set the target's **Connect through** to `jump`, and `jump`'s **Connect through** to `edge`. Each hop's host key is checked separately, using the same trusted host keys as the [SSH terminal](./ssh-terminal.md).

## Audit log

Each routed session adds an `ssh.session.chain_opened` entry to the audit log, with the hop count and the ordered list of intermediate `host:port:username` hops. Agent-forwarding requests still log the usual `ssh.agent.session_opened` entry. Together they show who used which jump hosts.

## Limitations

- This is different from a [bastion agent](./bastion-vms.md). Bastion agents carry cloud API traffic, not SSH. Jumpbox routing doesn't need a bastion agent.
- Agent forwarding only applies to the **final** hop. Intermediate hops never see your agent.
- The first hop must be reachable from wherever the SSH session runs: your computer on desktop, or Infrawrench's server on web.
