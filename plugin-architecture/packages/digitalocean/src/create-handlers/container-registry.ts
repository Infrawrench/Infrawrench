/** Create handlers for the DigitalOcean Container Registry (DOCR). */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { regionDisplay } from "../constants.js";
import type { DoCreateArgs, DoCreateContext } from "./shared.js";

/**
 * Datacenters DOCR can be homed in (per digitalocean/openapi
 * registries/models: `region` enum). Narrower than the general droplet
 * region list, so it's kept here rather than in constants.
 */
const REGISTRY_REGIONS = ["nyc3", "sfo3", "ams3", "fra1", "sgp1", "blr1", "syd1"];

/**
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function containerRegistryGetCreateConfig(
  _ctx: DoCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "container-registry") {
    // No project field — DOCR is an account-level singleton, not
    // project-scoped, and DO refuses a second registry with a 409.
    const regionOptions = REGISTRY_REGIONS.map((slug) => {
      const info = regionDisplay(slug);
      return { id: slug, label: info ? `${slug} — ${info.location}` : slug };
    });
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description:
            "Globally unique across all DO registries (lowercase letters, digits, hyphens). Becomes registry.digitalocean.com/<name>.",
        },
        {
          key: "subscriptionTier",
          label: "Subscription Tier",
          kind: "select",
          required: false,
          defaultValue: "starter",
          options: [
            { id: "starter", label: "Starter (free, 1 repo, 500 MiB)" },
            { id: "basic", label: "Basic ($5/mo, 5 repos, 5 GiB)" },
            { id: "professional", label: "Professional ($20/mo, unlimited repos, 100 GiB)" },
          ],
        },
        {
          key: "region",
          label: "Region",
          kind: "select",
          required: false,
          defaultValue: "",
          options: [{ id: "", label: "Automatic (nearest datacenter)" }, ...regionOptions],
        },
      ],
    };
  }

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module. DO returns 409 when the account already has a
 * registry or the name is taken globally — that error propagates as-is.
 */
export async function containerRegistryCreateResource(
  args: DoCreateArgs,
): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields } = args;
  if (typeId === "container-registry") {
    const tier = fields["subscriptionTier"] || "starter";
    const data = await ctx.fetch<{ registry?: Record<string, unknown> }>("/registry", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"] ?? "",
        subscription_tier_slug: tier,
        ...(fields["region"] ? { region: fields["region"] } : {}),
      }),
    });
    const r = data.registry ?? {};
    const name = String(r["name"] ?? fields["name"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:container-registry:${name}`,
      pluginId: "digitalocean",
      resourceTypeId: "container-registry",
      accountId,
      displayName: name,
      fields: {
        name,
        subscriptionTier: tier,
        region: String(r["region"] ?? fields["region"] ?? ""),
        storageUsageBytes: Number(r["storage_usage_bytes"] ?? 0),
        createdAt: String(r["created_at"] ?? now),
      },
      resolvedOutputs: {
        endpoint: `registry.digitalocean.com/${name}`,
        serverUrl: "registry.digitalocean.com",
      },
      secretStates: [],
      externalId: name,
      createdAt: String(r["created_at"] ?? now),
      updatedAt: now,
    };
  }

  return null;
}
