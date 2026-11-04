---
title: Managed accounts & invoices
description: Bill customers for the infrastructure you run for them, with customers scoped to cost centres, invoices that lock when you approve them, and a full breakdown you can hand to accounts payable.
sidebar_order: 11
---

If you run infrastructure for other people, sooner or later you have to bill them for it. [Cost centres](./tag-policy-and-showback.md) decide whose spend is whose, [billing rules](./billing-rules.md) add your markup, and showback adds it up. Managed accounts add the customer and the invoice.

A **managed account** is a customer. An **invoice** is what you send them.

## Customers are built from cost centres

This is the most important thing to understand about the feature.

A managed account is a list of **cost centres**. It has no tag matching or rules of its own. Which spend lands in which cost centre is already decided by your [allocation rules](./tag-policy-and-showback.md#allocation-rules).

So an invoice line for a cost centre is **the same number** the showback report gives for that centre and period. If you can explain the showback report, you can explain the invoice.

Two things follow from this:

- **A parent bills everything under it.** Choosing _Engineering_ also bills _Engineering > Platform > Search_. Choosing both a parent and its child bills the child once, not twice.
- **A cost centre belongs to only one customer.** So does a cloud account. Giving the same centre to a second customer is refused, with an error naming the first one.

If a customer has their own cloud account, you can choose the **account** instead. An account only bills spend that no cost centre has already claimed, so every cost is billed exactly once.

![The Invoices tab's Customers section, showing two managed accounts with their billing currency and the cost centres in each one's scope](https://agent-assets.infrawrench.com/docs-screenshots/features/managed-accounts/customers-section.png)

## Set up a customer

1. Open **Invoices** in the sidebar.
2. Click **New customer**.
3. Enter a name, contact details and a **billing currency**.
4. Tick the cost centres, and any cloud accounts, whose spend is theirs.
5. Choose the **cost basis** and whether your **billing rules** apply.
6. Optionally pick a [billing profile](#billing-profiles) for tax, terms, bank details and numbering.

![The New customer modal with the cost-centre picker showing an indented tree and two centres ticked](https://agent-assets.infrawrench.com/docs-screenshots/features/managed-accounts/new-customer-modal.png)

### Cost basis

Choose **cash**, **amortized** or **blended**. **Blended** spreads each shared commitment's discount evenly across all the usage it could cover, so a customer isn't billed more or less depending on which account the provider applied your commitment to. The default is **amortized**, which suits most managed services: charging a customer the full cash cost of a three-year reservation in the month you bought it isn't a bill anyone can budget for. Use cash if your contract says so.

### Billing rules on or off

On by default, since markup is what [billing rules](./billing-rules.md) are for. Turn it **off** for a pass-through contract, where the customer pays exactly what the providers charged.

Fixed-amount rules appear as their own invoice lines rather than being folded into a cost centre's spend, so a management fee shows clearly as a fee.

[Tiered and expression rules](./billing-rules.md#rules-that-price-customer-invoices) only apply to customer invoices, and can be limited to particular customers.

## Price a customer

The **Pricing** section of the customer editor controls how this customer's usage is priced beyond your billing rules. Like every rule, it only applies to invoices and **never changes your collected spend**. Every line still shows what the providers charged next to what the customer is billed.

<insert [The customer editor's Pricing section with "Re-rate usage to the providers' public on-demand list prices" ticked, a 5% fallback uplift and one per-service uplift, discounts set to Retain and credits to Pass through partly at 50%, and the preview's re-rating coverage bar underneath] here>

### Re-rating to public pricing

Tick **Re-rate usage to the providers' public on-demand list prices** to bill this customer at list price instead of what you actually paid. Resellers with negotiated rates usually bill this way.

A list price is only used where the provider reports one:

| Provider                          | Where the list price comes from                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Cloud                      | The billing export's `cost_at_list` column (populated from 29 June 2023)                                                                                                          |
| AWS                               | On-demand usage lines: negotiated discounts arrive as separate discount lines, so the usage line itself is at the public rate. Spot usage is re-rated at the Spot price it ran at |
| Providers priced from a rate card | Their amounts are list prices already                                                                                                                                             |

Everything else (Azure, reservation-covered usage on AWS, any provider without a list price) uses **collected plus an uplift %**. Set a default uplift and override it per provider or per service. The most specific one wins. You can limit re-rating to particular providers or services, or leave the list empty for all of them.

Only usage lines are re-rated. Credits, taxes, discounts and commitment purchases follow the next setting. Every invoice shows the **coverage**: how much of the usage was priced from a list price and how much used the uplift, overall and per service.

### Discounts, credits and commitment benefits

For each customer, choose what happens to three kinds of provider benefit: **pass through** (the customer gets all of it, the default), **retain** (you keep it), or **pass through partly** (the customer gets a percentage).

- **Provider discounts:** enterprise agreement, private pricing and bundled discounts, and Savings Plan negation lines.
- **Credits:** promotional and negotiated credits.
- **Commitment benefits:** the difference between list price and the reservation or Savings Plan rate on covered usage. This can only be measured where the provider reports a list price. Elsewhere it passes through and the invoice says so. A line already re-rated to list price has no benefit left to keep.

**Preview against that month** prices a month of this customer's spend with the settings on screen, before you save.

## See which rule changed what

Every invoice line lists the steps that changed it, in order: re-rating, discount treatment and each billing rule, with how much each added or removed. Click the ▸ next to a line to expand it. Below the lines, **How this total was reached** lists every rule and setting with its total effect, the re-rating coverage, and anything that couldn't be priced. On an approved invoice, all of this is locked with the figures.

## Billing profiles

A **billing profile** covers everything on an invoice that isn't a number: who it's addressed to, who it's emailed to, tax, when it's due, where to pay, and how it's numbered. Several customers can share one. A parent company with a managed account per business unit, or every customer you bill from the same entity on the same terms, becomes one profile to keep up to date instead of a dozen.

Open **Invoices > Billing profiles > New profile**. A profile has:

| Section                     | Fields                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Bill to**                 | Legal entity name, address, tax ID or VAT number, PO number                                                                    |
| **Recipients**              | **To** and **Cc** addresses                                                                                                    |
| **Currency, terms and tax** | Invoice currency, payment terms in days (net 30 prints a due date 30 days after the issue date), and up to five tax rates      |
| **Bank details**            | Account name, bank, IBAN, SWIFT/BIC, account and routing number for banks without IBANs, and free-text remittance instructions |
| **Numbering and layout**    | Number prefix, whether the number includes the year, the first number, a footer, and a logo (PNG or JPEG, up to 100 KB)        |

<insert [The billing profile editor with a legal name, a VAT number, one To address, net 30 terms, a 19% VAT line, an IBAN and a logo filled in, and the "Numbers look like EU-2026-0100" hint under the numbering fields] here>

Assign it to a customer with the **Billing profile** picker in the customer editor.

### Profile fields override customer fields

Leave a profile field blank and each customer's own details are used: no legal name on the profile means each customer's name appears, no address means each customer's billing address, no currency means each customer's billing currency. Fill a field in and it applies to every customer on the profile.

Recipients are the exception: they **add up**. The customer's own contact email still gets every invoice, and the profile's **To** addresses are added. **Cc** addresses get their own copy too.

When a profile sets a **currency**, its customers' invoices are issued in that currency instead of the customer's billing currency, converted at your [exchange rates](./cloud-costs.md#currency).

### Tax lines

Each tax rate becomes its own line at the bottom of the invoice, charged on the **converted subtotal** of all other lines and rounded to the currency's smallest unit (cents, pence, or nothing for yen). Two rates are each charged on the same subtotal. Taxes don't compound. A tax line has nothing collected, so `collected + adjustment = subtotal` still holds.

### Numbering

Invoice numbers follow the profile: `INV-2026-0001` by default, `EU-2026-0001` with the prefix `EU`, or `EU-0001` without the year. **First number** lets you continue a sequence from your previous system, so your first invoice here can be `EU-2026-0100`. Profiles with the same prefix share a sequence. Customers without a profile use `INV-YYYY-NNNN`.

### Approved invoices keep their profile

A draft follows its profile, so if you change the bank details, every draft shows the new ones. **Approving copies the profile onto the invoice** along with the figures, so later edits to a profile (a new bank account, tax rate or logo) only affect future invoices, never one a customer already has.

Organizations that had customers before billing profiles existed got one profile called **Default**, with all their customers assigned and every field blank. Nothing changed on their next invoice. It's there so you have one place to add tax, terms and bank details for everyone at once.

You can't delete a profile while customers are assigned to it. The error names them. Move them to another profile first.

## Raise an invoice

Click **Raise invoice** on a customer and pick the period (last calendar month by default). You get a **draft**.

A draft's figures are **recalculated from live spend every time you open it**. Cost data keeps changing for days after a month ends, so this keeps the draft current while you're still deciding what to bill.

![A draft invoice's detail view, with the "these figures are recomputed" notice above the line table](https://agent-assets.infrawrench.com/docs-screenshots/features/managed-accounts/draft-invoice.png)

## Approving locks the numbers

When you approve an invoice, Infrawrench calculates the figures one last time and locks them onto the invoice: the lines, totals, exchange rates _and the date those rates were read_, the billing rules in force, and the names of everything included.

After that, nothing changes. A provider revising January's bill in March, a corrected exchange rate, an edited billing rule, a renamed cost centre or one moved to another customer: none of them can change an invoice you've already approved.

| Status       | Figures                      | What you can do                     |
| ------------ | ---------------------------- | ----------------------------------- |
| **Draft**    | Recalculated every time      | Edit the period, delete it, approve |
| **Approved** | Locked                       | Send, void                          |
| **Sent**     | Locked                       | Send again, void                    |
| **Void**     | Locked, and kept as a record | Nothing (raise a correction)        |

Approving, sending and voiding are **separate steps with separate audit entries**, each naming who did it.

Approval is refused if the invoice includes spend in a currency you haven't set an exchange rate for, since an approved invoice must be one total in the customer's currency. Add the rate under [Settings > Currency](./cloud-costs.md#currency) and approve again.

It's also refused (and nothing is approved) if someone changed the draft or its customer while the figures were being calculated: a different period, scope, billing currency, cost basis or billing rules setting. Reopen the draft, check what it says now, and approve again.

## Void, never delete

An issued invoice can never be edited or deleted. If it's wrong, **void** it with a reason and raise a **corrective** invoice. Both are kept and linked to each other, so the customer sees "we billed you this, it was wrong, here's the corrected one".

Tick **Raise a corrective draft** when you void to do both in one step. Either both happen or neither does, so you're never left with a void invoice and no draft.

Each void gets one correction. If a corrective invoice already exists, you can't raise a second one.

![The Void modal with a reason typed in and "Raise a corrective draft for the same period" ticked](https://agent-assets.infrawrench.com/docs-screenshots/features/managed-accounts/void-modal.png)

## Every invoice shows how it was worked out

A customer who can't reconcile an invoice won't pay it, so every line shows the full chain:

| Column         | What it is                                                    |
| -------------- | ------------------------------------------------------------- |
| **Collected**  | What the providers charged, before any rule of yours          |
| **Adjustment** | What your billing rules and pricing settings added or removed |
| **Subtotal**   | Collected + adjustment                                        |
| **Rate**       | The exchange rate applied, and `-` when none was needed       |
| **Invoiced**   | The subtotal in the customer's currency                       |

`collected + adjustment = subtotal` holds on every line and every total. Below, the invoice lists which cost centres were included, which billing rules applied and what each does, the exchange rates used, and **the date those rates were read**. That's always the last day of the period, so "January, at the 31 January rate" is something you can reproduce.

![An approved invoice showing the line table with Collected, Adjustment, Subtotal, Rate and Invoiced columns, and the "How this total was reached" block underneath](https://agent-assets.infrawrench.com/docs-screenshots/features/managed-accounts/approved-invoice.png)

### Download it

**Download PDF** gives you the document a customer files: your logo, the addressee from the billing profile, the lines, the subtotal, each tax line, the total due, issue and due dates, the PO number, and the bank details, with the profile's footer on every page. It shows the price, not the breakdown. The collected versus adjusted split is in the CSV. A draft's PDF says **Draft invoice** across the top.

<insert [A downloaded invoice PDF showing a logo top left, "INVOICE" and its number top right, the Bill to block with a VAT number, the dates and PO number, two lines, a subtotal, a VAT line, the total due, and the payment section with an IBAN] here>

**Download CSV** gives you the breakdown as a file: every column above, the totals, and the addressee, tax ID, PO number, issue date, due date and payment terms on every row. It uses the same RFC 4180 quoting as [scheduled cost exports](./cost-exports.md), so customers who already import those need nothing new.

Both downloads work in the web and desktop apps.

## Send it to the customer

**Send** on an approved invoice does two things, recorded separately:

- it records the **release**: this invoice may go to the customer, and this person said so;
- it **emails the invoice** to the customer's contact addresses and the billing profile's **To** and **Cc** addresses, with the PDF and CSV attached.

Recipients are locked in at approval, so an address added to the profile later won't get an invoice approved before that.

The CSV is attached rather than linked, so it still opens months later.

The customer's contact email can hold **several addresses**, separated by commas or semicolons (an AP mailbox and a named contact, for example). Each gets its own copy, so nobody sees anyone else's address.

Sending needs a mail provider configured on your deployment (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `EMAIL_FROM`). Without one, sending still records the release and shows a failed delivery explaining why.

### When delivery fails

Delivery status appears next to the invoice status: which addresses were tried, how many the mail provider accepted, and the error if it failed. A failed send is **visible and can be sent again**. It never just reads "Sent".

Sending again depends on **whether anything arrived**:

| Last attempt                            | Sending again is…                         |
| --------------------------------------- | ----------------------------------------- |
| Reached nobody (failed, no recipients)  | a **retry**: one click, no confirmation   |
| Reached somebody (delivered, or partly) | **Send again**: asks you to confirm first |
| Interrupted, outcome unknown            | **Send again**: asks you to confirm first |

A partial delivery is never retried automatically, since that would send a second copy to people who already have it. Fix the failing address and use **Send again** if the customer needs another copy.

Sending again never changes who released the invoice or any figure.

![A sent invoice's detail view showing a red "Delivery failed" line with the recipient addresses and the transport's error, and a "Retry delivery" button](https://agent-assets.infrawrench.com/docs-screenshots/features/managed-accounts/delivery-failed.png)

## Assign cost centres and accounts in bulk

Adding a dozen new accounts to an existing customer, or splitting one customer into two, is one action. Open **Invoices > Assign in bulk**:

1. Pick the customer to assign to, or **No customer (unassign)**.
2. Tick the cost centres and cloud accounts. Each shows which customer has it now. The filter box narrows both lists.
3. Check the preview, then click **Assign**.

The preview prices the move over a period (the last full month by default; change the dates to see another). For each item it shows who bills it now and the spend that moves with it: a cost centre's spend **including everything under it**, and an account's spend **that no cost centre already claims**. Below that, it shows how much leaves each customer, how many draft invoices will change, and warns you if a cost centre sits under another customer's centre (its spend would be billed to both).

<insert [The Assign cost centres and accounts modal with "Contoso" chosen as the target, three accounts ticked (one currently on "Northwind"), and the preview listing each item's spend, "£1,240.00 moves from Northwind to Contoso" and "2 draft invoices will change"] here>

Everything moves at once, and each item is taken off its old customer as it's given to the new one, so the same money never ends up on two customers. Only drafts change. Approved invoices keep their own copy of what they cover, so moving an account can't re-bill a period you've already invoiced.

## Find spend nobody is billed for

**Invoices > Unassigned spend** lists the period's spend, by cost centre and by cloud account, that no customer is billed for: the account connected last week and never added to a customer, or the new cost centre nobody added to a contract. It's raw, amortized spend, before your billing rules.

Rows are worked out the same way as invoices: your allocation rules assign spend to cost centres first, and each account row is only the spend no rule claimed. A cost centre counts as assigned when it or any of its parents is on a customer. So assigning a row moves exactly the amount it shows.

Pick a customer in a row's **Assign to…** box to open the preview with that row selected, or tick several rows and use **Assign selected**. A row reading **Not attributable to a connected account** is spend from an account that's since been removed, or uploaded costs with no account, and can't be assigned to a customer.

<insert [The Unassigned spend view for last month showing "£3,410.00 unassigned, of £48,200.00 in total", a table of four rows (two cloud accounts, a cost centre and one "Not attributable to a connected account" row) with checkboxes and an "Assign to…" picker on each] here>

When last month has unassigned spend, a banner above your customers says how much and across how many cost centres and accounts, with a **Review** button.

## Permissions

Invoices have their own permissions, separate from `costs:*`, because they hold customers' contact details and the prices you quoted them.

| Permission       | Covers                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `invoices:read`  | Customers, invoices, line items, the CSV and PDF, billing profiles                                             |
| `invoices:write` | Add a customer, raise a draft, edit a period, delete a draft, create and edit billing profiles, assign in bulk |
| `invoices:issue` | Approve, send, void                                                                                            |

**Unassigned spend** and the bulk assignment preview also need `costs:read`, since they show your whole organization's spend. None of this is available to members with [scoped cost visibility](../team-and-billing/cost-visibility.md).

Every billing profile change is recorded in the [audit log](../team-and-billing/audit-log.md) field by field, with IBANs and account numbers cut to their last four characters, remittance instructions shown as "(set)", and the logo as whether there is one. A bulk assignment logs one entry listing every customer whose scope changed, before and after, plus an entry on each customer.

The split between `invoices:write` and `invoices:issue` is worth using. Anything under `write` can be undone. `issue` can't: approving locks what a customer will be sent, and sending puts it in their inbox. A billing clerk can have `read` and `write` and prepare the month, while only the finance lead has `issue`.

Members get none of the three by default. Admins and owners get all three. Give a custom role the first two if you want someone preparing invoices without being able to issue them. See [Roles & permissions](../team-and-billing/roles-and-permissions.md).

## Use the CLI

```
infrawrench invoices                      # every invoice, newest period first
infrawrench invoices customers            # the managed accounts themselves
infrawrench invoices INV-2026-0004        # one invoice, with its full derivation
infrawrench invoices northwind --json     # by customer name, as JSON
infrawrench invoices profiles             # billing profiles and how many customers use each
infrawrench invoices profiles "EU"        # one profile in full (account numbers masked)
infrawrench invoices unassigned           # last month's spend no customer is billed for
infrawrench invoices unassigned --from 2026-01-01 --to 2026-03-31 --json
```

`invoices profiles <name>` shows only the last four characters of IBANs and account numbers. `--json` includes them in full for scripts that need them. `invoices unassigned --json` includes `assignable`, the number of rows that could be assigned to a customer, so a scheduled job can fail when it isn't zero.

The CLI is read-only. Approving and sending happen in the app. `infrawrench invoices INV-2026-0004` shows the delivery outcome, so a reconciliation script can tell "we released it" from "it arrived". It's also handy for printing an invoice's breakdown next to `infrawrench showback` for the same period.

The list doesn't calculate draft totals (it shows `not computed`, never `0.00`). Ask for the invoice by name or number to see them.

See the [CLI reference](./cli.md).

## Use it from an AI agent

The [MCP server and AI chat](./mcp.md) offer `list_managed_accounts`, `get_managed_account`, `list_invoices`, `get_invoice`, `list_billing_profiles` (account numbers masked, no logo) and `find_unassigned_spend` (which also needs `costs:read`). All are read-only and need `invoices:read`. A model can't approve an invoice.

`get_invoice` returns the full breakdown, so the model can answer "why is this customer being billed this".

## API

- `GET /managed-accounts`, `GET /managed-accounts/{id}` (`invoices:read`)
- `POST /managed-accounts`, `PUT /managed-accounts/{id}`, `DELETE /managed-accounts/{id}` (`invoices:write`)
- `GET /managed-accounts/unassigned`, `POST /managed-accounts/assignments/preview` (`invoices:read` and `costs:read`)
- `POST /managed-accounts/assignments` (`invoices:write`)
- `GET /billing-profiles`, `GET /billing-profiles/{id}` (`invoices:read`)
- `POST /billing-profiles`, `PUT /billing-profiles/{id}`, `DELETE /billing-profiles/{id}` (`invoices:write`)
- `GET /invoices`, `GET /invoices/{id}`, `GET /invoices/{id}/export`, `GET /invoices/{id}/pdf` (`invoices:read`)
- `POST /invoices`, `PUT /invoices/{id}`, `DELETE /invoices/{id}` (`invoices:write`)
- `POST /invoices/{id}/approve`, `POST /invoices/{id}/send`, `POST /invoices/{id}/void` (`invoices:issue`)

`POST /invoices/{id}/send` returns **200 even when the email failed**, because the release happened either way. The `delivery` object in the response says what happened to the email. Pass `{"resend": true}` to send another copy of an invoice that already reached someone. A retry after a delivery that reached nobody needs no flag.

See the [OpenAPI reference](../team-and-billing/openapi.md).
