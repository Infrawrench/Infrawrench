# status-origin.infrawrench.com — vanity-host origin for public status pages

A Cloudflare Worker that is the **origin** for customer custom domains on
status pages. Cloudflare for SaaS terminates TLS on `status.acme.com` and
routes the request here; this Worker looks up the hostname in KV, then proxies
to `app.infrawrench.com`.

Customers never deploy anything. They CNAME a subdomain at Infrawrench; the
cloud API creates a Custom Hostname and writes `hostname → slug` into the KV
this Worker reads.

## Request handling

| Incoming                              | Proxied to                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/status` (any path under it) | `ORIGIN/api/status/{slug}`                                                       |
| `/assets/…`, files with extensions    | `ORIGIN` unchanged                                                               |
| `/` (document)                        | `ORIGIN/` SPA shell, with `iw-status-host` meta so the client enters vanity mode |

Unknown hostnames 404. Unpublished pages still 404 at the origin API — the
Worker does not second-guess publish state.

## One-time Cloudflare setup

1. Enable **Cloudflare for SaaS** on the zone that will hold custom hostnames.
2. Create an originless fallback DNS record, e.g. `status-origin.infrawrench.com`
   `AAAA 100::` (proxied), and set it as the SaaS fallback origin.
3. Create the KV namespace and put its id in `wrangler.jsonc` **and** in the
   web pods as `STATUS_PAGE_KV_NAMESPACE_ID`:

   ```sh
   pnpm --filter @infrawrench/status-page-edge exec wrangler kv namespace create STATUS_HOSTS
   ```

4. Deploy this Worker (CI does this on push; or run locally):

   ```sh
   pnpm --filter @infrawrench/status-page-edge deploy
   ```

5. Ensure a Workers route sends SaaS traffic to this Worker (custom domain on
   the fallback host, or a `*/*` route on the SaaS zone — see
   [Worker as origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).

6. Set on the web/poller pods (see `.env.example` / `terraform.tfvars.example`):

   - `STATUS_PAGE_CF_ACCOUNT_ID`
   - `STATUS_PAGE_CF_ZONE_ID`
   - `STATUS_PAGE_CF_API_TOKEN` (Custom Hostnames + Workers KV edit)
   - `STATUS_PAGE_CNAME_TARGET` (what customers CNAME to — usually the SaaS
     CNAME target Cloudflare shows for the zone)
   - `STATUS_PAGE_KV_NAMESPACE_ID`

Without those variables, the attach endpoint returns a clear configuration
error; slug URLs keep working.

## Deploy

```sh
pnpm --filter @infrawrench/status-page-edge test
pnpm --filter @infrawrench/status-page-edge deploy
```

CI (`.github/workflows/status-page-edge-deploy.yml`) redeploys on any push to
`app/packages/status-page-edge/**`, after the package tests pass. It reuses
`secrets.CLOUDFLARE_API_TOKEN`.

## Not a general-purpose reverse proxy

Don't point arbitrary traffic here. The only Host values that resolve are ones
the cloud API wrote into KV when attaching a status-page custom domain.
