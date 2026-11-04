---
title: Domains & dangling DNS
description: See every DNS zone and record across all your providers in one view, with possible subdomain-takeover risks (records pointing at a provider name nothing in your workspace claims) flagged automatically.
sidebar_order: 9
---

DNS tends to be spread across more consoles than anything else you own: a zone in Cloudflare, a Route 53 hosted zone from a migration that never finished, a DigitalOcean domain from a side project, a Netlify zone that came with a site. **Domains** puts it all in one table, every zone and every record across every connected provider. More usefully, it flags records whose targets nothing in your workspace claims.

That's the subdomain-takeover problem. You delete the S3 bucket, tear down the Vercel project or rename the Netlify site, and the `CNAME` in your zone stays behind, still pointing at a name the provider has now released. Whoever registers that name next can serve their content on your hostname. Depending on how TLS and cookies are set up for that deployment, their content could also end up behind your certificate and inside your cookie scope.

Like [posture checks](./posture-checks.md), the [orphan finder](./orphan-finder.md) and the [expiry radar](./expiry-radar.md), it costs nothing to leave on. It uses data your accounts already sync, with no extra provider API calls and **no DNS lookups**. A record's target is checked against what you actually have, not against what a resolver answers right now.

## Open the view

Open **Domains** from the sidebar on web or desktop, or run `infrawrench dns`.

**Zones** lists every managed zone: the apex domain, the provider and account it's in, how many records were synced and how many are dangling. If the provider reports its own record count and it differs from what was synced, both numbers show. Several providers list zones without their records, so this makes it clear a zone isn't really empty.

**Records** lists every record, worst first, with each target's status:

| Status            | What it means                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dangling**      | The target points into a provider namespace you manage, and nothing you've synced claims it. This is the sign of a takeover risk.                  |
| **Resolves here** | The target is a resource in your workspace, such as a droplet's IP, a bucket or a project. Click through to open it.                               |
| **External**      | The target points somewhere Infrawrench knows nothing about: a third-party SaaS, someone else's nameserver, an IP you never synced. Not a finding. |
| **Not analysed**  | The record type has no host target to check (TXT, MX, SOA, CAA, SRV). Listed, never judged.                                                        |

Click the zone domain or record name to open the underlying resource, which is where you edit or delete it. You can also tab through the table with the keyboard.

![Domains screen showing the zones roll-up above the records table, with one record marked Dangling and its explanation visible](https://agent-assets.infrawrench.com/docs-screenshots/features/domains/domains-overview.png)

## Supported providers

| Provider     | Zones                        | Records               |
| ------------ | ---------------------------- | --------------------- |
| Cloudflare   | Zones                        | DNS records           |
| AWS          | Route 53 hosted zones        | Route 53 record sets  |
| Google Cloud | Cloud DNS zones              | Cloud DNS record sets |
| DigitalOcean | Domains                      | DNS records           |
| Netlify      | Managed DNS zones            | DNS records           |
| Linode       | DNS Manager domains          | DNS records           |
| Azure        | DNS zones, Private DNS zones | (not listed)          |
| Vercel       | Domains                      | (not listed)          |

Azure and Vercel zones appear with the provider's own record count and no records underneath.

Private and split-horizon zones (Route 53 private hosted zones, Cloud DNS private zones, Azure Private DNS) are listed and clearly marked, but never checked for takeover. An internal name pointing at nothing is a broken deploy, not an exposure.

## What counts as dangling

A record is dangling when its target is in a **provider namespace** and **nothing in your workspace claims that name**. These are namespaces where names are globally unique and released when you delete the resource, which is what makes them possible to take over:

- S3 bucket endpoints and CloudFront distribution domains
- Cloud Storage bucket endpoints
- Azure Storage account and App Service default hostnames
- DigitalOcean Spaces endpoints
- Linode Object Storage bucket hostnames and NodeBalancer hostnames
- Netlify site subdomains, Vercel deployment aliases, Fly.io app hostnames
- `workers.dev` Worker subdomains

So a `CNAME` to `assets.s3.amazonaws.com` is fine while that bucket is in one of your connected accounts. It becomes a finding after the next sync shows the bucket is gone.

### When a namespace isn't checked

To avoid false alarms, a namespace is only checked when both of these are true:

1. You have an account connected for that provider. Without one, there's no way to tell your bucket from a stranger's.
2. At least one resource of that type has synced. An account with zero buckets looks the same as one whose credentials can't list them.

If either is missing, records pointing there show as **External**, and the namespace is listed under **Not checked** with the reason.

One false positive remains, and the finding says so: a bucket or app in an account you **haven't** connected looks the same as one that was deleted. Connecting that account clears it.

### What it can't tell you

An `A` record pointing at an IP address you no longer hold (a released Elastic IP, a destroyed droplet) shows as **External**, not dangling. IP addresses don't belong to a provider namespace, so there's no way to tell "an IP I released last week" from "an IP I never owned". The view just tells you the address matches nothing you've synced.

## Alerts

Dangling records also show on the [Posture](./posture-checks.md) screen as high-severity `dns-dangling-target` findings. They alert through the posture channels you already set up (push, [Slack](./slack-alerts.md), [Teams](./teams-alerts.md)), with nothing extra to turn on. Turning posture alerts off turns these off too.

## From the CLI

```bash
infrawrench dns              # zones, records and dangling targets for your org
infrawrench dns --json       # the same as JSON
infrawrench dns --local      # scan this machine's local workspace, signed out
```

`--local` runs the same check against the desktop app's local workspace, with no credentials, no network and no DNS lookups.

## From the API and MCP

`GET /api/org/{orgId}/dns` returns the whole inventory (permission `resources:read`). See the [OpenAPI spec](../team-and-billing/openapi.md). The `list_dns_records` [MCP tool](./mcp.md) gives you the same data with `status` and `domain` filters, so you can ask an assistant "what points at this domain?" or "find any takeover risks".

## Related

- [DNS records](./dns-records.md): creating and editing records, and pointing them at a resource with live tracking
- [Posture checks](./posture-checks.md): where dangling records show up as findings
- [Dependency graph](./dependency-graph.md): the same matching, drawn as a map
