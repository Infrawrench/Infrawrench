/**
 * Create forms and create calls. Region, size, disk image, network,
 * firewall, Kubernetes version and marketplace apps, database engine and
 * version, and volume type are all pickers fed by live calls.
 */

import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  PolicyOption,
  ResourceInstance,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { dnsContentField } from "@infrawrench/plugin-base";
import { type CivoApi, intOr, listValue, regional } from "./api.js";
import {
  type ListContext,
  mapCluster,
  mapCredential,
  mapDatabase,
  mapDatabaseBackup,
  mapDnsRecord,
  mapDomain,
  mapFirewall,
  mapInstance,
  mapInstanceSnapshot,
  mapIp,
  mapLoadBalancer,
  mapNetwork,
  mapObjectStore,
  mapPool,
  mapSshKey,
  mapVolume,
  mapVolumeSnapshot,
} from "./listers.js";
import type {
  CivoCluster,
  CivoDatabase,
  CivoDiskImage,
  CivoDnsDomain,
  CivoDnsRecord,
  CivoFirewall,
  CivoInstance,
  CivoIp,
  CivoKubernetesVersion,
  CivoLoadBalancer,
  CivoMarketplaceApp,
  CivoNetwork,
  CivoObjectStore,
  CivoObjectStoreCredential,
  CivoSize,
  CivoSshKey,
  CivoVolume,
} from "./types.js";

/** Size options of one kind (`instance`, `kubernetes`, `database`). */
export function sizeOptions(sizes: CivoSize[], kind: string): SizeOption[] {
  return sizes
    .filter((s) => s.selectable !== false && (s.type ?? "").toLowerCase().startsWith(kind))
    .map((s) => ({
      id: s.name,
      label: s.nice_name || s.name,
      vcpus: s.cpu_cores ?? 0,
      memoryMb: s.ram_mb ?? 0,
      diskGb: s.disk_gb ?? 0,
      category: s.gpu_count ? `GPU (${s.gpu_type ?? ""})` : (s.description ?? kind),
    }));
}

export async function listSizes(api: CivoApi): Promise<CivoSize[]> {
  return api.get<CivoSize[]>("/sizes").catch(() => []);
}

export async function imageOptions(api: CivoApi, region?: string): Promise<ImageOption[]> {
  const images = await api
    .get<CivoDiskImage[]>("/disk_images", region ? { region } : undefined)
    .catch(() => [] as CivoDiskImage[]);
  return images
    .filter((i) => !i.state || i.state === "available")
    .map((i) => ({
      id: i.id,
      label: i.label || `${i.distribution ?? ""} ${i.version ?? ""}`.trim() || (i.name ?? i.id),
      family: i.distribution ?? "",
      category: (i.distribution ?? "Other").replace(/^./, (c) => c.toUpperCase()),
    }));
}

/** Reuse a stored key with the same material or upload it. */
export async function ensureSshKey(api: CivoApi, publicKey: string): Promise<string> {
  const material = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  const keys = await api.list<CivoSshKey>("/sshkeys");
  const match = keys.find(
    (k) => (k.public_key ?? "").trim().split(/\s+/).slice(0, 2).join(" ") === material,
  );
  if (match) return match.id;
  const comment = publicKey.trim().split(/\s+/)[2];
  const res = await api.send<{ id?: string }>("POST", "/sshkeys", undefined, {
    name: comment ? `infrawrench-${comment}`.slice(0, 60) : `infrawrench-${Date.now()}`,
    public_key: publicKey.trim(),
  });
  if (!res.id) throw new Error("Civo did not return the uploaded SSH key.");
  return res.id;
}

const yesNo = (
  key: string,
  label: string,
  def: "true" | "false",
  description?: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "select",
  required: false,
  defaultValue: def,
  options: [
    { id: "true", label: "Yes" },
    { id: "false", label: "No" },
  ],
  ...(description ? { description } : {}),
});

/** Pickers over regional resources: the value is the raw UUID (an output). */
const picker = (
  key: string,
  label: string,
  resourceTypeId: string,
  outputKey: string,
  opts: { required?: boolean; description?: string } = {},
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required: opts.required ?? false,
  associationSources: [{ pluginId: "civo", resourceTypeId, outputKey }],
  scopeFromFieldKey: "region",
  ...(opts.description ? { description: opts.description } : {}),
});

export async function instancePolicyOptions(api: CivoApi, region: string): Promise<PolicyOption[]> {
  const instances = await api
    .list<CivoInstance>("/instances", { region })
    .catch(() => [] as CivoInstance[]);
  return instances
    .filter((i) => i.private_ip)
    .map((i) => ({
      id: i.private_ip!,
      label: i.hostname ?? i.id,
      description: i.private_ip ?? "",
      category: i.size ?? "Instances",
    }));
}

export async function getCreateConfig(
  ctx: ListContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const { api } = ctx;
  const regionField = async (
    feature?: Parameters<typeof ctx.regions.options>[0],
  ): Promise<CreateFieldConfig> => {
    const regions = await ctx.regions.options(feature);
    return {
      key: "region",
      label: "Region",
      kind: "region-picker",
      required: true,
      regions,
      defaultValue: regions.find((r) => r.id.toUpperCase() === "LON1")?.id ?? regions[0]?.id ?? "",
    };
  };
  switch (typeId) {
    case "instance": {
      const [region, sizes, images] = await Promise.all([
        regionField("iaas"),
        listSizes(api),
        imageOptions(api),
      ]);
      const sizeOpts = sizeOptions(sizes, "instance");
      return {
        fields: [
          { key: "hostname", label: "Hostname", kind: "text", required: true },
          region,
          {
            key: "size",
            label: "Size",
            kind: "size-picker",
            required: true,
            sizes: sizeOpts,
            defaultValue: sizeOpts.find((s) => s.id === "g3.small")?.id ?? sizeOpts[0]?.id ?? "",
          },
          {
            key: "diskImage",
            label: "Disk Image",
            kind: "image-picker",
            required: true,
            images,
            defaultValue:
              images.find((i) => /ubuntu/i.test(i.label) && /24\.04/.test(i.label))?.id ??
              images[0]?.id ??
              "",
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
          {
            key: "initialUser",
            label: "Initial User",
            kind: "text",
            required: false,
            defaultValue: "civo",
            description: "The user created on the server; Civo generates its password",
          },
          picker("networkId", "Network", "network", "networkId", {
            description: "Defaults to the region's default network",
          }),
          picker("firewallId", "Firewall", "firewall", "firewallId", {
            description:
              "Leave empty and Civo uses the network's default firewall, which allows everything",
          }),
          {
            key: "publicIp",
            label: "Public IP",
            kind: "select",
            required: false,
            defaultValue: "create",
            options: [
              { id: "create", label: "Assign a public IPv4" },
              { id: "none", label: "Private only" },
            ],
          },
          picker("reservedIpv4", "Reserved IP", "reserved-ip", "ip", {
            description: "Use one of your reserved IPs as the public address",
          }),
          {
            key: "script",
            label: "Initialization Script",
            kind: "code",
            codeLanguage: "shell",
            required: false,
            description: "Uploaded to /usr/local/bin/civo-user-init-script and run on first boot",
          },
          { key: "tags", label: "Tags", kind: "string-list", required: false, addLabel: "Add tag" },
        ],
      };
    }
    case "volume": {
      const [region, types] = await Promise.all([
        regionField("volume"),
        api
          .get<Array<{ name: string; description?: string; enabled?: boolean }>>("/volumetypes")
          .catch(() => []),
      ]);
      const typeOptions: SelectOption[] = types
        .filter((t) => t.enabled !== false)
        .map((t) => ({
          id: t.name,
          label: t.name,
          ...(t.description ? { description: t.description } : {}),
        }));
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          region,
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 1,
            maxGb: 10000,
            defaultGb: 20,
            stepGb: 1,
          },
          ...(typeOptions.length
            ? [
                {
                  key: "volumeType",
                  label: "Type",
                  kind: "select" as const,
                  required: false,
                  options: typeOptions,
                  defaultValue: typeOptions[0]?.id ?? "",
                },
              ]
            : []),
          picker("networkId", "Network", "network", "networkId"),
          picker("instanceId", "Attach to Instance", "instance", "instanceId"),
        ],
      };
    }
    case "volume-snapshot":
      return {
        fields: [
          {
            key: "volumeRef",
            label: "Volume",
            kind: "resource-picker",
            required: true,
            associationSources: [
              { pluginId: "civo", resourceTypeId: "volume", outputKey: "volumeRef" },
            ],
          },
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "instance-snapshot":
      return {
        fields: [
          {
            key: "instanceRef",
            label: "Instance",
            kind: "resource-picker",
            required: true,
            associationSources: [
              { pluginId: "civo", resourceTypeId: "instance", outputKey: "instanceRef" },
            ],
          },
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "kubernetes-cluster": {
      const [region, sizes, versions, apps] = await Promise.all([
        regionField("kubernetes"),
        listSizes(api),
        api
          .get<CivoKubernetesVersion[]>("/kubernetes/versions")
          .catch(() => [] as CivoKubernetesVersion[]),
        api
          .get<CivoMarketplaceApp[]>("/kubernetes/applications")
          .catch(() => [] as CivoMarketplaceApp[]),
      ]);
      const nodeSizes = sizeOptions(sizes, "kubernetes");
      const usable = versions.filter((v) => v.type !== "deprecated" && v.type !== "legacy");
      const versionOptions: SelectOption[] = usable.map((v) => ({
        id: v.version,
        label: v.label || v.version,
        ...(v.clusterType ? { description: v.clusterType } : {}),
      }));
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          region,
          {
            key: "clusterType",
            label: "Distribution",
            kind: "select",
            required: true,
            defaultValue: "k3s",
            options: [
              { id: "k3s", label: "K3s" },
              { id: "talos", label: "Talos" },
            ],
          },
          {
            key: "version",
            label: "Kubernetes Version",
            kind: "select",
            required: true,
            options: versionOptions,
            defaultValue: usable.find((v) => v.default)?.version ?? versionOptions[0]?.id ?? "",
          },
          {
            key: "cniPlugin",
            label: "CNI",
            kind: "select",
            required: false,
            defaultValue: "flannel",
            options: [
              { id: "flannel", label: "Flannel" },
              { id: "cilium", label: "Cilium" },
            ],
          },
          {
            key: "nodeSize",
            label: "Node Size",
            kind: "size-picker",
            required: true,
            sizes: nodeSizes,
            defaultValue:
              nodeSizes.find((s) => s.id.endsWith("kube.medium"))?.id ?? nodeSizes[0]?.id ?? "",
          },
          {
            key: "nodeCount",
            label: "Nodes",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 100,
            defaultValue: "3",
          },
          picker("networkId", "Network", "network", "networkId"),
          picker("firewallId", "Firewall", "firewall", "firewallId", {
            description: "Leave empty and Civo creates one allowing the Kubernetes API and HTTP(S)",
          }),
          {
            key: "applications",
            label: "Marketplace Applications",
            kind: "policy-picker",
            required: false,
            policies: apps.map((a) => ({
              id: a.name,
              label: a.title || a.name,
              ...(a.description ? { description: a.description } : {}),
              category: a.category ?? "Other",
            })),
          },
          { key: "tags", label: "Tags", kind: "string-list", required: false, addLabel: "Add tag" },
        ],
      };
    }
    case "node-pool": {
      const sizes = sizeOptions(await listSizes(api), "kubernetes");
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        fields.push({
          key: "clusterRef",
          label: "Cluster",
          kind: "resource-picker",
          required: true,
          associationSources: [
            { pluginId: "civo", resourceTypeId: "kubernetes-cluster", outputKey: "clusterRef" },
          ],
        });
      }
      fields.push(
        {
          key: "size",
          label: "Node Size",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: sizes[0]?.id ?? "",
        },
        {
          key: "count",
          label: "Nodes",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 100,
          defaultValue: "2",
        },
        yesNo("publicIpNodePool", "Public IP Nodes", "false", "Give every node a public address"),
      );
      return { fields };
    }
    case "database": {
      const [region, sizes, versions] = await Promise.all([
        regionField("dbaas"),
        listSizes(api),
        api
          .get<Record<string, Array<{ software_version: string; default?: boolean }>>>(
            "/databases/versions",
          )
          .catch(
            () => ({}) as Record<string, Array<{ software_version: string; default?: boolean }>>,
          ),
      ]);
      const engines = Object.keys(versions);
      const dbSizes = sizeOptions(sizes, "database");
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          region,
          {
            key: "software",
            label: "Engine",
            kind: "select",
            required: true,
            options: engines.map((e) => ({ id: e, label: e })),
            defaultValue: engines.find((e) => /postgres/i.test(e)) ?? engines[0] ?? "",
          },
          ...engines.map((engine): CreateFieldConfig => ({
            key: `version_${engine}`,
            label: `${engine} Version`,
            kind: "select",
            required: false,
            options: (versions[engine] ?? []).map((v) => ({
              id: v.software_version,
              label: v.software_version,
            })),
            defaultValue:
              (versions[engine] ?? []).find((v) => v.default)?.software_version ??
              versions[engine]?.[0]?.software_version ??
              "",
            showWhen: { fieldKey: "software", fieldValue: engine },
          })),
          {
            key: "size",
            label: "Size",
            kind: "size-picker",
            required: true,
            sizes: dbSizes,
            defaultValue: dbSizes[0]?.id ?? "",
          },
          {
            key: "nodes",
            label: "Nodes",
            kind: "select",
            required: true,
            defaultValue: "1",
            options: [
              { id: "1", label: "1 node" },
              { id: "3", label: "3 nodes (high availability)" },
            ],
          },
          picker("networkId", "Network", "network", "networkId"),
          picker("firewallId", "Firewall", "firewall", "firewallId"),
        ],
      };
    }
    case "database-backup": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        fields.push({
          key: "databaseRef",
          label: "Database",
          kind: "resource-picker",
          required: true,
          associationSources: [
            { pluginId: "civo", resourceTypeId: "database", outputKey: "databaseRef" },
          ],
        });
      }
      fields.push(
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "manual",
          options: [
            { id: "manual", label: "Take a backup now" },
            { id: "scheduled", label: "Back up on a schedule" },
          ],
        },
        {
          key: "schedule",
          label: "Schedule (cron)",
          kind: "text",
          required: false,
          placeholder: "0 3 * * *",
          showWhen: { fieldKey: "type", fieldValue: "scheduled" },
        },
      );
      return { fields };
    }
    case "load-balancer": {
      const region = await regionField("loadbalancer");
      const regionCode = region.defaultValue ?? "";
      const instances = regionCode ? await instancePolicyOptions(api, regionCode) : [];
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          region,
          {
            key: "algorithm",
            label: "Algorithm",
            kind: "select",
            required: false,
            defaultValue: "round_robin",
            options: [
              { id: "round_robin", label: "Round robin" },
              { id: "least_connections", label: "Least connections" },
            ],
          },
          {
            key: "protocol",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: "TCP",
            options: [
              { id: "TCP", label: "TCP" },
              { id: "HTTP", label: "HTTP" },
            ],
          },
          {
            key: "sourcePort",
            label: "Listen Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "targetPort",
            label: "Backend Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "backends",
            label: "Backend Instances",
            kind: "policy-picker",
            required: false,
            policies: instances,
            description: "Instances in the default region; their private addresses are used",
          },
          picker("networkId", "Network", "network", "networkId"),
          picker("firewallId", "Firewall", "firewall", "firewallId"),
        ],
      };
    }
    case "firewall":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          await regionField("iaas"),
          picker("networkId", "Network", "network", "networkId", {
            description: "Defaults to the region's default network",
          }),
          yesNo(
            "createRules",
            "Create Civo's default rules",
            "false",
            "The defaults open every port; leave off and add only what you need",
          ),
          yesNo("allowSsh", "Allow SSH (TCP 22) from anywhere", "true"),
          yesNo("allowWeb", "Allow HTTP and HTTPS from anywhere", "false"),
        ],
      };
    case "network":
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          await regionField("iaas"),
          {
            key: "cidr",
            label: "IPv4 Range",
            kind: "text",
            required: false,
            placeholder: "10.10.0.0/24",
            description: "Leave empty for Civo to choose",
          },
        ],
      };
    case "reserved-ip":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          await regionField("iaas"),
        ],
      };
    case "domain":
      return {
        fields: [
          {
            key: "name",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
          },
        ],
      };
    case "dns-record": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const domains = await api.list<CivoDnsDomain>("/dns").catch(() => [] as CivoDnsDomain[]);
        fields.push({
          key: "domainId",
          label: "Domain",
          kind: "select",
          required: true,
          options: domains.map((d) => ({ id: d.id, label: d.name })),
        });
      }
      fields.push(
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "A",
          options: ["A", "CNAME", "MX", "TXT", "SRV", "NS"].map((t) => ({ id: t, label: t })),
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          defaultValue: "@",
          description: "@ for the apex",
        },
        ...dnsContentField({ key: "value", label: "Value" }),
        {
          key: "ttl",
          label: "TTL (seconds)",
          kind: "number",
          required: false,
          defaultValue: "600",
          minValue: 60,
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          defaultValue: "10",
          showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
        },
      );
      return { fields };
    }
    case "object-store":
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "Lowercase letters, digits and dashes",
          },
          await regionField("object_store"),
          {
            key: "maxSizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 500,
            maxGb: 10000,
            defaultGb: 500,
            stepGb: 500,
          },
          picker("credentialAccessKey", "Credential", "object-store-credential", "accessKey", {
            description: "Leave empty and Civo creates a credential for this store",
          }),
        ],
      };
    case "object-store-credential":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          await regionField("object_store"),
        ],
      };
    case "ssh-key":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "publicKey",
            label: "Public Key",
            kind: "text",
            multiline: true,
            required: true,
            placeholder: "ssh-ed25519 AAAA… user@host",
          },
        ],
      };
    default:
      throw new Error(`Civo plugin: no create form for "${typeId}"`);
  }
}

/** Split a `{region}/{id}` reference produced by a `*Ref` output. */
export function splitRef(ref: string | undefined): { region: string; id: string } {
  const v = (ref ?? "").trim();
  const i = v.indexOf("/");
  if (i < 0) return { region: "", id: v };
  return { region: v.slice(0, i), id: v.slice(i + 1) };
}

export function firewallRule(
  protocol: string,
  ports: string,
  cidr: string[],
  label: string,
  direction = "ingress",
  action = "allow",
): Record<string, unknown> {
  const [start, end] = ports.includes("-") ? ports.split("-") : [ports, ports];
  return {
    protocol,
    ...(ports && ports !== "all" ? { start_port: start, end_port: end || start } : {}),
    cidr,
    direction,
    action,
    label,
  };
}

export async function createResource(
  ctx: ListContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const { api } = ctx;
  const region = fields["region"] ?? "";
  const parent = parentResourceId ? regional(parentResourceId) : { region: "", id: "" };
  switch (typeId) {
    case "instance": {
      const sshKeyId = fields["sshPublicKey"]
        ? await ensureSshKey(api, fields["sshPublicKey"])
        : "";
      const res = await api.send<CivoInstance>("POST", "/instances", region, {
        hostname: fields["hostname"],
        size: fields["size"],
        template_id: fields["diskImage"],
        count: 1,
        public_ip: fields["publicIp"] || "create",
        ...(fields["reservedIpv4"] ? { reserved_ipv4: fields["reservedIpv4"] } : {}),
        ...(fields["networkId"] ? { network_id: fields["networkId"] } : {}),
        ...(fields["firewallId"] ? { firewall_id: fields["firewallId"] } : {}),
        ...(fields["initialUser"] ? { initial_user: fields["initialUser"] } : {}),
        ...(sshKeyId ? { ssh_key_id: sshKeyId } : {}),
        ...(fields["script"] ? { script: fields["script"] } : {}),
        tags: listValue(fields["tags"]).join(" "),
      });
      return mapInstance(res, region, accountId);
    }
    case "volume": {
      const res = await api.send<CivoVolume & { result?: string }>("POST", "/volumes", region, {
        name: fields["name"],
        size_gb: intOr(fields["sizeGb"], 20),
        ...(fields["volumeType"] ? { volume_type: fields["volumeType"] } : {}),
        ...(fields["networkId"] ? { network_id: fields["networkId"] } : {}),
      });
      if (fields["instanceId"] && res.id) {
        await api.send("PUT", `/volumes/${res.id}/attach`, region, {
          instance_id: fields["instanceId"],
          attach_at_boot: false,
        });
      }
      return mapVolume(
        {
          id: res.id,
          name: fields["name"] ?? "",
          size_gb: intOr(fields["sizeGb"], 20) ?? 20,
          instance_id: fields["instanceId"] ?? "",
        },
        region,
        accountId,
      );
    }
    case "volume-snapshot": {
      const ref = splitRef(fields["volumeRef"]);
      if (!ref.id) throw new Error("Pick the volume to snapshot.");
      const res = await api.send<{ snapshot_id?: string; id?: string }>(
        "POST",
        `/volumes/${ref.id}/snapshots`,
        ref.region,
        {
          name: fields["name"],
          description: fields["description"] ?? "",
        },
      );
      return mapVolumeSnapshot(
        {
          snapshot_id: res.snapshot_id ?? res.id ?? fields["name"] ?? "",
          name: fields["name"] ?? "",
          volume_id: ref.id,
        },
        ref.region,
        accountId,
      );
    }
    case "instance-snapshot": {
      const ref = splitRef(fields["instanceRef"]);
      if (!ref.id) throw new Error("Pick the instance to snapshot.");
      const res = await api.send<{ id?: string; name?: string }>(
        "POST",
        `/instances/${ref.id}/snapshots`,
        ref.region,
        {
          name: fields["name"],
          ...(fields["description"] ? { description: fields["description"] } : {}),
        },
      );
      return mapInstanceSnapshot(
        { id: res.id ?? fields["name"] ?? "", name: fields["name"] ?? "" },
        ref.id,
        ref.region,
        accountId,
      );
    }
    case "kubernetes-cluster": {
      const tags = listValue(fields["tags"]);
      const res = await api.send<CivoCluster>("POST", "/kubernetes/clusters", region, {
        name: fields["name"],
        cluster_type: fields["clusterType"] || "k3s",
        kubernetes_version: fields["version"],
        ...(fields["cniPlugin"] ? { cni_plugin: fields["cniPlugin"] } : {}),
        ...(fields["networkId"] ? { network_id: fields["networkId"] } : {}),
        ...(fields["firewallId"] ? { firewall_id: fields["firewallId"] } : {}),
        pools: [{ size: fields["nodeSize"], count: intOr(fields["nodeCount"], 3) }],
        ...(listValue(fields["applications"]).length
          ? { applications: listValue(fields["applications"]).join(",") }
          : {}),
        ...(tags.length ? { tags: tags.join(" ") } : {}),
      });
      return mapCluster(res, region, accountId);
    }
    case "node-pool": {
      const ref = fields["clusterRef"] ? splitRef(fields["clusterRef"]) : parent;
      if (!ref.id) throw new Error("Pick the cluster to add the pool to.");
      await api.send("POST", `/kubernetes/clusters/${ref.id}/pools`, ref.region, {
        size: fields["size"],
        count: intOr(fields["count"], 2),
        public_ip_node_pool: fields["publicIpNodePool"] === "true",
      });
      const cluster = await api.get<CivoCluster>(`/kubernetes/clusters/${ref.id}`, {
        region: ref.region,
      });
      const pool = (cluster.pools ?? []).slice(-1)[0];
      if (!pool) throw new Error("Civo accepted the node pool but the cluster lists none.");
      return mapPool(pool, cluster, ref.region, accountId);
    }
    case "database": {
      const software = fields["software"] ?? "";
      const res = await api.send<CivoDatabase>("POST", "/databases", region, {
        name: fields["name"],
        size: fields["size"],
        software,
        software_version: fields[`version_${software}`] ?? "",
        nodes: intOr(fields["nodes"], 1),
        ...(fields["networkId"] ? { network_id: fields["networkId"] } : {}),
        ...(fields["firewallId"] ? { firewall_id: fields["firewallId"] } : {}),
      });
      return mapDatabase(res, region, accountId);
    }
    case "database-backup": {
      const ref = fields["databaseRef"] ? splitRef(fields["databaseRef"]) : parent;
      if (!ref.id) throw new Error("Pick the database to back up.");
      const scheduled = fields["type"] === "scheduled";
      if (scheduled && !fields["schedule"])
        throw new Error("Enter a cron schedule, e.g. 0 3 * * *.");
      await api.send("POST", `/databases/${ref.id}/backups`, ref.region, {
        name: fields["name"],
        type: scheduled ? "scheduled" : "manual",
        ...(scheduled ? { schedule: fields["schedule"] } : {}),
      });
      return mapDatabaseBackup(
        { name: fields["name"] ?? "", is_scheduled: scheduled, schedule: fields["schedule"] ?? "" },
        ref.id,
        ref.region,
        accountId,
      );
    }
    case "load-balancer": {
      const res = await api.send<CivoLoadBalancer>("POST", "/loadbalancers", region, {
        name: fields["name"],
        algorithm: fields["algorithm"] || "round_robin",
        backends: listValue(fields["backends"]).map((ip) => ({
          ip,
          protocol: fields["protocol"] || "TCP",
          source_port: intOr(fields["sourcePort"], 80),
          target_port: intOr(fields["targetPort"], 80),
        })),
        ...(fields["networkId"] ? { network_id: fields["networkId"] } : {}),
        ...(fields["firewallId"] ? { firewall_id: fields["firewallId"] } : {}),
      });
      return mapLoadBalancer(res, region, accountId);
    }
    case "firewall": {
      const res = await api.send<{ id: string; name?: string }>("POST", "/firewalls", region, {
        name: fields["name"],
        ...(fields["networkId"] ? { network_id: fields["networkId"] } : {}),
        create_rules: fields["createRules"] === "true",
      });
      const rules: Array<Record<string, unknown>> = [];
      if (fields["allowSsh"] !== "false")
        rules.push(firewallRule("tcp", "22", ["0.0.0.0/0"], "SSH"));
      if (fields["allowWeb"] === "true") {
        rules.push(
          firewallRule("tcp", "80", ["0.0.0.0/0"], "HTTP"),
          firewallRule("tcp", "443", ["0.0.0.0/0"], "HTTPS"),
        );
      }
      for (const rule of rules) await api.send("POST", `/firewalls/${res.id}/rules`, region, rule);
      return mapFirewall(
        { id: res.id, name: fields["name"] ?? "", rules_count: rules.length },
        region,
        accountId,
      );
    }
    case "network": {
      const res = await api.send<CivoNetwork>("POST", "/networks", region, {
        label: fields["label"],
        ...(fields["cidr"] ? { cidr_v4: fields["cidr"] } : {}),
      });
      return mapNetwork({ ...res, label: res.label ?? fields["label"] ?? "" }, region, accountId);
    }
    case "reserved-ip": {
      const res = await api.send<CivoIp>("POST", "/ips", region, { name: fields["name"] });
      return mapIp(res, region, accountId);
    }
    case "domain": {
      const res = await api.send<CivoDnsDomain>("POST", "/dns", undefined, {
        name: fields["name"],
      });
      return mapDomain({ ...res, name: res.name ?? fields["name"] ?? "" }, accountId, 0);
    }
    case "dns-record": {
      const domainId = fields["domainId"] || parent.id;
      if (!domainId) throw new Error("Pick the domain to add the record to.");
      const domains = await api.list<CivoDnsDomain>("/dns");
      const domain = domains.find((d) => d.id === domainId) ?? { id: domainId, name: "" };
      const res = await api.send<CivoDnsRecord>(
        "POST",
        `/dns/${domainId}/records`,
        undefined,
        recordBody(fields),
      );
      return mapDnsRecord(res, domain, accountId);
    }
    case "object-store": {
      const res = await api.send<CivoObjectStore>("POST", "/objectstores", region, {
        name: fields["name"],
        max_size_gb: intOr(fields["maxSizeGb"], 500),
        ...(fields["credentialAccessKey"] ? { access_key_id: fields["credentialAccessKey"] } : {}),
      });
      return mapObjectStore(res, region, accountId);
    }
    case "object-store-credential": {
      const res = await api.send<CivoObjectStoreCredential>(
        "POST",
        "/objectstore/credentials",
        region,
        {
          name: fields["name"],
        },
      );
      return mapCredential(res, region, accountId);
    }
    case "ssh-key": {
      const res = await api.send<{ id: string }>("POST", "/sshkeys", undefined, {
        name: fields["name"],
        public_key: (fields["publicKey"] ?? "").trim(),
      });
      return mapSshKey(
        { id: res.id, name: fields["name"] ?? "", public_key: fields["publicKey"] ?? "" },
        accountId,
      );
    }
    default:
      throw new Error(`Civo plugin: cannot create "${typeId}"`);
  }
}

export function recordBody(fields: Record<string, string>): Record<string, unknown> {
  const type = (fields["type"] ?? "A").toUpperCase();
  return {
    type,
    name: (fields["name"] ?? "").trim() || "@",
    value: fields["value"] ?? "",
    ttl: intOr(fields["ttl"], 600),
    priority: type === "MX" || type === "SRV" ? intOr(fields["priority"], 10) : 0,
  };
}
