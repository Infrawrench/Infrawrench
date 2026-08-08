---
title: Mobile app
description: The Infrawrench app for iOS and Android — browse resources, watch dashboards, chat with the AI, and open an SSH terminal from your phone.
sidebar_order: 14
---

The Infrawrench mobile app puts your cloud organization in your pocket. It is a native iOS/Android app (built with Expo) that talks to the same cloud API as the web app — same accounts, same plugin-rendered resource views, same permissions. It is built for the on-call moments: a push notification lands, you tap it, and you are looking at the failing account — or an SSH prompt — in seconds.

> **Cloud only.** The app signs into an Infrawrench Cloud organization. There is no local-only mode on mobile — if you use the desktop app standalone, link it to a cloud org first (see [Desktop, web, and mobile](../core-concepts/desktop-vs-web.md)).

## Signing in

1. Install the app and tap **Sign in**.
2. Your browser opens the same WorkOS sign-in as the web app — email, Google, or Microsoft.
3. After sign-in you are redirected back into the app and land on the organization picker.

Authentication uses OAuth with PKCE — no password ever touches the app — and tokens are kept in the platform secure store (Keychain on iOS, Keystore on Android). Signing in also registers the device for [push notifications](./mobile-push-notifications.md); allow notifications when prompted if you want incident and budget alerts.

You can switch organizations at any time from the org switcher; everything you see is scoped by your [role permissions](../team-and-billing/roles-and-permissions.md), exactly as on the web.

<insert [Mobile sign-in screen next to the organization picker after OAuth completes] here>

## What you can do

- **Dashboards** — every [dashboard](./dashboard.md) in the org, the default one first. Tap one to open it, with its name in the header and a back button to the list. A dashboard renders exactly what the web app shows: pinned resource tiles, workflow tiles, [cost graphs](./cloud-costs.md), and [budgets](./cloud-costs.md#budgets--alerts), in the order you arranged them. Cost graphs are drawn natively — every chart type, the previous-period and forecast overlays, and per-series totals in the legend — and budgets show month-to-date spend against the amount with their thresholds and forecast marker. A budget appears on the dashboard its card was added to, the same as on web and desktop; the **Costs** tab lists all of them regardless. You can also build one from scratch here — **New dashboard** on the list, then **Edit** on the dashboard itself to add cards, reorder them, configure a cost graph or budget, and rename or delete the dashboard. See [building a dashboard on the phone](#building-a-dashboard-on-the-phone).
- **Accounts & resources** — browse every connected account and drill into its resources. An account page lists every resource type the plugin exposes, nested ones like DNS records and database users included, with a search box that narrows those sections exactly as it does on web and desktop. Resource detail pages are rendered from the same plugin schemas as web and desktop, so a droplet, a bucket, or a Kubernetes deployment looks like itself — including plugin actions, a Logs tab, and metrics charts.
- **Costs** — month-to-date spend for the org and every budget in it, the same as the [**Costs** panel](./cloud-costs.md#the-costs-panel) on web and desktop. Budgets are listed here whether or not a dashboard shows them, so a budget alert push always has somewhere to land. Read-only, as on web: budgets are created and edited from a dashboard card. When the org has a [tag policy](./tag-policy-and-showback.md), the tab also shows per-account tag compliance and the untagged-spend summary; the policy itself, cost centres, and allocation rules are edited from the web app. The tab also lists [right-sizing recommendations](./right-sizing.md) — machines whose two-week p95 utilisation sits well under their size, with the recommended smaller size and monthly saving; read-only here, since applying a resize is a provider mutation that stays on web and desktop. The tab ends with the org's [sleep/wake schedules](./sleep-schedules.md) — each window, next transition, last outcome, and projected saving, with a pause/resume toggle; creating and editing a schedule (day pickers, times, timezones) stays on web and desktop.
- **Search** — global search across your org's resources, same as [spotlight search](./spotlight-search.md).
- **SFTP files** — browse, download (to the share sheet), and upload files on SSH-capable hosts, proxied through the cloud. Object-storage browsers (GCS, S3, R2, Azure Blob) remain on web and desktop.
- **[AI chat](./ai-chat.md)** — the full org chat with streamed markdown responses, the per-conversation model picker, the spend meter, and approve/reject buttons for pending actions. Approving a risky action from the couch works the same as from the desk.
- **SSH terminal** — a real terminal on your phone; see below.
- **[SQL editor](./sql-editor.md)** — run a query against any resource with a SQL surface and page through the rows. Autocomplete stays on web and desktop; the queries themselves run the same way.
- **[KV console](./kv-console.md) and document browser** — a Redis, Valkey, Memcached or Kafka console with per-driver command hints, and a MongoDB document browser with collections, a JSON filter, paging, and insert/edit/delete. Tap an echoed command to put it back in the input — there are no arrow keys to recall history with.
- **Key-value namespaces** — for provider KV stores (Cloudflare Workers KV and friends), list keys with a prefix filter, reveal a value, write it back, or delete it.
- **[Speech testing](./speech-testing.md)** — resources from a speech provider get a **Speech** screen: pick a voice and model, type something and play the clip back (or send it to the share sheet), and record from the phone's own microphone — or pick an audio file — to get the transcript and its word timings. iOS and Android ask for microphone permission the first time you record.
- **Container actions** — start, stop, and restart a Docker container from its resource page.
- **Integrations** — the peer panes a resource picks up from its plugin integrations; see below.
- **Logs** — the same controls as the web Logs tab: container picker, tail length, previous-instance, follow, and copy.
- **[Changes](./change-timeline.md)** — the org's drift feed, reached from **Changes** at the top of the Resources tab. Filter by change kind, by account, and by a time window — **Any time**, **24h**, **7d** or **30d** — then tap any event to see its per-field before → after values and jump to the resource. Each resource page also carries its own **Changes** section, the phone's version of the web tab. **Investigate a moment** at the top opens the [moment view](./moment.md) — every feed merged around one timestamp — which is also where drift, cost-anomaly and provider-incident notifications land.
- **[Dependencies](./dependency-graph.md)** — every resource page shows what it depends on and what depends on it, with the same captions the web tab uses. **Blast radius** opens a screen listing everything that transitively depends on the resource — what breaks if it does. The org-wide graph canvas stays on web and desktop; see below.
- **Resource cost estimates** — a resource whose provider can price it carries an **Estimated cost** card on its detail screen, with the same line items and the same monthly figure web and desktop show in the header chip. See [live cost estimates](./cost-estimates.md).
- **Workflows & agents** — read-only views of your [workflows](./workflows.md) (definitions and run history) and [agent sessions](./agents.md).
- **[Approvals](./workflows.md#deciding-from-your-phone)** — every run in the org suspended on `infra.waitForApproval(...)`, with **Approve** and **Deny** behind a confirmation step. An approval push opens straight here with its request at the top. This is the one place the read-only workflows surface can change something, and it is the whole point of the notification.
- **Settings** — team members, [API keys](../team-and-billing/api-keys.md) (view and revoke), the [audit log](../team-and-billing/audit-log.md), [SSH keys](../team-and-billing/ssh-keys.md), approvals, billing (read-only), your [push notification](./mobile-push-notifications.md) preferences and devices (including the **Resource drift** toggle), Slack and Teams routing, the [weekly digest](./weekly-digest.md) with its last-send status, a test push, and your [account settings](./account-settings.md) — name, password reset, two-factor enrolment, active sessions, and [deleting your account](./account-settings.md#deleting-your-account).

<insert [Mobile Dashboards tab listing the org's dashboards with the default one marked, next to an opened dashboard showing a pinned resource card, a stacked-bar cost graph with its legend totals, and a budget card with its progress bar] here>

<insert [Mobile resource detail page for a droplet showing the schema-rendered overview, action buttons, and a metrics chart] here>

## Building a dashboard on the phone

**New dashboard** at the bottom of the Dashboards tab asks for a name and drops you straight into the empty dashboard it just made.

Every dashboard has an **Edit** button at the top. In edit mode:

- **Add a card** offers the same four choices as the **+** tile on web — pin a resource (searched the same way as the Search tab), a **Cost graph**, a **New budget**, or an **Existing budget** the org already has.
- Each card grows **Move up** / **Move down** buttons. There is no drag-and-drop on a phone, but the order is the same single sequence web drags through, so a cost graph can sit between two resource cards.
- **Configure** on a cost graph opens the same options web's config dialog has — chart type, binning, date range, group-by (including by tag key), filters, top-N, previous-period comparison, and the forecast overlay — rendered as tappable chips rather than dropdowns. Custom absolute date ranges are the one thing left to web and desktop; a graph that already has one keeps it.
- **Configure** on a budget edits the budget itself, so the change follows it to every dashboard it sits on and to the alerts it fires.
- **Remove** takes a card off the dashboard. Removing a budget card leaves the budget tracking and alerting, exactly as on web.
- **Rename** and **Delete** act on the dashboard. The default dashboard cannot be deleted.

Everything here writes through the same API the web app uses, so a dashboard built on a phone opens unchanged on the desktop.

<insert [Mobile dashboard in edit mode showing the Add a card / Rename / Delete / Done buttons, a card with its Move up, Move down, Configure and Remove strip, and the Add a card sheet open] here>

## The SSH terminal

Tap **SSH terminal** on any SSH-capable resource and the app opens a full terminal — the same xterm.js terminal the web app uses, speaking the same WebSocket proxy protocol against the cloud, with your org's [SSH keys](../team-and-billing/ssh-keys.md). Host key verification, jumpbox routing, and the [audit log](../team-and-billing/audit-log.md) all behave exactly as they do in the [web SSH terminal](./ssh-terminal.md), because it is the same server-side session underneath.

Virtual machines — DigitalOcean droplets, EC2 instances, Hetzner servers and the like — authenticate with one of your org's [SSH keys](../team-and-billing/ssh-keys.md) rather than the account's own credentials, so the app shows a quick-connect step first: it fills in the host and the resource type's default username, you pick the key, and **Connect** opens the pty. This is the same choice the web app's quick-connect panel offers. Accounts whose plugin carries its own SSH credentials (the SSH plugin, Fly) skip the step and connect straight away. The **Files** browser asks the same question for the same resources.

Connecting to a host for the first time — or to one whose key has changed — brings up the [host-key trust prompt](./ssh-terminal.md#security-notes) with the presented fingerprint, and the previously pinned one when it changed. Accepting pins the fingerprint for the whole organization and reconnects; declining leaves the session closed. The prompt covers the file browser too, so anything that dials SSH asks before it connects.

<insert [Mobile host-key trust prompt for an unknown host: the fingerprint block with its Copy control and the "Trust key and continue" button] here>

<insert [Mobile SSH quick-connect step for a droplet: host line, username field pre-filled with root, and the org SSH key list with one key selected] here>

## Integrations and Kubernetes shells

When a resource has peer integrations — a managed Kubernetes cluster carrying its workloads, a managed database carrying its tables — they appear under **Integrations** on the resource page. Opening one builds the pane on demand, the same call the web app makes when you click a peer tab, and lists the same grouped resources. Tapping one opens its own resource page; if the integration needs setting up first (a managed database with no connection user yet, say), the pane shows the provider's guidance and its fix-it button, which runs the command against the parent resource exactly as on web.

Pods listed by a Kubernetes integration have a **Shell** button that opens a `kubectl exec` terminal, and a pod's own page has the same button when you reached it through its cluster. It is the same server-side session and the same terminal as the [SSH terminal](#the-ssh-terminal).

<insert [Mobile Kubernetes integration pane for a DOKS cluster: grouped workloads with a pod row showing its Shell button] here>

## What stays on web and desktop

The mobile app is deliberately a read-and-respond surface. Some things are demoted or absent by design:

- **Billing is read-only** — you can see your plan, your monthly and prepaid seats, and your [capacity slot](../team-and-billing/billing-and-plans.md#prepaid-capacity-slots) purchases with their expiry dates, but plan changes, slot purchases and payment details are managed on the web (App Store rules).
- **Code editors are absent** — manifest editing, the [bucket policy editor](./bucket-policy-editor.md), and [workflow](./workflows.md) editing all use Monaco, which stays on web and desktop.
- **[Secret reroll](../core-concepts/secret-rerolls.md) wizard** is web/desktop-only. Plugin command prompts do work — the form renders natively, though the richer pickers (region, size, machine image) fall back to a plain text field.
- **Dashboard drag-and-drop and custom date ranges** — dashboards are fully editable on mobile (see [above](#building-a-dashboard-on-the-phone)), but cards are reordered with **Move up** / **Move down** rather than dragged, and a cost graph's custom absolute date range is set on web or desktop.
- **The [dependency graph](./dependency-graph.md) canvas** stays on web and desktop. Its whole value is seeing many resources wired together at once, which is the one thing a phone screen cannot do. What a phone is actually asked — "what does this touch, and what breaks with it" — is on every resource page instead, as the **Dependencies** section and the **Blast radius** screen.
- **[Drift alert settings](./change-timeline.md#choosing-what-counts)** are set on web. They are one organization-wide policy; the phone-sized control is your own **Resource drift** push toggle in Settings → Notifications.
- **k9s and Kubernetes port-forward** are not yet supported on mobile. Pod shells are — see above.
- **The [weekly digest](./weekly-digest.md) schedule and email recipients** are shown on the phone but edited on web. The send day, hour, and time zone need a searchable zone picker, and the recipient list is an organization-wide address list rather than a personal setting. The digest's on/off switch, the AI-summary opt-in, **Send now**, and the last-send status are all on mobile — a digest that has quietly stopped arriving has to be visible everywhere.
- **[Drift alert](./change-timeline.md) filters** — your personal **Resource drift** push toggle is on the phone; what counts as drift for the whole organization (change kinds, cooldown, minimum changes, which accounts) is set on web, because it changes what everyone hears.
- **[SQL editor](./sql-editor.md) autocomplete** is absent (queries still run).

If you try to do one of these, the app points you at the web app rather than offering a worse version of the same flow.
