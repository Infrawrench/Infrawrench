---
title: Credit burndown
description: See prepaid balances with a measured burn rate and a runway, like "$42 left, six days at your current spend", for providers that expose a credit balance.
sidebar_order: 13
---

Most providers bill you after the fact. A few work the other way: prepaid AI inference, trial grants and committed-spend balances. There's a pot of credit, and when it runs out the API stops answering.

So an empty balance means an **outage**, not a bill. Credit burndown shows each balance with how fast you're spending it and how long it will last: not just "$42 left", but "$42, six days left at your current spend".

![The Credit burndown section on the Costs panel showing three balances: one red at "4d", one amber at "3w", and one grey at "5mo", each with its remaining amount and burn per day](https://agent-assets.infrawrench.com/docs-screenshots/features/credit-burndown/three-balances.png)

Open the Costs panel, go to the **Commitments & credits** tab and find the **Credit burndown** section.

## Supported providers

Only providers that expose a balance appear here:

- **DeepSeek**
- **OpenRouter**
- **Deepgram**
- **xAI**
- **ClickHouse Cloud**
- **Snowflake** (contract capacity, rollover and free usage, when the role can read organization usage)
- **Crusoe Cloud**
- **Linode** (active promotions and account credit)
- **Oracle Cloud** (Universal Credits commitments)
- **Twilio** (account balance)
- **Elastic Cloud** (prepaid ECUs, one balance per order line with its expiry)
- **Anyscale** (one balance per credit grant and prepaid commit, with its expiry)

Each balance uses the name from the provider's console, such as "Credits" on OpenRouter, "Balance" on DeepSeek and Deepgram, and "Account balance" on Twilio.

### Credentials some providers need

Some balances need a stronger credential than the rest of the account:

- **OpenRouter:** a provisioning key.
- **Deepgram:** an admin or owner role.
- **Crusoe:** an organization admin or billing role.
- **Twilio:** the auth token or a Main API key, not a Standard key.

If a balance needs one of these, the section tells you and links to the page where you can create it.

## Reading a row

Infrawrench checks each balance about twice a day and works out the burn rate from those readings. Top-ups are counted separately, so adding credit never makes it look like you're spending less. If a top-up happened in the window, the row says so.

You may also see:

- **Not enough history:** there are fewer than three days of readings, which is too little for a reliable rate.
- **No spend observed:** nothing has been drawn from this balance.
- **Limited by the credit's own expiry:** the credit expires before it would run out at your current spend. The runway is whichever comes first, running out or expiring.

Runways are rounded more as they get longer: days, then weeks, then months.

Rows are sorted by urgency, then by days remaining. Red means less than a week, amber means less than a month. The balance closest to running out is always at the top.

## Multiple balances

If a provider splits credit by currency or by project, each one gets its own row. Balances are never added together, so you can see when one project is running dry while another still has room.

## From the CLI

```
infrawrench credits
infrawrench credits --json
```

This is a good one for a morning check. Add `--json` to whatever monitoring you already run and you'll find out before your inference calls start returning 402.

## Permissions

You need `costs:read` to see the burndown.

## For plugin authors

To show a balance from your plugin, declare `credits` on its manifest and implement `fetchCreditBalance` on its client to return the balances. Infrawrench handles the schedule and works out the burn rate and runway. If the credential can't see the balance, throw `CreditAccessError`, and users will see it as a permissions gap with your help link instead of an error.
