import type { SizeOption, CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { REGION_INFO } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const gkeCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "gke-cluster": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const [zonesData, machineTypesData, serverConfig] = await Promise.all([
      ctx.get<{ items?: Array<{ name: string; status: string; region: string }> }>(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones`,
      ),
      ctx.get<{ items?: Array<{ name: string; guestCpus: number; memoryMb: number }> }>(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/us-central1-a/machineTypes?maxResults=500`,
      ),
      ctx.get<{
        defaultClusterVersion?: string;
        validMasterVersions?: string[];
      }>(`https://container.googleapis.com/v1/projects/${p}/locations/us-central1-a/serverConfig`),
    ]);

    const locations = (zonesData.items ?? [])
      .filter((zone) => zone.status === "UP")
      .map((zone) => {
        const regionSlug = zone.region.split("/").pop() ?? zone.region;
        const info = REGION_INFO[regionSlug];
        return {
          id: zone.name,
          label: zone.name,
          ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const machineTypes = (machineTypesData.items ?? []).filter((m) => !m.name.includes("custom"));

    // Pre-populate machine type spec cache for GKE cost estimates
    for (const m of machineTypes) {
      ctx.machineTypeSpecCache.set(m.name, { guestCpus: m.guestCpus, memoryMb: m.memoryMb });
    }

    const familyOrder = ["e2", "n1", "n2", "n2d", "c2", "c3", "m1", "m2", "a2", "g2"];
    const familyLabels: Record<string, string> = {
      e2: "E2 · Cost-optimized",
      n1: "N1 · General purpose",
      n2: "N2 · General purpose",
      n2d: "N2D · AMD general purpose",
      c2: "C2 · Compute-optimized",
      c3: "C3 · Compute-optimized",
      m1: "M1 · Memory-optimized",
      m2: "M2 · Memory-optimized",
      a2: "A2 · GPU",
      g2: "G2 · GPU",
    };
    const sizes: SizeOption[] = machineTypes
      .map((machineType) => {
        const family =
          familyOrder.find((candidate) => machineType.name.startsWith(candidate)) ??
          machineType.name.split("-")[0] ??
          "other";
        return {
          id: machineType.name,
          label: machineType.name,
          vcpus: machineType.guestCpus,
          memoryMb: machineType.memoryMb,
          category: familyLabels[family] ?? family.toUpperCase(),
        };
      })
      .sort((a, b) => {
        const ai = familyOrder.indexOf(a.category?.split(" ")[0]?.toLowerCase() ?? "");
        const bi = familyOrder.indexOf(b.category?.split(" ")[0]?.toLowerCase() ?? "");
        if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.vcpus - b.vcpus || a.memoryMb - b.memoryMb;
      });
    const versions = (serverConfig.validMasterVersions ?? []).map((version) => ({
      id: version,
      label: version,
    }));
    const defaultLocation =
      locations.find((location) => location.id === "us-central1-a")?.id ?? locations[0]?.id;
    const defaultVersion = serverConfig.defaultClusterVersion ?? versions[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: locations,
          ...(defaultLocation ? { defaultValue: defaultLocation } : {}),
        },
        {
          key: "version",
          label: "Kubernetes Version",
          kind: "select",
          required: true,
          options: versions,
          ...(defaultVersion ? { defaultValue: defaultVersion } : {}),
        },
        {
          key: "machineType",
          label: "Node Machine Type",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: "e2-medium",
        },
        {
          key: "diskSizeGb",
          label: "Disk Per Node",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 2048,
          defaultGb: 100,
          stepGb: 10,
          description: "Persistent disk size attached to each node.",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "3",
          minValue: 1,
          stepValue: 1,
          description: "Initial number of nodes in the default node pool.",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network to deploy the cluster in",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  },
};

export const gkeCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "gke-cluster": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const location = fields["location"] ?? "";
    const machineType = fields["machineType"] ?? "e2-medium";
    const requestedDiskSizeGb = Number.parseInt(fields["diskSizeGb"] ?? "100", 10);
    const diskSizeGb =
      Number.isFinite(requestedDiskSizeGb) && requestedDiskSizeGb >= 10 ? requestedDiskSizeGb : 100;
    const name = fields["name"] ?? "";
    const version = fields["version"] ?? "";
    const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
    const initialNodeCount =
      Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 3;
    const tok = await ctx.token();
    const network = fields["network"];
    const body = {
      cluster: {
        name,
        ...(version ? { initialClusterVersion: version } : {}),
        initialNodeCount,
        nodeConfig: {
          machineType,
          diskSizeGb,
        },
        ...(network
          ? {
              network:
                network.indexOf("projects/") >= 0
                  ? network.slice(network.indexOf("projects/"))
                  : `projects/${p}/global/networks/${network}`,
            }
          : {}),
      },
    };
    const res = await fetch(
      `https://container.googleapis.com/v1/projects/${p}/locations/${location}/clusters`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`GKE API ${res.status}: ${await res.text()}`);
    }
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gke-cluster",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        version,
        machineType,
        diskSizeGb,
        nodeCount: initialNodeCount,
        status: "PROVISIONING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
};
