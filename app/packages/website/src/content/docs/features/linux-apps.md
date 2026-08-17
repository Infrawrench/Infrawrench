---
title: Linux applications
description: Open a graphical application from a Linux host in a workspace tab, over the SSH connection you already have.
sidebar_order: 6
---

Infrawrench can open a graphical application running on one of your Linux hosts in a workspace tab — one tab per window, with the application's own icon on the tab. It works over the SSH connection you already use for the terminal, and installs nothing on the host.

<insert [The Apps tab of a Linux VM showing the launcher grid of installed applications with their icons] here>

## Opening one

Open a Linux host in Infrawrench and click **Apps**, next to SSH and SFTP. Choose a key the same way you would for a terminal, and the launcher lists what is installed on that machine. Click an application and it opens in its own tab.

The launcher reads the host's own desktop entries — the same list its own menu would show — so what you see is what is installed, with the names and icons that machine uses.

## What runs where

Infrawrench brings the display; the host brings the applications.

There is no X server, no VNC server and no desktop environment involved. Infrawrench uploads a small program called `iwappd` over your SSH connection, which acts as a Wayland compositor for that session: applications connect to it, it collects what they draw, and it sends the pixels back to your tab. Your keyboard and mouse go the other way.

The program is **never installed on your host**. It is written to a memory-backed directory, opened, deleted, and then run from the open file — so from the moment it starts there is no file on the machine, and nothing remains after the session ends, the connection drops, or the process crashes.

## Sharpness and speed

Applications are rendered at your display's own resolution. On a high-DPI screen the host is told to draw at that scale, so text is as crisp as it is in a local window rather than a magnified version of a smaller one — the tab asks for the pixels it will actually show, and the application lays itself out for them. Resizing the tab re-asks.

How those pixels reach you depends on what the window is doing, and Infrawrench switches by itself:

- **A window that is mostly still** — an editor, a terminal, a settings dialog — is sent losslessly. Only the parts that changed are sent, and each is sent as the difference from what your screen already shows, which is usually a few kilobytes.
- **A window in motion** — a video, a page being scrolled fast, an animation — moves to a lossy encoding. It is softer, and it is what makes the difference between a video that plays and a video that stutters.

When the motion stops, the window is redrawn exactly. So a video looks like a video while it plays, and the text beside it goes back to being sharp within a moment of it stopping. You do not have to choose, and there is no setting for it.

## What the host needs

- **SSH access**, which you already have if the terminal works.
- **The applications themselves.** A minimal cloud image usually has none; installing an application through the host's own package manager makes it appear in the launcher.
- **Software rendering.** Applications that require a GPU need mesa installed on the host. Infrawrench asks every toolkit for its software path, which covers most applications, but it cannot supply a graphics stack the machine does not have.
- **A session bus**, for anything built on GTK — which is most Linux desktop software. Infrawrench finds one if the host has one and starts a private one per application if it does not, so on most hosts there is nothing to do. On a machine with no D-Bus installed at all, GTK applications wait for a bus that never arrives and never open a window; `apt install dbus` (or your distribution's equivalent) is the whole fix.
- **Fonts and an icon theme**, if you want the applications to look like themselves. A minimal cloud image often ships neither, which shows up as boxes instead of text and letters instead of icons.

If an application fails to start, the launcher shows the reason the host gave — usually a missing library, named exactly.

### A Debian or Ubuntu host, in one block

```
sudo loginctl enable-linger "$USER"
sudo apt update
sudo apt install -y dbus-user-session libgl1-mesa-dri \
  fontconfig fonts-dejavu-core hicolor-icon-theme adwaita-icon-theme
```

Then log out and back in, so the first line takes effect. `enable-linger` is what gives your user a runtime directory — and with it a session bus — outside a login session; everything else on that list is what a bare server image is missing.

Install the applications themselves the same way: anything built on GTK, Qt, Electron, or Firefox works. Applications that only speak X11 — `xterm` and its generation — do not yet.

## Windows, dialogs and menus

Each window of an application gets its own tab. Dialogs, menus and tooltips are drawn inside the window they belong to, not as tabs of their own, so opening a menu does not clutter your workspace.

Closing a tab closes that window. Closing the **Apps** tab ends the whole session on that host, including any applications it opened.

## Sessions and reconnecting

A session belongs to the Infrawrench window that opened it. Reloading the page, or quitting the app, ends it; applications that were running are stopped along with it.

An idle session — no client attached and no windows open — also ends itself after thirty minutes, so a forgotten session does not sit on your machine indefinitely.

## From the command line

```
infrawrench apps <resource-id> --key ~/.ssh/id_ed25519
```

lists the applications installed on a host, with `--json` for the machine-readable form. Adding `--launch <app-id>` opens that application in the desktop app — a terminal has nowhere to draw a window, so the CLI hands it over.

## What is recorded

Starting a session and launching an application are written to the [audit log](../team-and-billing/audit-log.md).

Graphical sessions are **not** captured by [session recording](./session-recording.md), which records terminal input and output. If you rely on recording for a compliance requirement, treat application sessions as outside its scope.

## Limitations

- **Desktop and web only.** The mobile app does not open application sessions.
- **Clipboard** carries text from your machine to the host; reading the host's clipboard is not implemented yet.
- **No audio**, no printing, no USB redirection.
- **Keyboard layouts** are translated by character, so any layout types what its keys say — including the punctuation UK, German and French keyboards move around. Characters no US keyboard has at all (`£`, accents, anything an input method composes) are sent separately and work, with the exception of dead keys, which are not implemented.
- **X11-only applications** need XWayland, which is not included yet. Applications that speak Wayland — which is most current desktop software — work.
