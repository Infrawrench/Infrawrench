---
title: Instance price chat
description: Ask about AWS instance types and prices in plain language on instances.infrawrench.com, and get tables and charts you can filter, share and get email alerts on.
---

The home page of [instances.infrawrench.com](https://instances.infrawrench.com) is a chat about AWS instance types and their prices. Ask a question in plain language, in any of the site's languages, and the answer comes from the same data as the rest of the site: every published version of the AWS Price List for EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and GameLift, plus EC2 spot prices, in every region, with history. No account is needed.

<insert [The instances.infrawrench.com home page: the "What do you want to know about Amazon EC2?" headline, the question box and the four suggestion cards] here>

Some things to ask:

- "What is the cheapest ARM instance with at least 8 GiB of memory in eu-west-1?"
- "Build me a table of current-generation x86_64 EC2 instances with their Linux on-demand price."
- "Show me a bar graph of Graviton instance costs running Linux."
- "How has the price of db.r6g.large changed since 2023?"
- "Compare a 3-year all-upfront reserved m7g.large with on demand."

Each conversation gets its own address (`/chat/…`), so the back button, reloading and coming back from an instance page all return to it. Conversations are kept in your browser only, so that address works on the device you asked on; to show someone a result, use a table's **Copy link** instead.

The assistant writes and runs SQL against the price data to answer, so every number comes from AWS's price list rather than from the model's memory. It tells you the assumptions it made, such as the region, operating system or pricing model; ask again with different ones if they are not what you meant. Instance types in answers link to their pages on the site.

## Tables and charts

When an answer is a list, it comes as an interactive table; when a graph reads better, as a bar or line chart. Under each one:

- **Tables** sort by any column (click its header), filter per column (text contains, or on numbers `>4`, `<=0.05` or a range such as `2..8`), search across every column, and let you pick which columns show.
- **SQL** shows the query behind it.
- **CSV** downloads the rows as currently filtered and sorted.
- **Copy link** copies a permanent link to the table or chart. The link re-runs the query, so it always shows current prices, and opens as a new conversation you can ask follow-ups in.
- **Email if this changes** subscribes an email address to the table (see below).

<insert [A chat answer showing an interactive table of ARM EC2 instances, with the footer actions (SQL, CSV, Email if this changes, Copy link) visible] here>

## Email alerts

Ask something like "notify me if a new cheap ARM EC2 instance is available", or press **Email if this changes** under any table, and enter your address. You get a confirmation email first; nothing else is sent until you confirm. After that, every time AWS publishes a price list update, the table's query runs again, and if its results changed you get an email listing the rows that appeared and disappeared, with a link to the table. Every email has a link to stop them.

Alerts follow the table's exact query, so ask for the table that changes exactly when you want to hear about it: "current ARM EC2 types under $0.05 an hour, by name" alerts on new cheap types, while a table that includes prices also alerts on price changes.

## Limits

- Questions are limited to a few a minute from one address.
- The data is AWS's public list prices in USD. It does not include your own discounts, Savings Plans, or taxes; spot prices are EC2 Linux and Windows only.
- Your questions are sent to Anthropic's Claude through Cloudflare's AI Gateway to write the answers, and are not stored. Shared links store only the table's title and query. See the [privacy policy](https://infrawrench.com/privacy#instances-chat).

The same data is available without the chat: browse it at [instances.infrawrench.com/aws](https://instances.infrawrench.com/aws), or download it with the [bulk instances API](../team-and-billing/bulk-instances-api.md).
