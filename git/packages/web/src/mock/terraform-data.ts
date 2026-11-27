/**
 * The mock's Terraform workspaces: `acme/infra` has one per environment, each
 * with runs (plans on branches, applies on merge), state versions and
 * the resources its state manages, matched to Infrawrench resources with
 * what they cost.
 */
import type { UserRef } from "@infrawrench/git-contract";
import type {
  TerraformAccount,
  TerraformAction,
  TerraformCostDelta,
  TerraformLock,
  TerraformManagedResource,
  TerraformPlanSummary,
  TerraformResourceChange,
  TerraformRoot,
  TerraformRun,
  TerraformStateVersion,
  TerraformWorkspace,
} from "@infrawrench/git-contract";
import { notFound, type Mutable } from "./define";
import { APP_URL, accessTo, gitOf, type RepositoryRecord } from "./db";
import { flatten } from "./git";
import { hoursAgo, newId, person } from "./settings-data";

export interface WorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  branch: string | null;
  terraformVersion: string | null;
  planOnBranch: boolean;
  applyOnMerge: boolean;
  applyRequiresApproval: boolean;
  accounts: TerraformAccount[];
  lock: TerraformLock | null;
  versions: Array<Mutable<TerraformStateVersion>>;
  resources: TerraformManagedResource[];
  drifted: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Store {
  workspaces: WorkspaceRecord[];
  runs: Array<Mutable<TerraformRun>>;
}

export const ACCOUNTS: TerraformAccount[] = [
  { accountId: "acc_aws_prod", name: "acme-production", pluginId: "aws", pluginName: "AWS" },
  { accountId: "acc_aws_staging", name: "acme-staging", pluginId: "aws", pluginName: "AWS" },
  { accountId: "acc_cf", name: "acme.example", pluginId: "cloudflare", pluginName: "Cloudflare" },
  { accountId: "acc_aws_shared", name: "shared-services", pluginId: "aws", pluginName: "AWS" },
];

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]';

type ResourceSeed = [
  address: string,
  appType: string | null,
  appName: string | null,
  monthly: number | null,
  drift?: "in_sync" | "drifted" | "missing",
];

function resources(env: "staging" | "production", scale: number): TerraformManagedResource[] {
  const name = `acme-${env}`;
  const accountId = env === "production" ? "acc_aws_prod" : "acc_aws_staging";
  const seeds: ResourceSeed[] = [
    ["data.aws_availability_zones.available", null, null, null],
    ["module.cluster.aws_eks_cluster.this", "eks-cluster", name, 73.0],
    [
      "module.cluster.aws_eks_node_group.workers",
      "eks-node-group",
      `${name}-workers`,
      119.14 * scale,
      env === "production" ? "drifted" : "in_sync",
    ],
    ["module.cluster.aws_iam_role.cluster", "iam-role", `${name}-cluster`, 0],
    ["module.cluster.aws_iam_role.nodes", "iam-role", `${name}-nodes`, 0],
    ["module.database.aws_rds_cluster.this", "rds-cluster", name, 43.8 * scale],
    ["module.database.aws_rds_cluster_instance.this[0]", "rds-instance", `${name}-0`, 189.8],
    [
      "module.database.aws_secretsmanager_secret.master",
      "secrets-manager-secret",
      `${name}/master`,
      0.4,
    ],
    ["module.network.aws_eip.nat[0]", null, null, null],
    ["module.network.aws_eip.nat[1]", null, null, null],
    ["module.network.aws_eip.nat[2]", null, null, null],
    ["module.network.aws_flow_log.this[0]", null, null, null],
    ["module.network.aws_internet_gateway.this", "internet-gateway", name, 0],
    ["module.network.aws_nat_gateway.this[0]", "nat-gateway", `${name}-a`, 32.85 + 13.7 * scale],
    ["module.network.aws_nat_gateway.this[1]", "nat-gateway", `${name}-b`, 32.85 + 13.7 * scale],
    ["module.network.aws_nat_gateway.this[2]", "nat-gateway", `${name}-c`, 32.85 + 13.7 * scale],
    ["module.network.aws_route_table.private[0]", null, null, null],
    ["module.network.aws_route_table.private[1]", null, null, null],
    ["module.network.aws_route_table.private[2]", null, null, null],
    ["module.network.aws_subnet.private[0]", "subnet", `${name}-private-a`, 0],
    ["module.network.aws_subnet.private[1]", "subnet", `${name}-private-b`, 0],
    ["module.network.aws_subnet.private[2]", "subnet", `${name}-private-c`, 0],
    ["module.network.aws_vpc.this", "vpc", name, 0],
    ...(env === "production"
      ? ([
          ["aws_budgets_budget.monthly", null, null, null],
          ["aws_route53_zone.edge", "route53-hosted-zone", "edge.acme.example", 0.5, "in_sync"],
        ] as ResourceSeed[])
      : []),
  ];
  return seeds
    .map(([address, appType, appName, monthly, drift]): TerraformManagedResource => {
      const parts = address.replace(/\[\d+\]$/, "").split(".");
      const data = parts[0] === "data";
      const module = parts[0] === "module" ? `module.${parts[1]}` : null;
      const type = parts[parts.length - 2]!;
      const local = address.split(".").pop()!;
      const externalId = `${type.replace(/^aws_/, "")}-${Math.abs(hash(address + env))
        .toString(16)
        .padStart(8, "0")}`;
      return {
        address,
        mode: data ? "data" : "managed",
        type,
        name: local.replace(/\[\d+\]$/, ""),
        module,
        provider: AWS,
        providerId: data ? null : externalId,
        infrawrench:
          appType === null || appName === null
            ? null
            : {
                resourceId: `aws:${accountId}:${externalId}`,
                name: appName,
                pluginId: "aws",
                resourceTypeId: appType,
                appUrl: `${APP_URL}/org/org_acme/resources/${encodeURIComponent(
                  `aws:${accountId}:${externalId}`,
                )}`,
              },
        monthlyCost:
          monthly === null || appType === null
            ? null
            : { amount: Math.round(monthly * 100) / 100, currency: "USD" },
        drift: appType === null ? null : (drift ?? "in_sync"),
      };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (Math.imul(value, 31) + char.charCodeAt(0)) | 0;
  return value;
}

function versions(
  count: number,
  top: number,
  resourceCount: number,
  runIds: Array<string | null>,
): Array<Mutable<TerraformStateVersion>> {
  const lineage =
    top > 50 ? "6f1c2b9e-52a7-4d0c-9f3e-0b7a3d51c8e2" : "c94e7a10-8d3b-4f6a-b2c1-7e5f9a0d4b36";
  return Array.from({ length: count }, (_, index) => {
    const serial = top - index;
    const runId = runIds[index] ?? null;
    return {
      id: `sv_${top > 50 ? "p" : "s"}_${serial}`,
      serial,
      lineage,
      sha256: Math.abs(hash(`${lineage}${serial}`))
        .toString(16)
        .padStart(8, "0")
        .repeat(4),
      sizeBytes: 48_200 + resourceCount * 1730 - index * 911,
      resourceCount: resourceCount - (index > 3 ? 2 : 0),
      terraformVersion: index > 5 ? "1.9.8" : "1.10.3",
      createdAt: hoursAgo(index === 0 ? 30 : 30 + index * 61),
      createdBy: runId === null ? person(index % 2 === 0 ? "mara" : "jonas") : null,
      runId,
      current: index === 0,
    };
  });
}

const change = (
  address: string,
  action: TerraformAction,
  changedAttributes: string[] = [],
): TerraformResourceChange => {
  const parts = address.replace(/\[[^\]]+\]$/, "").split(".");
  return {
    address,
    type: parts[parts.length - 2]!,
    name: parts[parts.length - 1]!,
    module: parts[0] === "module" ? `module.${parts[1]}` : null,
    provider: AWS,
    action,
    changedAttributes,
  };
};

function plan(changes: TerraformResourceChange[], outputChanges = 0): TerraformPlanSummary {
  const count = (...actions: TerraformAction[]) =>
    changes.filter((item) => actions.includes(item.action)).length;
  return {
    add: count("create", "replace"),
    change: count("update"),
    destroy: count("delete", "replace"),
    replace: count("replace"),
    import: 0,
    hasChanges: changes.some((item) => item.action !== "no-op" && item.action !== "read"),
    resourceChanges: changes,
    resourceChangesTruncated: false,
    outputChanges,
  };
}

function cost(
  before: number,
  lines: Array<[address: string, action: TerraformAction, was: number | null, now: number | null]>,
  unpriced = 0,
): TerraformCostDelta {
  const delta = lines.reduce((sum, [, , was, now]) => sum + ((now ?? 0) - (was ?? 0)), 0);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    currency: "USD",
    monthlyBefore: round(before),
    monthlyAfter: round(before + delta),
    monthlyDelta: round(delta),
    unpriced,
    lines: lines.map(([address, action, was, now]) => ({
      address,
      type: address
        .replace(/\[[^\]]+\]$/, "")
        .split(".")
        .slice(-2)[0]!,
      action,
      monthlyBefore: was,
      monthlyAfter: now,
      monthlyDelta: round((now ?? 0) - (was ?? 0)),
    })),
  };
}

const stores = new Map<string, Store>();

const sumCost = (items: TerraformManagedResource[]): number =>
  Math.round(items.reduce((sum, item) => sum + (item.monthlyCost?.amount ?? 0), 0) * 100) / 100;

function seedInfra(repo: RepositoryRecord): Store {
  const fx = gitOf(repo);
  const oidOf = (prefix: string): string => fx.order.find((oid) => oid.startsWith(prefix)) ?? "";
  const staging = resources("staging", 2);
  const production = resources("production", 8);
  const run = (
    workspace: { id: string; name: string },
    fields: Partial<Mutable<TerraformRun>> &
      Pick<TerraformRun, "operation" | "trigger" | "status" | "commitOid" | "ref">,
    hours: number,
    seconds = 74,
  ): Mutable<TerraformRun> => {
    const waiting = fields.status === "queued";
    const going = fields.status === "planning" || fields.status === "applying";
    return {
      id: newId("tfrun"),
      workspace,
      statusReason: null,
      branchPage: null,
      actor: null,
      approvedBy: null,
      createdAt: hoursAgo(hours),
      startedAt: waiting ? null : hoursAgo(hours - 0.01),
      finishedAt:
        waiting || going || fields.status === "awaiting_approval"
          ? null
          : new Date(Date.now() - hours * 3_600_000 + seconds * 1000).toISOString(),
      plan: null,
      costDelta: null,
      ciRunId: null,
      stateVersionId: null,
      ...fields,
    };
  };
  const ws = {
    staging: { id: "ws_staging", name: "staging" },
    production: { id: "ws_production", name: "production" },
  };
  const stagingCost = sumCost(staging);
  const productionCost = sumCost(production);
  const peering = [
    change('module.network.aws_vpc_peering_connection.shared["shared"]', "create"),
    change('module.network.aws_route.peer["shared-0"]', "create"),
    change('module.network.aws_route.peer["shared-1"]', "create"),
    change('module.network.aws_route.peer["shared-2"]', "create"),
  ];
  const runs: Array<Mutable<TerraformRun>> = [
    run(
      ws.production,
      {
        operation: "apply",
        trigger: "merge",
        status: "awaiting_approval",
        commitOid: oidOf("22794c7"),
        ref: "main",
        actor: person("mara"),
        plan: plan([
          change("aws_budgets_budget.monthly", "update", ["limit_amount", "notification"]),
          change("module.cluster.aws_eks_node_group.workers", "update", ["scaling_config"]),
        ]),
        costDelta: cost(productionCost, [
          ["module.cluster.aws_eks_node_group.workers", "update", 953.12, 1191.4],
          ["aws_budgets_budget.monthly", "update", 0, 0],
        ]),
      },
      34,
    ),
    run(
      ws.staging,
      {
        operation: "apply",
        trigger: "merge",
        status: "applied",
        commitOid: oidOf("22794c7"),
        ref: "main",
        actor: person("mara"),
        plan: plan([change("aws_budgets_budget.monthly", "create")]),
        costDelta: cost(stagingCost, [["aws_budgets_budget.monthly", "create", null, 0]]),
        stateVersionId: "sv_s_43",
      },
      34,
      58,
    ),
    run(
      ws.staging,
      {
        operation: "plan",
        trigger: "branch",
        status: "planned",
        commitOid: fx.branches["feature/vpc-peering"]!,
        ref: "feature/vpc-peering",
        branchPage: "feature/vpc-peering",
        actor: person("jonas"),
        plan: plan(peering, 1),
        costDelta: cost(
          stagingCost,
          [
            ['module.network.aws_vpc_peering_connection.shared["shared"]', "create", null, 0],
            ["module.network.aws_nat_gateway.this[0]", "no-op", 60.25, 46.55],
            ["module.network.aws_nat_gateway.this[1]", "no-op", 60.25, 46.55],
            ["module.network.aws_nat_gateway.this[2]", "no-op", 60.25, 46.55],
          ],
          3,
        ),
      },
      38,
    ),
    run(
      ws.production,
      {
        operation: "plan",
        trigger: "branch",
        status: "no_changes",
        commitOid: fx.branches["feature/vpc-peering"]!,
        ref: "feature/vpc-peering",
        branchPage: "feature/vpc-peering",
        actor: person("jonas"),
        plan: plan([]),
        costDelta: cost(productionCost, []),
      },
      38,
      41,
    ),
    run(
      ws.staging,
      {
        operation: "plan",
        trigger: "branch",
        status: "discarded",
        statusReason: "A newer plan replaced it",
        commitOid: fx.commits[fx.branches["feature/vpc-peering"]!]!.parents[0]!,
        ref: "feature/vpc-peering",
        branchPage: "feature/vpc-peering",
        actor: person("jonas"),
        plan: plan(peering),
      },
      47,
    ),
    run(
      ws.staging,
      {
        operation: "plan",
        trigger: "branch",
        status: "planned",
        commitOid: fx.branches["fix/database-backups"]!,
        ref: "fix/database-backups",
        branchPage: "fix/database-backups",
        actor: person("priya"),
        plan: plan([
          change("module.database.aws_rds_cluster.this", "update", ["backup_retention_period"]),
        ]),
        costDelta: cost(stagingCost, [
          ["module.database.aws_rds_cluster.this", "update", 87.6, 99.0],
        ]),
      },
      52,
    ),
    run(
      ws.production,
      {
        operation: "plan",
        trigger: "branch",
        status: "no_changes",
        commitOid: fx.branches["fix/database-backups"]!,
        ref: "fix/database-backups",
        branchPage: "fix/database-backups",
        actor: person("priya"),
        plan: plan([]),
        costDelta: cost(productionCost, []),
      },
      52,
      39,
    ),
    run(
      ws.production,
      {
        operation: "apply",
        trigger: "merge",
        status: "applied",
        commitOid: oidOf("5663027"),
        ref: "main",
        actor: person("mara"),
        approvedBy: person("priya"),
        plan: plan([
          change("module.cluster.aws_eks_node_group.workers", "update", ["scaling_config"]),
        ]),
        costDelta: cost(productionCost - 238.28, [
          ["module.cluster.aws_eks_node_group.workers", "update", 714.84, 953.12],
        ]),
        stateVersionId: "sv_p_57",
      },
      24 * 5,
      312,
    ),
    run(
      ws.staging,
      {
        operation: "plan",
        trigger: "drift",
        status: "no_changes",
        commitOid: oidOf("5663027"),
        ref: "main",
        plan: plan([]),
      },
      24 * 5.5,
      44,
    ),
    run(
      ws.staging,
      {
        operation: "apply",
        trigger: "merge",
        status: "errored",
        statusReason:
          "Error: creating EC2 Flow Log: InvalidParameter: LogDestination: acme-staging-flow-logs does not exist",
        commitOid: oidOf("2832462"),
        ref: "main",
        actor: person("mara"),
        plan: plan([change("module.network.aws_flow_log.this[0]", "create")]),
      },
      24 * 8.6,
      27,
    ),
    run(
      ws.staging,
      {
        operation: "apply",
        trigger: "manual",
        status: "applied",
        commitOid: oidOf("2832462"),
        ref: "main",
        actor: person("jonas"),
        plan: plan([change("module.network.aws_flow_log.this[0]", "create")]),
        costDelta: cost(stagingCost - 7.2, [
          ["module.network.aws_flow_log.this[0]", "create", null, 7.2],
        ]),
        stateVersionId: "sv_s_41",
      },
      24 * 8.5,
      63,
    ),
    run(
      ws.production,
      {
        operation: "plan",
        trigger: "manual",
        status: "cancelled",
        statusReason: "Cancelled before it started",
        commitOid: oidOf("c88c321"),
        ref: "main",
        actor: person("priya"),
      },
      24 * 9,
      2,
    ),
  ];
  const idsFor = (name: string) =>
    runs.filter((item) => item.workspace.name === name && item.stateVersionId !== null);
  const workspace = (
    env: "staging" | "production",
    items: TerraformManagedResource[],
    top: number,
  ): WorkspaceRecord => ({
    id: ws[env].id,
    name: env,
    rootPath: `environments/${env}`,
    branch: null,
    terraformVersion: null,
    planOnBranch: true,
    applyOnMerge: true,
    applyRequiresApproval: env === "production",
    accounts: env === "production" ? [ACCOUNTS[0]!, ACCOUNTS[2]!] : [ACCOUNTS[1]!],
    lock:
      env === "staging"
        ? {
            id: "0c2f7a51-3be9-4d86-a1f4-6e08d2b95c73",
            operation: "OperationTypePlan",
            who: "jonas@jonas-mbp",
            holder: person("jonas"),
            runId: null,
            createdAt: hoursAgo(0.2),
          }
        : null,
    versions: versions(9, top, items.length, [
      idsFor(env)[0]?.id ?? null,
      null,
      idsFor(env)[1]?.id ?? null,
      null,
      null,
    ]),
    resources: items,
    drifted: items.filter((item) => item.drift === "drifted").length,
    createdAt: hoursAgo(24 * 21),
    updatedAt: hoursAgo(30),
  });
  return {
    workspaces: [workspace("production", production, 57), workspace("staging", staging, 43)],
    runs,
  };
}

export function terraformOf(repo: RepositoryRecord): Store {
  let store = stores.get(repo.id);
  if (!store) {
    store =
      `${repo.owner.slug}/${repo.name}` === "acme/infra"
        ? seedInfra(repo)
        : { workspaces: [], runs: [] };
    stores.set(repo.id, store);
  }
  return store;
}

export function findWorkspace(repo: RepositoryRecord, name: string): WorkspaceRecord {
  const found = terraformOf(repo).workspaces.find((item) => item.name === name);
  if (!found) throw notFound("Workspace not found");
  return found;
}

function lastRunOf(repo: RepositoryRecord, store: Store, item: WorkspaceRecord) {
  const last = store.runs
    .filter((run) => run.workspace.id === item.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return last === undefined ? null : toRun(repo, last);
}

export function toWorkspace(
  repo: RepositoryRecord,
  item: WorkspaceRecord,
  origin: string,
): TerraformWorkspace {
  const store = terraformOf(repo);
  const total = sumCost(item.resources);
  return {
    id: item.id,
    name: item.name,
    rootPath: item.rootPath,
    branch: item.branch ?? repo.defaultBranch,
    terraformVersion: item.terraformVersion,
    planOnBranch: item.planOnBranch,
    applyOnMerge: item.applyOnMerge,
    applyRequiresApproval: item.applyRequiresApproval,
    accounts: item.accounts,
    stateAddress: `${origin}/${repo.owner.slug}/${repo.name}/terraform/${item.name}/state`,
    lock: item.lock,
    currentState: item.versions.find((version) => version.current) ?? null,
    resourceCount: item.resources.filter((resource) => resource.mode === "managed").length,
    monthlyCost:
      item.resources.some((resource) => resource.monthlyCost !== null) && item.accounts.length > 0
        ? { amount: total, currency: "USD" }
        : null,
    matchedResourceCount: item.resources.filter(
      (resource) => resource.mode === "managed" && resource.infrawrench !== null,
    ).length,
    driftedCount: item.accounts.length === 0 ? null : item.drifted,
    lastRun: lastRunOf(repo, store, item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Directories of the default branch that hold a root module: a `terraform {}` block with a backend. */
export function rootsOf(repo: RepositoryRecord, ref?: string): TerraformRoot[] {
  if (repo.fixture === null) return [];
  const fx = gitOf(repo);
  const oid = fx.branches[ref ?? repo.defaultBranch] ?? fx.branches[fx.defaultBranch]!;
  const found = new Map<string, string | null>();
  for (const [path, [, blobOid]] of flatten(fx, oid)) {
    if (!path.endsWith(".tf")) continue;
    const blob = fx.blobs[blobOid];
    if (!blob || blob.binary) continue;
    const backend = /backend\s+"([a-z0-9_]+)"/.exec(blob.text);
    if (!/^\s*terraform\s*\{/m.test(blob.text) || !/provider\s+"|backend\s+"/.test(blob.text)) {
      continue;
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    found.set(dir, backend?.[1] ?? found.get(dir) ?? null);
  }
  const store = terraformOf(repo);
  return [...found]
    .map(([path, backend]) => ({
      path,
      backend,
      workspaces: store.workspaces
        .filter((item) => item.rootPath === path)
        .map((item) => item.name),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A run as the API serves it to this viewer: `viewerCanApprove` on one that
 * waits, for an administrator of the repository (the mock has no `ci:approve`).
 */
export function toRun(repo: RepositoryRecord, run: TerraformRun): TerraformRun {
  return run.status === "awaiting_approval"
    ? { ...run, viewerCanApprove: accessTo(repo) === "admin" && !repo.archived }
    : run;
}

/** Writes an older version's document again as the newest one, as `restoreVersion` does. */
export function restoreVersion(
  repo: RepositoryRecord,
  name: string,
  versionId: string,
  by: UserRef,
): TerraformStateVersion {
  const item = findWorkspace(repo, name);
  const source = item.versions.find((version) => version.id === versionId);
  if (!source) throw notFound("State version not found");
  const top = Math.max(...item.versions.map((version) => version.serial));
  for (const version of item.versions) version.current = false;
  const restored = {
    ...source,
    id: newId("sv"),
    serial: top + 1,
    createdAt: new Date().toISOString(),
    createdBy: by,
    runId: null,
    current: true,
  };
  item.versions.unshift(restored);
  return restored;
}

/** A stand-in for a state document: the mock has no real state to hand out. */
export function stateDocument(repo: RepositoryRecord, name: string, versionId: string): string {
  const item = findWorkspace(repo, name);
  const version = item.versions.find((entry) => entry.id === versionId);
  if (!version) throw notFound("State version not found");
  return JSON.stringify(
    {
      version: 4,
      terraform_version: version.terraformVersion,
      serial: version.serial,
      lineage: version.lineage,
      outputs: {},
      resources: item.resources.map((resource) => ({
        mode: resource.mode,
        type: resource.type,
        name: resource.name,
        ...(resource.module === null ? {} : { module: resource.module }),
        provider: resource.provider,
        instances: [],
      })),
    },
    null,
    2,
  );
}
