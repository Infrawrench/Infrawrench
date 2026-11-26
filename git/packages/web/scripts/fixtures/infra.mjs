/**
 * `acme/infra`: a Terraform repository with modules, environments, CI
 * pipelines, scripts and docs, written over a few weeks by three people, with
 * feature branches, a merge and release tags.
 */
import { diagram } from "./png.mjs";

const mara = { name: "Mara Lindqvist", email: "mara@acme.example" };
const jonas = { name: "Jonas Weber", email: "jonas@acme.example" };
const priya = { name: "Priya Raman", email: "priya@acme.example" };
const ci = { name: "Infrawrench CI", email: "ci@infrawrench.example" };

let clock = Date.UTC(2026, 9, 5, 8, 12, 0);
/** Moves the clock forward and answers a Git date in the given offset. */
const at = (hours, zone = "+0100") => {
  clock += Math.round(hours * 3600) * 1000;
  return `${Math.floor(clock / 1000)} ${zone}`;
};

/** Replaces one exact occurrence, and fails loudly when the text has moved. */
const edit = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`edit: text not found: ${from.slice(0, 60)}`);
  return text.replace(from, to);
};

const readme1 = `# infra

Terraform for Acme's cloud accounts.

## Layout

- \`modules/\`: reusable modules
- \`environments/\`: one root per environment
`;

const readme2 = `# infra

Terraform for Acme's cloud accounts: networking, the Kubernetes clusters, the
databases and the edge.

![Network layout](docs/images/network.png)

## Layout

| Path                    | What                                         |
| ----------------------- | -------------------------------------------- |
| \`modules/network\`       | VPC, subnets, NAT and routing                |
| \`modules/cluster\`       | EKS cluster and managed node groups          |
| \`modules/database\`      | Aurora PostgreSQL with a reader per zone     |
| \`environments/staging\`  | The staging root                             |
| \`environments/production\` | The production root                        |
| \`scripts/\`              | Helpers the pipelines call                   |

## Working on it

\`\`\`sh
cd environments/staging
terraform init
terraform plan -out plan.tfplan
\`\`\`

State lives in the repository's Terraform backend, one workspace per root.
Plans run on every pull request and applies on merge.

## Conventions

- [x] Every resource carries the \`service\`, \`environment\` and \`owner\` tags
- [x] Modules pin their provider versions
- [ ] Budgets per environment

See [docs/runbook.md](docs/runbook.md) for the on-call procedures.
`;

const gitignore = `.terraform/
*.tfplan
*.tfstate
*.tfstate.backup
crash.log
.env
`;

const versions = `terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}
`;

const networkMain1 = `locals {
  zones = slice(data.aws_availability_zones.available.names, 0, var.zone_count)
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, {
    Name = "\${var.name}-vpc"
  })
}

resource "aws_subnet" "public" {
  count = var.zone_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(var.cidr_block, 4, count.index)
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "\${var.name}-public-\${local.zones[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count = var.zone_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.zones[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index + 8)

  tags = merge(var.tags, {
    Name = "\${var.name}-private-\${local.zones[count.index]}"
    Tier = "private"
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "\${var.name}-igw"
  })
}
`;

const networkNat = `
resource "aws_eip" "nat" {
  count  = var.single_nat_gateway ? 1 : var.zone_count
  domain = "vpc"

  tags = merge(var.tags, {
    Name = "\${var.name}-nat-\${count.index}"
  })
}

resource "aws_nat_gateway" "this" {
  count = var.single_nat_gateway ? 1 : var.zone_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, {
    Name = "\${var.name}-nat-\${count.index}"
  })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = var.zone_count
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
  }

  tags = merge(var.tags, {
    Name = "\${var.name}-private-\${count.index}"
  })
}

resource "aws_route_table_association" "private" {
  count = var.zone_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
`;

const networkFlowLogs = `
resource "aws_flow_log" "this" {
  count = var.flow_logs_bucket_arn == null ? 0 : 1

  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination_type = "s3"
  log_destination      = var.flow_logs_bucket_arn

  tags = var.tags
}
`;

const networkPeering = `
resource "aws_vpc_peering_connection" "shared" {
  for_each = var.peer_vpcs

  vpc_id      = aws_vpc.this.id
  peer_vpc_id = each.value.vpc_id
  peer_region = each.value.region

  tags = merge(var.tags, {
    Name = "\${var.name}-to-\${each.key}"
  })
}

resource "aws_route" "peer" {
  for_each = {
    for pair in setproduct(keys(var.peer_vpcs), range(var.zone_count)) :
    "\${pair[0]}-\${pair[1]}" => { peer = pair[0], index = pair[1] }
  }

  route_table_id            = aws_route_table.private[each.value.index].id
  destination_cidr_block    = var.peer_vpcs[each.value.peer].cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.shared[each.value.peer].id
}
`;

const networkVariables1 = `variable "name" {
  description = "Prefix for every resource name."
  type        = string
}

variable "cidr_block" {
  description = "The VPC's range. Subnets are /4 slices of it."
  type        = string
}

variable "zone_count" {
  description = "How many availability zones to spread across."
  type        = number
  default     = 3
}

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
`;

const networkVariablesNat = `
variable "single_nat_gateway" {
  description = "One NAT gateway for the whole VPC instead of one per zone."
  type        = bool
  default     = false
}
`;

const networkVariablesFlow = `
variable "flow_logs_bucket_arn" {
  description = "Bucket that receives VPC flow logs. Null turns them off."
  type        = string
  default     = null
}
`;

const networkVariablesPeering = `
variable "peer_vpcs" {
  description = "VPCs to peer with, by name."
  type = map(object({
    vpc_id     = string
    region     = string
    cidr_block = string
  }))
  default = {}
}
`;

const networkOutputs = `output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
`;

const clusterMain1 = `resource "aws_eks_cluster" "this" {
  name     = var.name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.public_endpoint
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  tags = var.tags
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "\${var.name}-default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  instance_types  = var.instance_types

  scaling_config {
    desired_size = var.desired_nodes
    min_size     = var.min_nodes
    max_size     = var.max_nodes
  }

  update_config {
    max_unavailable = 1
  }

  tags = var.tags
}
`;

const clusterIam = `data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "\${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "\${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])

  role       = aws_iam_role.node.name
  policy_arn = each.value
}
`;

const clusterVariables = `variable "name" {
  type = string
}

variable "kubernetes_version" {
  type    = string
  default = "1.31"
}

variable "subnet_ids" {
  type = list(string)
}

variable "public_endpoint" {
  description = "Expose the API server to the internet."
  type        = bool
  default     = false
}

variable "instance_types" {
  type    = list(string)
  default = ["m7g.large"]
}

variable "desired_nodes" {
  type    = number
  default = 3
}

variable "min_nodes" {
  type    = number
  default = 3
}

variable "max_nodes" {
  type    = number
  default = 9
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

const databaseMain = `resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = var.name
  engine             = "aurora-postgresql"
  engine_version     = var.engine_version
  database_name      = var.database_name
  master_username    = "postgres"

  manage_master_user_password = true
  storage_encrypted           = true
  deletion_protection         = var.deletion_protection
  backup_retention_period     = var.backup_retention_days
  preferred_backup_window     = "02:00-03:00"

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = var.security_group_ids

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  tags = var.tags
}

resource "aws_rds_cluster_instance" "this" {
  count = var.instance_count

  identifier         = "\${var.name}-\${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version
  instance_class     = "db.serverless"

  tags = var.tags
}
`;

const databaseVariables = `variable "name" {
  type = string
}

variable "engine_version" {
  type    = string
  default = "16.4"
}

variable "database_name" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "instance_count" {
  type    = number
  default = 2
}

variable "min_capacity" {
  type    = number
  default = 0.5
}

variable "max_capacity" {
  type    = number
  default = 8
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

const envMain = (env, cidr) => `terraform {
  backend "http" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

locals {
  tags = {
    service     = "platform"
    environment = "${env}"
    owner       = "infrastructure"
  }
}

module "network" {
  source = "../../modules/network"

  name       = "acme-${env}"
  cidr_block = "${cidr}"
  tags       = local.tags
}
`;

const envCluster = (env, nodes) => `
module "cluster" {
  source = "../../modules/cluster"

  name          = "acme-${env}"
  subnet_ids    = module.network.private_subnet_ids
  desired_nodes = ${nodes}
  min_nodes     = ${nodes}
  tags          = local.tags
}
`;

const envDatabase = (env) => `
module "database" {
  source = "../../modules/database"

  name          = "acme-${env}"
  database_name = "app"
  subnet_ids    = module.network.private_subnet_ids
  tags          = local.tags
}
`;

const envVariables = `variable "region" {
  type    = string
  default = "eu-central-1"
}
`;

const ciPlan = `name: terraform
on:
  pull_request:
    paths: ["modules/**", "environments/**"]
  push:
    branches: [main]

jobs:
  fmt:
    env: terraform@1.9
    steps:
      - run: terraform fmt -check -recursive

  validate:
    env: terraform@1.9
    matrix:
      root: [environments/staging, environments/production]
    steps:
      - run: terraform -chdir=\${{ matrix.root }} init -backend=false
      - run: terraform -chdir=\${{ matrix.root }} validate
`;

const ciLint = `
  lint:
    env: terraform@1.9
    steps:
      - run: ./scripts/lint.sh
`;

const lintSh = `#!/usr/bin/env bash
set -euo pipefail

# Every module must pin its providers.
missing=0
for module in modules/*/; do
  if [[ ! -f "\${module}versions.tf" ]]; then
    echo "missing versions.tf: \${module}" >&2
    missing=1
  fi
done

exit "\${missing}"
`;

const costsPy = `"""Summarises a Terraform plan's resource changes by type."""

import json
import sys
from collections import Counter


def summarise(plan: dict) -> Counter:
    counts: Counter = Counter()
    for change in plan.get("resource_changes", []):
        actions = change["change"]["actions"]
        if actions == ["no-op"]:
            continue
        counts[(change["type"], "/".join(actions))] += 1
    return counts


def main() -> int:
    plan = json.load(sys.stdin)
    for (kind, action), count in sorted(summarise(plan).items()):
        print(f"{action:<16} {count:>3}  {kind}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

const runbook = `# Runbook

## A plan fails on the state lock

Somebody else's run holds it, or a run died with it. Check the workspace's
runs before forcing anything:

1. Open the Infrastructure tab and find the run that holds the lock.
2. If it is still running, wait for it.
3. If it is gone, unlock from the workspace page.

## Rolling the node group

\`\`\`sh
terraform -chdir=environments/production apply \\
  -target=module.cluster.aws_eks_node_group.default
\`\`\`

Nodes are replaced one at a time (\`max_unavailable = 1\`). A full roll of
production takes about forty minutes.

## Restoring the database

> Restores create a new cluster. Nothing is overwritten.

| Step | Who      | Notes                                   |
| ---- | -------- | --------------------------------------- |
| 1    | On-call  | Pick the restore point                  |
| 2    | On-call  | Restore to \`acme-production-restore\`    |
| 3    | Owner    | Verify row counts against the dashboard |
| 4    | Owner    | Switch the application's secret         |
`;

const regions = Array.from({ length: 34 }, (_, i) => {
  const names = ["eu-central-1", "eu-west-1", "eu-north-1", "us-east-1", "us-west-2"];
  const region = names[i % names.length];
  const zone = "abc"[i % 3];
  return `  "${region}${zone}-${String(i).padStart(2, "0")}" = { region = "${region}", weight = ${
    (i * 7) % 10
  } }`;
}).join("\n");

const zonesTf = `# Weights the edge uses to spread traffic. Generated by scripts/zones.py.
locals {
  edge_zones = {
${regions}
  }
}
`;

const lfsPointer = `version https://git-lfs.github.com/spec/v1
oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
size 48213504
`;

let stagingMain = envMain("staging", "10.20.0.0/16");
let productionMain = envMain("production", "10.10.0.0/16");
let networkMain = networkMain1;
let networkVariables = networkVariables1;
let pipeline = ciPlan;

const steps = [];
const commit = (by, hours, message, files, extra = {}) =>
  steps.push({ by, at: at(hours, by === priya ? "+0530" : "+0100"), message, files, ...extra });

commit(mara, 0, "Initial commit", { "README.md": readme1, ".gitignore": gitignore });

commit(mara, 2.5, "Add the network module\n\nA VPC with a public and a private subnet per zone.", {
  "modules/network/main.tf": networkMain,
  "modules/network/variables.tf": networkVariables,
  "modules/network/outputs.tf": networkOutputs,
  "modules/network/versions.tf": versions,
});

networkMain += networkNat;
networkVariables += networkVariablesNat;
commit(jonas, 20, "network: NAT gateways and private routing", {
  "modules/network/main.tf": networkMain,
  "modules/network/variables.tf": networkVariables,
});

commit(mara, 5, "Add the staging root", {
  "environments/staging/main.tf": stagingMain,
  "environments/staging/variables.tf": envVariables,
});

commit(priya, 18, "Add the cluster module", {
  "modules/cluster/main.tf": clusterMain1,
  "modules/cluster/iam.tf": clusterIam,
  "modules/cluster/variables.tf": clusterVariables,
  "modules/cluster/versions.tf": versions,
});

stagingMain += envCluster("staging", 2);
commit(priya, 1.5, "staging: run a cluster", { "environments/staging/main.tf": stagingMain });

commit(jonas, 26, "Check formatting and validate in CI", {
  ".infrawrench/ci/terraform.yml": pipeline,
});

commit(mara, 22, "Add the database module", {
  "modules/database/main.tf": databaseMain,
  "modules/database/variables.tf": databaseVariables,
  "modules/database/versions.tf": versions,
});

stagingMain += envDatabase("staging");
commit(mara, 0.4, "staging: add the application database", {
  "environments/staging/main.tf": stagingMain,
});

productionMain += envCluster("production", 6) + envDatabase("production");
commit(
  mara,
  30,
  "Add the production root\n\nThe same three modules as staging, sized for production: six nodes and\nthe database's deletion protection left on.",
  {
    "environments/production/main.tf": productionMain,
    "environments/production/variables.tf": envVariables,
  },
);

steps.push({ tag: "v1.0.0", message: "First production apply", by: mara, at: at(0.2) });

pipeline += ciLint;
commit(jonas, 44, "Lint that every module pins its providers", {
  "scripts/lint.sh": { executable: lintSh },
  ".infrawrench/ci/terraform.yml": pipeline,
});

commit(priya, 9, "docs: runbook and the network diagram", {
  "docs/runbook.md": runbook,
  "docs/images/network.png": { bytes: diagram(480, 270, [1, 3, 2]) },
  "README.md": readme2,
});

// A feature branch that is merged back.
steps.push({ checkout: "feature/flow-logs", create: true });
networkMain += networkFlowLogs;
networkVariables += networkVariablesFlow;
commit(jonas, 16, "network: optional VPC flow logs", {
  "modules/network/main.tf": networkMain,
  "modules/network/variables.tf": networkVariables,
});
const stagingWithFlow = edit(
  stagingMain,
  `  cidr_block = "10.20.0.0/16"\n`,
  `  cidr_block = "10.20.0.0/16"\n\n  flow_logs_bucket_arn = "arn:aws:s3:::acme-staging-flow-logs"\n`,
);
commit(jonas, 1, "staging: send flow logs to the audit bucket", {
  "environments/staging/main.tf": stagingWithFlow,
});
stagingMain = stagingWithFlow;

steps.push({ checkout: "main" });
const clusterMain2 = edit(
  clusterMain1,
  `  enabled_cluster_log_types = ["api", "audit", "authenticator"]`,
  `  enabled_cluster_log_types = ["api", "audit", "authenticator", "scheduler"]`,
);
commit(priya, 3, "cluster: keep scheduler logs", { "modules/cluster/main.tf": clusterMain2 });

steps.push({
  merge: "feature/flow-logs",
  message: "Merge pull request #7 from feature/flow-logs\n\nnetwork: optional VPC flow logs",
  by: mara,
  at: at(5),
});

commit(mara, 20, "Add a script that summarises a plan", {
  "scripts/plan/summary.py": costsPy,
  "scripts/plan/README.md": "# plan\n\n`summary.py` reads `terraform show -json` on stdin.\n",
});

commit(jonas, 7, "Add the edge zone weights", {
  "environments/production/zones.tf": zonesTf,
  "data/latency.bin": lfsPointer,
  "docs/current": { symlink: "runbook.md" },
  "modules/vendor/terraform-aws-tags": {
    submodule: "8f2c1d7a9b3e4f60a1c2d3e4f5a6b7c8d9e0f1a2",
  },
});

steps.push({ tag: "v1.1.0" });

const clusterVariables2 = edit(
  clusterVariables,
  `  default = ["m7g.large"]`,
  `  default = ["m7g.xlarge"]`,
);
commit(
  priya,
  28,
  "cluster: default to m7g.xlarge\n\nThe large nodes ran out of pod IPs before they ran out of memory.",
  {
    "modules/cluster/variables.tf": clusterVariables2,
  },
);

commit(
  mara,
  6,
  "Rename the plan summary script",
  {},
  {
    rename: { "scripts/plan/summary.py": "scripts/plan/summarise.py" },
  },
);

const productionMain2 = edit(
  productionMain,
  `  desired_nodes = 6\n  min_nodes     = 6`,
  `  desired_nodes = 8\n  min_nodes     = 6`,
);
commit(mara, 19, "production: two more nodes for the batch workers", {
  "environments/production/main.tf": productionMain2,
});
productionMain = productionMain2;

steps.push({ tag: "v1.2.0", message: "Flow logs, larger nodes", by: mara, at: at(0.1) });

// A release branch cut from here.
steps.push({ checkout: "release/2026.11", create: true });
commit(ci, 1, "Release 2026.11", {
  VERSION: "2026.11.0\n",
});
steps.push({ checkout: "main" });

// Open work: two branches ahead of main, main moves on underneath them.
steps.push({ checkout: "feature/vpc-peering", create: true });
networkMain += networkPeering;
networkVariables += networkVariablesPeering;
commit(jonas, 22, "network: peer with the shared services VPC", {
  "modules/network/main.tf": networkMain,
  "modules/network/variables.tf": networkVariables,
});
const stagingPeered = edit(
  stagingMain,
  `  flow_logs_bucket_arn = "arn:aws:s3:::acme-staging-flow-logs"\n`,
  `  flow_logs_bucket_arn = "arn:aws:s3:::acme-staging-flow-logs"\n\n  peer_vpcs = {\n    shared = {\n      vpc_id     = "vpc-0a1b2c3d4e5f60718"\n      region     = "eu-central-1"\n      cidr_block = "10.0.0.0/16"\n    }\n  }\n`,
);
commit(jonas, 2, "staging: peer with shared services", {
  "environments/staging/main.tf": stagingPeered,
});
// What lets a peer in, so the branch's last version has a file with more changed
// lines than anything is said about: the branch page shows it cut down.
const networkPeerAccess = `
resource "aws_security_group" "peer" {
  for_each = var.peer_vpcs

  name        = "\${var.name}-from-\${each.key}"
  description = "What the \${each.key} VPC may reach here."
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "\${var.name}-from-\${each.key}"
  })
}

resource "aws_vpc_security_group_ingress_rule" "peer_https" {
  for_each = var.peer_vpcs

  security_group_id = aws_security_group.peer[each.key].id
  description       = "HTTPS from \${each.key}"
  cidr_ipv4         = each.value.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "peer_metrics" {
  for_each = var.peer_vpcs

  security_group_id = aws_security_group.peer[each.key].id
  description       = "Metrics scrapes from \${each.key}"
  cidr_ipv4         = each.value.cidr_block
  ip_protocol       = "tcp"
  from_port         = 9100
  to_port           = 9100
}

resource "aws_vpc_security_group_ingress_rule" "peer_dns" {
  for_each = var.peer_vpcs

  security_group_id = aws_security_group.peer[each.key].id
  description       = "DNS from \${each.key}"
  cidr_ipv4         = each.value.cidr_block
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "peer_all" {
  for_each = var.peer_vpcs

  security_group_id = aws_security_group.peer[each.key].id
  description       = "Answers back to \${each.key}"
  cidr_ipv4         = each.value.cidr_block
  ip_protocol       = "-1"
}
`;
commit(jonas, 17, "docs: how the peering routes are laid out", {
  "modules/network/main.tf": networkMain + networkPeerAccess,
  "docs/peering.md":
    '# Peering\n\nEach private route table gets one route per peered VPC.\n\n```hcl\npeer_vpcs = {\n  shared = { vpc_id = "vpc-...", region = "eu-central-1", cidr_block = "10.0.0.0/16" }\n}\n```\n',
  "docs/images/network.png": { bytes: diagram(480, 270, [2, 3, 2]) },
});

steps.push({ checkout: "main" });
steps.push({ checkout: "fix/database-backups", create: true });
const databaseVariables2 = edit(
  databaseVariables,
  `variable "backup_retention_days" {\n  type    = number\n  default = 7\n}`,
  `variable "backup_retention_days" {\n  description = "Days of automated backups to keep. Production keeps 35."\n  type        = number\n  default     = 14\n\n  validation {\n    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35\n    error_message = "Aurora keeps between 1 and 35 days of backups."\n  }\n}`,
);
commit(priya, 9, "database: keep two weeks of backups by default", {
  "modules/database/variables.tf": databaseVariables2,
});

steps.push({ checkout: "main" });
const pipeline2 = edit(
  pipeline,
  `    env: terraform@1.9\n    steps:\n      - run: terraform fmt`,
  `    env: terraform@1.10\n    steps:\n      - run: terraform fmt`,
);
commit(jonas, 12, "ci: format with Terraform 1.10", { ".infrawrench/ci/terraform.yml": pipeline2 });

const readme3 = edit(readme2, `- [ ] Budgets per environment`, `- [x] Budgets per environment`);
commit(mara, 21, "Add a budget per environment", {
  "environments/production/budget.tf": `resource "aws_budgets_budget" "monthly" {
  name         = "acme-production"
  budget_type  = "COST"
  limit_amount = "42000"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 90
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ["infrastructure@acme.example"]
  }
}
`,
  "environments/staging/budget.tf": `resource "aws_budgets_budget" "monthly" {
  name         = "acme-staging"
  budget_type  = "COST"
  limit_amount = "6000"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
}
`,
  "README.md": readme3,
});

commit(priya, 4, "Remove the unused latency data", { "data/latency.bin": null });

export const history = { defaultBranch: "main", steps };
