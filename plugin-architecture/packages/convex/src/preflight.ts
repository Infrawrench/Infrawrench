/**
 * Credential preflight. A team access token acts with its creator's role
 * (admin or developer, or a custom role), so the probe makes one read per
 * capability and reads 401/403 as missing.
 */
import type {
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { ConvexContext, CvDeployment } from "./api.js";
import { deploymentApi, enc, mgmt, paged, statusOf } from "./api.js";

const TOKENS_URL = "https://dashboard.convex.dev/team/settings/access-tokens";

const P = {
  team: { id: "team-token", label: "A team access token (not a deploy or project key)" },
  projects: { id: "project:view", label: "project:view / deployment:view" },
  env: { id: "deployment:env:view", label: "deployment:env:view" },
  members: { id: "member:view", label: "member:view" },
} satisfies Record<string, PreflightPermission>;

export const CONVEX_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    {
      id: "inventory",
      label: "List projects and deployments",
      description: "Projects, deployments, deploy keys and custom domains.",
      requiredPermissions: [P.team, P.projects],
      essential: true,
    },
    {
      id: "deployment",
      label: "Deployment settings",
      description: "Environment variables, log streams, usage limits, usage, pause and unpause.",
      requiredPermissions: [P.env],
    },
    {
      id: "team",
      label: "Team members",
      description: "Members, invitations, custom roles and access tokens.",
      requiredPermissions: [P.members],
    },
  ],
};

async function probe(
  capabilityId: string,
  perms: PreflightPermission[],
  call: () => Promise<unknown>,
): Promise<PreflightCapabilityCheck> {
  try {
    await call();
    return { capabilityId, status: "ok" };
  } catch (err) {
    const status = statusOf(err);
    if (status === 400 || status === 401 || status === 403) {
      return {
        capabilityId,
        status: "missing",
        missingPermissions: perms,
        message: err instanceof Error ? err.message : String(err),
        helpLink: { label: "Team access tokens", url: TOKENS_URL },
      };
    }
    return {
      capabilityId,
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyConvexCredentials(
  ctx: ConvexContext,
  teamId: () => Promise<number>,
): Promise<PreflightResult> {
  let deployments: CvDeployment[] = [];
  const inventory = await probe("inventory", [P.team, P.projects], async () => {
    deployments = await paged<CvDeployment>(ctx, `/teams/${enc(await teamId())}/list_deployments`);
  });
  const cloud = deployments.find((d) => d.kind !== "local" && d.deploymentUrl);
  const deployment: PreflightCapabilityCheck = cloud
    ? await probe("deployment", [P.env], () =>
        deploymentApi(ctx, cloud.deploymentUrl!, "GET", "/list_environment_variables"),
      )
    : { capabilityId: "deployment", status: "unknown", message: "No deployment to test against." };
  const team = await probe("team", [P.members], async () =>
    mgmt(ctx, "GET", `/teams/${enc(await teamId())}/list_members`),
  );
  return { checks: [inventory, deployment, team], identity: `${deployments.length} deployment(s)` };
}
