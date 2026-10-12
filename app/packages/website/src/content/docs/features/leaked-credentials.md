---
title: Leaked credentials
description: Pull GitHub secret scanning and GitLab secret detection findings into Posture, match each leaked token to the account or stored secret it belongs to, and rotate it from the same row.
sidebar_order: 12
---

A token committed to a repository is only half a finding. The scanner that spotted it knows the file and the commit; it does not know which of your cloud accounts that token unlocks, or which resource has it stored. Leaked credentials joins the two halves: Infrawrench reads your code scanner's findings, works out which account or stored secret each one belongs to, and puts a **Rotate** button next to it.

The findings appear as a **Leaked credentials** section at the top of the [Posture](./posture-checks.md) tab, on web and on desktop while signed in to your organization. An account with an open leak against it also gets a banner on its own page.

## Connecting a scanner

Leaks come from a **scanner account**: a connected account whose provider finds secrets committed to code. Two plugins are scanners today. Connect the account as usual; there is nothing extra to switch on, and the first scan runs within half an hour.

### GitHub secret scanning

A [GitHub](../plugins/github.md) account connected to an **organization** reads the organization's secret scanning alerts across every repository.

- **Token.** A fine-grained token needs the repository permission **Secret scanning alerts**: read to list the alerts, read and write to close them after a rotation. A classic token needs `repo` or `security_events`.
- **Role.** The token's owner must be an organization owner or a security manager. Closing an alert also needs admin on the repository it was found in.
- **Enterprise accounts** see nothing here: GitHub has no enterprise-wide alert list. Connect each organization as its own account.

GitHub returns the secret itself with each alert. That is what makes GitHub matches exact; see [how matching works](#how-matching-works).

### GitLab secret detection

A [GitLab](../plugins/gitlab.md) account reads the secret detection findings in the vulnerability report of its 100 most recently active projects.

- **Tier.** The vulnerability report is a GitLab **Ultimate** feature. Projects on other tiers are skipped.
- **Token.** `read_api` and the Developer role to read the findings; `api` and the Maintainer role (or Security Manager) to resolve or dismiss them from Infrawrench.

GitLab never returns the secret value, so its findings are matched by **token type** only, and the screen says so on each match.

## How matching works

Each finding is matched to one of three things Infrawrench holds:

- **An account credential**: the API token or key a connected account signs in with.
- **A secret stored on a resource**: a literal value you saved into a resource's secret field.
- **A referenced resource output**: a value one resource produces and another references (see [Output references](../core-concepts/output-references.md)). The match names the resource that issues it, since that is what can be reissued.

How sure the match is depends on the scanner:

- **By fingerprint** (GitHub). The leaked value is compared with what Infrawrench stores, byte for byte, through a keyed hash. Only an exact match counts. A GitHub finding that matches nothing is a token Infrawrench does not hold, even when you have an account on that provider, so no account is suggested for it.
- **By token type** (GitLab). The finding is only known to be, say, a DigitalOcean token. If the organization has one DigitalOcean account, the leak is attributed to it as **probably** that account; with several, they are all listed as candidates. Either way it may be another key from the same provider.

Which provider issued a token comes from the plugins themselves: 27 plugins declare their token formats, so a leaked AWS key, Stripe key or OpenAI key is attributed to the right provider and links to its key management page.

### What is never stored

The secret itself is never stored, logged or sent anywhere. When GitHub returns it, Infrawrench computes a fingerprint in memory and discards the value. The fingerprint is an HMAC-SHA256 under a key derived for your organization alone, so it cannot be reversed, cannot be checked offline, and the same token in two organizations gives two unrelated fingerprints.

What is kept is that fingerprint and a hint of at most the first and last four characters (`ghp_…3f9a`), so you can tell which key it was. Values too short to mask safely get no hint at all. Neither the hint nor the fingerprint appears in alerts or events.

## The Leaked credentials section

Each row shows the token type, where it was found (repository, file and line), when the scanner first saw it, and what it was matched to. Badges add what the scanner knows: **Also public** when it found the token somewhere public too, **Still valid** or **No longer valid** when it checked the token with its issuer. A leak is **Critical** unless the scanner reports the token dead and it matches nothing Infrawrench holds, in which case it is **High**.

Filter by status: **Open**, **Rotated**, **Dismissed**, and **Resolved upstream** for findings someone closed on the scanner before they were rotated here. Under the header, each scanner account shows when it last scanned and why, if it failed.

<insert [Posture tab with the Leaked credentials section at the top, Open filter selected, showing two open leaks: a referenced output matched by fingerprint with a Rotate button, and an account match with "Manage keys at DigitalOcean" and "Mark rotated" buttons] here>

Scans run every 30 minutes. **Scan now** reads every scanner account immediately and reports how many new leaks it found.

## Rotating a leak

What the row offers depends on what the leak matched:

- **Rotate** (a referenced output, or a stored value the provider can issue). One click: the plugin asks the provider for a new value, and every resource that references the old one is updated with it straight away. Anything outside Infrawrench that uses the old value stops working, which is the point.
- **Replace value** (a literal stored on a resource). Rotate it at the provider first, then paste the new value. Infrawrench pushes it to the provider when the plugin supports that, then stores it encrypted.
- **Manage keys at _provider_**, then **Update credentials** (an account credential). Revoke and reissue the token on the provider's own key management page, then update the account with the new one. Infrawrench notices the stored credential's fingerprint has changed and records the leak as rotated on its own, on the next scan. **Mark rotated** records it immediately, and for an account match it checks first that the stored credential really changed.
- **Mark rotated** (nothing Infrawrench holds). Rotate it at the provider and record that you did.

A rotation is verified where it can be: if a leak matched by fingerprint still fingerprints the same after a rotation, Infrawrench refuses to record it rather than close a live leak. Rotations done elsewhere (editing the account, the [secret reroll](../core-concepts/secret-rerolls.md) dialog) are detected the same way and recorded as **Stored value changed**.

### Closing the alert upstream

Every rotation offers **Close the alert on _scanner_ as revoked**, ticked by default. Infrawrench then closes the finding on GitHub or GitLab with the resolution "revoked". If the scanner refuses (the token lacks write access, the repository is gone), the rotation still stands and the row shows why the alert could not be closed.

## Dismissing a leak

Some findings are not a risk. **Dismiss** takes a reason, **False positive**, **Used in tests** or **Won't fix**, and an optional note. The same reason is passed to the scanner when it can close the alert (with **Also close the alert on _scanner_**, also ticked by default). **Reopen** undoes a dismissal or a manual rotation recorded by mistake.

## The account page banner

When an open leak matches an account, or may belong to it, the account's page shows a banner naming the token and where it was found, with **Review in Posture** to jump to the row. For a match by token type, the banner says it may be another key from the same provider.

<insert [Account page for a DigitalOcean account with the red "A credential for this account was found committed to code" banner above the resource list, naming the token type, the repository and file, with the Review in Posture link] here>

## Alerts and events

New leaks raise an alert under the **Leaked credentials** trigger in [alert routing](./alert-routing.md), **critical** by default, so they page through the same rules as any critical alert and reach phones as a [push notification](./mobile-push-notifications.md). A scan sends one alert for everything new it found rather than one per finding, since the first scan of a busy organization can turn up dozens. If an alert reaches nobody (no channel yet, every transport down), the next scan tries again. A finding already closed on the scanner when Infrawrench first sees it is recorded as history and never alerts.

For your own systems, [event subscriptions](./event-subscriptions.md) carry `secret.leaked`, once per leak, and `secret.rotated`, whenever one is rotated or its stored value is seen to change. Neither ever includes the secret or its hint.

Rotating, dismissing and reopening are written to the [audit log](../team-and-billing/audit-log.md) as `leaked_secret.rotated`, `leaked_secret.dismissed` and `leaked_secret.reopened`.

## Permissions

Viewing leaks needs `resources:read`. Every action, scanning now, rotating, marking rotated, dismissing and reopening, needs `secrets:write`; members without it see the list and no buttons. See [Roles and permissions](../team-and-billing/roles-and-permissions.md).

## The CLI and the phone

`infrawrench leaks` lists the same findings in the terminal, with `--json` for scripts; see the [CLI reference](./cli.md).

The [mobile app](./mobile-app.md) shows the leaks read-only at the top of its Posture screen, and a leak push opens there. Rotating means pasting a value or visiting a provider's key page, which stays on web and desktop.

## Caveats

- Desktop shows leaks in cloud mode only. Scanning is done by the cloud poller, so local-only mode has no list.
- Each scan reads up to 1,000 findings per scanner account, most recently updated first.
- GitLab coverage is the 100 most recently active projects, the same bound the plugin uses for every other per-project child.
- A leak whose account or stored secret has since been deleted stays open: removing it from Infrawrench does not revoke the token at the provider.
