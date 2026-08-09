---
title: Push from your own servers
description: Raise on-call pages and report your own cost data over the HTTP API, from code running anywhere.
sidebar_order: 18
---

Most of what Infrawrench knows, it went and fetched. Two things it can't: an alert about something only your code can see, and spend that arrives as an invoice rather than a billing API.

Both have an endpoint that pushes **into** Infrawrench, so a health check, a deploy script, or a cron on a box can hand over what it knows and let the org's existing configuration decide what happens next.

| You want to                    | Endpoint                           | Permission    |
| ------------------------------ | ---------------------------------- | ------------- |
| Wake somebody up               | `POST /api/org/{orgId}/pages`      | `pages:write` |
| Clear a page's cooldown        | `DELETE /api/org/{orgId}/pages`    | `pages:write` |
| Report spend from your systems | `POST /api/org/{orgId}/costs/rows` | `costs:write` |

Both authenticate with an [API key](../team-and-billing/api-keys.md) (`Authorization: Bearer iwk_…`) scoped to just that permission — or with a signed-in session, which is what makes them testable from the browser. Neither is in a system role by default: mint a key with the scope, or add it to a custom role.

## Paging

`POST /pages` raises the same alert a [workflow](./workflows.md#paging-a-human) raises with `infra.page(...)`, and it reaches the same people: SMS (and optionally a voice call) through your org's Twilio credentials, [mobile push](./mobile-push-notifications.md), and any [Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channel opted into pages. Recipients configure themselves under **Settings → Notifications**; the caller doesn't hold a single transport credential.

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

`source` is your name for the system doing the paging. It becomes the notification's sender, and it scopes the throttle — two services paging under the key `disk-full` never silence each other.

### Repeat pages are suppressed, not rejected

A monitor re-finds the same problem on every tick. Calling this endpoint every minute would be 1,440 messages a day about one broken thing, so every page carries a **key**, and a page under a key that already fired is held quiet until its cooldown elapses — one hour by default.

That means you should **call it unconditionally** and read the response rather than tracking state yourself:

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

A suppressed page is a `200`. So is a page that reached nobody — but that one does **not** start a cooldown, so the next call tries again instead of going quiet after a failed delivery.

| Field             | Default    | What it does                                                                                 |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `source`          | _required_ | Names the system paging. Letters, digits, `.`, `_`, `-`; up to 64 characters.                |
| `message`         | _required_ | The alert text. Becomes the SMS body and the notification body.                              |
| `title`           | `source`   | Headline of the notification.                                                                |
| `key`             | `default`  | Throttle bucket. Use a per-object key (a host, a cluster) to alert per object.               |
| `cooldownMinutes` | `60`       | How long a key stays quiet after firing. `0` sends every time.                               |
| `voice`           | `false`    | Also place a voice call to recipients who opted into voice. Reserve it for waking people up. |

When the condition recovers, clear the key so the next occurrence pages immediately instead of waiting out a stale timer:

```bash
curl -X DELETE "https://app.infrawrench.com/api/org/$ORG/pages?source=checkout-api&key=5xx-rate" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

![Settings → Notifications with the Pages trigger enabled on a Slack channel and a mobile device, so a reader can see where a pushed page lands](https://agent-assets.infrawrench.com/docs/screenshots/features/server-push-pages.png)

## Cost rows

`POST /costs/rows` reports spend Infrawrench has no plugin for — a parsed SaaS invoice, an internal chargeback, a colo bill. The rows land in the same store the provider collectors write to, so they appear in [cost graphs](./cloud-costs.md), dimension filters, and budgets with no special-casing.

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

Each row is one day of spend for one combination of dimensions. `date`, `currency`, and `amount` are required; `service`, `region`, `resourceId`, `tags`, `usageAmount`, and `usageUnit` are the dimensions you can then group and filter by. `amount` may be negative for a credit.

Rows show up under the provider **External** and, unless you attribute them to one of your accounts with `accountId`, in the account dimension as "&lt;source&gt; (external)".

### Pushing the same day twice restates it

Writes are keyed by `(source, day, service, region, resourceId, tags, currency)`. Re-pushing a day **replaces** those rows rather than adding to them, so a nightly job can safely re-push a trailing window to absorb late-arriving invoice lines — the same restatement behaviour the provider collectors get.

Rows pushed under a source can never overwrite rows a collector wrote, even when you attribute them to a real account, and two sources can never overwrite each other.

The whole batch is validated before anything is stored, so a `400` means nothing was written and the message names the offending row:

```json
{ "error": "costs/rows: row 3 has an invalid currency \"dollars\" (expected a 3-letter ISO code)." }
```

Limits: 5,000 rows per call, 32 tags per row, 256 characters per field. Tag keys beginning `infrawrench:` are reserved and rejected — that namespace is what keeps sources from colliding.

## From the CLI

The [`infrawrench` CLI](./cli.md) wraps both, which is often the shortest path on a server that already has it installed:

```bash
# Page, honouring the same cooldown as the API
infrawrench page "backup did not complete" --source backups --key nightly

# Recovered — re-arm the key
infrawrench page clear --source backups --key nightly

# Push cost rows from a file, or from a pipeline
infrawrench costs push --source colo --file rows.json
parse-invoice --json | infrawrench costs push --source colo
```

Both accept `--json` for scripting, and both use the CLI's existing sign-in rather than a separate key.

## Doing this from a workflow instead

If the thing you're checking is reachable from Infrawrench — a cloud API, a database, an SSH host — a [workflow](./workflows.md) is usually less work than a server: it has `infra.page(...)` and `infra.costs.write(...)` built in, runs on a schedule you set in the UI, and needs no key to manage. These endpoints are for code that runs where Infrawrench doesn't.
