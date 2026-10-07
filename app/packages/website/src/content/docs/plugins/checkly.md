---
title: Checkly
description: Manage Checkly checks of every type (activate, mute, run now, edit), check groups, alert channels, maintenance windows, private locations, dashboards, status pages and environment variables, and chart response times and failures per location.
sidebar_order: 50
---

Connect a Checkly account to manage your synthetic checks and uptime monitors alongside the infrastructure they watch.

## What you can manage

- **Checks** of every type: API, browser, multistep, Playwright check suites, URL, TCP, ICMP (ping), DNS, SSL, gRPC, traceroute and heartbeat monitors. Each shows its type, target, locations, current status (passing, degraded, failing) and, for checked domains, how many days the SSL certificate has left. **Run now**, **Activate** or **Deactivate**, and **Mute** or **Unmute** any check; edit its name, description, frequency, tags and the degraded and failing response time limits. The detail page shows the last 7 days' availability and response times from Checkly's analytics, and the Metrics tab charts response time per run location and failed runs over the selected range (up to the 30 days Checkly keeps raw results).
- **Create checks** for URL, API (with an expected status code), TCP, ping, DNS and heartbeat monitors, with pickers for locations and group. Browser, multistep and Playwright checks need a script, so create those with the Checkly CLI or in Checkly; you can still run, activate, mute and edit them here.
- **Heartbeat monitors** expose their ping URL as a sensitive output, exportable as `CHECKLY_HEARTBEAT_URL` to the job that pings it.
- **Check groups**: create, rename, retag, change concurrency, activate, deactivate, mute, and **Run all checks**.
- **Alert channels**: email, Slack, webhook, SMS, phone call, PagerDuty and Opsgenie. Create them and choose which events they send (failure, recovery, degraded, SSL expiry and its warning threshold) and whether new checks subscribe automatically. Webhook URLs are shown with their path hidden.
- **Maintenance windows**: schedule one-off or recurring windows for checks with given tags, rename them and change their tags or description.
- **Private locations**: create them, rename them, set their proxy, see connected agents and outdated agent versions, chart the queue of scheduled runs, and **Generate agent key**: the key is kept as the location's **Agent API Key** output, exportable as `API_KEY` for the agent container.
- **Dashboards**: create them and edit the header, description, subdomain, custom domain, tags and refresh rate.
- **Status pages**: rename them, change their description, or delete them.
- **Environment variables**: create them (optionally as secrets), change values and locking. Secret values are never shown.

<insert [Checkly check detail page showing the Run now, Deactivate and Mute buttons, the Last 7 days availability section and the Metrics tab with response time per location] here>

## Credentials

Create a **user API key** in Checkly under **User settings → API keys**. The key acts with your role in the account: **Read & Write** to manage checks and alerting, **Admin** to generate private location keys, **Read only** for an account that only lists and charts. Paste the key, then pick the **Account**: Infrawrench lists the accounts the key belongs to.

<insert [Checkly Add-account form with the API Key filled in and the Account picker open showing the accounts the key can access] here>

## Metrics

Check charts read raw check results, which Checkly keeps for 30 days, so ranges beyond that are cut to 30 days. Checkly rate-limits results to 60 requests a minute and analytics to 30, so very large accounts may see a chart load slowly. Private location charts cover the last 15 days.

## Usage credits

Accounts on a Checkly credit package see their credit consumption for the current usage term against its budget on the quota radar. Accounts on a plan with fixed limits report nothing there. Checkly bills in credits rather than currency through its API, so Checkly spend does not appear on the Costs page.

## Status

Open incidents and maintenance in progress on [Checkly's status page](https://is.checkly.online) show on your Checkly resources. Scheduled maintenance that has not started yet is not shown.

## Export to Terraform

URL and TCP monitors, check groups, dashboards, maintenance windows, private locations and environment variables export as `checkly/checkly` resources with their import ids; secret variable values become Terraform variables. API, browser, multistep and Playwright checks are not exported because their requests, assertions and scripts are not part of the inventory; use the Checkly CLI's own export for those.

## Limits

- Groups list at most 100 member checks when running all of them.
- Changing a check's type, request or script is done in Checkly or with the Checkly CLI.
