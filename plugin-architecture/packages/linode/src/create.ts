/**
 * Create forms and create calls. Every id the API wants (region, plan,
 * image, engine version, Kubernetes version, firewall, Linode) is a picker
 * fed from the live API; nobody types a slug.
 */

import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  ResourceInstance,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { dnsContentField } from "@infrawrench/plugin-base";
import { type LinodeApi, splitList, trailingId } from "./api.js";
import {
  mapBucket,
  mapDatabase,
  mapDomain,
  mapDomainRecord,
  mapFirewall,
  mapImage,
  mapLinode,
  mapLkeCluster,
  mapLkePool,
  mapNodeBalancer,
  mapReservedIp,
  mapStackScript,
  mapVolume,
  mapVpc,
} from "./listers.js";
import {
  type PriceCatalog,
  type PriceCatalogCache,
  monthlyOf,
  planCategory,
  regionalPrice,
} from "./pricing.js";
import { regionOptions } from "./regions.js";
import type {
  LinodeBucket,
  LinodeDatabase,
  LinodeDomain,
  LinodeDomainRecord,
  LinodeFirewall,
  LinodeImage,
  LinodeInstance,
  LinodeLkeCluster,
  LinodeLkePool,
  LinodeNodeBalancer,
  LinodeReservedIp,
  LinodeStackScript,
  LinodeVolume,
  LinodeVpc,
} from "./types.js";

export interface CreateContext {
  api: LinodeApi;
  catalog: PriceCatalogCache;
}

/** The Linode plan catalog as size-picker options (default-region prices). */
export function linodeSizeOptions(
  catalog: PriceCatalog,
  opts: { excludeGpu?: boolean } = {},
): SizeOption[] {
  return catalog.linodeTypes
    .filter((t) => !(opts.excludeGpu && (t.gpus ?? 0) > 0))
    .map((t) => {
      const price = monthlyOf(regionalPrice(t, undefined));
      return {
        id: t.id,
        label: t.label ?? t.id,
        vcpus: t.vcpus ?? 0,
        memoryMb: t.memory ?? 0,
        diskGb: Math.round((t.disk ?? 0) / 1024),
        category: planCategory(t.class),
        ...(price != null ? { priceMonthly: price } : {}),
      };
    });
}

async function imageOptions(api: LinodeApi): Promise<ImageOption[]> {
  const images = await api.all<LinodeImage>("/images").catch(() => [] as LinodeImage[]);
  return images
    .filter((i) => i.status === "available" && !i.deprecated)
    .map((i) => ({
      id: i.id,
      label: i.label ?? i.id,
      ...(i.description ? { description: i.description } : {}),
      category: i.is_public ? (i.vendor ?? "Other") : "My Images",
      isOwned: i.is_public !== true,
    }));
}

/** A strong random root password: Linode requires one when deploying an image. */
export function randomRootPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+";
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const firewallPicker = (key = "firewallId"): CreateFieldConfig => ({
  key,
  label: "Cloud Firewall",
  kind: "resource-picker",
  required: false,
  description: "Protect it with an existing Cloud Firewall",
  associationSources: [{ pluginId: "linode", resourceTypeId: "firewall", outputKey: "firewallId" }],
});

const tagsField: CreateFieldConfig = {
  key: "tags",
  label: "Tags",
  kind: "string-list",
  required: false,
  addLabel: "Add tag",
};

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

export async function getCreateConfig(
  ctx: CreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const { api } = ctx;
  switch (typeId) {
    case "linode": {
      const [regions, catalog, images] = await Promise.all([
        regionOptions(api, "Linodes"),
        ctx.catalog.get(),
        imageOptions(api),
      ]);
      const sizes = linodeSizeOptions(catalog);
      const defaultImage = images.find((i) => i.id === "linode/ubuntu24.04")?.id ?? images[0]?.id;
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions.find((r) => r.id === "us-east")?.id ?? regions[0]?.id ?? "",
          },
          {
            key: "type",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes,
            defaultValue: sizes.find((s) => s.id === "g6-standard-1")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "image",
            label: "Image",
            kind: "image-picker",
            required: true,
            images,
            ...(defaultImage ? { defaultValue: defaultImage } : {}),
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
          {
            key: "rootPass",
            label: "Root Password",
            kind: "password",
            required: false,
            description:
              "Leave empty to generate a strong random password; sign in with your SSH key instead",
          },
          yesNo(
            "backupsEnabled",
            "Backups",
            "false",
            "The Backups add-on is billed per plan on top of the Linode",
          ),
          yesNo(
            "privateIp",
            "Private IPv4",
            "false",
            "Adds a private address in the region's private network",
          ),
          firewallPicker(),
          tagsField,
        ],
      };
    }
    case "volume": {
      const regions = await regionOptions(api, "Block Storage");
      return {
        fields: [
          {
            key: "label",
            label: "Label",
            kind: "text",
            required: true,
            description: "Up to 32 characters",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: false,
            regions,
            defaultValue: regions[0]?.id ?? "",
            description: "Ignored when attaching to a Linode, which decides the region",
          },
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 10,
            maxGb: 16384,
            defaultGb: 20,
            stepGb: 10,
          },
          {
            key: "linodeId",
            label: "Attach to Linode",
            kind: "resource-picker",
            required: false,
            associationSources: [
              { pluginId: "linode", resourceTypeId: "linode", outputKey: "linodeId" },
            ],
          },
          yesNo("encryption", "Encryption", "true"),
          tagsField,
        ],
      };
    }
    case "nodebalancer": {
      const regions = await regionOptions(api, "NodeBalancers");
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: false },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions[0]?.id ?? "",
          },
          {
            key: "clientConnThrottle",
            label: "Connection Throttle",
            kind: "number",
            required: false,
            minValue: 0,
            maxValue: 20,
            defaultValue: "0",
            description: "New connections per second per client IP; 0 disables throttling",
          },
          firewallPicker(),
          tagsField,
        ],
      };
    }
    case "lke-cluster": {
      const [regions, catalog, versions] = await Promise.all([
        regionOptions(api, "Kubernetes"),
        ctx.catalog.get(),
        api.all<{ id: string }>("/lke/versions").catch(() => [] as Array<{ id: string }>),
      ]);
      const versionOptions: SelectOption[] = versions.map((v) => ({ id: v.id, label: v.id }));
      const sizes = linodeSizeOptions(catalog, { excludeGpu: true });
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions[0]?.id ?? "",
          },
          {
            key: "k8sVersion",
            label: "Kubernetes Version",
            kind: "select",
            required: true,
            options: versionOptions,
            defaultValue: versionOptions[0]?.id ?? "",
          },
          yesNo(
            "highAvailability",
            "HA Control Plane",
            "false",
            "Replicated control plane, billed per cluster; cannot be turned off later",
          ),
          {
            key: "nodeType",
            label: "Node Plan",
            kind: "size-picker",
            required: true,
            sizes,
            defaultValue: sizes.find((s) => s.id === "g6-standard-2")?.id ?? sizes[0]?.id ?? "",
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
          tagsField,
        ],
      };
    }
    case "lke-node-pool": {
      const catalog = await ctx.catalog.get();
      const sizes = linodeSizeOptions(catalog, { excludeGpu: false });
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        fields.push({
          key: "clusterId",
          label: "Cluster",
          kind: "resource-picker",
          required: true,
          associationSources: [
            { pluginId: "linode", resourceTypeId: "lke-cluster", outputKey: "clusterId" },
          ],
        });
      }
      fields.push(
        {
          key: "type",
          label: "Node Plan",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: sizes.find((s) => s.id === "g6-standard-2")?.id ?? sizes[0]?.id ?? "",
        },
        {
          key: "count",
          label: "Nodes",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 100,
          defaultValue: "3",
        },
        yesNo("autoscalerEnabled", "Autoscaler", "false"),
        {
          key: "autoscalerMin",
          label: "Autoscaler Minimum",
          kind: "number",
          required: false,
          minValue: 1,
          maxValue: 100,
          defaultValue: "1",
          showWhen: { fieldKey: "autoscalerEnabled", fieldValue: "true" },
        },
        {
          key: "autoscalerMax",
          label: "Autoscaler Maximum",
          kind: "number",
          required: false,
          minValue: 1,
          maxValue: 100,
          defaultValue: "5",
          showWhen: { fieldKey: "autoscalerEnabled", fieldValue: "true" },
        },
      );
      return { fields };
    }
    case "bucket": {
      const regions = await regionOptions(api, "Object Storage");
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description:
              "3 to 63 lowercase letters, digits, dashes and periods; unique within the region",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions[0]?.id ?? "",
          },
          {
            key: "acl",
            label: "Access",
            kind: "select",
            required: false,
            defaultValue: "private",
            options: [
              { id: "private", label: "Private" },
              { id: "authenticated-read", label: "Authenticated read" },
              { id: "public-read", label: "Public read" },
              { id: "public-read-write", label: "Public read and write" },
            ],
          },
          yesNo("corsEnabled", "CORS", "true"),
        ],
      };
    }
    case "database": {
      const [regions, catalog, engines] = await Promise.all([
        regionOptions(api, "Managed Databases"),
        ctx.catalog.get(),
        api
          .all<{ id: string; engine?: string; version?: string }>("/databases/engines")
          .catch(() => []),
      ]);
      const engineOptions: SelectOption[] = engines
        .map((e) => ({
          id: e.id,
          label: `${e.engine === "postgresql" ? "PostgreSQL" : "MySQL"} ${e.version ?? ""}`.trim(),
        }))
        .sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
      const sizes: SizeOption[] = catalog.databaseTypes.map((t) => {
        const single = t.engines?.["mysql"]?.find((e) => e.quantity === 1)?.price?.monthly;
        return {
          id: t.id,
          label: (t.label ?? t.id).replace(/^DBaaS - /, ""),
          vcpus: t.vcpus ?? 0,
          memoryMb: t.memory ?? 0,
          diskGb: Math.round((t.disk ?? 0) / 1024),
          category: planCategory(t.class),
          ...(single != null ? { priceMonthly: single } : {}),
        };
      });
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "engineVersion",
            label: "Engine",
            kind: "select",
            required: true,
            options: engineOptions,
            defaultValue:
              engineOptions.find((e) => e.id.startsWith("postgresql"))?.id ??
              engineOptions[0]?.id ??
              "",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions[0]?.id ?? "",
          },
          {
            key: "type",
            label: "Node Plan",
            kind: "size-picker",
            required: true,
            sizes,
            defaultValue: sizes.find((s) => s.id === "g6-nanode-1")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "clusterSize",
            label: "Nodes",
            kind: "select",
            required: true,
            defaultValue: "1",
            options: [
              { id: "1", label: "1 node" },
              { id: "3", label: "3 nodes (high availability)" },
            ],
          },
          {
            key: "allowList",
            label: "Allowed IPs",
            kind: "string-list",
            required: false,
            addLabel: "Add IP or CIDR",
            description:
              "Addresses allowed to connect; leave empty to block all access until you add one",
          },
        ],
      };
    }
    case "firewall":
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "inboundPolicy",
            label: "Default Inbound",
            kind: "select",
            required: true,
            defaultValue: "DROP",
            options: [
              { id: "DROP", label: "Drop (only allow what rules permit)" },
              { id: "ACCEPT", label: "Accept" },
            ],
          },
          {
            key: "outboundPolicy",
            label: "Default Outbound",
            kind: "select",
            required: true,
            defaultValue: "ACCEPT",
            options: [
              { id: "ACCEPT", label: "Accept" },
              { id: "DROP", label: "Drop" },
            ],
          },
          yesNo("allowSsh", "Allow SSH (TCP 22)", "true"),
          yesNo("allowWeb", "Allow HTTP and HTTPS (TCP 80, 443)", "false"),
          yesNo("allowPing", "Allow ping (ICMP)", "true"),
          tagsField,
        ],
      };
    case "domain":
      return {
        fields: [
          {
            key: "domain",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "master",
            options: [
              { id: "master", label: "Primary (Linode is authoritative)" },
              { id: "slave", label: "Secondary (mirror another nameserver)" },
            ],
          },
          {
            key: "soaEmail",
            label: "SOA Email",
            kind: "text",
            required: false,
            description: "Required for primary domains",
            showWhen: { fieldKey: "type", fieldValue: "master" },
          },
          {
            key: "masterIps",
            label: "Primary Nameserver IPs",
            kind: "string-list",
            required: false,
            addLabel: "Add IP",
            showWhen: { fieldKey: "type", fieldValue: "slave" },
          },
          tagsField,
        ],
      };
    case "domain-record": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const domains = await api.all<LinodeDomain>("/domains").catch(() => [] as LinodeDomain[]);
        fields.push({
          key: "domainId",
          label: "Domain",
          kind: "select",
          required: true,
          options: domains.map((d) => ({ id: String(d.id), label: d.domain ?? String(d.id) })),
        });
      }
      fields.push(
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "A",
          options: ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"].map((t) => ({
            id: t,
            label: t,
          })),
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: false,
          description: "Relative to the domain; leave empty for the apex",
        },
        ...dnsContentField({ key: "target", label: "Target" }),
        {
          key: "ttlSec",
          label: "TTL (seconds)",
          kind: "number",
          required: false,
          defaultValue: "0",
          description: "0 uses the domain's default",
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          minValue: 0,
          maxValue: 255,
          defaultValue: "10",
          showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
        },
        {
          key: "weight",
          label: "Weight",
          kind: "number",
          required: false,
          minValue: 0,
          maxValue: 65535,
          showWhen: { fieldKey: "type", fieldValue: "SRV" },
        },
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: false,
          minValue: 1,
          maxValue: 65535,
          showWhen: { fieldKey: "type", fieldValue: "SRV" },
        },
        {
          key: "service",
          label: "Service",
          kind: "text",
          required: false,
          placeholder: "sip",
          showWhen: { fieldKey: "type", fieldValue: "SRV" },
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "text",
          required: false,
          placeholder: "tcp",
          showWhen: { fieldKey: "type", fieldValue: "SRV" },
        },
        {
          key: "tag",
          label: "CAA Tag",
          kind: "select",
          required: false,
          defaultValue: "issue",
          options: [
            { id: "issue", label: "issue" },
            { id: "issuewild", label: "issuewild" },
            { id: "iodef", label: "iodef" },
          ],
          showWhen: { fieldKey: "type", fieldValue: "CAA" },
        },
      );
      return { fields };
    }
    case "vpc": {
      const regions = await regionOptions(api, "VPCs");
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions[0]?.id ?? "",
          },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "subnetLabel",
            label: "First Subnet Label",
            kind: "text",
            required: false,
            defaultValue: "default",
          },
          {
            key: "subnetIpv4",
            label: "First Subnet Range",
            kind: "text",
            required: false,
            defaultValue: "10.0.0.0/24",
            description: "A private IPv4 range in CIDR form",
          },
        ],
      };
    }
    case "image":
      return {
        fields: [
          {
            key: "linodeId",
            label: "Linode",
            kind: "resource-picker",
            required: true,
            description: "The Linode whose primary disk is captured",
            associationSources: [
              { pluginId: "linode", resourceTypeId: "linode", outputKey: "linodeId" },
            ],
          },
          { key: "label", label: "Label", kind: "text", required: false },
          { key: "description", label: "Description", kind: "text", required: false },
          yesNo("cloudInit", "Supports cloud-init", "true"),
        ],
      };
    case "stackscript": {
      const images = await imageOptions(api);
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "images",
            label: "Compatible Images",
            kind: "policy-picker",
            required: true,
            policies: images
              .filter((i) => !i.isOwned)
              .map((i) => ({ id: i.id, label: i.label, category: i.category ?? "Other" })),
          },
          {
            key: "script",
            label: "Script",
            kind: "code",
            required: true,
            codeLanguage: "shell",
            defaultValue: "#!/bin/bash\n",
          },
          yesNo(
            "isPublic",
            "Public",
            "false",
            "Public StackScripts can never be made private again",
          ),
        ],
      };
    }
    case "reserved-ip": {
      const regions = await regionOptions(api, "Linodes");
      return {
        fields: [
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: regions[0]?.id ?? "",
          },
          tagsField,
        ],
      };
    }
    default:
      throw new Error(`Linode plugin: no create form for "${typeId}"`);
  }
}

const intOr = (v: string | undefined, d?: number): number | undefined => {
  if (v === undefined || v === "") return d;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : d;
};

/** A JSON array (policy-picker) or comma list into strings. */
export function listValue(v: string | undefined): string[] {
  if (!v) return [];
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return splitList(t);
}

export function firewallRulesFromForm(fields: Record<string, string>) {
  const anywhere = { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] };
  const inbound: Array<Record<string, unknown>> = [];
  if (fields["allowSsh"] !== "false")
    inbound.push({
      label: "allow-ssh",
      action: "ACCEPT",
      protocol: "TCP",
      ports: "22",
      addresses: anywhere,
    });
  if (fields["allowWeb"] === "true")
    inbound.push({
      label: "allow-web",
      action: "ACCEPT",
      protocol: "TCP",
      ports: "80,443",
      addresses: anywhere,
    });
  if (fields["allowPing"] !== "false")
    inbound.push({ label: "allow-ping", action: "ACCEPT", protocol: "ICMP", addresses: anywhere });
  return {
    inbound_policy: fields["inboundPolicy"] || "DROP",
    outbound_policy: fields["outboundPolicy"] || "ACCEPT",
    inbound,
    outbound: [],
  };
}

export async function createResource(
  ctx: CreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const { api } = ctx;
  const tags = listValue(fields["tags"]);
  switch (typeId) {
    case "linode": {
      const keys = fields["sshPublicKey"] ? [fields["sshPublicKey"].trim()] : [];
      const firewallId = intOr(fields["firewallId"]);
      const created = await api.send<LinodeInstance>("POST", "/linode/instances", {
        label: fields["label"],
        region: fields["region"],
        type: fields["type"],
        image: fields["image"],
        root_pass: fields["rootPass"] || randomRootPassword(),
        ...(keys.length ? { authorized_keys: keys } : {}),
        backups_enabled: fields["backupsEnabled"] === "true",
        private_ip: fields["privateIp"] === "true",
        ...(firewallId ? { firewall_id: firewallId } : {}),
        ...(tags.length ? { tags } : {}),
      });
      return mapLinode(created, accountId, firewallId ? [String(firewallId)] : []);
    }
    case "volume": {
      const linodeId = intOr(fields["linodeId"]);
      const created = await api.send<LinodeVolume>("POST", "/volumes", {
        label: fields["label"],
        size: intOr(fields["sizeGb"], 20),
        ...(linodeId ? { linode_id: linodeId } : { region: fields["region"] }),
        encryption: fields["encryption"] === "false" ? "disabled" : "enabled",
        ...(tags.length ? { tags } : {}),
      });
      return mapVolume(created, accountId);
    }
    case "nodebalancer": {
      const firewallId = intOr(fields["firewallId"]);
      const created = await api.send<LinodeNodeBalancer>("POST", "/nodebalancers", {
        region: fields["region"],
        ...(fields["label"] ? { label: fields["label"] } : {}),
        client_conn_throttle: intOr(fields["clientConnThrottle"], 0),
        ...(firewallId ? { firewall_id: firewallId } : {}),
        ...(tags.length ? { tags } : {}),
      });
      return mapNodeBalancer(created, accountId, [], firewallId ? [String(firewallId)] : []);
    }
    case "lke-cluster": {
      const created = await api.send<LinodeLkeCluster>("POST", "/lke/clusters", {
        label: fields["label"],
        region: fields["region"],
        k8s_version: fields["k8sVersion"],
        control_plane: { high_availability: fields["highAvailability"] === "true" },
        node_pools: [{ type: fields["nodeType"], count: intOr(fields["nodeCount"], 3) }],
        ...(tags.length ? { tags } : {}),
      });
      return mapLkeCluster(created, accountId, [
        { id: 0, type: fields["nodeType"] ?? "", count: intOr(fields["nodeCount"], 3) ?? 3 },
      ]);
    }
    case "lke-node-pool": {
      const clusterId =
        fields["clusterId"] || (parentResourceId ? trailingId(parentResourceId) : "");
      if (!clusterId) throw new Error("Pick the cluster to add the node pool to.");
      const autoscale = fields["autoscalerEnabled"] === "true";
      const pool = await api.send<LinodeLkePool>("POST", `/lke/clusters/${clusterId}/pools`, {
        type: fields["type"],
        count: intOr(fields["count"], 3),
        ...(autoscale
          ? {
              autoscaler: {
                enabled: true,
                min: intOr(fields["autoscalerMin"], 1),
                max: intOr(fields["autoscalerMax"], 5),
              },
            }
          : {}),
      });
      const cluster = await api.get<LinodeLkeCluster>(`/lke/clusters/${clusterId}`);
      return mapLkePool(pool, cluster, accountId);
    }
    case "bucket": {
      const created = await api.send<LinodeBucket>("POST", "/object-storage/buckets", {
        label: fields["name"],
        region: fields["region"],
        acl: fields["acl"] || "private",
        cors_enabled: fields["corsEnabled"] !== "false",
      });
      return mapBucket(created, accountId, {
        acl: fields["acl"] || "private",
        cors_enabled: fields["corsEnabled"] !== "false",
      });
    }
    case "database": {
      const engineVersion = fields["engineVersion"] ?? "";
      const engine = engineVersion.split("/")[0] === "postgresql" ? "postgresql" : "mysql";
      const created = await api.send<LinodeDatabase>("POST", `/databases/${engine}/instances`, {
        label: fields["label"],
        engine: engineVersion,
        region: fields["region"],
        type: fields["type"],
        cluster_size: intOr(fields["clusterSize"], 1),
        allow_list: listValue(fields["allowList"]),
      });
      return mapDatabase({ ...created, engine: created.engine ?? engine }, accountId);
    }
    case "firewall": {
      const created = await api.send<LinodeFirewall>("POST", "/networking/firewalls", {
        label: fields["label"],
        rules: firewallRulesFromForm(fields),
        ...(tags.length ? { tags } : {}),
      });
      return mapFirewall(created, accountId);
    }
    case "domain": {
      const created = await api.send<LinodeDomain>("POST", "/domains", {
        domain: fields["domain"],
        type: fields["type"] || "master",
        ...(fields["soaEmail"] ? { soa_email: fields["soaEmail"] } : {}),
        ...(fields["type"] === "slave" ? { master_ips: listValue(fields["masterIps"]) } : {}),
        ...(tags.length ? { tags } : {}),
      });
      return mapDomain(created, accountId, 0);
    }
    case "domain-record": {
      const domainId = fields["domainId"] || (parentResourceId ? trailingId(parentResourceId) : "");
      if (!domainId) throw new Error("Pick the domain to add the record to.");
      const domain = await api.get<LinodeDomain>(`/domains/${domainId}`);
      const record = await api.send<LinodeDomainRecord>(
        "POST",
        `/domains/${domainId}/records`,
        recordBody(fields),
      );
      return mapDomainRecord(record, domain, accountId);
    }
    case "vpc": {
      const subnet = fields["subnetIpv4"]?.trim();
      const created = await api.send<LinodeVpc>("POST", "/vpcs", {
        label: fields["label"],
        region: fields["region"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(subnet
          ? { subnets: [{ label: fields["subnetLabel"] || "default", ipv4: subnet }] }
          : {}),
      });
      return mapVpc(created, accountId);
    }
    case "image": {
      const linodeId = intOr(fields["linodeId"]);
      if (!linodeId) throw new Error("Pick the Linode to capture.");
      const disks = await api.all<{ id: number; filesystem?: string; size?: number }>(
        `/linode/instances/${linodeId}/disks`,
      );
      const disk = [...disks]
        .filter((d) => d.filesystem !== "swap")
        .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
      if (!disk) throw new Error("That Linode has no disk that can be captured.");
      const created = await api.send<LinodeImage>("POST", "/images", {
        disk_id: disk.id,
        ...(fields["label"] ? { label: fields["label"] } : {}),
        ...(fields["description"] ? { description: fields["description"] } : {}),
        cloud_init: fields["cloudInit"] !== "false",
      });
      return mapImage(created, accountId);
    }
    case "stackscript": {
      const created = await api.send<LinodeStackScript>("POST", "/linode/stackscripts", {
        label: fields["label"],
        description: fields["description"] ?? "",
        images: listValue(fields["images"]),
        script: fields["script"],
        is_public: fields["isPublic"] === "true",
      });
      return mapStackScript(created, accountId);
    }
    case "reserved-ip": {
      const created = await api.send<LinodeReservedIp>("POST", "/networking/reserved/ips", {
        region: fields["region"],
        ...(tags.length ? { tags } : {}),
      });
      return mapReservedIp(created, accountId);
    }
    default:
      throw new Error(`Linode plugin: cannot create "${typeId}"`);
  }
}

/** Form fields to a domain record body; `@` means the apex, which Linode spells as "". */
export function recordBody(fields: Record<string, string>): Record<string, unknown> {
  const type = fields["type"] ?? "A";
  const name = (fields["name"] ?? "").trim();
  const body: Record<string, unknown> = {
    type,
    name: name === "@" ? "" : name,
    target: fields["target"] ?? "",
  };
  const ttl = intOr(fields["ttlSec"]);
  if (ttl !== undefined) body["ttl_sec"] = ttl;
  if (type === "MX" || type === "SRV") body["priority"] = intOr(fields["priority"], 10);
  if (type === "SRV") {
    body["weight"] = intOr(fields["weight"], 0);
    body["port"] = intOr(fields["port"], 0);
    if (fields["service"]) body["service"] = fields["service"];
    if (fields["protocol"]) body["protocol"] = fields["protocol"];
  }
  if (type === "CAA") body["tag"] = fields["tag"] || "issue";
  return body;
}
