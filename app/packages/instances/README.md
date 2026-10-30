# instances.infrawrench.com

One page per AWS instance type, for every platform the AWS bulk pricing data
covers (EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune,
MemoryDB, DAX, SageMaker, EMR and GameLift): specs, current prices in every
region, and the full history of both.

Built with [vinext](https://github.com/cloudflare/vinext) (the Next.js App
Router on Vite) and served by a Cloudflare Worker.

## Routes

| Path                                                               | What                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `/`                                                                | The index: every AWS service, with its instance-type and family counts            |
| `/aws/<platform>`                                                  | One service: every family and every instance type in it, with a filter            |
| `/aws/<platform>/<instance>`                                       | The instance page, e.g. `/aws/ec2/m5.large`                                       |
| `/<locale>/...`                                                    | Any of the above in `es`, `fr`, `de`, `ja` or `zh` (the desktop app's languages)  |
| `/index.md`, `/aws/<platform>.md`, `/aws/<platform>/<instance>.md` | Markdown for agents; also served for `Accept: text/markdown`                      |
| `/aws/<platform>/<instance>/opengraph-image`                       | The share card: specs beside the price history (Satori, `next/og`), per language  |
| `/sitemap.xml`, `/sitemaps/*.xml`                                  | Sitemap index, the index page and per-platform sitemaps, with hreflang alternates |
| `/robots.txt`                                                      | Allows everything; points at the sitemap                                          |
| `/api/aws/<platform>/<instance>/<region>`                          | One region's full price history, fetched when the visitor switches region         |

Pages are ISR, revalidated every 30 minutes. `/aws` redirects to `/`.

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
