import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapPagesProject(p: Record<string, unknown>, accountId: string): ResourceInstance {
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
  const cfAccountId = await api.getAccountId();
  const projects = await api.paginate<Record<string, unknown>>(
    `/accounts/${cfAccountId}/pages/projects`,
  );
  return projects.map((p) => mapPagesProject(p, accountId));
}

export async function createPagesProject(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const project = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/pages/projects`,
    {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"] ?? "",
        production_branch: fields["productionBranch"] ?? "main",
      }),
    },
  );
  return mapPagesProject(project, accountId);
}

export async function deletePagesProject(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/pages/projects/${externalId}`, {
    method: "DELETE",
  });
}

export function mapPagesDeployment(
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
  const cfAccountId = await api.getAccountId();
  const projects = await api.paginate<Record<string, unknown>>(
    `/accounts/${cfAccountId}/pages/projects`,
  );
  const results: ResourceInstance[] = [];
  for (const project of projects) {
    const projectName = String(project["name"] ?? "");
    try {
      const deployments = await api.paginate<Record<string, unknown>>(
        `/accounts/${cfAccountId}/pages/projects/${projectName}/deployments`,
      );
      // Only include the latest 5 deployments per project
      for (const d of deployments.slice(0, 5)) {
        results.push(mapPagesDeployment(d, accountId, projectName));
      }
    } catch {
      // Skip projects we can't read deployments for
    }
  }
  return results;
}

export async function deletePagesDeployment(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const [project, deploymentId] = externalId.split("/");
  if (!project || !deploymentId) throw new Error("Invalid pages deployment ID");
  await api.fetch(
    `/accounts/${cfAccountId}/pages/projects/${project}/deployments/${deploymentId}`,
    { method: "DELETE" },
  );
}
