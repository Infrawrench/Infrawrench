---
title: Checkly
description: Manage Checkly checks of every type (activate, mute, run now, edit), check groups, alert channels, maintenance windows, private locations, dashboards, status pages and environment variables, and chart response times and failures per location.
sidebar_order: 50
---

Connect a Checkly account to manage your synthetic checks and uptime monitors next to the infrastructure they watch.

## What you can manage

- **Checks** of every type: API, browser, multistep, Playwright check suites, URL, TCP, ICMP (ping), DNS, SSL, gRPC, traceroute and heartbeat monitors. Each shows its type, target, locations, current status (passing, degraded, failing) and, for checked domains, how many days the SSL certificate has left.
  - **Run now**, **Activate** or **Deactivate**, and **Mute** or **Unmute** any check.
  - Edit its name, description, frequency, tags and the degraded and failing response time limits.
  - The detail page shows the last 7 days' availability and response times. The Metrics tab charts response time per run location and failed runs over the range you pick (up to 30 days).
- **Create checks** for URL, API (with an expected status code), TCP, ping, DNS and heartbeat monitors, picking locations and group from lists. Browser, multistep and Playwright checks need a script, so create those with the Checkly CLI or in Checkly. You can still run, activate, mute and edit them here.
- **Heartbeat monitors** show their ping URL as a sensitive output. You can export it as `CHECKLY_HEARTBEAT_URL` to the job that pings it.
- **Check groups**: create, rename, retag, change concurrency, activate, deactivate, mute, and **Run all checks**.
- **Alert channels**: email, Slack, webhook, SMS, phone call, PagerDuty and Opsgenie. Create them, choose which events they send (failure, recovery, degraded, SSL expiry and its warning threshold), and choose whether new checks subscribe automatically. Webhook URLs are shown with their path hidden.
- **Maintenance windows**: schedule one-off or recurring windows for checks with given tags, rename them and change their tags or description.
- **Private locations**: create them, rename them, set their proxy, see connected agents and outdated agent versions, and chart the queue of scheduled runs. **Generate agent key** saves the key as the location's **Agent API Key** output, which you can export as `API_KEY` for the agent container.
- **Dashboards**: create them and edit the header, description, subdomain, custom domain, tags and refresh rate.
- **Status pages**: rename them, change their description, or delete them.
- **Environment variables**: create them (optionally as secrets), and change values and locking. Secret values are never shown.

<insert [Checkly check detail page showing the Run now, Deactivate and Mute buttons, the Last 7 days availability section and the Metrics tab with response time per location] here>

## Connect your account

1. In Checkly, create a **user API key** under **User settings > API keys**. The key acts with your role in the account:
   - **Read & Write** to manage checks and alerting
   - **Admin** to generate private location keys
   - **Read only** to just list and chart
2. Paste the key into Infrawrench.
3. Pick the **Account** from the list of accounts the key belongs to.

<insert [Checkly Add-account form with the API Key filled in and the Account picker open showing the accounts the key can access] here>

## Metrics

Checkly keeps raw check results for 30 days, so check charts can't go further back than that. On very large accounts, charts may load slowly because of Checkly's rate limits. Private location charts cover the last 15 days.

## Usage credits

If you're on a Checkly credit package, the quota radar shows your credit use for the current usage term against its budget. Plans with fixed limits show nothing there. Checkly spend doesn't appear on the Costs page, because Checkly reports it in credits rather than money.

## Status

Open incidents and maintenance in progress on [Checkly's status page](https://is.checkly.online) show on your Checkly resources. Scheduled maintenance that hasn't started yet isn't shown.

## Export to Terraform

URL and TCP monitors, check groups, dashboards, maintenance windows, private locations and environment variables export as `checkly/checkly` resources with their import ids. Secret variable values become Terraform variables. API, browser, multistep and Playwright checks aren't exported. Use the Checkly CLI's own export for those.

## Limits

- **Run all checks** on a group runs at most 100 member checks.
- Change a check's type, request or script in Checkly or with the Checkly CLI.
