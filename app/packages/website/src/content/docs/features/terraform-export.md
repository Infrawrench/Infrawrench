---
title: Terraform export
description: Eject a resource or a whole account's inventory as ready-to-import Terraform HCL.
sidebar_order: 6
---

Terraform export turns the resources Infrawrench already knows about into a Terraform configuration you can adopt with `terraform import`. It works entirely from stored state — no extra provider API calls, no credentials involved — and it never inlines a secret: API tokens and account IDs are emitted as `var.*` input variables that you fill in locally.

<insert [Export to Terraform modal on a Hetzner server showing the generated HCL, the resource count line, and the Copy HCL / Download main.tf buttons] here>

## Where to find it

- **A single resource** — open the resource's detail page and click **Export to Terraform…** in the bottom action row. The export includes the resource and its direct children (a Cloudflare zone brings its DNS records along, for example).
- **A whole account** — open the account page and click **Export to Terraform** in the header. Every stored resource in the account is considered.
- **The CLI** — `infrawrench export --account <id|name> --format terraform` prints the same HCL to stdout (redirect it: `infrawrench export -a my-account > main.tf`). `--json` returns the structured result — HCL plus the exported/unsupported resource lists. Warnings go to stderr so redirected output stays clean.

## What you get

One HCL document containing:

- a `terraform { required_providers { … } }` block pinned to the provider's current major version,
- `variable` blocks for credentials (marked `sensitive`) and provider-level IDs,
- a `provider` block wired to those variables,
- one `resource` block per exported resource, each preceded by a comment with the exact `terraform import` command to adopt the live resource into state.

Resources that have no mapping yet are listed clearly — in the modal's amber panel, on stderr in the CLI, and in the `unsupported` array of the API response — with the reason, so nothing is dropped silently.

<insert [Account page export modal for a mixed account showing the amber "resources have no Terraform mapping yet" panel above the generated HCL] here>

## Supported providers

| Plugin       | Terraform provider          | Exported resource types                                                                                 |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| AWS          | `hashicorp/aws`             | EC2, S3, VPC, subnet, security group, EBS, RDS, SQS, SNS, Route 53 zones, EFS                           |
| GCP          | `hashicorp/google`          | GCS, VPC, subnet, GKE, Pub/Sub, Cloud DNS zones, BigQuery datasets, Artifact Registry, service accounts |
| Azure        | `hashicorp/azurerm`         | Resource groups, VNets, subnets, NSGs, storage accounts, DNS zones, Key Vault, Redis                    |
| Hetzner      | `hetznercloud/hcloud`       | Servers (`hcloud_server`), Volumes (`hcloud_volume`)                                                    |
| DigitalOcean | `digitalocean/digitalocean` | Droplets, Volumes, Domains, DNS records                                                                 |
| Cloudflare   | `cloudflare/cloudflare` v5  | Zones (`cloudflare_zone`), DNS records (`cloudflare_dns_record`)                                        |
| Vercel       | `vercel/vercel`             | Projects, project domains, environment variables                                                        |
| Neon         | `kislerdm/neon`             | Projects, branches, endpoints, databases, roles                                                         |
| Fly.io       | `stategraph/fly`            | Apps, machines, volumes, certificates                                                                   |
| Scaleway     | `scaleway/scaleway`         | Instances, block volumes, Object Storage buckets, RDB, Kapsule clusters                                 |
| OVHcloud     | `ovh/ovh`                   | Instances, volumes, private networks, managed DBs, Object Storage buckets                               |
| PlanetScale  | `planetscale/planetscale`   | Vitess branches and branch passwords                                                                    |
| ClickHouse   | `ClickHouse/clickhouse`     | Cloud services (`clickhouse_service`)                                                                   |
| Databricks   | `databricks/databricks`     | Clusters, SQL warehouses, catalogs, schemas                                                             |
| Netlify      | `netlify/netlify`           | DNS zones, DNS records, environment variables                                                           |

Coverage is per resource type: types that need nested blocks or credentials Infrawrench doesn't store (for example Azure VMs, AWS Lambda packages, Netlify sites) stay in the unsupported list with a reason. A plugin declares its own mapping, so coverage grows type by type.

## Adopting the resources

1. Save the export as `main.tf` in an empty directory.
2. Create a `terraform.tfvars` (keep it out of git) with the variables the file declares, e.g. `hcloud_token`, `cloudflare_api_token`, `cloudflare_account_id`.
3. Run `terraform init`, then run the `terraform import` commands from the comments above each resource block.
4. Run `terraform plan` and reconcile any drift — attributes Infrawrench doesn't store (labels, backup windows, attachments) may need to be filled in by hand before the plan is clean.

## Things to watch

- The export reflects Infrawrench's **stored state**. Sync the account first if you've changed things on the provider side recently.
- Volume attachments are noted as comments rather than emitted as attachment resources — model them explicitly (`hcloud_volume_attachment`, `digitalocean_volume_attachment`) before applying.
- Server `image` attributes describe what the machine was created from; changing them in Terraform forces a rebuild/replacement, not an in-place change.
