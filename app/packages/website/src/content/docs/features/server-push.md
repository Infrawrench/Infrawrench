---
title: Push from your own servers
description: Raise on-call pages and report your own cost data over the HTTP API, from code running anywhere.
sidebar_order: 18
---

Most of what Infrawrench knows, it fetches itself. Two things it can't fetch: an alert about
something only your code can see, and spend that arrives as an invoice rather than through a
billing API.

For both, you can push the data **into** Infrawrench. A health check, a deploy script or a cron
job can send what it knows, and your organization's existing settings decide what happens next.

| You want to                    | Endpoint                           | Permission    |
| ------------------------------ | ---------------------------------- | ------------- |
| Wake somebody up               | `POST /api/org/{orgId}/pages`      | `pages:write` |
| Clear a page's cooldown        | `DELETE /api/org/{orgId}/pages`    | `pages:write` |
| Report spend from your systems | `POST /api/org/{orgId}/costs/rows` | `costs:write` |

Both authenticate with an [API key](../team-and-billing/api-keys.md)
(`Authorization: Bearer iwk_…`) scoped to just that permission, or with a signed-in session, so
you can test them from the browser. Neither permission is in a system role by default: create a
key with the scope, or add it to a custom role.

## Send a page

`POST /pages` raises the same alert a [workflow](./workflows.md#paging-a-human) raises with
`infra.page(...)`, and it reaches the same people: SMS (and optionally a voice call) through your
organization's Twilio credentials, [mobile push](./mobile-push-notifications.md), and any
[Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channel set up for pages.
Recipients choose their own settings under **Settings > Notifications**, so your code never needs
SMS or chat credentials.

```bash
curl -X POST https://app.infrawrench.com/api/org/$ORG/pages \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  -H "content-type: application/json" \
  -d '{
        "source": "checkout-api",
        "title": "Checkout 5xx",
        "message": "5xx rate above 2% for 5 minutes",
        "key": "5xx-rate"
      }'
```

`source` is your name for the system sending the page. It shows as the sender of the
notification, and repeat pages are tracked per source, so two services paging under the key
`disk-full` never silence each other.

### Repeat pages are held back, not rejected

A monitor finds the same problem every time it runs. Calling this endpoint every minute would mean
1,440 messages a day about one broken thing. So every page has a **key**, and once a key has
fired, further pages under it stay quiet until its cooldown ends (one hour by default).

That means you can **call it every time** and read the response, instead of tracking state
yourself:

```json
{
  "delivered": false,
  "suppressed": true,
  "sms": 0,
  "push": 0,
  "slack": 0,
  "msTeams": 0,
  "retryAt": "2026-07-27T15:30:00.000Z"
}
```

A held-back page returns `200`. So does a page that reached nobody, but that one does **not**
start a cooldown, so the next call tries again instead of going quiet after a failed delivery.

| Field             | Default    | What it does                                                                                 |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `source`          | _required_ | Names the system paging. Letters, digits, `.`, `_`, `-`; up to 64 characters.                |
| `message`         | _required_ | The alert text. Becomes the SMS body and the notification body.                              |
| `title`           | `source`   | Headline of the notification.                                                                |
| `key`             | `default`  | Throttle bucket. Use a per-object key (a host, a cluster) to alert per object.               |
| `cooldownMinutes` | `60`       | How long a key stays quiet after firing. `0` sends every time.                               |
| `voice`           | `false`    | Also place a voice call to recipients who opted into voice. Reserve it for waking people up. |

When the problem is fixed, clear the key so the next occurrence pages straight away instead of
waiting out an old cooldown:

```bash
curl -X DELETE "https://app.infrawrench.com/api/org/$ORG/pages?source=checkout-api&key=5xx-rate" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

![Settings > Notifications with the Pages trigger enabled on a Slack channel and a mobile device, showing where a pushed page lands](https://agent-assets.infrawrench.com/docs-screenshots/features/server-push/pages-routing-rule.png)

## Report cost rows

`POST /costs/rows` reports spend Infrawrench has no integration for, such as a parsed SaaS
invoice, an internal chargeback, or a colo bill. The rows show up in
[cost graphs](./cloud-costs.md), dimension filters and budgets just like provider costs do.

```bash
curl -X POST https://app.infrawrench.com/api/org/$ORG/costs/rows \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  -H "content-type: application/json" \
  -d '{
        "source": "snowflake-invoices",
        "rows": [
          { "date": "2026-07-26", "currency": "USD", "amount": 412.55,
            "service": "Snowflake Compute", "tags": { "team": "data" } },
          { "date": "2026-07-26", "currency": "USD", "amount": 38.10,
            "service": "Snowflake Storage" }
        ]
      }'
```

Each row is one day of spend for one combination of dimensions. `date`, `currency` and `amount`
are required. `service`, `region`, `resourceId`, `tags`, `usageAmount` and `usageUnit` are the
dimensions you can group and filter by. `amount` can be negative for a credit.

If your spend comes as a file (a CSV or a FOCUS export) rather than from code, a
[custom cost source](./custom-cost-sources.md) is usually a better fit. It's its own named
provider, keeps an upload history, and lets you delete or replace an upload.

Rows appear under the provider **External**. In the account dimension they show as
"&lt;source&gt; (external)", unless you assign them to one of your accounts with `accountId`.

### Pushing the same day again replaces it

Rows are matched on `(source, day, service, region, resourceId, tags, currency)`. Pushing a day
again **replaces** those rows instead of adding to them. So a nightly job can safely re-push the
last few days to pick up late invoice lines.

Rows you push can never overwrite costs Infrawrench collected from a provider, even when you
assign them to a real account, and two sources can never overwrite each other.

The whole batch is checked before anything is saved. A `400` means nothing was written, and the
message names the row with the problem:

```json
{ "error": "costs/rows: row 3 has an invalid currency \"dollars\" (expected a 3-letter ISO code)." }
```

Limits: 5,000 rows per call, 32 tags per row, 256 characters per field. Tag keys starting with
`infrawrench:` are reserved and rejected.

## Use the CLI

The [`infrawrench` CLI](./cli.md) does both, which is often the quickest option on a server that
already has it installed:

```bash
# Page, honouring the same cooldown as the API
infrawrench page "backup did not complete" --source backups --key nightly

# Recovered: re-arm the key
infrawrench page clear --source backups --key nightly

# Push cost rows from a file, or from a pipeline
infrawrench costs push --source colo --file rows.json
parse-invoice --json | infrawrench costs push --source colo
```

Both accept `--json` for scripting, and both use your existing CLI sign-in rather than a separate
key.

## Use a workflow instead

If what you're checking is reachable from Infrawrench (a cloud API, a database, an SSH host), a
[workflow](./workflows.md) is usually less work than running your own server. It has
`infra.page(...)` and `infra.costs.write(...)` built in, runs on a schedule you set in the app,
and needs no key. These endpoints are for code that runs where Infrawrench can't reach.
