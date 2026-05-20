import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { ProjectCreateParams } from "cloudflare/resources/pages/projects/projects";

function mapPagesProject(p: Record<string, unknown>, accountId: string): ResourceInstance {
  const name = String(p["name"] ?? "");
  const subdomain = String(p["subdomain"] ?? `${name}.pages.dev`);
  const latestDeploy = p["latest_deployment"] as Record<string, unknown> | undefined;
  const source = p["source"] as Record<string, unknown> | undefined;
  const buildConfig = p["build_config"] as Record<string, unknown> | undefined;
  const customDomains = Array.isArray(p["domains"]) ? (p["domains"] as string[]).join(", ") : "";
  return {
    id: `${accountId}:pages-project:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "pages-project",
    accountId,
    displayName: name,
    fields: {
      name,
      subdomain,
      productionBranch: String(p["production_branch"] ?? source?.["config"]?.toString() ?? ""),
      latestDeploymentStatus: String(
        latestDeploy?.["latest_stage"]?.toString() ?? latestDeploy?.["environment"] ?? "",
      ),
      latestDeploymentUrl: String(latestDeploy?.["url"] ?? ""),
      framework: String(buildConfig?.["framework"] ?? ""),
      domains: customDomains,
    },
    resolvedOutputs: {
      subdomain,
      projectName: name,
    },
    secretStates: [],
    externalId: name,
    createdAt: String(p["created_on"] ?? new Date().toISOString()),
    updatedAt: String(p["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listPagesProjects(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const p of api.cf.pages.projects.list({ account_id })) {
    results.push(mapPagesProject(p as unknown as Record<string, unknown>, accountId));
  }
  return results;
}

export async function createPagesProject(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const params: ProjectCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    production_branch: fields["productionBranch"] ?? "main",
  } as ProjectCreateParams;
  const project = await api.cf.pages.projects.create(params);
  return mapPagesProject(project as unknown as Record<string, unknown>, accountId);
}

export async function deletePagesProject(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.pages.projects.delete(externalId, { account_id });
}

function mapPagesDeployment(
  d: Record<string, unknown>,
  accountId: string,
  projectName: string,
): ResourceInstance {
  const id = String(d["id"] ?? "");
  const env = String(d["environment"] ?? "production");
  const latestStage = d["latest_stage"] as Record<string, unknown> | undefined;
  const status = String(latestStage?.["status"] ?? d["status"] ?? "");
  const source = d["source"] as Record<string, unknown> | undefined;
  return {
    id: `${accountId}:pages-deployment:${projectName}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "pages-deployment",
    accountId,
    displayName: `${env} · ${String(d["deployment_trigger"]?.toString() ?? "").slice(0, 20) || id.slice(0, 8)}`,
    fields: {
      environment: env,
      url: String(d["url"] ?? ""),
      branch: String(source?.["branch"] ?? d["branch"] ?? ""),
      commitHash: String(source?.["commit_hash"] ?? d["commit_hash"] ?? ""),
      commitMessage: String(source?.["commit_message"] ?? d["commit_message"] ?? ""),
      status,
      createdOn: String(d["created_on"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${projectName}/${id}`,
    parentResourceId: `${accountId}:pages-project:${projectName}`,
    createdAt: String(d["created_on"] ?? new Date().toISOString()),
    updatedAt: String(d["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllPagesDeployments(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const project of api.cf.pages.projects.list({ account_id })) {
    const projectName = String((project as unknown as { name?: string }).name ?? "");
    try {
      let count = 0;
      for await (const d of api.cf.pages.projects.deployments.list(projectName, { account_id })) {
        if (count >= 5) break;
        results.push(
          mapPagesDeployment(d as unknown as Record<string, unknown>, accountId, projectName),
        );
        count++;
      }
    } catch {
      // Skip projects we can't read deployments for
    }
  }
  return results;
}

export async function deletePagesDeployment(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  const [project, deploymentId] = externalId.split("/");
  if (!project || !deploymentId) throw new Error("Invalid pages deployment ID");
  await api.cf.pages.projects.deployments.delete(project, deploymentId, { account_id });
}
