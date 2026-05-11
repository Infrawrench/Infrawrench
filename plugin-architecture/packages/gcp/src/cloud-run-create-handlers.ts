import type {
  RegionOption,
  CreateResourceConfig,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const cloudRunCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-run-service": async (ctx, parentResourceId) => {
    const regionsData = await ctx
      .get<{
        items?: Array<{ name: string; status: string }>;
      }>(`https://run.googleapis.com/v2/projects/${ctx.project}/locations`)
      .catch(() => ({
        items: [] as Array<{ name: string; status: string }>,
      }));
    const dynamicRegionIds = (regionsData.items ?? [])
      .map((r) => r.name?.split("/").pop())
      .filter((id): id is string => !!id);
    const regionOptions: RegionOption[] =
      dynamicRegionIds.length > 0
        ? dynamicRegionIds.map((id) => GCP_REGIONS.find((r) => r.id === id) ?? { id, label: id })
        : GCP_REGIONS;
    return {
      fields: [
        { key: "name", label: "Service Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          defaultValue: "us-central1",
        },
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "Container image URL (e.g. gcr.io/project/image:tag)",
        },
        {
          key: "port",
          label: "Container Port",
          kind: "number",
          required: false,
          defaultValue: "8080",
        },
        {
          key: "ingress",
          label: "Ingress",
          kind: "select",
          required: false,
          options: [
            { id: "INGRESS_TRAFFIC_ALL", label: "All traffic" },
            { id: "INGRESS_TRAFFIC_INTERNAL_ONLY", label: "Internal only" },
            { id: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", label: "Internal load balancer" },
          ],
          defaultValue: "INGRESS_TRAFFIC_ALL",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network for private service access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  },
};

export const cloudRunCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-run-service": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const image = fields["image"] ?? "";
    const port = Number(fields["port"] ?? "8080");
    const ingress = fields["ingress"] ?? "INGRESS_TRAFFIC_ALL";
    const network = fields["network"];
    const tok = await ctx.token();

    const template: Record<string, unknown> = {
      containers: [
        {
          image,
          ports: [{ containerPort: port }],
        },
      ],
    };

    if (network) {
      template.vpcAccess = {
        network: `projects/${p}/global/networks/${network}`,
      };
    }

    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${p}/locations/${region}/services?serviceId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ingress, template }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Run create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    // Use the full GCP service name so the resource ID matches what
    // listResources returns once the service is provisioned. Otherwise
    // getResource and getManifest will throw "not found" until the next sync.
    const fullName = `projects/${p}/locations/${region}/services/${name}`;
    return {
      id: ctx.id(accountId, "cloud-run-service", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-run-service",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        latestRevision: "",
        state: "PROVISIONING",
        ingress,
      },
      resolvedOutputs: { url: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
