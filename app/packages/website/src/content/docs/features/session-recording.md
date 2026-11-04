---
title: SSH session recording
description: Record every SSH session opened through the cloud and replay it later, including who connected, to what, and exactly what crossed the terminal. Recordings are standard asciinema casts.
sidebar_order: 6
---

Session recording lets you replay any SSH session your team opened through Infrawrench Cloud:
who connected, which host they reached, how they got there, and exactly what the terminal showed
them. There's no agent to install on your hosts. Turn it on for your organization and every cloud
SSH session is recorded.

It's the record an auditor asks for and almost nobody has.

## What gets recorded

**Recorded:** any SSH session opened through Infrawrench Cloud. That includes the
[SSH terminal](./ssh-terminal.md) in the web app, the desktop app's SSH tabs in cloud mode, and
sessions that go through a [bastion or jumpbox](./ssh-jumpbox.md) (the number of hops is saved
with the recording).

**Not recorded:** sessions the desktop app opens straight to a host in local-only mode. Those
never pass through Infrawrench Cloud. The Session Recordings page says so, so you don't assume
coverage you don't have.

## Shared sessions

A session [shared with colleagues](./shared-consoles.md) is recorded just like a solo one, and the
recording knows who was on it. Every participant is listed with the highest role they held. The
timeline also marks who joined, when the keyboard was handed over and to whom, and when sharing
was revoked. These markers are part of the standard asciicast format, so the file still plays
anywhere a normal cast does.

That's how you answer "whose hands were on this box" when more than one person was in the
session.

## Turn it on

Go to **Settings > Session Recordings** on web or desktop. Recording is off until you turn it on,
since recording your staff's terminals is a decision your organization should make on purpose.

![The Session Recordings settings page with the recording policy card: the "Record SSH sessions" toggle on, the keystroke toggle off, the retention field set to 90, and the storage summary line beneath](https://agent-assets.infrawrench.com/docs-screenshots/features/session-recording/recording-policy.png)

There are three settings:

- **Record SSH sessions**: captures what the host printed. This is the compliance record of what
  happened on the box.
- **Also capture keystrokes**: off by default, and a separate choice on purpose. It also records
  anything typed at a prompt the host didn't echo, such as a `sudo` password or a token pasted
  into an editor. That's a very different promise to the people being recorded.
- **Keep recordings for**: how many days to keep recordings. Expired recordings are deleted
  within the hour. Turning recording off doesn't shorten how long existing recordings are kept.

The card also shows what your organization stores: the number of recordings, their compressed
size, how much raw terminal output that represents, and the date of the oldest one. Terminal
output compresses very well, so even long sessions usually take little space.

## Watch a session

The **Sessions** list shows every recording, newest first, with who opened it, the target, when it
started, how long it ran, and its size. Press **Watch** to replay it right there.

![The Sessions list with several recordings, one expanded to show the player mid-playback with the scrubber, the clock reading "2:14 / 6:03" and the speed buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/session-recording/player-mid-playback.png)

The player has play/pause, a scrubber, and 0.5×, 1×, 2× and 4× speed. Jumping to any point is
instant, however far you drag.

Sessions replay at the size they were recorded at. A session recorded in a 200-column window isn't
squeezed into a narrow panel, because that wouldn't be what the operator saw.

The player works with screen readers. It's named "Session recording playback terminal", and since
a replay takes no input, you can arrow through the output as text. See
[screen readers](./ssh-terminal.md) on the SSH terminal page for how this works across the app.

### Statuses

- **Complete**: the session ended and the recording closed cleanly.
- **Live**: the session is open right now. You can watch what has been captured so far.
- **Truncated**: the session hit the limit of 32 MB of terminal output per session (about ten
  hours of ordinary interactive work), usually because someone `cat`-ed something huge. You get
  everything up to the limit, clearly marked as partial.
- **Incomplete**: the connection to Infrawrench Cloud dropped before the recording could close.
  Everything captured up to that point is intact.

## Download a recording

Recordings are [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) files, asciinema's
own format. Every recording has a **download .cast** link, and the file plays in
`asciinema play`, in the asciinema web player, and in whatever tools your auditor already uses.

From the [CLI](./cli.md):

```
infrawrench recordings
infrawrench recordings get <id> | asciinema play -
infrawrench recordings get <id> --file incident-4417.cast
```

`infrawrench recordings --json` gives you the list plus your organization's recording settings and
storage use, for a report or a scheduled export.

## Who can see recordings

Recordings have their own permissions, separate from SSH keys and the audit log:

- `session-recordings:read`: list, watch and download recordings.
- `session-recordings:write`: change the recording settings and delete recordings.

Neither is part of the **Member** [system role](../team-and-billing/roles-and-permissions.md),
since recording exists to watch operators. Owners and admins have both by default. A
[custom role](../team-and-billing/roles-and-permissions.md) can grant read without write, which
suits a compliance or security reviewer who should watch recordings but not change the settings
or delete evidence.

**Watching a recording is itself recorded in the audit log**, along with settings changes and
deletions. Most reads aren't logged, but this one is, so nobody can watch a recording without
leaving a trace. Look for `session_recording.view`, `session_recording.delete` and
`session_recording.settings.update` in the [audit log](../team-and-billing/audit-log.md).

## Tell your team

Recording people's terminals without telling them is a bad idea and, in most places, a legal
problem. Infrawrench gives you the control; telling your team is up to you. If you turn on
keystroke capture, say so clearly, because that's the setting that can pick up a password.
