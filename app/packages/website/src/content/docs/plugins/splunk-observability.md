---
title: Splunk Observability Cloud
description: Manage Splunk Observability Cloud detectors, alerts, muting rules, dashboards and charts, teams, members, integrations, access tokens, SLOs and synthetic tests, chart SignalFlow, and watch usage against your organization's limits.
sidebar_order: 50
---

Connect a Splunk Observability Cloud organization to manage its alerting and content next to the infrastructure it watches.

## What you can manage

- **Organization**: account type and status, renewal date, the data-points-per-minute limit and tokens about to expire. Its Metrics tab charts usage: active metric time series against the limit, data points received, hosts and containers monitored, and custom metrics.
- **Detectors**: name, description, tags, SignalFlow program and rules. Create detectors (each `detect(...).publish('label')` becomes a rule with the severity you pick), edit them, turn all their rules off and on, delete them, and chart the signals the program publishes.
- **Alerts**: active incidents with their detector, rule, severity and inputs. **Clear alert** resolves one.
- **Muting rules**: create one with friendly filters such as `host=web-1, !env=dev`, a start and an optional end; edit the description, **End now**, or delete.
- **Dashboard groups, dashboards and charts**: create and rename groups, rename dashboards and charts, edit a chart's SignalFlow, chart it here, and delete any of them.
- **Teams**: create, rename and delete teams; detectors and dashboard groups link to the teams that own them.
- **Members**: invite users, grant or revoke admin, and remove them.
- **Integrations**: Slack, PagerDuty, webhooks, cloud and SSO integrations. Turn them off and on, **Validate**, or delete.
- **Access tokens**: scopes, expiry, last rotation and quota. Edit the description, turn tokens off and on, delete them, or use **Get credentials** to rotate a token and see its new secret once. Expiring tokens show on the Expiry radar.
- **SLOs**: target, compliance period and alert rules. Delete them here; define them in Splunk.
- **Synthetic tests**: browser, API, HTTP, SSL and port tests with their recent runs. **Run now**, pause, resume, or delete.

<insert [Splunk Observability detector detail page showing the rules, the SignalFlow program and the Metrics tab charting the published signals] here>

## Credentials

1. **Realm**: pick it from the list. It is in your app address (`app.<realm>.observability.splunkcloud.com`).
2. **API access token**: in Splunk Observability Cloud open **Settings → Access Tokens → New Token**, choose **API token** and the **power** role (`read_only` lists everything but cannot edit). Access tokens, members and integrations can only be managed with a token tied to an administrator: use an admin's **user API access token** from your profile for those. **Check credentials** shows which areas the token can reach.

<insert [Splunk Observability Add-account form with the realm picker and the API Access Token field] here>

## Metrics

Detectors and charts have a Metrics tab that runs their own SignalFlow program over the selected window (SignalFlow `execute` over the REST transport) and charts what it publishes, up to 20 series. The organization charts its usage metrics the same way.

## Limits and usage

The organization's **Quotas** show active metric time series, active custom metric time series and detectors against the limits Splunk reports for your organization (the `sf.org.limit.*` metrics), so you see a limit coming before ingest is throttled.

## Costs

Splunk Observability Cloud has no billing API, so spend does not appear on the Costs page. Usage is available through the organization's metrics and quotas.

## Status

Splunk publishes a separate status page per realm (for example status.us1.observability.splunkcloud.com), and Infrawrench follows one status feed per provider, so Splunk incidents are not correlated automatically.

## Terraform

Detectors, teams and dashboard groups export to the `splunk-terraform/signalfx` provider with import commands. Detector rule notifications are not exported, so add them before applying.

## Limits

- Lists read up to 20,000 items per type (1,000 per page).
- Dashboards and charts are renamed here; their layout and visual options are edited in Splunk.
- SLO and synthetic test definitions are edited in Splunk.
