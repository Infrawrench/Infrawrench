---
title: Linux applications
description: Open a graphical application from a Linux host in a workspace tab, over the SSH connection you already have.
sidebar_order: 6
---

You can open a graphical application running on one of your Linux hosts right in a workspace tab, one tab per window, with the application's own icon on the tab. It works over the SSH connection you already use for the terminal, and nothing is installed on the host. (Infrawrench can install the few packages applications need if you ask it to. That's the only thing here that changes the machine, and it only happens when you click it.)

<insert [The Apps tab of a Linux VM showing the launcher grid of installed applications with their icons] here>

## Open an application

1. Open a Linux host in Infrawrench and click **Apps**, next to SSH and SFTP.
2. Choose a key, the same way you would for a terminal. The launcher lists what's installed on that machine, with the same names and icons its own menu would show.
3. Click an application. It opens in its own tab.

[Cloud-held keys](../team-and-billing/ssh-keys.md) work in both the browser and the desktop app. In the browser, the cloud opens the connection for you. On desktop, the connection goes straight from your machine to the host, and the cloud only signs the login with the key it holds. Either way, the private key never leaves the cloud, your screen contents never pass through it on desktop, and each signature is recorded in the [audit log](../team-and-billing/audit-log.md). Using a cloud key on desktop needs an active cloud sign-in. Imported keys can't be used this way, because the cloud only stores their public half.

## What runs where

Infrawrench brings the display, and the host brings the applications. There's no X server, VNC server or desktop environment involved.

For each session, Infrawrench uploads a small display program over your SSH connection. It's **never installed on your host**: it runs from memory, and nothing is left behind when the session ends, the connection drops, or the program crashes.

## Sharpness and speed

Applications are drawn at your display's own resolution. On a high-DPI screen, text is as crisp as in a local window. Resizing the tab redraws at the new size.

Infrawrench adjusts how it sends the picture based on what the window is doing:

- **Mostly still windows** (an editor, a terminal, a settings dialog) are sent losslessly, and only the parts that changed are sent.
- **Windows in motion** (a video, fast scrolling, an animation) switch to a lighter, slightly softer encoding so playback stays smooth.

When the motion stops, the window is redrawn exactly. There's no setting for this.

## What the host needs

Infrawrench checks the host before it connects, and offers to fix anything missing.

If a host isn't ready, **Apps** shows a checklist instead of the launcher: what's missing, what each missing piece breaks, and the exact commands to install it. **Install what's missing** runs them on the host over the same SSH connection, shows the package manager's output as it goes, and then checks again to confirm the fix worked.

<insert [The Apps tab showing the host setup checklist: keyboard layout data and session D-Bus marked missing, the apt-get commands that would install them, and the Install what's missing button] here>

There's nothing to prepare in advance. A host that already has everything goes straight to the launcher.

### What it checks

|                                               | Without it                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **gzip**                                      | The app server can't be unpacked after upload, so nothing starts at all.                                                          |
| **Keyboard layout data** (`xkeyboard-config`) | Typing does nothing, with no error.                                                                                               |
| **Session D-Bus**                             | Applications built on GTK (most Linux desktop software) wait forever before showing a window, without saying why.                 |
| **Fonts**                                     | Qt applications exit; GTK ones draw empty boxes where the text should be.                                                         |
| **Software OpenGL** (optional)                | Browsers and Electron applications have no GL driver. GTK and Qt applications use software rendering regardless, so they're fine. |
| **Icon theme** (optional)                     | The launcher shows initials instead of icons, and toolbar buttons come out blank.                                                 |

The two optional items are installed with the rest by default. Untick the checkbox to leave them out. Applications still run without them, but you'll notice.

One thing no package fixes: the app server needs a directory it can write to and run programs from. If `/tmp`, `/dev/shm` and your runtime directory are all unwritable or mounted `noexec`, the check tells you, and one of them has to allow execution.

### If Infrawrench can't install it for you

Installing needs root on the host, or `sudo` without a password. Otherwise the checklist still shows the commands with a **Copy** button. Run them over SSH yourself and click **Check again**.

The same goes for a distribution whose package manager Infrawrench doesn't recognise. It supports `apt`, `dnf`, `yum`, `apk`, `pacman` and `zypper`. On anything else, it names the packages and leaves the install to you.

### The applications themselves

A minimal cloud image usually has no graphical applications, and Infrawrench doesn't install any for you. Install the ones you want with the host's package manager and they'll appear in the launcher. Anything built on GTK, Qt, Electron or Firefox works. Applications that only support X11 (`xterm` and similar) don't work yet.

If an application fails to start, the launcher shows the reason the host gave, usually a missing library, named exactly.

### Check from the command line

```
infrawrench apps <resource-id> --check --key ~/.ssh/id_ed25519
```

prints the same checklist in your terminal and exits non-zero if the host isn't ready, so you can loop over a fleet to find hosts that need attention. Add `--install` to fix them, or `--json` for machine-readable output.

## Windows, dialogs and menus

Each window of an application gets its own tab, and launching an application takes you straight to it. Menus, tooltips and popups (a browser's padlock panel, for example) appear inside their window, where the application put them. Dialogs, such as Save As or Print, appear centred over their window, so they don't add extra tabs.

Closing a tab closes that window. Closing the **Apps** tab ends the whole session on that host, including any applications it opened.

## Sound

Applications can play sound, with nothing to set up on the host. Everything they play comes through your tab.

A speaker button in the top corner of the window mutes the session. Muting also stops audio being sent over the SSH connection, which helps on a slow link. All windows on one host share one mute.

Two things to know:

- Browsers won't play sound until you've interacted with the page. If an application starts playing before you've clicked or typed, the sound starts with your first click into the window.
- Sound is playback only. Applications that want a microphone won't find one.

<insert [An application window tab playing media, with the speaker mute button visible in the top-right corner next to Close window] here>

## Clipboard

Text copies both ways.

**Into an application:** copy anything on your own machine, click into the application's window, and paste with your usual shortcut. `Cmd+V` on a Mac works even though Linux applications don't know what `Cmd` is. In a terminal, where paste is usually `Ctrl+Shift+V`, use that instead.

**Out of an application:** copy inside the application as usual, and the text lands on your own clipboard. The browser tab needs to be focused for this, so copy first, then switch away.

Images aren't copied in either direction.

## Sessions and reconnecting

A session belongs to the Infrawrench window that opened it. Reloading the page or quitting the app ends it, and stops any applications that were running.

A session with nothing connected and no windows open also ends itself after thirty minutes.

## List and launch from the command line

```
infrawrench apps <resource-id> --key ~/.ssh/id_ed25519
```

lists the applications installed on a host. Add `--json` for machine-readable output. Add `--launch <app-id>` to open that application in the desktop app, since a terminal can't show a window.

`--check` and `--install` run the host setup check described [above](#check-from-the-command-line) without opening a tab.

## Let an AI client use an application

Everything the tab does (launch an application, see it, act on it) is also available to AI clients over [MCP](./mcp.md), so a model can operate a graphical application the way a person does.

The tools launch an application on a resource's host and return a `windowId`. The model can then **see** the window in two ways and **act** on it by pixel:

- `screenshot_app_window` returns the window as a PNG.
- `read_app_accessibility_tree` returns what a screen reader would read: every element's role, name, text, value, state and on-screen bounds. It's usually the better choice, since it's exact and much cheaper than an image, and each element with bounds includes a `center` point ready to click. Most GTK and Qt applications support it. It needs the session D-Bus (see [What it checks](#what-it-checks)).
- `click_app_window`, `type_in_app_window`, `press_keys_in_app_window` and `scroll_app_window` send the input a person would. Accented characters work when typing.

Screenshots, click coordinates and accessibility bounds all use the same coordinates. The usual loop is: read the tree (or a screenshot) to find a target, act on it, then take a screenshot to confirm.

The session is reused across calls and uses the resource's [SSH key settings](../team-and-billing/ssh-keys.md). A VM resource takes an `sshKeyId`. A host whose provider supplies SSH itself (Fly, Hetzner) needs none. Every tool needs `resources:execute` and is recorded in the audit log, the same as the terminal.

In the in-app [AI chat](./ai-chat.md), tools that amount to running a command wait for your approval, like `ssh_exec` does: `type_in_app_window` and `press_keys_in_app_window` (typing into a terminal window is running a command), and `launch_app` when given a raw `exec` command instead of an installed application. Looking at a window, clicking, scrolling and closing run without asking.

## What's recorded

Starting a session and launching an application are recorded in the [audit log](../team-and-billing/audit-log.md). So is installing packages on a host through the setup check, with the packages named. Because installing packages changes a host, it also respects [change freezes](../team-and-billing/change-freeze.md).

Graphical sessions are **not** captured by [session recording](./session-recording.md), which records terminal input and output only. If you rely on recording for compliance, treat application sessions as outside its scope.

## Limits

- **Desktop and web only.** The mobile app can't open application sessions.
- **Clipboard** copies text both ways, and images neither way. Copying out of an application only works while the tab is focused, so switch away _after_ copying.
- **Sound is playback only.** No microphone, no printing, no USB redirection.
- **Keyboard layouts** are translated by character, so any layout types what its keys say, including the punctuation UK, German and French keyboards move around. Characters a US keyboard doesn't have (`£`, accents, anything an input method composes) work too, except dead keys, which aren't supported yet.
- **X11-only applications** don't work yet. Applications that support Wayland, which is most current desktop software, work.
