---
title: DNS records
description: View a zone's DNS records as a table and point A, AAAA and CNAME records at your other resources.
sidebar_order: 8
---

You can view and edit a zone's DNS records in a table on the zone's page. When you create an A, AAAA or CNAME record, you can **point it at one of your resources** instead of pasting an IP or hostname by hand.

## View and edit records

Open a DNS zone (Cloudflare zone, DigitalOcean domain, Route 53 hosted zone, Cloud DNS zone, Netlify DNS zone). The **DNS Records** section shows a table with **Type**, **Name**, **Content**, **Proxy** and **TTL** columns:

- **Type** is a colored badge (A, AAAA, CNAME, MX, TXT, …).
- **Name** shows the short record name (`www`) rather than the full domain. The zone apex shows as `@`.
- **Proxy** shows an orange cloud for proxied records and a grey cloud for DNS-only (Cloudflare).
- The first cell of each row is a button (**Edit _name_**, or **Open _name_** for tables that link elsewhere). Click it to edit the record right there on the zone page. The **Delete** button at the end of the row removes the record. You can reach both with the keyboard.
- **+ Create DNS Record** opens the create form.

![DNS zone detail page showing the DNS Records table with type badges and proxy indicators](https://agent-assets.infrawrench.com/docs-screenshots/features/dns-records/dns-records-table.png)

## Point a record at a resource

When you create an **A**, **AAAA** or **CNAME** record, the value field starts as a **resource picker**:

- **A** records list resources with a public IPv4 address (EC2 instances, Elastic IPs, droplets, Azure VMs/public IPs, Hetzner servers/floating IPs, Scaleway instances, GCE instances, GCP forwarding rules).
- **AAAA** records list resources with a public IPv6 address (droplets, Hetzner servers, Fly machines).
- **CNAME** records list resources with a hostname (ALBs, RDS/DocumentDB endpoints, EC2 public DNS, Spaces buckets, Azure FQDNs).

The picker searches **every account in your org**, so a Cloudflare A record can point at an AWS Elastic IP, a DigitalOcean droplet and so on. Each option shows which account it's from.

To type a value yourself, switch **Value source** to **Use custom value**. Other record types (MX, TXT, SRV, …) always use a plain text field.

![DNS record create form for an A record with the resource picker open, listing IP-producing resources across accounts](https://agent-assets.infrawrench.com/docs-screenshots/features/dns-records/create-record-resource-picker.png)

![DNS record create form with the "Use custom value" toggle enabled, showing the plain text fallback](https://agent-assets.infrawrench.com/docs-screenshots/features/dns-records/create-record-custom-value.png)

## Keep records up to date automatically

When you pick a resource, the record stays linked to it through an [output reference](../core-concepts/output-references.md). If the resource's address changes (a server is rebuilt with a new IP, or a load balancer's hostname changes), Infrawrench updates the record at the provider on its next sync, so it keeps pointing at the right place.

This works on Cloudflare, DigitalOcean, AWS Route 53 and Google Cloud DNS. Netlify doesn't allow DNS records to be changed, so a Netlify record keeps the value it had when you created it.

## See every zone at once

To see every zone and record across all your providers in one table, with records that point at names nothing in your workspace owns flagged as possible takeover risks, see [Domains & dangling DNS](./domains.md).
