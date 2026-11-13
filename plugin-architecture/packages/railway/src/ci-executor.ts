/**
 * CI jobs on Railway: a throwaway project per job, holding one service that
 * deploys an image once with restart policy `NEVER`, deleted when the job
 * ends.
 *
 * A Railway service with `restartPolicyType: NEVER` runs its start command
 * once: Railway does not restart it when it exits, a deployment that exits 0
 * stays `SUCCESS` with its instances stopped and one that exits otherwise
 * ends `CRASHED`. Railway bills the CPU and memory a container uses, by the
 * minute, so a container that has exited costs nothing more; that is what
 * makes this a run to completion rather than a long-running service. The
 * project is the job's, so deleting it is the whole teardown.
 *
 * **Wire shapes verified against Railway's public GraphQL schema
 * (introspected from `backboard.railway.com/graphql/v2`) and
 * docs.railway.com ("Manage projects", "Manage services", "Deployment
 * actions", "Restart policy", "Build and start commands", "Regions",
 * "Pricing"), November 2026:**
 * - `projectCreate(input: { name, description, workspaceId,
 *   defaultEnvironmentName })`, `projectDelete(id)`, `projects(workspaceId,
 *   first, after)` with `description`, `createdAt`, `deployments(first)`.
 *   Projects and services have no tags, so the project's name is the mark
 *   and its description keeps the tags as JSON.
 * - `serviceCreate(input: { projectId, environmentId, name, variables })`
 *   with no source, so nothing deploys before it is set up;
 *   `serviceInstanceUpdate(serviceId, environmentId, input: { source:
 *   { image }, startCommand, restartPolicyType, region })`;
 *   `serviceInstanceLimitsUpdate(input: { serviceId, environmentId, vCPUs,
 *   memoryGB })`; `serviceInstanceDeployV2(serviceId, environmentId)`
 *   answering the deployment id.
 * - `deployment(id) { status deploymentStopped }`, `DeploymentStatus`
 *   `BUILDING CRASHED DEPLOYING FAILED INITIALIZING NEEDS_APPROVAL QUEUED
 *   REMOVED REMOVING SKIPPED SLEEPING SUCCESS WAITING`.
 *
 * Railway has no run-time limit, so the container's main process is
 * `ciContainerCommand`'s watchdog. The start command wraps itself in
 * `/bin/sh -c`, as Railway's docs say to, and takes the script from a
 * base64 service variable (`${{ }}` is Railway's reference syntax, which
 * base64 never contains). A container gets `RAILWAY_*` names and domains,
 * never a token.
 */
import {
  CI_JOB_TAG,
  ciBootstrapWithTools,
  ciComputeKey,
  ciContainerCommand,
  ciShellQuote,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";
import { nodes, type RailwayApi } from "./api.js";
import { RailwayApiError } from "./kit.js";
import { credentialWorkspaces } from "./oauth.js";

export const CI_DEFAULT_MACHINE = "2vcpu-4gb";
/** Docker's official image: Ubuntu 24.04 with curl. */
export const CI_DEFAULT_IMAGE = "buildpack-deps:noble-curl";
/** The service variable that holds the job's script, as base64. */
export const CI_SCRIPT_VAR = "INFRAWRENCH_CI_JOB";
const PROJECT_PREFIX = "iwci-";
const SERVICE_NAME = "job";
const ENVIRONMENT_NAME = "ci";
/** Projects read per page, and the most pages a lookup reads. */
const PAGE = 100;
const MAX_PAGES = 50;

/** The service's start command: decode the script, then run it as the main process. */
export const START_COMMAND = `/bin/sh -c "echo $${CI_SCRIPT_VAR} | base64 -d > /tmp/iwci-job.sh && exec /bin/sh /tmp/iwci-job.sh"`;

export const RAILWAY_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "One-off deployment in a throwaway project",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE },
      // Not documented: an image pull and a deployment.
      typicalStartSeconds: 30,
      // Railway bills CPU and memory by the minute.
      minimumBillingSeconds: 60,
      machineSuggestions: ["1vcpu-1gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb", "16vcpu-32gb"],
    },
  ],
  helpLink: {
    label: "Use an account or workspace token from a workspace member who can create projects",
    url: "https://docs.railway.com/integrations/api",
  },
} as const satisfies CiExecutorDeclaration;

const Q_PROJECTS = `query CiProjects($workspaceId: String, $after: String) {
  projects(workspaceId: $workspaceId, first: ${PAGE}, after: $after) {
    edges { node { id name description createdAt
      deployments(first: 1) { edges { node { id status deploymentStopped } } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const Q_PROJECT = `query CiProject($id: String!) {
  project(id: $id) {
    id
    environments(first: 5) { edges { node { id name } } }
    services(first: 5) { edges { node { id name } } }
    deployments(first: 1) { edges { node { id status deploymentStopped } } }
  }
}`;
const Q_DEPLOYMENT = `query CiDeployment($id: String!) {
  deployment(id: $id) { id status deploymentStopped }
}`;
const M_PROJECT_CREATE = `mutation CiProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) { id environments(first: 5) { edges { node { id name } } } }
}`;
const M_PROJECT_DELETE = `mutation CiProjectDelete($id: String!) { projectDelete(id: $id) }`;
const M_SERVICE_CREATE = `mutation CiServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`;
const M_INSTANCE_UPDATE = `mutation CiInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`;
const M_LIMITS_UPDATE = `mutation CiLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) {
  serviceInstanceLimitsUpdate(input: $input)
}`;
const M_DEPLOY = `mutation CiDeploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}`;

interface Deployment {
  id?: string;
  status?: string;
  deploymentStopped?: boolean;
}
interface ProjectNode {
  id?: string;
  name?: string;
  description?: string | null;
  createdAt?: string;
  deployments?: { edges?: Array<{ node?: Deployment | null } | null> } | null;
}
type Edges<T> = { edges?: Array<{ node?: T | null } | null> } | null | undefined;

/** Context the executor needs beyond the transport. */
export interface RailwayCiContext {
  api: RailwayApi;
  /** The connection's workspace; empty means the token's only one. */
  workspaceId: string;
  oauth: boolean;
}

function requireKind(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(
      `Railway runs CI jobs of kind \`container\` (a one-off deployment), not \`${kind}\`.`,
    );
  }
}

/** The job's project name: the same job, the same name. */
export function projectName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `${PROJECT_PREFIX}${ciComputeKey(spec)}`;
}

function statusOf(err: unknown): number {
  return err instanceof RailwayApiError ? err.status : 0;
}

function parseTags(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return null;
  }
}

const base64 = (text: string) => {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** The script the container runs: the watchdog around the job, as one shell line. */
export function jobScript(spec: CiStartSpec): string {
  const argv = ciContainerCommand(ciBootstrapWithTools(spec.bootstrap), spec.maxSeconds);
  return `#!/bin/sh\nexec ${argv.map(ciShellQuote).join(" ")}\n`;
}

/** `cloud.machine` as Railway's per-service limits. */
export function limitsFor(machine: string): { vCPUs: number; memoryGB: number } {
  const size = parseCiContainerSize(machine);
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a Railway job is CPU and memory limits, like ${CI_DEFAULT_MACHINE}, not ${machine}.`,
    );
  }
  return { vCPUs: size.vcpus, memoryGB: size.memoryGb };
}

function handleOf(
  project: string,
  ids: { environment?: string; service?: string; deployment?: string },
): CiHandle {
  return {
    id: ids.deployment ?? project,
    label: `railway project ${project}${ids.deployment ? ` deployment ${ids.deployment.slice(0, 8)}` : ""}`,
    data: {
      project,
      ...(ids.environment ? { environment: ids.environment } : {}),
      ...(ids.service ? { service: ids.service } : {}),
      ...(ids.deployment ? { deployment: ids.deployment } : {}),
    },
  };
}

async function workspaceOf(ctx: RailwayCiContext): Promise<string> {
  if (ctx.workspaceId) return ctx.workspaceId;
  const all = await credentialWorkspaces(ctx.api, ctx.oauth);
  if (all.length === 1 && all[0]?.id) return all[0].id;
  throw new Error(
    all.length
      ? "This Railway token reaches several workspaces. Pick the workspace CI jobs run in on the connection."
      : "This Railway token reaches no workspace to make CI projects in.",
  );
}

/** Every project in the workspace, read page by page. */
async function listProjects(ctx: RailwayCiContext, workspaceId: string): Promise<ProjectNode[]> {
  const out: ProjectNode[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.api.gql<{
      projects?: Edges<ProjectNode> & {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    }>(Q_PROJECTS, { workspaceId, ...(after ? { after } : {}) });
    out.push(...nodes(res.projects));
    const info = res.projects?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return out;
    after = info.endCursor;
  }
  throw new Error(`The workspace has more than ${PAGE * MAX_PAGES} projects to look through.`);
}

export async function railwayCiPreflight(
  ctx: RailwayCiContext,
  kind: CiExecutorKind,
): Promise<CiPreflightResult> {
  requireKind(kind);
  const problems: string[] = [];
  // Railway tokens have no scopes to read (a workspace token acts as a
  // workspace admin), so this is a harmless read of the workspace the jobs
  // would go in. A member whose role cannot create projects fails at start.
  try {
    const workspaceId = await workspaceOf(ctx);
    await ctx.api.gql(Q_PROJECTS, { workspaceId });
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  return { ok: problems.length === 0, missing: [], problems };
}

export async function railwayCiStart(ctx: RailwayCiContext, spec: CiStartSpec): Promise<CiHandle> {
  requireKind(spec.kind);
  if (spec.gpu) throw new Error("Railway services have no GPUs.");
  const limits = limitsFor(spec.machine ?? CI_DEFAULT_MACHINE);
  const script = jobScript(spec);
  const workspaceId = await workspaceOf(ctx);
  const name = projectName(spec);

  let projectId: string | undefined;
  let environmentId: string | undefined;
  let serviceId: string | undefined;
  const existing = (await listProjects(ctx, workspaceId)).find((p) => p.name === name);
  if (existing?.id) {
    // A retry after a lost answer: only ever this job's project.
    const tags = parseTags(existing.description);
    if (!tags || tags[CI_JOB_TAG] !== spec.tags[CI_JOB_TAG]) {
      throw new Error(`A Railway project named ${name} already exists and is not this CI job's.`);
    }
    const { project } = await ctx.api.gql<{
      project?: {
        environments?: Edges<{ id?: string }>;
        services?: Edges<{ id?: string; name?: string }>;
        deployments?: Edges<Deployment>;
      };
    }>(Q_PROJECT, { id: existing.id });
    projectId = existing.id;
    environmentId = nodes(project?.environments)[0]?.id;
    serviceId = nodes(project?.services).find((s) => s.name === SERVICE_NAME)?.id;
    const deployment = nodes(project?.deployments)[0]?.id;
    if (deployment) {
      return handleOf(projectId, {
        ...(environmentId ? { environment: environmentId } : {}),
        ...(serviceId ? { service: serviceId } : {}),
        deployment,
      });
    }
  } else {
    const made = await ctx.api.gql<{
      projectCreate: { id: string; environments?: Edges<{ id?: string }> };
    }>(M_PROJECT_CREATE, {
      input: {
        name,
        description: JSON.stringify(spec.tags),
        workspaceId,
        defaultEnvironmentName: ENVIRONMENT_NAME,
      },
    });
    projectId = made.projectCreate.id;
    environmentId = nodes(made.projectCreate.environments)[0]?.id;
  }
  if (!environmentId) throw new Error("Railway did not return the CI project's environment.");

  if (!serviceId) {
    const service = await ctx.api.gql<{ serviceCreate: { id: string } }>(M_SERVICE_CREATE, {
      input: {
        projectId,
        environmentId,
        name: SERVICE_NAME,
        // Not secret: the script holds the job's callback, nothing else.
        variables: { [CI_SCRIPT_VAR]: base64(script) },
      },
    });
    serviceId = service.serviceCreate.id;
  }
  await ctx.api.gql(M_INSTANCE_UPDATE, {
    serviceId,
    environmentId,
    input: {
      source: { image: spec.image ?? CI_DEFAULT_IMAGE },
      startCommand: START_COMMAND,
      restartPolicyType: "NEVER",
      ...(spec.region ? { region: spec.region } : {}),
    },
  });
  await ctx.api.gql(M_LIMITS_UPDATE, { input: { serviceId, environmentId, ...limits } });
  const deployed = await ctx.api.gql<{ serviceInstanceDeployV2: string }>(M_DEPLOY, {
    serviceId,
    environmentId,
  });
  return handleOf(projectId, {
    environment: environmentId,
    service: serviceId,
    deployment: deployed.serviceInstanceDeployV2,
  });
}

/** How a deployment reads to the host. */
export function deploymentState(d: Deployment): CiComputeStatus {
  switch (d.status) {
    case "SUCCESS":
      return d.deploymentStopped
        ? { state: "stopped", detail: "The container exited 0." }
        : { state: "running" };
    case "SLEEPING":
      return { state: "running" };
    case "CRASHED":
    case "FAILED":
    case "REMOVED":
    case "REMOVING":
    case "SKIPPED":
      return { state: "stopped", detail: `The deployment is ${d.status.toLowerCase()}.` };
    default:
      return { state: "starting" };
  }
}

export async function railwayCiStatus(
  ctx: RailwayCiContext,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  const deploymentId = handle.data?.["deployment"];
  if (deploymentId) {
    try {
      const { deployment } = await ctx.api.gql<{ deployment?: Deployment | null }>(Q_DEPLOYMENT, {
        id: deploymentId,
      });
      if (deployment) return deploymentState(deployment);
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 403) throw err;
    }
  }
  // Railway answers "Not Authorized" for what the token cannot see, a
  // deleted project included, so the workspace's own list decides.
  const project = handle.data?.["project"] ?? handle.id;
  const listed = (await listProjects(ctx, await workspaceOf(ctx))).some((p) => p.id === project);
  return listed ? { state: "starting" } : { state: "gone" };
}

export async function railwayCiTeardown(ctx: RailwayCiContext, handle: CiHandle): Promise<void> {
  const project = handle.data?.["project"] ?? handle.id;
  try {
    await ctx.api.gql(M_PROJECT_DELETE, { id: project });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) return;
    if (status !== 403) throw err;
    // Not Authorized also answers a project that is already gone.
    const listed = (await listProjects(ctx, await workspaceOf(ctx))).some((p) => p.id === project);
    if (listed) throw err;
  }
}

export async function railwayCiListTagged(
  ctx: RailwayCiContext,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const project of await listProjects(ctx, await workspaceOf(ctx))) {
    if (!project.id || !project.name?.startsWith(PROJECT_PREFIX)) continue;
    const tags = parseTags(project.description);
    if (!tags || !(tagKey in tags)) continue;
    const deployment = nodes(project.deployments)[0];
    out.push({
      handle: handleOf(project.id, deployment?.id ? { deployment: deployment.id } : {}),
      tags,
      ...(project.createdAt ? { createdAt: project.createdAt } : {}),
      live: !deployment || deploymentState(deployment).state !== "stopped",
    });
  }
  return out;
}
