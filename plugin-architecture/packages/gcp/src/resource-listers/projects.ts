import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ListerContext } from "./shared.js";

export async function listGcpProjects(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  let items: Record<string, unknown>[];
  try {
    items = await ctx.paginate<Record<string, unknown>>(
      "https://cloudresourcemanager.googleapis.com/v1/projects",
      "projects",
      { filter: "lifecycleState:ACTIVE" },
    );
  } catch (err) {
    // A 403 means the Resource Manager API is disabled or the key lacks
    // resourcemanager.projects.get. The key always belongs to exactly one
    // project, so fall back to a single row synthesized from the credential's
    // own project id — the picker still works.
    if ((err as { status?: number }).status !== 403) throw err;
    items = [{ projectId: p, name: p, projectNumber: "", lifecycleState: "ACTIVE" }];
  }
  return items
    .filter((proj) => String(proj["lifecycleState"] ?? "ACTIVE") === "ACTIVE")
    .map((proj) => {
      const projectId = String(proj["projectId"]);
      const name = String(proj["name"] ?? "") || projectId;
      return {
        id: ctx.id(accountId, "gcp-project", projectId),
        pluginId: "gcp",
        resourceTypeId: "gcp-project",
        accountId,
        displayName: name,
        fields: {
          projectId,
          name,
          projectNumber: String(proj["projectNumber"] ?? ""),
          state: String(proj["lifecycleState"] ?? "ACTIVE"),
        },
        resolvedOutputs: { projectId },
        secretStates: [],
        externalId: projectId,
        createdAt: String(proj["createTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    });
}
