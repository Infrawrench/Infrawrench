---
title: Mobile app
description: The Infrawrench app for iOS and Android. Browse resources, watch dashboards, chat with the AI, and open an SSH terminal from your phone.
sidebar_order: 14
---

The Infrawrench mobile app puts your cloud organization in your pocket. It's a native iOS and Android app that uses the same accounts, resource views and permissions as the web app. It's built for on-call moments: a push notification lands, you tap it, and within seconds you're looking at the failing account, or an SSH prompt.

> **Cloud only.** The app signs in to an Infrawrench Cloud organization. There's no local-only mode on mobile. If you use the desktop app on its own, link it to a cloud org first (see [Desktop, web, and mobile](../core-concepts/desktop-vs-web.md)).

## Sign in

1. Install the app and tap **Sign in**.
2. Your browser opens the same sign-in as the web app: email, Google or Microsoft.
3. After signing in, you're sent back to the app and land on the organization picker.

Sign-in uses OAuth with PKCE, so your password never touches the app, and tokens are kept in your phone's secure store (Keychain on iOS, Keystore on Android). Signing in also registers your phone for [push notifications](./mobile-push-notifications.md). Allow notifications when asked if you want incident and budget alerts.

Switch organizations at any time from the org switcher. What you see depends on your [role permissions](../team-and-billing/roles-and-permissions.md), just like on the web.

<insert [Mobile sign-in screen next to the organization picker after OAuth completes] here>

## What you can do

- **Dashboards:** every [dashboard](./dashboard.md) in the org, default first. Tap one to open it. You see exactly what the web app shows: pinned resource tiles, workflow tiles, [cost graphs](./cloud-costs.md) and [budgets](./cloud-costs.md#budgets--alerts) in the order you arranged them, plus [KPI and text cards](./dashboard.md#kpi-cards) (edited on web or desktop). Cost graphs support every chart type, including donut and table, previous-period and forecast overlays, quarterly bins, running totals, usage and count measures, and per-series totals in the legend. Budgets show month-to-date spend against the amount, with thresholds and the forecast marker. A budget appears on the dashboard its card was added to. The **Costs** tab lists all of them. You can also build a dashboard here: **New dashboard** on the list, then **Edit** on the dashboard to add, reorder and configure cards, or rename or delete it. See [building a dashboard on the phone](#building-a-dashboard-on-the-phone).
- **Accounts and resources:** browse every connected account and its resources. An account page lists every resource type, including nested ones like DNS records and database users, with a search box that works the same as on web and desktop. **Sync from provider** refreshes the account now, and if a list [can't be read whole](../core-concepts/resources-and-accounts.md#when-a-list-cant-be-read-whole), the page says why and keeps the rows it had. Resource pages look the same as on web and desktop, including actions, a Logs tab and metrics charts.
- **Cost reports:** every saved [cost report](./cost-reports.md), read-only: the chart, the description, and links to each dashboard that uses it. Find them on the **Overview** tab of the Costs screen. **Share PDF** on a report or dashboard sends its [PDF](./dashboard-pdf.md) to the share sheet, and a dashboard lists its delivery schedules read-only.
- **Resource reports:** every saved [resource report](./resource-reports.md), read-only: rows and columns (tags, metadata and cost included), a page at a time with **Load more**. Tap a row to open the resource. Find them on the **Overview** tab of the Costs screen. Building and editing happens on web and desktop.
- **Canvases:** every [canvas](./ai-canvas.md) your org has built, read-only, from the **Overview** tab of the Costs screen: KPI tiles, charts, tables, budgets, anomalies and narrative, refreshed when you open it or pull to refresh, with **Share PDF**. Canvas cards on dashboards work too.
- **Costs:** month-to-date spend and every budget, the same as the [**Costs** panel](./cloud-costs.md#the-costs-panel) on web and desktop, with the same tabs: **Overview**, **Alerts**, **Savings**, **Commitments** and **Allocation** (there's no Network or Carbon tab on mobile). The app remembers the tab you last used.
  - **Overview** has the month-to-date chart and every budget, whether or not a dashboard shows it, so a budget alert push always has somewhere to land. Budgets show as the same expandable tree as on web, in money or a usage unit for the current period. They're read-only here, as on web: create and edit budgets from a dashboard card. An explicit period list is shown but edited on web or desktop.
  - Cost pushes open the matching tab: budget alerts open Overview, change and commitment or unit-cost alerts open Alerts, and savings and extended support findings open Savings. See [mobile push notifications](./mobile-push-notifications.md).
  - **Allocation** shows per-account tag compliance and untagged spend when your org has a [tag policy](./tag-policy-and-showback.md). The policy, cost centres and allocation rules are edited on the web.
  - **Savings** lists [right-sizing recommendations](./right-sizing.md) (read-only; apply resizes on web or desktop), [SaaS seats](./saas-seats.md) worth acting on with commands to copy (remove seats on web or desktop), and your [sleep/wake schedules](./sleep-schedules.md) with each window, next transition, last outcome and projected saving, plus a pause/resume toggle (create and edit schedules on web or desktop). Flagged resources in [Potential savings](./orphan-finder.md) show their [owner](../core-concepts/resource-ownership.md), with **Unowned** shown clearly and the unowned count below. Set owners on web or desktop.
- **Search:** search across your org's resources, like [spotlight search](./spotlight-search.md).
- **Starred:** items you starred on web or desktop appear above your dashboards on the home tab. Starring happens in the [command palette](./spotlight-search.md) or from a page header.
- **SFTP files:** browse, download (to the share sheet) and upload files on SSH-capable hosts. Object storage browsers (GCS, S3, R2, Azure Blob) are on web and desktop.
- **[AI chat](./ai-chat.md):** the full org chat with streamed responses, the per-conversation model picker, the spend meter, and approve/reject buttons for pending actions. Approving a risky action from the couch works the same as from your desk.
- **[Incident mode](./incident-mode.md):** declare an incident, read its timeline and add a timestamped note. On the phone, declaring asks for a title and severity only and uses safe defaults (announce, pin the moment, no change freeze, nothing published). Find it on the **Accounts** tab or open it from an incident push.
- **[Posture](./posture-checks.md) and [leaked credentials](./leaked-credentials.md):** your org's security findings, with leaked credentials at the top of the Posture screen showing token type, where it was found, what it matched and its status, read-only. A new leak arrives as a critical push (one per scan, under the **Leaked credentials** trigger). If the scan found exactly one, tapping it opens the Posture screen on that leak.
- **SSH terminal:** a real terminal on your phone. See below.
- **[SQL editor](./sql-editor.md):** run a query against any resource with SQL and page through the rows. The schema browser is on web and desktop.
- **[KV console](./kv-console.md) and document browser:** a Redis, Valkey, Memcached or Kafka console with command hints, and a MongoDB document browser with collections, a JSON filter, paging, and insert/edit/delete. Tap a previous command to put it back in the input, since there are no arrow keys.
- **Key-value namespaces:** for provider KV stores (Cloudflare Workers KV and similar), list keys with a prefix filter, reveal a value, write it back or delete it.
- **[Speech testing](./speech-testing.md):** resources from a speech provider get a **Speech** screen. Pick a voice and model, type something and play the clip (or send it to the share sheet), and record from your phone's microphone, or pick an audio file, to get the transcript and word timings. Your phone asks for microphone permission the first time.
- **Container actions:** start, stop and restart a Docker container from its resource page.
- **Integrations:** extra panes a resource gets from its integrations. See below.
- **Logs:** the same controls as the web Logs tab: container picker, tail length, previous instance, follow and copy.
- **[Changes](./change-timeline.md):** your org's drift feed, from **Changes** at the top of the Resources tab. Filter by change kind, account and time window (**Any time**, **24h**, **7d** or **30d**), then tap an event to see its before and after values and jump to the resource. Each resource page also has its own **Changes** section. **Investigate a moment** at the top opens the [moment view](./moment.md), which is also where drift, cost anomaly and provider incident notifications open.
- **[Dependencies](./dependency-graph.md):** every resource page shows what it depends on and what depends on it. **Blast radius** lists everything that depends on the resource, directly or indirectly, so you can see what breaks if it does. The org-wide graph is on web and desktop.
- **Resource cost estimates:** a resource your provider can price shows an **Estimated cost** card with the same line items and monthly figure as on web and desktop. See [live cost estimates](./cost-estimates.md).
- **Workflows and agents:** read-only views of your [workflows](./workflows.md) (definitions and run history) and [agent sessions](./agents.md).
- **[Approvals](./workflows.md#deciding-from-your-phone):** every run in your org waiting on `infra.waitForApproval(...)`, with **Approve** and **Deny** behind a confirmation step. An approval push opens straight here with its request at the top.
- **Settings:** team members, [API keys](../team-and-billing/api-keys.md) (view and revoke), the [audit log](../team-and-billing/audit-log.md), [SSH keys](../team-and-billing/ssh-keys.md), approvals, billing (read-only), [scheduled cost exports](./cost-exports.md) (read-only: the list, the schedule, and whether last night's run failed; create them on web or desktop), your [push notification](./mobile-push-notifications.md) preferences and devices (including the **Resource drift** toggle), Slack and Teams routing, the [weekly digest](./weekly-digest.md) with its last-send status, a test push, and your [account settings](./account-settings.md): name, password reset, two-factor setup, active sessions and [deleting your account](./account-settings.md#deleting-your-account).

<insert [Mobile Dashboards tab listing the org's dashboards with the default one marked, next to an opened dashboard showing a pinned resource card, a stacked-bar cost graph with its legend totals, and a budget card with its progress bar] here>

<insert [Mobile resource detail page for a droplet showing the schema-rendered overview, action buttons, and a metrics chart] here>

## Building a dashboard on the phone

Tap **New dashboard** at the bottom of the Dashboards tab, enter a name, and you're taken straight to the new, empty dashboard.

Every dashboard has an **Edit** button at the top. In edit mode:

- **Add a card** offers the same four choices as the **+** tile on web: pin a resource (searched like the Search tab), a **Cost graph**, a **New budget**, or an **Existing budget**.
- Each card gets **Move up** and **Move down** buttons, since there's no drag and drop on a phone. The order is the same as on web, so a cost graph can sit between two resource cards.
- **Configure** on a cost graph has the same options as on web: chart type, measure (cost, usage quantity with a unit picker, or count), binning, cumulative, date range, group-by (including by tag key, with your org's [preferred tag keys](./tag-keys.md) first and hidden ones left out), filters, top-N, previous-period comparison and the forecast overlay, shown as tappable chips. Custom absolute date ranges are set on web or desktop. A graph that already has one keeps it.
- **Configure** on a budget edits the budget itself, so the change applies everywhere it appears and to the alerts it sends.
- **Duplicate** copies a cost, budget, KPI, text or other widget card right after the original.
- **Remove** takes a card off the dashboard. Removing a budget card doesn't stop the budget tracking and alerting, the same as on web.
- **Rename** and **Delete** apply to the dashboard. You can't delete the default dashboard.

A dashboard built on your phone opens unchanged on desktop.

<insert [Mobile dashboard in edit mode showing the Add a card / Rename / Delete / Done buttons, a card with its Move up, Move down, Configure and Remove strip, and the Add a card sheet open] here>

## The SSH terminal

Tap **SSH terminal** on any SSH-capable resource to open a full terminal using your org's [SSH keys](../team-and-billing/ssh-keys.md). Host key checks, jumpbox routing and the [audit log](../team-and-billing/audit-log.md) all work exactly as in the [web SSH terminal](./ssh-terminal.md).

Virtual machines (DigitalOcean droplets, EC2 instances, Hetzner servers and the like) sign in with one of your org's [SSH keys](../team-and-billing/ssh-keys.md), so you'll see a quick-connect step first. The host and default username are filled in. Pick the key and tap **Connect**. This matches the web app's quick-connect panel. Accounts with their own SSH credentials (the SSH plugin, Fly) skip this step and connect straight away. The **Files** browser asks the same question for the same resources.

Connecting to a host for the first time, or to one whose key has changed, shows the [host key trust prompt](./ssh-terminal.md#security-notes) with the host's fingerprint, plus the previously trusted one if it changed. Accept to trust the fingerprint for your whole organization and reconnect. Decline to leave the session closed. The prompt covers the file browser too.

<insert [Mobile host-key trust prompt for an unknown host: the fingerprint block with its Copy control and the "Trust key and continue" button] here>

<insert [Mobile SSH quick-connect step for a droplet: host line, username field pre-filled with root, and the org SSH key list with one key selected] here>

## Integrations and Kubernetes shells

When a resource has integrations (a managed Kubernetes cluster with its workloads, a managed database with its tables), they appear under **Integrations** on the resource page. Open one to see the same grouped resources as on web, and tap any of them to open its page. If an integration needs setting up first (for example, a managed database with no connection user yet), the pane shows the provider's guidance and a button to fix it, just like on web.

Pods listed by a Kubernetes integration have a **Shell** button that opens a `kubectl exec` terminal. A pod's own page has the same button when you reached it through its cluster. It's the same terminal as the [SSH terminal](#the-ssh-terminal).

<insert [Mobile Kubernetes integration pane for a DOKS cluster: grouped workloads with a pod row showing its Shell button] here>

## What stays on web and desktop

The mobile app is for reading and responding. Some things are limited or left out on purpose:

- **Billing is read-only.** You can see your plan, your monthly and prepaid seats, and your [capacity slot](../team-and-billing/billing-and-plans.md#prepaid-capacity-slots) purchases with their expiry dates. Plan changes, slot purchases and payment details are managed on the web (App Store rules).
- **[Canvases](./ai-canvas.md) are read-only.** Building and editing one is a conversation with the assistant next to the canvas, which needs a bigger screen.
- **[Cost reports](./cost-reports.md) are read-only.** You can open any saved report with its chart, description and the dashboards it feeds. Creating or editing one happens on web or desktop.
- **Code editors aren't available.** Manifest editing, the [bucket policy editor](./bucket-policy-editor.md) and [workflow](./workflows.md) editing stay on web and desktop.
- **The [secret reroll](../core-concepts/secret-rerolls.md) wizard** is web and desktop only. Plugin command prompts do work, though richer pickers (region, size, machine image) become a plain text field.
- **Rotating or dismissing a [leaked credential](./leaked-credentials.md)** happens on web and desktop. The phone shows the list and gets the push.
- **Dashboard drag and drop and custom date ranges.** Dashboards are fully editable on mobile (see [above](#building-a-dashboard-on-the-phone)), but you reorder cards with **Move up** and **Move down**, and set a cost graph's custom absolute date range on web or desktop.
- **The [dependency graph](./dependency-graph.md)** stays on web and desktop. Every resource page on mobile has the **Dependencies** section and **Blast radius** screen instead.
- **[Drift alert settings](./change-timeline.md#choosing-what-counts)** are set on the web, since they're one policy for the whole organization (change kinds, cooldown, minimum changes, which accounts). Your own **Resource drift** push toggle is in **Settings > Notifications** on the phone.
- **k9s and Kubernetes port-forward** aren't supported on mobile yet. Pod shells are (see above).
- **The [weekly digest](./weekly-digest.md) schedule and email recipients** are shown on the phone but edited on the web. The on/off switch, the AI summary opt-in, **Send now** and the last-send status are all on mobile.
- **Editing an incident, retrying its failed steps, and the [postmortem](./incident-mode.md) export** stay on web and desktop. Declaring, reading and adding notes work on the phone.
- **The [SQL editor](./sql-editor.md) schema browser** isn't available (queries still run).

If you try one of these, the app points you to the web app.

## Just-in-time access

You can raise and decide [just-in-time access](./just-in-time-access.md) requests from your phone (**Settings > Just-in-time access**). Pick a policy, a role and a duration, give a reason, and send. Approvers get a push with **Approve** and **Deny** on the notification itself. Either one opens the app on a confirmation screen showing who, what, where and for how long, so a single tap on a lock screen never grants cloud access. You can also extend, revoke and cancel requests. Policies are written on web and desktop.

## Break-glass approvals

When a colleague is blocked mid-incident and asks for a permission they don't have, you can approve it from wherever you are. [Break-glass requests](../team-and-billing/break-glass-access.md) show up on the phone with the same two-tap confirmation as workflow approvals, and an `access_request` push opens straight to the request.

You can decide requests on mobile, but raising one happens on web and desktop.
