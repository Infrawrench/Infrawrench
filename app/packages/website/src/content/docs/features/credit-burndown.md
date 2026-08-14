---
title: Credit burndown
description: Prepaid balances with a measured burn rate and a runway — "$42 left, six days at your current spend" — for the providers that expose a credit balance.
sidebar_order: 13
---

Most providers bill in arrears. They send an invoice, you argue with it, life goes on. A few — prepaid AI inference, trial grants, committed-spend balances — work the other way: there is a pot, and when the pot empties the API stops answering.

That makes an empty credit balance an **outage**, not a bill. And a balance on its own is not actionable: "you have $42" tells you nothing. "$42, six days left at your current burn" is a decision.

![The Credit burndown section on the Costs panel showing three balances: one red at "4d", one amber at "3w", and one grey at "5mo", each with its remaining amount and burn per day](https://agent-assets.infrawrench.com/docs-screenshots/features/credit-burndown/three-balances.png)

Find it on the **Costs** panel, above the savings sections — those are about spending less, this is about not stopping.

## Which providers

Only the ones that expose a balance. At present: **DeepSeek**, **OpenRouter** and **Deepgram**. The section renders nothing at all if none of your accounts is on a credit-capable provider — a permanently empty card just teaches people to scroll past that part of the page.

Each provider's own word for the pot is used, because that is the word you will be looking for in their console: "Credits" on OpenRouter, "Balance" on DeepSeek and Deepgram.

Some balances need a stronger credential than the account otherwise does. OpenRouter's `/credits` endpoint wants a provisioning key, and Deepgram's balances are an admin-or-owner read. Where that is the case the section says so and links to the page where you make one, rather than reporting a generic failure — "your key can't see this" and "the provider is down" want completely different reactions.

## How the burn rate is measured

Infrawrench reads each balance about twice a day and keeps the series. The burn rate is derived from that series — not reported by the provider, most of whom have no such number.

The important detail is how top-ups are handled. A pot that went 500 → 300 → 900 → 700 over four readings has **burned 400 and been topped up by 600**. Subtracting the endpoints of that window gives −200: a negative burn and an infinite runway, which is the most dangerous possible wrong answer, delivered with confidence. So the burn is the sum of the _decreases_ between consecutive readings, and increases are counted as top-ups and shown separately. When a top-up happened inside the window, the row says so.

Below three days of readings there is no rate. Two readings a few hours apart across a quiet night extrapolate to a runway of years; two spanning a busy afternoon, to a runway of days. Neither is a rate, so the row reads **not enough history** rather than showing a number it cannot support.

A pot nothing has been drawn from reads **no spend observed**, not "infinite". That is a real observation about an idle account and should read as one.

## How the runway is bounded

Two things end a credit, and the earlier one wins:

- **The burn** — balance divided by spend per day.
- **The credit's own expiry**, where the provider sets one. A trial grant that lapses in nine days does not have a 200-day runway however slowly it is being spent, and a report that said otherwise would be wrong in exactly the case where the warning matters most.

When the expiry is the binding constraint the row says **limited by the credit's own expiry**.

Runways are shown coarsely as they grow — days, then weeks, then months. "213 days" implies a burn measured to a precision a 30-day window cannot support; "7 months" is the honest rendering of the same estimate.

Rows are sorted by urgency, then by days remaining: red inside a week, amber inside a month. The thing about to break is the first row — not the biggest balance, which is the sort a "credits" screen would naively pick and which buries exactly the account that needs attention.

## Multiple pots

Providers that split credit by currency or by project get a row each, and nothing is ever summed across them. "$40 and ¥300" is not a number, and one project running dry while another has headroom is precisely the situation this exists to surface.

## From the CLI

```
infrawrench credits
infrawrench credits --json
```

Worth putting in a morning check. This is the number that turns into an outage rather than an invoice, and `--json` in whatever you already run is how you find out before your inference calls start returning 402.

## Permissions

Reading the burndown needs `costs:read`. A prepaid balance is spend information, and the permission that already governs "what is this costing us" is the one that should govern "how much is left".

## For plugin authors

A plugin opts in by declaring `credits` on its manifest and implementing `fetchCreditBalance` on its client. It returns the pots; the host owns the schedule, the series, and every derived number. Throw `CreditAccessError` when the credential cannot see the balance, and the host will present it as a permission gap with your help link rather than as a failure.
