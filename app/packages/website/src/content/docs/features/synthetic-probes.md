---
title: Synthetic probes
description: HTTP uptime and latency checks run on an interval from outside your infrastructure, with auto-suggested endpoints, latency charts, trailing uptime, and alerts after N consecutive failures.
sidebar_order: 11
---

A synthetic probe answers one question: **can the internet reach this endpoint, and how fast?** Point a probe at a URL and Infrawrench requests it on an interval (every 60 seconds by default) from outside your clusters and clouds. It records latency and status, and alerts you by push, Slack or Microsoft Teams when the endpoint fails enough checks in a row.

<insert [The Probes tab showing a list of probes: one down (warning triangle next to its name, with the failure reason), several up with uptime percentages and last latencies, with one row expanded into its 24-hour latency chart] here>

## Where to find it

- **Web and desktop:** **Probes** in the sidebar. On desktop, probes need cloud mode.
- **Mobile:** a read-only Probes screen, handy for checking "is it still down?" after a push notification.
- **CLI:** `infrawrench probes` lists your probes. Add a probe's name to see its latency chart in the terminal. See [CLI](./cli.md).

## Create a probe

The probe editor opens with a list of endpoints from resources you've already synced: load balancer hostnames, app URLs, database public endpoints, domains, public IPs. Pick one and the URL and name fill in, and the probe stays linked to that resource.

For anything Infrawrench doesn't know about, choose the custom URL option. A bare hostname gets `https://` added.

![The probe editor modal with the endpoint dropdown open, listing suggested URLs labelled with their resource names, and the Custom URL option at the bottom](https://agent-assets.infrawrench.com/docs-screenshots/features/synthetic-probes/probe-editor-endpoint-picker.png)

Settings:

- **Method:** GET, HEAD or OPTIONS. Probes never send a request body.
- **Interval:** seconds between checks, minimum 60.
- **Timeout:** how long a check waits before it counts as a failure (default 10s).
- **Failures before alert:** how many failures in a row before you're alerted (default 3).

## What counts as up

A check is **up** when the request finishes with a status below 500. A `404` or `401` means the endpoint is alive and answering, so an auth wall in front of a healthy service won't page anyone. A `5xx`, a timeout, a TLS failure or an unreachable host counts as **down**.

Latency is measured to the first response. Because checks come from outside your infrastructure, the numbers include DNS and the TLS handshake, just like your users see. If your ingress goes down, you'll see it even when everything behind it looks healthy.

## Alerts

A single failed check is usually noise. A probe only turns **down** and alerts you after it fails the set number of checks in a row. Any success resets the count. When a down probe answers again, you get a **recovered** notification.

Probe alerts have their own trigger ("Probes"), so you can route them per Slack channel, per Teams webhook and per person in mobile push preferences. See [Slack alerts](./slack-alerts.md), [Teams alerts](./teams-alerts.md) and [Mobile push notifications](./mobile-push-notifications.md).

## Charts and uptime

Each check records **Latency** (ms) and **Up** (1 or 0). The probe list shows each probe's uptime over the last 24 hours and its last latency. Expand a row to see its latency chart.

Deleting a probe stops the checks. Its history is removed over time under the normal retention rules.

## Publish a status page

The probes you already run make most of a status page. Use the **Status pages** tab to publish a chosen set of them at a public link, showing current state, uptime and 90 days of history under names your customers recognise. Probe URLs and account details aren't shown. See [Public status pages](./status-pages.md).

## Requirements

Probes only target endpoints the internet can reach. Private, loopback and cluster-internal addresses are refused.

**Self-hosting:** probes need the workflow fetch proxy configured (`WORKFLOW_FETCH_PROXY_URL` / `WORKFLOW_FETCH_PROXY_TOKEN`). Without it, probes don't run, because they need to measure from outside your network.

## Related

- [Status pages](./status-pages.md): publish a chosen set of these probes.
- [Incident mode](./incident-mode.md): a down probe has a **Declare incident** button that opens the form pre-filled with the probe's name, its error and when it went down.
