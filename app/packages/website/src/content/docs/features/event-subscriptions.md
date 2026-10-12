---
title: Event subscriptions
description: Send Infrawrench's own events as versioned JSON to a signed HTTPS webhook, an AWS EventBridge bus or a GCP Pub/Sub topic.
sidebar_order: 15
---

[Alert routing](./alert-routing.md) decides which **people** hear about something. Event subscriptions decide which **systems** get a copy: every cost anomaly, budget threshold, critical posture finding, leaked credential found or rotated, drift window, declared incident, just-in-time access change, SLO burn, metric alert and failing sync, as JSON with a versioned schema, delivered to your own receiver.

Use them to feed a SIEM, open tickets in a tool Infrawrench does not integrate with, trigger automation on an event bus, or keep an audit trail outside Infrawrench.

> **Cloud only.** Events are raised by the cloud's background poller and API, and delivered by the poller. You manage subscriptions from the web app, from the desktop app's Settings tab while signed in to your organization, from [Terraform](./terraform-provider.md) (`infrawrench_event_subscription`), or read them from the [CLI](./cli.md) and the mobile app.

## Adding a subscription

Open **Settings → Notifications → Event subscriptions** and choose **Add subscription**. You need the `org:settings:write` permission.

<insert [Settings > Notifications > Event subscriptions tab with two subscriptions listed: one webhook (On, secret hint shown) and one EventBridge destination, with the Add subscription button above] here>

1. **Name** it.
2. Pick a **destination**:
   - **HTTPS webhook**: paste an `https://` URL. Hosts in private or internal address space are refused, and redirects are never followed.
   - **Event bus or topic in a connected account**: pick an AWS EventBridge rule or a GCP Pub/Sub topic from the accounts you have already connected. Nothing to type: the list comes from your synced inventory, so a topic created a minute ago appears after the next sync.
3. Choose the **events**: every event (including types added later), or specific ones.
4. Optionally narrow it with a **minimum severity**, **accounts** and **environments**.
5. Save. For a webhook, the **signing secret is shown once**. Copy it into your receiver now.

<insert [The one-time signing secret panel after creating a webhook subscription, with the Copy button and the "How to verify a request" section expanded] here>

### Filters

| Filter           | Matches                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Events           | Any of the ticked event types. Leaving "every event" on also receives types added in future releases.                  |
| Minimum severity | `info`, `warning` or `critical` and above.                                                                             |
| Accounts         | Events about one of the ticked accounts.                                                                               |
| Environments     | Events whose resource carries one of the values in an `env`, `environment` or `stage` tag or label (case-insensitive). |

An empty filter does not filter. A filter that is set **never matches an event that lacks the fact**: a subscription limited to the production account does not receive a drift window spanning three accounts, or a declared incident, which names no single account.

Cost events (`cost.anomaly.detected`, `budget.threshold.crossed`) carry spend, so subscribing to them, or to every event, also needs the `costs:read` permission. Budgets visible only to their owner never emit events.

## The event catalog

| Event type                 | When                                                                              | Default severity                                                      |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `cost.anomaly.detected`    | A [cost anomaly](./cost-anomaly-alerts.md) or a new source of spend is found      | warning                                                               |
| `budget.threshold.crossed` | A budget's actual or forecast crosses a threshold                                 | warning; critical at 100% or more                                     |
| `posture.finding.detected` | A critical or high [posture finding](./posture-checks.md) appears (once each)     | critical for critical, else warning                                   |
| `secret.leaked`            | A secret scanner finds a [leaked credential](./leaked-credentials.md) (once each) | critical; warning when the token is reported dead and matches nothing |
| `secret.rotated`           | A leaked credential is rotated, or its stored value is seen to change             | info                                                                  |
| `drift.detected`           | A [drift window](./change-timeline.md) has changes                                | info                                                                  |
| `incident.declared`        | Someone [declares an incident](./incident-mode.md)                                | critical for sev1/sev2, else warning                                  |
| `incident.mitigated`       | A declared incident is marked mitigated                                           | as declared                                                           |
| `incident.resolved`        | A declared incident is resolved                                                   | info                                                                  |
| `jit_access.requested`     | A member asks for [just-in-time access](./just-in-time-access.md)                 | info                                                                  |
| `jit_access.approved`      | An approver approves a request                                                    | warning                                                               |
| `jit_access.denied`        | An approver denies a request                                                      | info                                                                  |
| `jit_access.expired`       | A granted role reaches the end of its window and is removed                       | info                                                                  |
| `slo.burn_alert`           | An [SLO](./slos.md) starts or stops burning, or exhausts its budget               | critical for fast burn and exhausted                                  |
| `metric_alert.fired`       | A [metric alert](./metric-alerts.md) starts firing                                | warning                                                               |
| `metric_alert.resolved`    | A firing metric alert recovers                                                    | info                                                                  |
| `account.sync.failing`     | An account's sync keeps failing past your paging threshold                        | warning                                                               |
| `account.sync.recovered`   | A failing sync that was announced succeeds again                                  | info                                                                  |

Posture findings ride the daily posture scan, so they need posture alerts turned on under **Notifications → Alerts & digest**; sync failures follow the paging threshold set under **SMS & voice**.

Leak events come from the 30-minute secret scan and are raised whether or not any routing rule took the alert. Both carry the leak id, the token type and its owning plugin, and what it matched (`matchKind`, `matchedAccountId`, `matchedResourceId`); `secret.leaked` adds the scanner, the match confidence, the repository, file and finding URL, the scanner's validity check and whether it was also found in public, and `secret.rotated` adds how it was rotated (`reissued`, `replaced`, `detected` or `manual`), who did it, and whether the finding was closed on the scanner. Neither ever includes the secret or its masked hint.

The full schema of every event's `data` is in the [API reference](../team-and-billing/openapi.md) under **Webhooks**, and the live catalog with JSON Schemas is at `GET /api/org/{orgId}/event-subscriptions/catalog`.

## The envelope

Every destination receives the same JSON object:

```json
{
  "id": "evt_5f0c2a1e9b7d4c3a8e6f1b2d3c4a5e6f",
  "type": "budget.threshold.crossed",
  "version": 1,
  "createdAt": "2026-10-12T09:14:03.120Z",
  "organizationId": "org_example",
  "severity": "critical",
  "accountId": null,
  "environment": null,
  "title": "Budget \"Platform\" at 100%",
  "url": "https://app.infrawrench.com/org/org_example/budgets/b_example",
  "test": false,
  "data": {
    "budgetId": "b_example",
    "budgetName": "Platform",
    "periodKey": "2026-10",
    "periodStart": null,
    "periodEnd": null,
    "thresholdType": "actual",
    "thresholdPercent": 100,
    "measure": "spend",
    "observed": 1250000,
    "limit": 1200000,
    "currency": "USD"
  }
}
```

- **`id` is stable** across retries and redeliveries. Delivery is at-least-once, so dedupe on it.
- **`version`** is the schema version of `data` for that `type`. New fields can appear in the same version; a removed, renamed or retyped field means a new version number.
- Ordering is not guaranteed between events.

## Verifying webhook signatures

Each webhook request is a `POST` with these headers:

| Header                    | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `Infrawrench-Signature`   | `t=<unix seconds>,v1=<hex HMAC-SHA256>`, sometimes with a second `v1=` |
| `Infrawrench-Event-Id`    | The envelope's `id`                                                    |
| `Infrawrench-Event-Type`  | The envelope's `type`                                                  |
| `Infrawrench-Delivery-Id` | This delivery attempt's log id                                         |

Each `v1` value is HMAC-SHA256 of the string `<t>.<raw request body>`, keyed with your signing secret. Verify against the **raw** body before parsing it, reject timestamps more than five minutes old, and accept the request if **any** `v1` matches:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received, before JSON.parse.
export function verifyInfrawrench(rawBody, header, secret) {
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
```

```python
import hashlib, hmac, time

def verify_infrawrench(raw_body: bytes, header: str, secret: str) -> bool:
    parts = [p.split("=", 1) for p in header.split(",")]
    t = next((v for k, v in parts if k == "t"), None)
    sigs = [v for k, v in parts if k == "v1"]
    if not t or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)
```

### Rerolling the secret

**Reroll secret** shows a new secret once. The previous one keeps signing for 24 hours, so for that day every request carries two `v1` values and a receiver holding either secret accepts it. Update your receiver, and the old secret stops on its own. In Terraform, change `secret_version`.

## EventBridge and Pub/Sub

Publish destinations are not signed: delivery goes through the connected account's own credentials, and the cloud provider authenticates it.

- **AWS EventBridge**: each event is a `PutEvents` entry on the picked rule's event bus with `Source` `infrawrench`, `DetailType` the event type (for example `incident.declared`) and the envelope as `Detail`. Match it with an event pattern such as `{"source": ["infrawrench"], "detail-type": ["incident.declared"]}`. The account needs `events:PutEvents` on that bus.
- **GCP Pub/Sub**: each event is one message whose data is the envelope, with attributes `eventType`, `eventVersion`, `eventId` and `source`, so subscriptions can filter on `attributes.eventType`. The account needs `pubsub.topics.publish` on the topic.

## Delivery, retries and the log

Events are queued the moment they happen and sent by the background poller, usually within a minute. A webhook must answer **2xx within 10 seconds**; anything else (including a redirect) is a failure. Failures retry after 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours and 12 hours, eight attempts over about a day and a half, then the delivery is marked failed.

**Deliveries** on each subscription shows the last 30 days: state, attempts, the receiver's status code and the first kilobyte of its reply, and the envelope as sent. **Redeliver** queues a fresh copy of any delivery with the same event `id`.

<insert [The Deliveries panel of a webhook subscription showing one Delivered row, one Retrying row with its next attempt time, and one expanded Failed row with its attempts and the JSON envelope] here>

**Send test event** sends an `infrawrench.test` event right away and shows what the receiver answered. Tests are tried once, are never retried, and do not count toward health. They work on a subscription that is turned off, so you can check a fix before turning it back on.

### Automatic turn-off

When a subscription's deliveries have failed **for three days without a single success, across at least 20 attempts**, Infrawrench turns it off and emails the organization's owners and admins. Its queued deliveries are skipped, and events raised while it is off are not queued for it. Turn it back on from the same page (or let Terraform's next apply do it); that clears its failure history.

## Permissions and audit

Creating, editing, testing, rerolling and deleting subscriptions, and reading the delivery log, need `org:settings:write`; receiving cost events also needs `costs:read`. Every change is recorded in the [audit log](../team-and-billing/audit-log.md).
