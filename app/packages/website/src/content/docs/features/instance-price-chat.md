---
title: Instance price chat
description: Ask about AWS, Azure, Google Cloud, Alibaba Cloud and RunPod instance types and prices in plain language on instances.infrawrench.com, and get tables and charts you can filter, share and get email alerts on.
---

The home page of [instances.infrawrench.com](https://instances.infrawrench.com) is a chat about cloud instance types and their prices. Ask a question in plain language, in any of the site's languages, and the answer comes from the same data as the rest of the site, in every region, with history:

- **AWS**: every published version of the AWS Price List for EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and GameLift, plus EC2 spot prices.
- **Azure**: Virtual Machines sizes, with pay-as-you-go, Spot and Low Priority prices, reservations and savings plans from the Azure Retail Prices API, from November 2026.
- **Google Cloud**: Compute Engine machine types, with Standard and Spot prices and committed use discounts from Google's Cloud Billing Catalog, from November 2026.
- **Alibaba Cloud**: ECS instance types, with pay-as-you-go, subscription and reserved instance prices from Alibaba Cloud's international price list, back to May 2018.
- **RunPod**: GPU types (priced per GPU) and CPU pods, in Secure Cloud and Community Cloud, with savings plans, from November 2026.
  It also knows every incident AWS has posted on its public Health Dashboard since 2008, so it can answer questions about outages too. No account is needed.

<insert [The instances.infrawrench.com home page: the "What do you want to know about Amazon EC2?" headline, the question box and the four suggestion cards] here>

Some things to ask:

- "What is the cheapest ARM instance with at least 8 GiB of memory in eu-west-1?"
- "Build me a table of current-generation x86_64 EC2 instances with their Linux on-demand price."
- "Show me a bar graph of Graviton instance costs running Linux."
- "How has the price of db.r6g.large changed since 2023?"
- "Compare a 3-year all-upfront reserved m7g.large with on demand."
- "How many EC2 incidents did AWS post for Dublin in 2023, and how long did they last?"
- "Build me a table of RunPod GPUs by price per GB of GPU memory."
- "Compare 4 vCPU, 16 GiB instances on AWS, Azure and Google Cloud in Virginia."

Every service and instance page also has an **Ask about** button beside its breadcrumb trail (for example **Ask about g4dn.xlarge**). It opens the chat with that name already in the question box, so you only have to finish the question.

Each conversation gets its own address (`/chat/…`), so the back button, reloading and coming back from an instance page all return to it. Conversations are kept in your browser only, so that address works on the device you asked on; to show someone a result, use a table's **Copy link** instead.

The assistant writes and runs SQL against the price data to answer, so every number comes from the provider's price list rather than from the model's memory. Only the five providers above are covered, and only their virtual machines and instances; ask about another cloud and it says so instead of guessing. When it compares providers, it matches the specs in the query, compares like with like (a 1-year AWS reservation against a 1-year Azure reservation or Google commitment, say, or EC2 spot against Azure and Google Spot) and points out that a RunPod GPU price is per GPU. AWS publishes no uptime figure, so for reliability questions it lists and totals the incidents AWS posted publicly, and says that issues AWS only reported to affected accounts are not among them. It tells you the assumptions it made, such as the region, operating system or pricing model; ask again with different ones if they are not what you meant. Instance types in answers link to their pages on the site.

## Tables and charts

When an answer is a list, it comes as an interactive table; when a graph reads better, as a bar or line chart. Under each one:

- **Tables** sort by any column (click its header), filter per column (text contains, or on numbers `>4`, `<=0.05` or a range such as `2..8`), search across every column, and let you pick which columns show.
- **SQL** shows the query behind it.
- **CSV** downloads the rows as currently filtered and sorted.
- **Copy link** copies a permanent link to the table or chart. The link opens it filling the window and re-runs the query, so it always shows current prices. Ask a follow-up in the box under it to start a new conversation that begins with that table.
- **Email if this changes** subscribes an email address to the table (see below).

<insert [A chat answer showing an interactive table of ARM EC2 instances, with the footer actions (SQL, CSV, Email if this changes, Copy link) visible] here>

## Email alerts

Ask something like "notify me if a new cheap ARM EC2 instance is available", or press **Email if this changes** under any table, and enter your address. You get a confirmation email first; nothing else is sent until you confirm. After that, every time a provider publishes a price list update, the table's query runs again, and if its results changed you get an email listing the rows that appeared and disappeared, with a link to the table. Every email has a link to stop them.

Alerts follow the table's exact query, so ask for the table that changes exactly when you want to hear about it: "current ARM EC2 types under $0.05 an hour, by name" alerts on new cheap types, while a table that includes prices also alerts on price changes.

## Limits

- Questions are limited to a few a minute from one address.
- The data is each provider's public list prices in USD (Alibaba Cloud's from its international site). It does not include your own discounts, AWS Savings Plans, or taxes; EC2 spot prices are Linux and Windows only, the lowest across each region's availability zones, and go back to August 2026. Google Cloud prices leave out bundled Local SSD, OS licenses and sustained use discounts, and Azure dedicated hosts are not included. RunPod's stock levels and spot prices are not included.
- Your questions are sent to Anthropic's Claude through Cloudflare's AI Gateway to write the answers, and are not stored. Shared links store only the table's title and query. See the [privacy policy](https://infrawrench.com/privacy#instances-chat).

The same data is available without the chat: browse it at [instances.infrawrench.com/aws](https://instances.infrawrench.com/aws), [/azure](https://instances.infrawrench.com/azure), [/gcp](https://instances.infrawrench.com/gcp), [/alibaba](https://instances.infrawrench.com/alibaba) and [/runpod](https://instances.infrawrench.com/runpod), query it yourself with the [instance pricing SQL API](../team-and-billing/instance-pricing-api.md) (the same tables the chat queries, so a chat answer's **SQL** runs there unchanged), ask an assistant connected to the [MCP server](./mcp.md) or the in-app chat to run it with `query_instance_pricing`, or download it with the [bulk instances API](../team-and-billing/bulk-instances-api.md).
