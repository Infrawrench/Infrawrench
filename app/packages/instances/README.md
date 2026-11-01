# instances.infrawrench.com

A chat about AWS instance prices on the home page, and one page per AWS instance type, for every platform the AWS bulk pricing data
covers (EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune,
MemoryDB, DAX, SageMaker, EMR and GameLift): specs, current prices in every
region, and the full history of both.

Built with [vinext](https://github.com/cloudflare/vinext) (the Next.js App
Router on Vite) and served by a Cloudflare Worker.

## Routes

| Path                                                               | What                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `/`                                                                | The chat: questions answered from the pricing warehouse as text, tables, charts   |
| `/aws`                                                             | Every AWS service, with its instance-type and family counts                       |
| `/v/<id>`                                                          | A table or chart shared from the chat, re-queried, as a new conversation          |
| `/alerts/<id>`                                                     | Confirm or stop an email alert (the link in alert emails)                         |
| `/aws/<platform>`                                                  | One service: every family and every instance type in it, with a filter            |
| `/aws/<platform>/<instance>`                                       | The instance page, e.g. `/aws/ec2/m5.large`                                       |
| `/<locale>/...`                                                    | Any of the above in `es`, `fr`, `de`, `ja` or `zh` (the desktop app's languages)  |
| `/index.md`, `/aws/<platform>.md`, `/aws/<platform>/<instance>.md` | Markdown for agents; also served for `Accept: text/markdown`                      |
| `/aws/<platform>/<instance>/opengraph-image`                       | The share card: specs beside the price history (Satori, `next/og`), per language  |
| `/sitemap.xml`, `/sitemaps/*.xml`                                  | Sitemap index, the index page and per-platform sitemaps, with hreflang alternates |
| `/robots.txt`                                                      | Allows everything; points at the sitemap                                          |
| `/api/aws/<platform>/<instance>/<region>`                          | One region's full price history, fetched when the visitor switches region         |
| `POST /api/chat`                                                   | One chat turn, streamed as NDJSON                                                 |
| `/api/views/<id>`, `POST /api/views/<id>/subscribe`                | A saved view with fresh data; start an email alert on it                          |
| `/api/alerts/<id>`, `POST /api/alerts/<id>/unsubscribe`            | Alert status, confirm and stop; RFC 8058 one-click unsubscribe                    |
| `POST /api/internal/notify`                                        | Called by the sync after a warehouse load; emails subscribers whose view changed  |

Pages are ISR, revalidated every 30 minutes.

The page takes `?region=<code>`, `?currency=<ISO code>`, `?duration=`, `?reserved=<class>|<option>` and
one parameter per price-picking field (`?operatingSystem=Windows`), so a
selection can be linked. They are applied in the browser: the page is cached
without its query string.

`proxy.ts` does the request-time routing: the English rewrite, the
language-cookie redirect and the Markdown negotiation.

## Translations

Marked with gt-react like the web and desktop apps (CLAUDE.md, "UI
translations"); catalogs are `_gt/<locale>.json`. The CI gate and the status
report cover this package:

```sh
pnpm --filter @infrawrench/web translations:audit
pnpm --filter @infrawrench/web translations:status
```

## Data

Read straight from the `AWS_BULK_PRICING` Workers KV namespace that
`/api/v1/aws-bulk-pricing` serves, written by
`.github/workflows/aws-bulk-pricing-sync.yml`. The format belongs to
`app/packages/web/src/aws-bulk-pricing/format.ts`; `lib/decode.ts` reads it.
A busy instance carries tens of thousands of price rows, so the page ships
current prices for every region plus one region's history (`lib/model.ts`),
and the rest comes from the region API on demand.

Other currencies use the ECB's daily euro reference rates (`lib/fx.ts`, parsed by
server-core's `parseEcbXml`), converted at the latest rate.

## The chat

`lib/chat/` and `lib/alerts.ts`: Claude Sonnet 5.5 through Cloudflare AI Gateway,
with tools that run read-only SQL against the AWS pricing warehouse (CloudHouse
on `instances-clickhouse.infrawrench.com`; the schema is
`@infrawrench/server-core/aws-pricing-warehouse/schema`, loaded by the bulk
pricing sync). Saved views and email alerts are in the `INSTANCES_CHAT` KV
namespace. KNOWLEDGE.md ("AWS pricing warehouse and the instances chat") has
the design. Claude is called with the `AI` binding through the `instances`
gateway on Unified Billing, so the Worker holds no model key. Secrets, set
with `wrangler secret put` (and in `.dev.vars` for `dev`):
`PRICING_WAREHOUSE_READ_TOKEN`, `NOTIFY_SECRET`, `MAILGUN_API_KEY`. To skip
the binding locally, `.dev.vars` can set
`AI_GATEWAY_URL=https://api.anthropic.com` and `ANTHROPIC_API_KEY`.

## Developing

```sh
pnpm --filter @infrawrench/instances dev     # vite dev, reading the real KV namespace
pnpm --filter @infrawrench/instances test
pnpm --filter @infrawrench/instances build
pnpm --filter @infrawrench/instances start   # the built Worker under wrangler dev
```

`dev` and `start` need `wrangler login` (or `CLOUDFLARE_API_TOKEN`) with read
access to the namespace, because the binding is `remote`.

## Deploying

`.github/workflows/instances-deploy.yml` runs `vinext-cloudflare deploy` on
every push to `main` that touches this package. It builds, then deploys the
generated `dist/server/wrangler.json`, which adds the two Workers Cache
entrypoints `workersCacheCdnAdapter()` serves ISR pages from. The custom
domain is created by the deploy.
