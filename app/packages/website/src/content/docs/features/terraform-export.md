---
title: Terraform export
description: Export a single resource or a whole account's inventory as ready-to-import Terraform HCL.
sidebar_order: 6
---

Terraform export turns the resources Infrawrench already knows about into a Terraform
configuration you can adopt with `terraform import`. It uses what Infrawrench has already synced,
so it makes no extra calls to your provider. It never includes a secret: API tokens and account
IDs become `var.*` input variables that you fill in locally.

![Export to Terraform modal on a Hetzner server showing the generated HCL, the resource count line, and the Copy HCL / Download main.tf buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/terraform-export/hetzner-server-modal.png)

## Export resources

- **A single resource**: open the resource's detail page and click **Export to Terraform…** in the
  bottom action row. The export includes the resource and its direct children (for example, a
  Cloudflare zone brings its DNS records along).
- **A whole account**: open the account page and click **Export to Terraform** in the header.
  Every synced resource in the account is included.
- **The CLI**: `infrawrench export --account <id|name> --format terraform` prints the same HCL.
  Redirect it to a file with `infrawrench export -a my-account > main.tf`. `--json` returns the
  HCL plus the lists of exported and unsupported resources. Warnings go to stderr, so redirected
  output stays clean.

## What you get

One HCL file containing:

- a `terraform { required_providers { … } }` block pinned to the provider's current major version
- `variable` blocks for credentials (marked `sensitive`) and provider-level IDs
- a `provider` block that uses those variables
- one `resource` block per exported resource, each with a comment above it giving the exact
  `terraform import` command to bring the live resource into state

Resources that can't be exported yet are listed with the reason, so nothing goes missing without
you knowing. You'll see them in the amber panel in the app, on stderr in the CLI, and in the
`unsupported` array of the API response.

![Account page export modal for a mixed account showing the amber "resources have no Terraform mapping yet" panel above the generated HCL](https://agent-assets.infrawrench.com/docs-screenshots/features/terraform-export/account-unsupported-panel.png)

## Supported providers

| Plugin          | Terraform provider          | Exported resource types                                                                                                                                |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS             | `hashicorp/aws`             | EC2, S3, VPC, subnet, security group, EBS, RDS, SQS, SNS, Route 53 zones, EFS                                                                          |
| GCP             | `hashicorp/google`          | GCS, VPC, subnet, GKE, Pub/Sub, Cloud DNS zones, BigQuery datasets, Artifact Registry, service accounts, Cloud Run jobs, Memorystore for Valkey        |
| Azure           | `hashicorp/azurerm`         | Resource groups, VNets, subnets, NSGs, storage accounts, DNS zones, Key Vault, Redis, Managed Redis, Container Apps environments, AI services accounts |
| Hetzner         | `hetznercloud/hcloud`       | Servers, volumes, networks, load balancers, floating IPs, placement groups                                                                             |
| DigitalOcean    | `digitalocean/digitalocean` | Droplets, Volumes, Domains, DNS records                                                                                                                |
| Cloudflare      | `cloudflare/cloudflare` v5  | Zones (`cloudflare_zone`), DNS records (`cloudflare_dns_record`)                                                                                       |
| Vercel          | `vercel/vercel`             | Projects, project domains, environment variables                                                                                                       |
| Neon            | `kislerdm/neon`             | Projects, branches, endpoints, databases, roles                                                                                                        |
| Fly.io          | `stategraph/fly`            | Apps, machines, volumes, certificates                                                                                                                  |
| Scaleway        | `scaleway/scaleway`         | Instances, block volumes, Object Storage buckets, RDB, Kapsule clusters                                                                                |
| OVHcloud        | `ovh/ovh`                   | Instances, volumes, private networks, managed DBs, Object Storage buckets                                                                              |
| PlanetScale     | `planetscale/planetscale`   | Vitess branches and branch passwords                                                                                                                   |
| ClickHouse      | `ClickHouse/clickhouse`     | Cloud services (`clickhouse_service`)                                                                                                                  |
| Databricks      | `databricks/databricks`     | Clusters, SQL warehouses, catalogs, schemas                                                                                                            |
| Snowflake       | `snowflakedb/snowflake`     | Warehouses, databases, schemas, resource monitors                                                                                                      |
| Netlify         | `netlify/netlify`           | DNS zones, DNS records, environment variables                                                                                                          |
| Datadog         | `datadog/datadog`           | Monitors (`datadog_monitor`) with thresholds, priority and tags                                                                                        |
| New Relic       | `newrelic/newrelic`         | Alert policies (`newrelic_alert_policy`) with their incident preference                                                                                |
| Crusoe Cloud    | `crusoecloud/crusoe`        | Projects, VMs, disks, VPC networks, subnets, firewall rules, Kubernetes clusters, node pools                                                           |
| CoreWeave       | `coreweave/coreweave`       | CKS clusters, VPCs, AI Object Storage buckets                                                                                                          |
| Linode          | `linode/linode`             | Linodes, volumes, NodeBalancers, LKE clusters, buckets, firewalls, domains, DNS records, VPCs, StackScripts, Managed Databases, reserved IPs           |
| Oracle Cloud    | `oracle/oci`                | Compartments, instances, block volumes, VCNs, subnets, reserved IPs, load balancers, buckets, Autonomous Databases, OKE clusters, budgets, alert rules |
| Temporal Cloud  | `temporalio/temporalcloud`  | Namespaces, users, service accounts, Nexus endpoints, connectivity rules                                                                               |
| Redis Cloud     | `RedisLabs/rediscloud`      | ACL rules, roles and users, Essentials subscriptions, Pro databases (`rediscloud_subscription_database`)                                               |
| Confluent Cloud | `confluentinc/confluent`    | Environments, Kafka clusters (with CKUs or eCKU ceiling), Flink compute pools, service accounts                                                        |
| MongoDB Atlas   | `mongodb/mongodbatlas`      | Projects (`mongodbatlas_project`), IP access list entries, Flex clusters                                                                               |
| Sentry          | `jianyuan/sentry`           | Projects, teams and client keys (`sentry_project`, `sentry_team`, `sentry_key`)                                                                        |
| Grafana Cloud   | `grafana/grafana`           | Stacks (`grafana_cloud_stack`) with region, description, labels and delete protection                                                                  |

Support is per resource type. Types that need nested blocks or credentials Infrawrench doesn't
store (for example Azure VMs, AWS Lambda packages, Netlify sites) stay in the unsupported list
with a reason. More types are added over time.

## Adopt the resources

1. Save the export as `main.tf` in an empty directory.
2. Create a `terraform.tfvars` file (keep it out of git) with the variables the file declares,
   such as `hcloud_token`, `cloudflare_api_token` or `cloudflare_account_id`.
3. Run `terraform init`, then run the `terraform import` commands from the comments above each
   resource block.
4. Run `terraform plan` and fix any drift. Attributes Infrawrench doesn't store (labels, backup
   windows, attachments) may need filling in by hand before the plan is clean.

## Things to watch

- The export reflects what Infrawrench last synced. If you've changed things on the provider side
  recently, sync the account first.
- Volume attachments appear as comments, not as attachment resources. Add them yourself
  (`hcloud_volume_attachment`, `digitalocean_volume_attachment`) before applying.
- A server's `image` attribute describes what it was created from. Changing it in Terraform
  rebuilds or replaces the server rather than changing it in place.

## Going the other way

Export only goes one way: your inventory out as HCL. To upload the Terraform state you already
have and find which resources it _doesn't_ cover, see
[IaC reconciliation](./iac-reconciliation.md). It generates `import` blocks for the unmanaged
resources, so you don't have to run `terraform import` by hand.
