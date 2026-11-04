---
title: Leaked credentials
description: Pull GitHub secret scanning and GitLab secret detection findings into Posture, match each leaked token to the account or stored secret it belongs to, and rotate it from the same row.
sidebar_order: 12
---

A token committed to a repository is only half a finding. Your code scanner knows the file and the commit, but not which cloud account that token unlocks or which resource has it stored. Leaked credentials connects the two: Infrawrench reads your scanner's findings, works out which account or stored secret each one belongs to, and puts a **Rotate** button next to it.

Findings appear in a **Leaked credentials** section at the top of the [Posture](./posture-checks.md) tab, on web and on desktop while signed in to your organization. An account with an open leak also gets a banner on its own page.

## Connect a scanner

Leaks come from a **scanner account**: a connected account whose provider finds secrets committed to code. GitHub and GitLab are supported. Connect the account as usual. There's nothing extra to switch on, and the first scan runs within half an hour.

### GitHub secret scanning

A [GitHub](../plugins/github.md) account connected to an **organization** reads the organization's secret scanning alerts across every repository.

- **Token.** A fine-grained token needs the repository permission **Secret scanning alerts**: read to list the alerts, read and write to close them after a rotation. A classic token needs `repo` or `security_events`.
- **Role.** The token's owner must be an organization owner or a security manager. Closing an alert also needs admin on the repository where it was found.
- **Enterprise accounts** don't show anything here, because GitHub has no enterprise-wide alert list. Connect each organization as its own account.

GitHub matches are exact. See [how matching works](#how-matching-works).

### GitLab secret detection

A [GitLab](../plugins/gitlab.md) account reads the secret detection findings in the vulnerability report of its 100 most recently active projects.

- **Tier.** The vulnerability report is a GitLab **Ultimate** feature. Projects on other tiers are skipped.
- **Token.** `read_api` and the Developer role to read findings; `api` and the Maintainer role (or Security Manager) to resolve or dismiss them from Infrawrench.

GitLab never shares the secret value, so its findings are matched by **token type** only, and each match says so.

## How matching works

Each finding is matched to one of three things:

- **An account credential:** the API token or key a connected account signs in with.
- **A secret stored on a resource:** a value you saved into a resource's secret field.
- **A referenced resource output:** a value one resource produces and another references (see [Output references](../core-concepts/output-references.md)). The match names the resource that issues it, since that's what can be reissued.

How certain the match is depends on the scanner:

- **By fingerprint** (GitHub). The leaked value is compared exactly with what Infrawrench stores. A GitHub finding that matches nothing is a token Infrawrench doesn't hold, even if you have an account on that provider, so no account is suggested.
- **By token type** (GitLab). The finding is only known to be, say, a DigitalOcean token. If your organization has one DigitalOcean account, the leak is marked as **probably** that account. With several, they're all listed as candidates. Either way, it might be a different key from the same provider.

Infrawrench recognises token formats from 27 providers, so a leaked AWS key, Stripe key or OpenAI key is attributed to the right provider and links to its key management page.

### What's never stored

The secret itself is never stored, logged or sent anywhere. When GitHub includes it, Infrawrench turns it into a one-way fingerprint and throws the value away. The fingerprint uses a key unique to your organization, so it can't be reversed or checked offline, and the same token in two organizations produces two unrelated fingerprints.

Infrawrench keeps that fingerprint and a hint of at most the first and last four characters (`ghp_…3f9a`) so you can tell which key it was. Values too short to mask safely get no hint. Neither the hint nor the fingerprint appears in alerts or events.

## The Leaked credentials section

Each row shows the token type, where it was found (repository, file and line), when the scanner first saw it, and what it was matched to. Badges add what the scanner knows: **Also public** if it found the token somewhere public too, and **Still valid** or **No longer valid** if it checked with the issuer. A leak is **Critical** unless the scanner reports the token dead and it matches nothing Infrawrench holds, in which case it's **High**.

Filter by status: **Open**, **Rotated**, **Dismissed**, and **Resolved upstream** for findings someone closed on the scanner before rotating them here. Under the header, each scanner account shows when it last scanned and, if it failed, why.

<insert [Posture tab with the Leaked credentials section at the top, Open filter selected, showing two open leaks: a referenced output matched by fingerprint with a Rotate button, and an account match with "Manage keys at DigitalOcean" and "Mark rotated" buttons] here>

Scans run every 30 minutes. **Scan now** checks every scanner account immediately and tells you how many new leaks it found.

## Rotate a leak

What you can do depends on what the leak matched:

- **Rotate** (a referenced output, or a stored value the provider can issue). One click: Infrawrench asks the provider for a new value, and every resource that references the old one is updated straight away. Anything outside Infrawrench that uses the old value stops working, which is the point.
- **Replace value** (a value stored on a resource). Rotate it at the provider first, then paste the new value. Infrawrench sends it to the provider where supported, then stores it encrypted.
- **Manage keys at _provider_**, then **Update credentials** (an account credential). Revoke and reissue the token on the provider's key management page, then update the account with the new one. Infrawrench notices the change and marks the leak as rotated on the next scan. **Mark rotated** records it right away, after checking that the stored credential really changed.
- **Mark rotated** (nothing Infrawrench holds). Rotate it at the provider and record that you did.

Rotations are checked where possible. If a leak matched by fingerprint still matches after a rotation, Infrawrench won't mark it rotated. Rotations done elsewhere (editing the account, the [secret reroll](../core-concepts/secret-rerolls.md) dialog) are detected too and recorded as **Stored value changed**.

### Close the alert on the scanner

Every rotation offers **Close the alert on _scanner_ as revoked**, ticked by default. Infrawrench then closes the finding on GitHub or GitLab as "revoked". If the scanner refuses (the token lacks write access, the repository is gone), the rotation still counts and the row shows why the alert couldn't be closed.

## Dismiss a leak

Some findings aren't a risk. **Dismiss** asks for a reason (**False positive**, **Used in tests** or **Won't fix**) and an optional note. The same reason is sent to the scanner when it can close the alert (with **Also close the alert on _scanner_**, also ticked by default). **Reopen** undoes a dismissal, or a manual rotation recorded by mistake.

## The account page banner

When an open leak matches an account, or might belong to it, the account's page shows a banner naming the token and where it was found, with **Review in Posture** to jump to the row. For a match by token type, the banner says it might be another key from the same provider.

<insert [Account page for a DigitalOcean account with the red "A credential for this account was found committed to code" banner above the resource list, naming the token type, the repository and file, with the Review in Posture link] here>

## Alerts and events

New leaks raise an alert under the **Leaked credentials** trigger in [alert routing](./alert-routing.md), **critical** by default, so they reach people through the same rules as any critical alert, including phones as a [push notification](./mobile-push-notifications.md). Each scan sends one alert covering everything new, not one per finding. If an alert reaches nobody (no channel yet, every channel down), the next scan tries again. A finding that was already closed on the scanner when Infrawrench first sees it is kept as history and never alerts.

For your own systems, [event subscriptions](./event-subscriptions.md) send `secret.leaked` once per leak, and `secret.rotated` whenever one is rotated or its stored value changes. Neither ever includes the secret or its hint.

Rotating, dismissing and reopening are recorded in the [audit log](../team-and-billing/audit-log.md) as `leaked_secret.rotated`, `leaked_secret.dismissed` and `leaked_secret.reopened`.

## Permissions

- Viewing leaks needs `resources:read`.
- Every action (scanning now, rotating, marking rotated, dismissing and reopening) needs `secrets:write`. Members without it see the list but no buttons.

See [Roles and permissions](../team-and-billing/roles-and-permissions.md).

## CLI and mobile

`infrawrench leaks` lists the same findings in the terminal, with `--json` for scripts. See the [CLI reference](./cli.md).

The [mobile app](./mobile-app.md) shows leaks read-only at the top of its Posture screen, and a leak push notification opens there. Rotating happens on web and desktop.

## Limits

- Desktop only shows leaks in cloud mode, not local-only mode.
- Each scan reads up to 1,000 findings per scanner account, most recently updated first.
- GitLab covers your 100 most recently active projects.
- A leak whose account or stored secret has since been deleted stays open. Removing it from Infrawrench doesn't revoke the token at the provider.
