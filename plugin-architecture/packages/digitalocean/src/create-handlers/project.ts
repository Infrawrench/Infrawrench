/** Create handlers for DigitalOcean projects. */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { DoCreateArgs, DoCreateContext } from "./shared.js";

/**
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function projectGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "project") {
    return {
      fields: [
        { key: "name", label: "Project Name", kind: "text", required: true },
        {
          key: "purpose",
          label: "Purpose",
          kind: "select",
          required: false,
          options: [
            { id: "Web Application", label: "Web Application" },
            { id: "API", label: "API" },
            { id: "Mobile Application", label: "Mobile Application" },
            { id: "Website", label: "Website" },
            { id: "CI/CD", label: "CI/CD" },
            { id: "Other", label: "Other" },
          ],
          defaultValue: "Web Application",
        },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "environment",
          label: "Environment",
          kind: "select",
          required: false,
          options: [
            { id: "Development", label: "Development" },
            { id: "Staging", label: "Staging" },
            { id: "Production", label: "Production" },
          ],
          defaultValue: "Development",
        },
      ],
    };
  }

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function projectCreateResource(args: DoCreateArgs): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields } = args;
  if (typeId === "project") {
    const data = await ctx.fetch<{ project: Record<string, unknown> }>("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"] ?? "",
        purpose: fields["purpose"] ?? "Web Application",
        description: fields["description"] ?? "",
        environment: fields["environment"] ?? "Development",
      }),
    });
    const p = data.project ?? {};
    const now = new Date().toISOString();
    return {
      id: `${accountId}:project:${String(p["id"] ?? "")}`,
      pluginId: "digitalocean",
      resourceTypeId: "project",
      accountId,
      displayName: String(p["name"] ?? fields["name"]),
      fields: {
        name: String(p["name"] ?? fields["name"]),
        purpose: String(p["purpose"] ?? fields["purpose"] ?? ""),
        description: String(p["description"] ?? fields["description"] ?? ""),
        environment: String(p["environment"] ?? fields["environment"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(p["id"] ?? ""),
      createdAt: String(p["created_at"] ?? now),
      updatedAt: String(p["updated_at"] ?? now),
    };
  }

  return null;
}
