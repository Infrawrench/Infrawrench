---
title: Linux applications
description: Open a graphical application from a Linux host in a workspace tab, over the SSH connection you already have.
sidebar_order: 6
---

Infrawrench can open a graphical application running on one of your Linux hosts in a workspace tab — one tab per window, with the application's own icon on the tab. It works over the SSH connection you already use for the terminal, and leaves nothing on the host — the program that streams the window is run from memory and deleted before it starts. (Infrawrench can also install the handful of packages the applications themselves need, if you ask it to. That is the one thing here that changes the machine, and it never happens without you clicking it.)

<insert [The Apps tab of a Linux VM showing the launcher grid of installed applications with their icons] here>

## Opening one

Open a Linux host in Infrawrench and click **Apps**, next to SSH and SFTP. Choose a key the same way you would for a terminal, and the launcher lists what is installed on that machine. Click an application and it opens in its own tab.

The launcher reads the host's own desktop entries — the same list its own menu would show — so what you see is what is installed, with the names and icons that machine uses.

[Cloud-held keys](../team-and-billing/ssh-keys.md) work here on both apps, and differently on each. In the browser, the cloud holds the key and opens the connection for you. On the desktop, the connection runs directly from your machine to the host — the cloud acts only as an SSH agent, signing the authentication handshake with the key it holds. The private key never leaves the cloud, the pixels never pass through it, and each signature is written to the [audit log](../team-and-billing/audit-log.md). Using a cloud key on the desktop needs an active cloud sign-in; imported keys cannot be used this way, because the cloud stores only their public half.

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

Infrawrench checks before it connects, and offers to fix what it finds.

Open **Apps** on a host that is not ready and you get a checklist instead of the launcher: what is missing, what each missing piece breaks, and the exact commands that would install it. **Install what's missing** runs them on the host through the same SSH connection, shows the package manager's output as it goes, and checks again — because a package manager can exit successfully having not fixed anything, and the second check is the only answer worth reporting.

<insert [The Apps tab showing the host setup checklist: keyboard layout data and session D-Bus marked missing, the apt-get commands that would install them, and the Install what's missing button] here>

There is nothing to prepare in advance. A host with everything already installed never sees the checklist — the check is one short command and the launcher opens as usual.

### What it checks

|                                               | Without it                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **gzip**                                      | The app server cannot be unpacked after upload, so nothing starts at all.                                                                 |
| **Keyboard layout data** (`xkeyboard-config`) | The compositor cannot build a keymap and typing does nothing — silently.                                                                  |
| **Session D-Bus**                             | Applications built on GTK — most Linux desktop software — wait for a bus before showing a window, and never report that they are waiting. |
| **Fonts**                                     | Qt applications exit; GTK ones draw empty boxes where the text should be.                                                                 |
| **Software OpenGL** (optional)                | Browsers and Electron applications have no GL driver. GTK and Qt are pushed onto software rendering regardless, so they are unaffected.   |
| **Icon theme** (optional)                     | The launcher shows initials instead of icons, and toolbar buttons come out blank.                                                         |

The two optional items are installed alongside the rest by default, and can be left out with the checkbox. They are optional in the sense that applications still run without them, not that you will not notice.

One thing no package fixes: the app server needs a directory it can both write to and execute from. If `/tmp`, `/dev/shm` and your runtime directory are all unwritable or mounted `noexec`, the check says so and there is nothing to install — one of them has to allow execution.

### When Infrawrench cannot install it for you

The install needs to be root on the host, or to have `sudo` without a password. Otherwise the checklist still shows the commands, with a **Copy** button — run them over SSH yourself and click **Check again**.

The same applies to a distribution whose package manager Infrawrench does not recognise. It knows `apt`, `dnf`, `yum`, `apk`, `pacman` and `zypper`; on anything else it names the packages it would have installed and leaves the rest to you.

### The applications themselves

Infrawrench brings the display; the host brings the applications. A minimal cloud image usually has none, and Infrawrench does not install any — which ones you want is not a decision it should make for you. Install them through the host's own package manager and they appear in the launcher: anything built on GTK, Qt, Electron or Firefox works. Applications that only speak X11 — `xterm` and its generation — do not yet.

If an application then fails to start, the launcher shows the reason the host gave — usually a missing library, named exactly.

### Checking from the command line

```
infrawrench apps <resource-id> --check --key ~/.ssh/id_ed25519
```

prints the same checklist in a terminal, and exits non-zero if the host is not ready — so a loop over a fleet can find the hosts that need attention. Add `--install` to fix them, or `--json` for the machine-readable form.

## Windows, dialogs and menus

Each window of an application gets its own tab. Dialogs, menus and tooltips are drawn inside the window they belong to, not as tabs of their own, so opening a menu does not clutter your workspace.

Closing a tab closes that window. Closing the **Apps** tab ends the whole session on that host, including any applications it opened.

## Sound

Applications play sound. There is nothing to set up on the host: `iwappd` brings its own sound server, applications find it exactly as they would find PulseAudio or PipeWire on a desktop, and everything they play is mixed into one stream and sent to your tab alongside the pixels.

A speaker button in the window's top corner mutes the session. Muting does more than silence the tab — it stops the audio stream crossing the SSH connection at all, which is worth doing on a slow link. All windows of one host share one mute, because they share one stream.

Two browser details worth knowing:

- Browsers refuse to play sound before you have interacted with a page. If a session starts playing before you have clicked or typed anywhere, the audio begins with your first click into the window.
- The stream is playback only. Applications that want a microphone find none, the same as on a machine with no input device.

<insert [An application window tab playing media, with the speaker mute button visible in the top-right corner next to Close window] here>

## Clipboard

Text copies both ways.

**Into an application**: copy anywhere on your own machine, click into the application's window, and paste with the shortcut you always use. Infrawrench hands the text to the host and asks the application to paste it, so `Cmd+V` on a Mac works even though no Linux application knows what `Cmd` is. In a terminal, whose paste is usually `Ctrl+Shift+V`, use that instead — the text is already on the host's clipboard by then either way.

**Out of an application**: select and copy inside the application as you normally would, and the text arrives on your own clipboard. This one needs the browser tab to be focused, because a browser will not let a background tab write your clipboard — so copy first, then switch away.

Images are not carried in either direction. They would be megabytes across an SSH connection for a paste that may never come.

## Sessions and reconnecting

A session belongs to the Infrawrench window that opened it. Reloading the page, or quitting the app, ends it; applications that were running are stopped along with it.

An idle session — no client attached and no windows open — also ends itself after thirty minutes, so a forgotten session does not sit on your machine indefinitely.

## From the command line

```
infrawrench apps <resource-id> --key ~/.ssh/id_ed25519
```

lists the applications installed on a host, with `--json` for the machine-readable form. Adding `--launch <app-id>` opens that application in the desktop app — a terminal has nowhere to draw a window, so the CLI hands it over.

`--check` and `--install` do the host setup check described [above](#checking-from-the-command-line) without opening a tab.

## What is recorded

Starting a session and launching an application are written to the [audit log](../team-and-billing/audit-log.md). So is installing packages on a host through the setup check, with the packages it installed named — it changes the state of a machine you own, and that is the kind of thing someone comes looking for months later. Because it is a change to a host, it also respects [change freezes](../team-and-billing/change-freeze.md).

Graphical sessions are **not** captured by [session recording](./session-recording.md), which records terminal input and output. If you rely on recording for a compliance requirement, treat application sessions as outside its scope.

## Limitations

- **Desktop and web only.** The mobile app does not open application sessions.
- **Clipboard** carries text both ways, and images neither way. Pasting into a remote application works with your usual shortcut — `Cmd+V` on a Mac reaches the application as the paste it expects. Copying inside a remote application puts the text on your own clipboard a moment later, provided the tab is focused; browsers refuse clipboard writes from a background tab, so switch away _after_ copying rather than before.
- **Audio is playback only** — applications find no microphone. No printing, no USB redirection.
- **Keyboard layouts** are translated by character, so any layout types what its keys say — including the punctuation UK, German and French keyboards move around. Characters no US keyboard has at all (`£`, accents, anything an input method composes) are sent separately and work, with the exception of dead keys, which are not implemented.
- **X11-only applications** need XWayland, which is not included yet. Applications that speak Wayland — which is most current desktop software — work.
