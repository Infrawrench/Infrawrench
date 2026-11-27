/**
 * The mock's Terraform scans: what `terraform.scan` and
 * `terraform.configurationChange` answer.
 *
 * - `mara/repo-testing` is shaped like a monorepo with a large Terraform root
 *   (`infra/terraform`: local state, five providers, list-priced estimate
 *   with what could not be priced) and a provider-less one
 *   (`infra/ci-runners`), neither with a workspace.
 * - `acme/infra` has its two workspace roots and one root with no workspace
 *   (`bootstrap`), whose estimate a branch page shows from configuration.
 * - Everything else has no Terraform.
 */
import type {
  TerraformConfigurationChange,
  TerraformConfigurationEstimate,
  TerraformRoot,
  TerraformScan,
} from "@infrawrench/git-contract";
import { gitOf, type RepositoryRecord } from "./db";
import { terraformOf } from "./terraform-data";

const SCANNED_AT = new Date(Date.now() - 6 * 60_000).toISOString();
const PRICED_AT = new Date(Date.now() - 5 * 60_000).toISOString();

const HOURS = 730;
const round = (amount: number) => Math.round(amount * 100) / 100;

/** One priced line: `count × type`, at an hourly list price. */
function line(
  address: string,
  type: string,
  count: number,
  size: string,
  region: string,
  hourly: number,
) {
  const each = round(hourly * HOURS);
  return {
    address,
    type,
    count,
    monthly: round(each * count),
    detail: `${count} × ${size}, ${region}, on demand, $${each.toFixed(2)} each`,
  };
}

function priced(
  lines: TerraformConfigurationEstimate["lines"],
  rest: Pick<TerraformConfigurationEstimate, "unpriced" | "others">,
): TerraformConfigurationEstimate {
  const sorted = [...lines].sort((a, b) => b.monthly - a.monthly);
  return {
    status: "priced",
    currency: "USD",
    monthlyTotal: round(sorted.reduce((sum, item) => sum + item.monthly, 0)),
    complete: rest.unpriced.length === 0 && !rest.others.some((other) => other.kind === "unknown"),
    lines: sorted,
    pricedAt: PRICED_AT,
    ...rest,
  };
}

const AWS_CONNECT = "priced through a connected AWS account; none is connected";

/** A priced estimate in which nothing has a price: total null, never zero. */
function nothingPriced(
  others: TerraformConfigurationEstimate["others"],
): TerraformConfigurationEstimate {
  return {
    status: "priced",
    currency: "USD",
    monthlyTotal: null,
    complete: !others.some((other) => other.kind === "unknown"),
    lines: [],
    unpriced: [],
    others,
    pricedAt: PRICED_AT,
  };
}

/** What `count = local.x ? 1 : 0` switches off with the variables' defaults. */
const INFRA_INACTIVE = [
  ...[
    "ecr_repository.web",
    "ecr_lifecycle_policy.web",
    "s3_bucket.session_runtime",
    "s3_bucket_public_access_block.session_runtime",
    "s3_object.session_agent",
    "s3_object.session_tunnel_env",
    "iam_role.session",
    "iam_role_policy.session",
    "iam_role_policy_attachment.session_ssm",
    "iam_instance_profile.session",
    "security_group.session",
    "instance.session",
    "ecr_repository.lambda",
    "ecr_lifecycle_policy.lambda",
    "secretsmanager_secret.app_env",
    "secretsmanager_secret_version.app_env",
    "secretsmanager_secret.edge_env",
    "secretsmanager_secret_version.edge_env",
    "vpc.lambda",
    "internet_gateway.lambda",
    "subnet.lambda_public",
    "subnet.lambda_private",
    "eip.lambda_nat",
    "nat_gateway.lambda",
    "route_table.lambda_public",
    "route_table_association.lambda_public",
    "route_table.lambda_private",
    "route_table_association.lambda_private",
    "security_group.lambda",
    "iam_role.lambda",
    "iam_role_policy_attachment.lambda_logs",
    "iam_role_policy_attachment.lambda_vpc",
    "iam_role_policy.lambda_app_env",
    "cloudwatch_log_group.lambda",
    "lambda_function.web",
    "lambda_alias.web_live",
    "lambda_function_url.web",
    "lambda_permission.web_url",
    "lambda_permission.web_url_invoke",
    "lambda_function.poller",
    "iam_role.poller_scheduler",
    "iam_role_policy.poller_scheduler",
    "scheduler_schedule.poller",
    "iam_openid_connect_provider.github",
    "iam_role.lambda_ci",
    "iam_role_policy.lambda_ci",
  ].map((address) => `aws_${address}`),
  ...[
    "identity_compartment.infrawrench",
    "core_vcn.infrawrench",
    "core_internet_gateway.infrawrench",
    "core_route_table.infrawrench",
    "core_security_list.infrawrench",
    "core_subnet.infrawrench",
    "objectstorage_bucket.runtime",
    "objectstorage_preauthrequest.runtime",
    "objectstorage_object.agent",
    "objectstorage_object.runtime_env",
    "objectstorage_object.registry_env",
    "artifacts_container_repository.app",
    "identity_auth_token.ocir",
    "identity_user.ci",
    "identity_group.ci",
    "identity_user_group_membership.ci",
    "identity_policy.ci",
    "identity_api_key.ci",
    "core_instance.watcher",
  ].map((address) => `oci_${address}`),
];

function monorepoRoots(): TerraformRoot[] {
  const terraform: TerraformRoot = {
    path: "infra/terraform",
    reasons: ["provider-block"],
    workspaces: [],
    suggestedWorkspace: "infra-terraform",
    backend: null,
    requiredVersion: ">= 1.6",
    providers: [
      {
        name: "aws",
        source: "hashicorp/aws",
        version: "~> 6.20",
        configured: true,
        resources: 47,
        dataSources: 3,
      },
      {
        name: "oci",
        source: "oracle/oci",
        version: "~> 9.9",
        configured: true,
        resources: 19,
        dataSources: 3,
      },
      {
        name: "google",
        source: "hashicorp/google",
        version: "~> 6.20",
        configured: true,
        resources: 6,
        dataSources: 1,
      },
      {
        name: "random",
        source: "hashicorp/random",
        version: "~> 3.6",
        configured: false,
        resources: 1,
        dataSources: 0,
      },
      {
        name: "tls",
        source: "hashicorp/tls",
        version: "~> 4.0",
        configured: false,
        resources: 1,
        dataSources: 0,
      },
    ],
    modules: [],
    localModules: [],
    resourceCount: 74,
    dataSourceCount: 7,
    resourceTypes: [
      { type: "aws_iam_role", count: 4 },
      { type: "aws_iam_role_policy", count: 4 },
      { type: "oci_objectstorage_object", count: 3 },
      { type: "aws_iam_role_policy_attachment", count: 3 },
      { type: "aws_ecr_lifecycle_policy", count: 2 },
      { type: "aws_ecr_repository", count: 2 },
      { type: "aws_lambda_function", count: 2 },
      { type: "aws_lambda_permission", count: 2 },
      { type: "aws_route_table", count: 2 },
      { type: "aws_route_table_association", count: 2 },
      { type: "aws_s3_object", count: 2 },
      { type: "aws_secretsmanager_secret", count: 2 },
      { type: "aws_instance", count: 1 },
      { type: "aws_nat_gateway", count: 1 },
      { type: "oci_core_instance", count: 1 },
    ],
    variableCount: 31,
    requiredVariables: ["project_id", "oci_tenancy_ocid"],
    outputCount: 14,
    lockFile: true,
    tfvarsFiles: [],
    usesWorkspace: false,
    unreadable: [],
    inactiveResources: INFRA_INACTIVE.length,
    inactiveAddresses: INFRA_INACTIVE,
    // With the values the repository holds, every priced feature is switched off.
    estimate: nothingPriced([
      { type: "google_artifact_registry_repository", count: 1, kind: "usage" },
      { type: "google_project_service", count: 3, kind: "free" },
      { type: "google_artifact_registry_repository_iam_member", count: 1, kind: "free" },
      { type: "google_iam_workload_identity_pool", count: 1, kind: "free" },
      { type: "google_iam_workload_identity_pool_provider", count: 1, kind: "free" },
      { type: "google_service_account", count: 1, kind: "free" },
      { type: "google_service_account_iam_member", count: 1, kind: "free" },
    ]),
  };
  const ciRunners: TerraformRoot = {
    path: "infra/ci-runners",
    reasons: ["unreferenced"],
    workspaces: [],
    suggestedWorkspace: "infra-ci-runners",
    backend: null,
    requiredVersion: ">= 1.6",
    providers: [],
    modules: [],
    localModules: [],
    resourceCount: 2,
    dataSourceCount: 0,
    resourceTypes: [{ type: "terraform_data", count: 2 }],
    variableCount: 14,
    requiredVariables: ["hosts", "proxy_url"],
    outputCount: 0,
    lockFile: false,
    tfvarsFiles: ["terraform.tfvars.example"],
    usesWorkspace: false,
    unreadable: [],
    inactiveResources: 0,
    inactiveAddresses: [],
    estimate: nothingPriced([]),
  };
  return [ciRunners, terraform];
}

/** `acme/infra`'s roots: the two environments (workspaces) and `bootstrap` (none). */
function acmeRoots(repo: RepositoryRecord): TerraformRoot[] {
  const workspacesOn = (path: string) =>
    terraformOf(repo)
      .workspaces.filter((item) => item.rootPath === path)
      .map((item) => item.name);
  const environment = (name: string, instances: number): TerraformRoot => ({
    path: `environments/${name}`,
    reasons: ["backend"],
    workspaces: workspacesOn(`environments/${name}`),
    suggestedWorkspace: name,
    backend: {
      type: "http",
      settings: [
        {
          name: "address",
          value: `https://git.infrawrench.com/acme/infra/terraform/${name}/state`,
        },
      ],
    },
    requiredVersion: ">= 1.9",
    providers: [
      {
        name: "aws",
        source: "hashicorp/aws",
        version: "~> 6.20",
        configured: true,
        resources: 28,
        dataSources: 2,
      },
    ],
    modules: [
      {
        name: "network",
        source: "../../modules/network",
        version: null,
        localPath: "modules/network",
      },
      {
        name: "cluster",
        source: "../../modules/cluster",
        version: null,
        localPath: "modules/cluster",
      },
      {
        name: "database",
        source: "../../modules/database",
        version: null,
        localPath: "modules/database",
      },
    ],
    localModules: ["modules/network", "modules/cluster", "modules/database"],
    resourceCount: 28,
    dataSourceCount: 2,
    resourceTypes: [
      { type: "aws_subnet", count: 6 },
      { type: "aws_route_table", count: 4 },
      { type: "aws_eks_node_group", count: 1 },
      { type: "aws_db_instance", count: 1 },
      { type: "aws_nat_gateway", count: 1 },
    ],
    variableCount: 6,
    requiredVariables: [],
    outputCount: 4,
    lockFile: true,
    tfvarsFiles: [`${name}.auto.tfvars`],
    usesWorkspace: false,
    unreadable: [],
    inactiveResources: 0,
    inactiveAddresses: [],
    estimate: priced(
      [
        line(
          "module.cluster.aws_eks_node_group.default",
          "aws_eks_node_group",
          instances,
          "m6i.large",
          "eu-west-1",
          0.107,
        ),
        line(
          "module.database.aws_db_instance.main",
          "aws_db_instance",
          1,
          "db.r6g.large",
          "eu-west-1",
          0.258,
        ),
      ],
      { unpriced: [], others: [{ type: "aws_subnet", count: 6, kind: "free" }] },
    ),
  });
  const bootstrap: TerraformRoot = {
    path: "bootstrap",
    reasons: ["provider-block"],
    workspaces: [],
    suggestedWorkspace: "bootstrap",
    backend: {
      type: "s3",
      settings: [
        { name: "bucket", value: "acme-terraform-state" },
        { name: "key", value: "bootstrap.tfstate" },
        { name: "region", value: "eu-west-1" },
      ],
    },
    requiredVersion: null,
    providers: [
      {
        name: "aws",
        source: "hashicorp/aws",
        version: "~> 6.20",
        configured: true,
        resources: 5,
        dataSources: 0,
      },
    ],
    modules: [],
    localModules: [],
    resourceCount: 5,
    dataSourceCount: 0,
    resourceTypes: [
      { type: "aws_s3_bucket", count: 2 },
      { type: "aws_instance", count: 1 },
      { type: "aws_dynamodb_table", count: 1 },
      { type: "aws_kms_key", count: 1 },
    ],
    variableCount: 2,
    requiredVariables: [],
    outputCount: 2,
    lockFile: false,
    tfvarsFiles: [],
    usesWorkspace: false,
    unreadable: [],
    inactiveResources: 1,
    inactiveAddresses: ["aws_instance.break_glass"],
    estimate: priced(
      [line("aws_instance.bastion", "aws_instance", 1, "t3.micro", "eu-west-1", 0.0114)],
      {
        unpriced: [
          {
            address: "aws_kms_key.state",
            type: "aws_kms_key",
            reason: "priced through a connected AWS account; none is connected",
          },
        ],
        others: [
          { type: "aws_s3_bucket", count: 2, kind: "usage" },
          { type: "aws_dynamodb_table", count: 1, kind: "usage" },
        ],
      },
    ),
  };
  return [bootstrap, environment("production", 6), environment("staging", 2)];
}

function rootsOf(repo: RepositoryRecord): TerraformRoot[] {
  switch (`${repo.owner.slug}/${repo.name}`) {
    case "mara/repo-testing":
      return monorepoRoots();
    case "acme/infra":
      return acmeRoots(repo);
    default:
      return [];
  }
}

export function scanOf(repo: RepositoryRecord, ref?: string): TerraformScan {
  const fx = gitOf(repo);
  const commitOid = fx.branches[ref ?? repo.defaultBranch] ?? fx.branches[fx.defaultBranch]!;
  return {
    commitOid,
    roots: rootsOf(repo),
    moduleCount: `${repo.owner.slug}/${repo.name}` === "acme/infra" ? 3 : 0,
    truncated: false,
    scannedAt: SCANNED_AT,
  };
}

/**
 * A branch page's change from configuration: `acme/infra`'s pages move
 * `bootstrap`'s bastion up a size. The environments have plans, which win.
 */
export function configurationChangeOf(
  repo: RepositoryRecord,
  page: { baseRef: string; headRef: string },
): TerraformConfigurationChange {
  const fx = gitOf(repo);
  const headOid = fx.branches[page.headRef] ?? fx.branches[fx.defaultBranch]!;
  const baseOid = fx.branches[page.baseRef] ?? null;
  if (`${repo.owner.slug}/${repo.name}` === "mara/repo-testing") {
    const session = line(
      "aws_instance.session",
      "aws_instance",
      2,
      "t4g.medium",
      "us-east-2",
      0.0336,
    );
    return {
      baseOid,
      headOid,
      roots: [
        {
          path: "infra/terraform",
          workspace: null,
          status: "priced",
          currency: "USD",
          monthlyBefore: null,
          monthlyAfter: session.monthly,
          monthlyDelta: session.monthly,
          complete: false,
          lines: [
            {
              address: session.address,
              type: session.type,
              monthlyBefore: null,
              monthlyAfter: session.monthly,
              monthlyDelta: session.monthly,
            },
          ],
          unpriced: [
            { address: "aws_nat_gateway.lambda", type: "aws_nat_gateway", reason: AWS_CONNECT },
            { address: "aws_eip.lambda_nat", type: "aws_eip", reason: AWS_CONNECT },
          ],
        },
      ],
    };
  }
  if (`${repo.owner.slug}/${repo.name}` !== "acme/infra") return { baseOid, headOid, roots: [] };
  const before = round(0.0114 * HOURS);
  const after = round(0.0228 * HOURS);
  return {
    baseOid,
    headOid,
    roots: [
      {
        path: "bootstrap",
        workspace: null,
        status: "priced",
        currency: "USD",
        monthlyBefore: before,
        monthlyAfter: after,
        monthlyDelta: round(after - before),
        complete: false,
        lines: [
          {
            address: "aws_instance.bastion",
            type: "aws_instance",
            monthlyBefore: before,
            monthlyAfter: after,
            monthlyDelta: round(after - before),
          },
        ],
        unpriced: [
          {
            address: "aws_ebs_volume.scratch",
            type: "aws_ebs_volume",
            reason: "priced through a connected AWS account; none is connected",
          },
        ],
      },
    ],
  };
}
