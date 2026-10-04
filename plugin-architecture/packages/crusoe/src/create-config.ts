import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  RegionOption,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import type { CrusoeClient } from "./client.js";
import { externalOf } from "./mappers.js";
import type { CrusoeImage, CrusoeKubeVersions, CrusoeVmType } from "./types.js";

/**
 * Live create forms. Every id a user would otherwise have to know (project,
 * location, instance type, image, VPC network, disk, cluster, version) is a
 * picker filled from the API. Resources under a project or cluster created
 * from the parent's page omit the parent picker.
 */

/** Crusoe names locations by zone (`us-northcentral1-a`); the region is the zone minus its letter. */
export function regionOption(location: string): RegionOption {
  return { id: location, label: location, location: location.replace(/-[a-z]$/, "") };
}

export function sizeOption(t: CrusoeVmType): SizeOption {
  const gpus = t.num_gpu ?? 0;
  return {
    id: t.product_name,
    label: t.product_name,
    vcpus: t.cpu_cores ?? 0,
    memoryMb: (t.memory_gb ?? 0) * 1024,
    ...(t.disk_gb ? { diskGb: t.disk_gb } : {}),
    category: gpus > 0 ? `${t.gpu_type || "GPU"}` : "CPU",
  };
}

/** Images are created by name and tag, e.g. `ubuntu22.04-nvidia-sxm-docker:latest`. */
export function imageOption(img: CrusoeImage): ImageOption {
  const tag = img.tags?.includes("latest") ? "latest" : img.tags?.[0];
  return {
    id: tag ? `${img.name}:${tag}` : img.name,
    label: img.name,
    ...(img.description ? { description: img.description } : {}),
    family: img.name.split(/[-:]/)[0] ?? img.name,
  };
}

function text(
  key: string,
  label: string,
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return { key, label, kind: "text", required: true, ...opts };
}

function select(
  key: string,
  label: string,
  options: SelectOption[],
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return {
    key,
    label,
    kind: "select",
    required: true,
    options,
    ...(options[0] ? { defaultValue: options[0].id } : {}),
    ...opts,
  };
}

const YES_NO: SelectOption[] = [
  { id: "false", label: "No" },
  { id: "true", label: "Yes" },
];

async function projectField(client: CrusoeClient): Promise<CreateFieldConfig> {
  const projects = await client.projects();
  return select(
    "projectId",
    "Project",
    projects.map((p) => ({ id: p.id, label: p.name || p.id })),
  );
}

async function locationField(client: CrusoeClient): Promise<CreateFieldConfig> {
  const locations = await client.locations().catch(() => []);
  return {
    key: "location",
    label: "Location",
    kind: "region-picker",
    required: true,
    regions: locations.map(regionOption),
  };
}

/** Options naming a project-scoped resource by its scoped id, labelled with the project. */
async function scopedOptions(
  client: CrusoeClient,
  typeId: string,
  accountId = "picker",
): Promise<SelectOption[]> {
  const [items, projects] = await Promise.all([
    client.listResources(typeId, accountId).catch(() => []),
    client.projects().catch(() => []),
  ]);
  const projectNames = new Map(projects.map((p) => [p.id, p.name || p.id]));
  return items.map((r) => {
    const pid = String(r.fields["projectId"] ?? "");
    return {
      id: r.externalId ?? externalOf(r.id),
      label: r.displayName,
      ...(pid ? { description: projectNames.get(pid) ?? pid } : {}),
    };
  });
}

async function firstProjectId(client: CrusoeClient, parentResourceId?: string): Promise<string> {
  if (parentResourceId?.includes(":project:")) return externalOf(parentResourceId);
  if (parentResourceId?.includes(":kubernetes-cluster:")) {
    return externalOf(parentResourceId).split("/")[0] ?? "";
  }
  return (await client.projects())[0]?.id ?? "";
}

async function sizeField(client: CrusoeClient, projectId: string): Promise<CreateFieldConfig> {
  const types = projectId ? await client.vmTypes(projectId) : [];
  return {
    key: "type",
    label: "Instance Type",
    kind: "size-picker",
    required: true,
    sizes: types.map(sizeOption),
  };
}

async function kubeVersions(
  client: CrusoeClient,
  projectId: string,
): Promise<{ cluster: SelectOption[]; nodePool: SelectOption[] }> {
  if (!projectId) return { cluster: [], nodePool: [] };
  const res = await client.api
    .request<CrusoeKubeVersions>(`/projects/${projectId}/kubernetes/versions`)
    .catch(() => undefined);
  const opt = (name: string | undefined, tags: string[] | undefined): SelectOption | null =>
    name
      ? { id: name, label: name, ...(tags?.length ? { description: tags.join(", ") } : {}) }
      : null;
  return {
    cluster: (res?.kubernetes_cluster_versions ?? [])
      .map((v) => opt(v.cluster_version_name, v.tags))
      .filter((v): v is SelectOption => v !== null),
    nodePool: (res?.kubernetes_node_pool_versions ?? [])
      .map((v) => opt(v.node_pool_version_name, v.tags))
      .filter((v): v is SelectOption => v !== null),
  };
}

export async function buildCreateConfig(
  client: CrusoeClient,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const underProject = parentResourceId?.includes(":project:") === true;
  const withProject = async (fields: CreateFieldConfig[]): Promise<CreateResourceConfig> => ({
    fields: underProject ? fields : [await projectField(client), ...fields],
  });

  switch (typeId) {
    case "project": {
      const orgs = await client.organizations().catch(() => []);
      const fields: CreateFieldConfig[] = [text("name", "Name")];
      if (orgs.length > 1) {
        fields.push(
          select(
            "organizationId",
            "Organization",
            orgs.map((o) => ({ id: o.id, label: o.name || o.id })),
          ),
        );
      }
      return { fields };
    }
    case "vm": {
      const projectId = await firstProjectId(client, parentResourceId);
      const [location, size, images] = await Promise.all([
        locationField(client),
        sizeField(client, projectId),
        client.api.request<{ items?: CrusoeImage[] }>("/compute/images").catch(() => undefined),
      ]);
      return withProject([
        text("name", "Name", { placeholder: "my-gpu-vm" }),
        location,
        size,
        {
          key: "image",
          label: "Image",
          kind: "image-picker",
          required: true,
          images: (images?.items ?? []).map(imageOption),
        },
        { key: "sshPublicKey", label: "SSH Public Key", kind: "ssh-key-picker", required: true },
        select("reservationStrategy", "Reservation", [
          {
            id: "lowest_cost",
            label: "Use the lowest-cost matching reservation",
            description: "Falls back to on-demand when no reservation has capacity",
          },
          { id: "on_demand", label: "On-demand only" },
        ]),
        text("startupScript", "Startup Script", { required: false, multiline: true }),
      ]);
    }
    case "disk":
      return withProject([
        text("name", "Name"),
        await locationField(client),
        {
          key: "sizeGib",
          label: "Size (GiB)",
          kind: "number",
          required: true,
          defaultValue: "100",
          minValue: 1,
        },
        select("type", "Type", [
          { id: "persistent-ssd", label: "Persistent SSD" },
          { id: "shared-volume", label: "Shared volume" },
        ]),
      ]);
    case "snapshot":
      return {
        fields: [
          select("diskId", "Disk", await scopedOptions(client, "disk")),
          text("name", "Name"),
        ],
      };
    case "vpc-network":
      return withProject([
        text("name", "Name"),
        text("cidr", "CIDR", { placeholder: "172.27.0.0/16" }),
      ]);
    case "vpc-subnet":
      return {
        fields: [
          select("networkId", "VPC Network", await scopedOptions(client, "vpc-network")),
          text("name", "Name"),
          text("cidr", "CIDR", { placeholder: "172.27.0.0/24" }),
          await locationField(client),
          select("natGateway", "NAT Gateway", YES_NO),
        ],
      };
    case "firewall-rule":
      return {
        fields: [
          select("networkId", "VPC Network", await scopedOptions(client, "vpc-network")),
          text("name", "Name"),
          select("direction", "Direction", [
            { id: "ingress", label: "Ingress (inbound)" },
            { id: "egress", label: "Egress (outbound)" },
          ]),
          select("action", "Action", [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ]),
          text("protocols", "Protocols", { defaultValue: "tcp", placeholder: "tcp,udp,icmp" }),
          text("sources", "Sources", {
            defaultValue: "0.0.0.0/0",
            description: "Comma-separated CIDR blocks or VPC network, subnet or VM IDs",
          }),
          text("sourcePorts", "Source Ports", { required: false, defaultValue: "1-65535" }),
          text("destinations", "Destinations", {
            required: false,
            description:
              "Comma-separated CIDR blocks or resource IDs. Empty means the whole VPC network",
          }),
          text("destinationPorts", "Destination Ports", { placeholder: "22,443" }),
        ],
      };
    case "ssh-key":
      return {
        fields: [
          text("name", "Name"),
          text("publicKey", "Public Key", { multiline: true, placeholder: "ssh-ed25519 AAAA…" }),
        ],
      };
    case "kubernetes-cluster": {
      const projectId = await firstProjectId(client, parentResourceId);
      const [location, versions] = await Promise.all([
        locationField(client),
        kubeVersions(client, projectId),
      ]);
      return withProject([
        text("name", "Name"),
        location,
        select("version", "Kubernetes Version", versions.cluster),
        select("private", "Private (no public API endpoint)", YES_NO),
      ]);
    }
    case "node-pool": {
      const underCluster = parentResourceId?.includes(":kubernetes-cluster:") === true;
      const projectId = await firstProjectId(client, parentResourceId);
      const [size, versions, clusters] = await Promise.all([
        sizeField(client, projectId),
        kubeVersions(client, projectId),
        underCluster ? Promise.resolve([]) : scopedOptions(client, "kubernetes-cluster"),
      ]);
      const fields: CreateFieldConfig[] = [];
      if (!underCluster) fields.push(select("clusterId", "Cluster", clusters));
      fields.push(
        text("name", "Name"),
        size,
        {
          key: "count",
          label: "Nodes",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 0,
        },
        { key: "sshPublicKey", label: "SSH Public Key", kind: "ssh-key-picker", required: true },
        select("version", "Node Pool Version", versions.nodePool, { required: false }),
      );
      return { fields };
    }
    default:
      throw new Error(`Crusoe plugin: "${typeId}" cannot be created`);
  }
}
