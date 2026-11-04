---
title: Public status pages
description: Publish the synthetic probes you already run at a public link, with current state, 24-hour uptime and 90 days of history, and no probe URLs or account details exposed.
sidebar_order: 12
---

A status page shows your customers whether your services are up. Pick some of your
[synthetic probes](./synthetic-probes.md), give them names your customers would recognise, and
publish them at a link anyone can open without an account.

Nothing new is measured. The page reuses the probe results you already have, so it costs no extra
checks and always agrees with your Probes tab.

![A published status page as a visitor sees it: a green "All systems operational" banner, three components grouped under "Core services" with uptime percentages, and a row of 90 daily uptime bars under each](https://agent-assets.infrawrench.com/docs-screenshots/features/status-pages/public-page-visitor.png)

## Where to find it

Open the **Status pages** tab in the web or desktop app (its own sidebar entry, next to
**Probes**). The mobile app shows a read-only list of your pages and whether each is live. The
`infrawrench` [CLI](./cli.md) shows the same with `infrawrench status-pages`.

## Publish a page

A new page starts as a **draft**. It already has a link, and you can open it yourself to check how
it looks, but anyone else who tries that link gets a 404.

The page becomes public only when you press **Publish**. The app asks you to confirm first and
tells you how many components you are about to expose.

## Keep the link safe

The link is the only thing protecting the page. There is no org id in the URL and no sign-in. The
slug is 22 random characters rather than something based on your title, so nobody can guess it
from your company name:

```
https://app.infrawrench.com/status/hq7mfp2wknx4bvz9td3rcs
```

Treat it as a secret you have chosen to share widely. If it ends up somewhere you didn't intend (a
public repo, a screenshot, an ex-contractor's bookmarks), press **New link**. The old URL stops
working immediately and the page stays published at the new one.

**Unpublish** is the blunter option: the page returns a 404 for everyone until you publish it
again.

## What visitors can and can't see

A visitor sees:

- the page title and description you wrote
- each component's **public name**, its group heading, and its current state
- 24-hour uptime, if you turned it on
- 90 days of daily uptime bars, if you turned them on
- your support link, if you set one
- any **notices** on the page: the title, body, state
  (_investigating, identified, monitoring, resolved_), timestamps, and which components on that
  page it names

A visitor never sees the probe's URL, HTTP method, interval, failure threshold, last status code
or error text. They also never see any resource id, account name, plugin name, your organization
id, or even the probe ids. Components have their own ids, which reveal nothing about your
monitoring.

An unpublished page and a link that never existed return the same 404, so nobody can use the link
to work out which pages are real.

Notices posted by [incident mode](./incident-mode.md) follow the same rule. The incident's id, who
declared it, and everything else about your organization stay private. Visitors learn that
something is wrong and what you're doing about it.

## Post a notice

Everything else on the page comes from your probes. A **notice** is the one part a person writes,
and it's what visitors actually come for: "we know, we're on it."

Notices show above the component list, newest first, using the usual _investigating, identified,
monitoring, resolved_ stages. Unresolved notices always show. Resolved ones stay for two weeks, so
someone arriving the morning after still sees what happened.

Usually you won't write one by hand. Declaring an incident with **Tell the public** ticked posts a
notice, and resolving the incident closes it. See [Incident mode](./incident-mode.md).

## Give components public names

A probe called `prod-api-lb health eu-west-1` is a good internal name and a bad public one. Give
each component a **public name** ("API", "Dashboard", "Webhooks") and, if you like, a group
heading so related components sit together:

| Probe                       | Public name      | Group         |
| --------------------------- | ---------------- | ------------- |
| `prod-api-lb health, eu-w1` | API              | Core services |
| `prod-web-cdn root`         | Dashboard        | Core services |
| `hooks-worker /healthz`     | Webhook delivery | Background    |

If you leave the public name blank, the probe's own name is shown. Check that it reads the way you
want.

Use the arrows beside each component to move it up or down. The order in the editor is the order
on the page.

## How states are shown

Each component shows its probe's current state:

| Probe                             | Component shows |
| --------------------------------- | --------------- |
| Up                                | **Operational** |
| Down (past its failure threshold) | **Down**        |
| No result yet                     | **No data**     |
| Paused                            | **No data**     |

A paused probe shows "No data" instead of its last green result, because the page describes what
is being checked right now. The editor warns you when a page includes a paused probe.

The banner at the top sums up the components:

- **All systems operational**: everything being measured is up
- **Some systems are experiencing issues**: some, but not all, are down
- **Major outage**: everything being measured is down
- **Status unavailable**: nothing has reported yet

Components with no data are left out of the banner, so adding a new component doesn't blank a page
that is otherwise reporting fine.

## Read the uptime history

Each daily bar shows how much of that day the endpoint was up, using the same data as the probe's
charts. A day with **no recorded data** is grey, not green or red. A page you created last week
shows seven coloured bars and 83 grey ones, rather than claiming three months of perfect uptime.

Days are in UTC. Bars are green at 99.9% and up, amber above 99%, and red below that.

## Permissions

Status pages use the same permissions as the probes they publish: `resources:read` to see them,
and `resources:write` to create, edit, publish, get a new link, or delete. Whoever can set up the
monitoring decides what of it is public.

Publishing, unpublishing, getting a new link and deleting are all recorded in the
[audit log](../team-and-billing/audit-log.md), so you can see exactly when a page became public.

## Related

- [Synthetic probes](./synthetic-probes.md): the checks a status page publishes
- [Metric alerts](./metric-alerts.md): the private side, alerting your team rather than your
  customers
- [CLI](./cli.md): `infrawrench status-pages` to see what of your monitoring is public right now
- [Incident mode](./incident-mode.md): what usually posts a notice, and what closes it
