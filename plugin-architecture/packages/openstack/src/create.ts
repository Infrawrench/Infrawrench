import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  ResourceCreateResult,
  ResourceInstance,
  ResourceWarning,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { externalIdOf, utf8ToBase64 } from "@infrawrench/plugin-base";
import { OpenStackApiError } from "./api.js";
import type { OpenStackClient } from "./client.js";
import { ruleBody } from "./ops.js";
import { str } from "./mappers.js";
import {
  CONTAINER,
  DNS_RECORDSET,
  DNS_ZONE,
  FLOATING_IP,
  KEYPAIR,
  LB_LISTENER,
  LB_POOL,
  LOADBALANCER,
  NETWORK,
  ROUTER,
  SECURITY_GROUP,
  SERVER,
  SG_RULE,
  STACK,
  SUBNET,
  VOLUME,
} from "./resources.js";
import { RULE_FIELDS } from "./render.js";

type Obj = Record<string, unknown>;
const o = (id: string, label = id, description?: string): SelectOption => ({
  id,
  label,
  ...(description ? { description } : {}),
});
const e = encodeURIComponent;

async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

const parentExt = (parentResourceId?: string) =>
  parentResourceId ? externalIdOf(parentResourceId) : "";

async function azs(c: OpenStackClient, service: "compute" | "block-storage"): Promise<string[]> {
  const res = await safely(
    () =>
      c.api.get<{
        availabilityZoneInfo?: Array<{ zoneName: string; zoneState?: { available?: boolean } }>;
      }>(service, "/os-availability-zone"),
    undefined,
  );
  return (res?.availabilityZoneInfo ?? [])
    .filter((z) => z.zoneState?.available !== false)
    .map((z) => z.zoneName);
}

function imageOptions(images: Obj[], projectId: string): ImageOption[] {
  return images
    .filter((i) => i["status"] === "active")
    .map((i) => {
      const distro =
        str(i["os_distro"]) || (/^[a-z]+/i.exec(str(i["name"]))?.[0] ?? "other").toLowerCase();
      const owned = i["owner"] === projectId;
      return {
        id: str(i["id"]),
        label: str(i["name"]) || str(i["id"]),
        description: [
          str(i["os_version"]),
          i["size"] ? `${Math.round((Number(i["size"]) / 1024 ** 3) * 10) / 10} GiB` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        family: distro,
        isOwned: owned,
        category: owned ? "My Images" : distro.charAt(0).toUpperCase() + distro.slice(1),
      };
    });
}

export async function openstackCreateConfig(
  c: OpenStackClient,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const api = c.api;
  switch (typeId) {
    case SERVER: {
      const [flavors, images, networks, keypairs, sgs, zones, pid] = await Promise.all([
        safely(() => c.flavors(), []),
        safely(() => c.images(false), [] as Obj[]),
        safely(() => c.networks(), [] as Obj[]),
        safely(
          () =>
            api.get<{ keypairs?: Array<{ keypair: { name: string } }> }>("compute", "/os-keypairs"),
          undefined,
        ),
        safely(() => c.securityGroups(), []),
        azs(c, "compute"),
        safely(() => c.projectId(), ""),
      ]);
      const sizes: SizeOption[] = flavors.map((fl) => ({
        id: fl.id,
        label: fl.name,
        vcpus: fl.vcpus,
        memoryMb: fl.ram,
        diskGb: fl.disk,
        category: fl.name.split(/[.\-_]/)[0] ?? "Flavors",
      }));
      const internal = networks.filter((n) => n["router:external"] !== true);
      const external = networks.filter((n) => n["router:external"] === true);
      const fields: CreateFieldConfig[] = [
        { key: "name", label: "Name", kind: "text", required: true, placeholder: "web01" },
        { key: "flavorRef", label: "Flavor", kind: "size-picker", required: true, sizes },
        {
          key: "imageRef",
          label: "Image",
          kind: "image-picker",
          required: true,
          images: imageOptions(images, pid),
        },
        {
          key: "network",
          label: "Network",
          kind: "select",
          required: true,
          options: [
            ...internal.map((n) =>
              o(str(n["id"]), str(n["name"]) || str(n["id"]), n["shared"] === true ? "shared" : ""),
            ),
            o("auto", "Auto-allocate"),
            o("none", "No network"),
          ],
          ...(internal[0] ? { defaultValue: str(internal[0]["id"]) } : { defaultValue: "auto" }),
        },
        {
          key: "keyName",
          label: "Key Pair",
          kind: "select",
          required: false,
          defaultValue: "",
          options: [
            o("", "None / use SSH key below"),
            ...(keypairs?.keypairs ?? []).map((k) => o(k.keypair.name)),
          ],
        },
        {
          key: "sshPublicKey",
          label: "SSH Key",
          kind: "ssh-key-picker",
          required: false,
          description: "Imported as a new key pair when no key pair is picked",
        },
        {
          key: "securityGroup",
          label: "Security Group",
          kind: "select",
          required: false,
          defaultValue: sgs.some((g) => g.name === "default") ? "default" : "",
          options: [
            o("", "Project default"),
            ...[...new Set(sgs.map((g) => g.name))].map((n) => o(n)),
          ],
        },
        ...(zones.length
          ? [
              {
                key: "availabilityZone",
                label: "Availability Zone",
                kind: "select" as const,
                required: false,
                defaultValue: "",
                options: [o("", "Any"), ...zones.map((z) => o(z))],
              },
            ]
          : []),
        {
          key: "bootFromVolume",
          label: "Root Disk",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [o("false", "Flavor's local disk"), o("true", "New Cinder volume")],
        },
        {
          key: "volumeSizeGb",
          label: "Root Volume Size",
          kind: "disk-slider",
          required: false,
          minGb: 1,
          maxGb: 2048,
          defaultGb: 20,
          stepGb: 1,
          showWhen: { fieldKey: "bootFromVolume", fieldValue: "true" },
        },
        ...(external.length
          ? [
              {
                key: "floatingNetwork",
                label: "Floating IP",
                kind: "select" as const,
                required: false,
                defaultValue: "",
                options: [
                  o("", "None"),
                  ...external.map((n) => o(str(n["id"]), `From ${str(n["name"])}`)),
                ],
              },
            ]
          : []),
        {
          key: "userData",
          label: "User Data",
          kind: "code",
          codeLanguage: "yaml",
          required: false,
          placeholder: "#cloud-config\npackages:\n  - nginx",
        },
      ];
      return { fields };
    }
    case KEYPAIR:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "publicKey", label: "Public Key", kind: "ssh-key-picker", required: true },
        ],
      };
    case VOLUME: {
      const [types, zones, images, snaps, pid] = await Promise.all([
        safely(
          () =>
            api.get<{ volume_types?: Array<{ id: string; name: string; description?: string }> }>(
              "block-storage",
              "/types",
            ),
          undefined,
        ),
        azs(c, "block-storage"),
        safely(() => c.images(false), [] as Obj[]),
        safely(
          () => api.paginate<Obj>("block-storage", "/snapshots/detail", "snapshots"),
          [] as Obj[],
        ),
        safely(() => c.projectId(), ""),
      ]);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "size",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 1,
            maxGb: 16384,
            defaultGb: 20,
            stepGb: 1,
          },
          ...((types?.volume_types ?? []).length
            ? [
                {
                  key: "volumeType",
                  label: "Volume Type",
                  kind: "select" as const,
                  required: false,
                  defaultValue: "",
                  options: [
                    o("", "Default"),
                    ...(types?.volume_types ?? []).map((t) => o(t.name, t.name, t.description)),
                  ],
                },
              ]
            : []),
          ...(zones.length
            ? [
                {
                  key: "availabilityZone",
                  label: "Availability Zone",
                  kind: "select" as const,
                  required: false,
                  defaultValue: "",
                  options: [o("", "Default"), ...zones.map((z) => o(z))],
                },
              ]
            : []),
          {
            key: "source",
            label: "Source",
            kind: "select",
            required: true,
            defaultValue: "blank",
            options: [
              o("blank", "Empty volume"),
              o("image", "From image"),
              o("snapshot", "From snapshot"),
            ],
          },
          {
            key: "imageRef",
            label: "Image",
            kind: "image-picker",
            required: true,
            images: imageOptions(images, pid),
            showWhen: { fieldKey: "source", fieldValue: "image" },
          },
          {
            key: "snapshotId",
            label: "Snapshot",
            kind: "select",
            required: true,
            options: snaps.map((s) =>
              o(str(s["id"]), str(s["name"]) || str(s["id"]), `${str(s["size"])} GiB`),
            ),
            showWhen: { fieldKey: "source", fieldValue: "snapshot" },
          },
        ],
      };
    }
    case NETWORK:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          { key: "mtu", label: "MTU", kind: "number", required: false, placeholder: "1450" },
          {
            key: "cidr",
            label: "Subnet CIDR",
            kind: "text",
            required: false,
            placeholder: "10.10.0.0/24",
            description: "Creates a subnet on the new network too",
          },
          {
            key: "dnsNameservers",
            label: "Subnet DNS Servers",
            kind: "string-list",
            required: false,
            showWhen: { fieldKey: "cidr", fieldValuesNot: [""] },
          },
        ],
      };
    case SUBNET: {
      const nets = (await safely(() => c.networks(), [] as Obj[])).filter(
        (n) => n["router:external"] !== true,
      );
      const parent = parentExt(parentResourceId);
      return {
        fields: [
          {
            key: "networkId",
            label: "Network",
            kind: "select",
            required: true,
            options: nets.map((n) => o(str(n["id"]), str(n["name"]) || str(n["id"]))),
            ...(parent ? { defaultValue: parent } : {}),
          },
          { key: "name", label: "Name", kind: "text", required: false },
          { key: "cidr", label: "CIDR", kind: "text", required: true, placeholder: "10.10.1.0/24" },
          {
            key: "ipVersion",
            label: "IP Version",
            kind: "select",
            required: true,
            defaultValue: "4",
            options: [o("4", "IPv4"), o("6", "IPv6")],
          },
          {
            key: "gatewayIp",
            label: "Gateway",
            kind: "text",
            required: false,
            placeholder: "Defaults to the first address",
          },
          {
            key: "enableDhcp",
            label: "DHCP",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [o("true", "Enabled"), o("false", "Disabled")],
          },
          { key: "dnsNameservers", label: "DNS Servers", kind: "string-list", required: false },
        ],
      };
    }
    case ROUTER: {
      const ext = (await safely(() => c.networks(), [] as Obj[])).filter(
        (n) => n["router:external"] === true,
      );
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "externalNetworkId",
            label: "External Gateway",
            kind: "select",
            required: false,
            defaultValue: ext[0] ? str(ext[0]["id"]) : "",
            options: [o("", "None"), ...ext.map((n) => o(str(n["id"]), str(n["name"])))],
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    }
    case FLOATING_IP: {
      const ext = (await safely(() => c.networks(), [] as Obj[])).filter(
        (n) => n["router:external"] === true,
      );
      return {
        fields: [
          {
            key: "networkId",
            label: "Pool",
            kind: "select",
            required: true,
            options: ext.map((n) => o(str(n["id"]), str(n["name"]))),
            ...(ext[0] ? { defaultValue: str(ext[0]["id"]) } : {}),
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    }
    case SECURITY_GROUP:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case SG_RULE: {
      const parent = parentExt(parentResourceId);
      const sgs = parent ? [] : await safely(() => c.securityGroups(), []);
      return {
        fields: [
          ...(parent
            ? []
            : [
                {
                  key: "securityGroupId",
                  label: "Security Group",
                  kind: "select" as const,
                  required: true,
                  options: sgs.map((g) => o(g.id, g.name)),
                },
              ]),
          ...RULE_FIELDS,
        ],
      };
    }
    case LOADBALANCER: {
      const subnets = await safely(() => c.neutron<Obj>("subnets", "subnets", false), [] as Obj[]);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "vipSubnetId",
            label: "VIP Subnet",
            kind: "select",
            required: true,
            options: subnets.map((s) =>
              o(str(s["id"]), `${str(s["name"]) || str(s["id"]).slice(0, 8)} (${str(s["cidr"])})`),
            ),
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    }
    case LB_LISTENER:
    case LB_POOL: {
      const parent = parentExt(parentResourceId);
      const lbs = parent ? [] : await safely(() => c.lbList("loadbalancers"), [] as Obj[]);
      const pools =
        typeId === LB_LISTENER ? await safely(() => c.lbList("pools"), [] as Obj[]) : [];
      const listeners =
        typeId === LB_POOL ? await safely(() => c.lbList("listeners"), [] as Obj[]) : [];
      const lbField: CreateFieldConfig[] = parent
        ? []
        : [
            {
              key: "loadBalancerId",
              label: "Load Balancer",
              kind: "select",
              required: true,
              options: lbs.map((l) => o(str(l["id"]), str(l["name"]) || str(l["vip_address"]))),
            },
          ];
      if (typeId === LB_LISTENER) {
        return {
          fields: [
            ...lbField,
            { key: "name", label: "Name", kind: "text", required: false },
            {
              key: "protocol",
              label: "Protocol",
              kind: "select",
              required: true,
              defaultValue: "HTTP",
              options: [
                "HTTP",
                "HTTPS",
                "TCP",
                "UDP",
                "SCTP",
                "TERMINATED_HTTPS",
                "PROMETHEUS",
              ].map((p) => o(p)),
            },
            {
              key: "port",
              label: "Port",
              kind: "number",
              required: true,
              defaultValue: "80",
              minValue: 1,
              maxValue: 65535,
            },
            {
              key: "defaultPoolId",
              label: "Default Pool",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                o("", "None"),
                ...pools.map((p) => o(str(p["id"]), str(p["name"]) || str(p["id"]).slice(0, 8))),
              ],
            },
          ],
        };
      }
      return {
        fields: [
          ...lbField,
          { key: "name", label: "Name", kind: "text", required: false },
          {
            key: "protocol",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: "HTTP",
            options: ["HTTP", "HTTPS", "TCP", "UDP", "PROXY", "PROXYV2", "SCTP"].map((p) => o(p)),
          },
          {
            key: "lbAlgorithm",
            label: "Algorithm",
            kind: "select",
            required: true,
            defaultValue: "ROUND_ROBIN",
            options: ["ROUND_ROBIN", "LEAST_CONNECTIONS", "SOURCE_IP", "SOURCE_IP_PORT"].map((a) =>
              o(a),
            ),
          },
          {
            key: "listenerId",
            label: "Default Pool of Listener",
            kind: "select",
            required: false,
            defaultValue: "",
            options: [
              o("", "None"),
              ...listeners.map((l) =>
                o(
                  str(l["id"]),
                  str(l["name"]) || `${str(l["protocol"])}:${str(l["protocol_port"])}`,
                ),
              ),
            ],
          },
        ],
      };
    }
    case CONTAINER:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "publicRead",
            label: "Public Read",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [o("false", "Private"), o("true", "Public (anyone can read)")],
          },
        ],
      };
    case DNS_ZONE:
      return {
        fields: [
          {
            key: "name",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
          },
          {
            key: "email",
            label: "Admin Email",
            kind: "text",
            required: true,
            placeholder: "hostmaster@example.com",
          },
          {
            key: "ttl",
            label: "Default TTL",
            kind: "number",
            required: false,
            defaultValue: "3600",
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case DNS_RECORDSET: {
      const parent = parentExt(parentResourceId);
      const zones = parent
        ? []
        : await safely(() => c.api.paginate<Obj>("dns", "/v2/zones", "zones"), [] as Obj[]);
      return {
        fields: [
          ...(parent
            ? []
            : [
                {
                  key: "zoneId",
                  label: "Zone",
                  kind: "select" as const,
                  required: true,
                  options: zones.map((z) => o(str(z["id"]), str(z["name"]))),
                },
              ]),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "www",
            description: "Relative to the zone, or a full name ending in a dot",
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "A",
            options: ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS", "PTR", "SSHFP"].map(
              (t) => o(t),
            ),
          },
          { key: "records", label: "Records", kind: "string-list", required: true },
          { key: "ttl", label: "TTL", kind: "number", required: false, defaultValue: "3600" },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    }
    case STACK:
      return {
        fields: [
          { key: "name", label: "Stack Name", kind: "text", required: true },
          {
            key: "template",
            label: "Template (HOT)",
            kind: "code",
            codeLanguage: "yaml",
            required: true,
            placeholder:
              "heat_template_version: 2021-04-16\nresources:\n  net:\n    type: OS::Neutron::Net",
          },
          {
            key: "parameters",
            label: "Parameters",
            kind: "text",
            multiline: true,
            required: false,
            placeholder: "key_name=mykey\nflavor=m1.small",
          },
          {
            key: "timeoutMins",
            label: "Timeout (minutes)",
            kind: "number",
            required: false,
            defaultValue: "60",
          },
        ],
      };
    default:
      throw new Error(`OpenStack plugin: ${typeId} cannot be created`);
  }
}

export async function openstackCreateResource(
  c: OpenStackClient,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance | ResourceCreateResult> {
  const api = c.api;
  const warnings: ResourceWarning[] = [];
  const done = async (ext: string): Promise<ResourceCreateResult> => {
    c.invalidate();
    const resource = await c
      .getResource(typeId, `${accountId}:${typeId}:${ext}`, accountId)
      .catch(() =>
        c.instance(accountId, typeId, ext, fields["name"] ?? ext, { name: fields["name"] ?? "" }),
      );
    return { resource, warnings };
  };
  const csv = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const post = <T>(service: Parameters<typeof api.json>[0], path: string, body: unknown) =>
    api.json<T>(service, "POST", path, { body });

  switch (typeId) {
    case SERVER: {
      if (!fields["name"] || !fields["flavorRef"])
        throw new OpenStackApiError("A name and a flavor are required.", 400);
      let keyName = fields["keyName"] ?? "";
      const pub = (fields["sshPublicKey"] ?? "").trim();
      if (!keyName && pub) {
        keyName = `${fields["name"]}-key`;
        await post("compute", "/os-keypairs", {
          keypair: { name: keyName, public_key: pub },
        }).catch(async (err: unknown) => {
          if (err instanceof OpenStackApiError && err.status === 409) return;
          throw err;
        });
      }
      const net = fields["network"] || "auto";
      const bootVolume = fields["bootFromVolume"] === "true";
      const server: Record<string, unknown> = {
        name: fields["name"],
        flavorRef: fields["flavorRef"],
        networks: net === "auto" || net === "none" ? net : [{ uuid: net }],
        ...(keyName ? { key_name: keyName } : {}),
        ...(fields["securityGroup"]
          ? { security_groups: [{ name: fields["securityGroup"] }] }
          : {}),
        ...(fields["availabilityZone"] ? { availability_zone: fields["availabilityZone"] } : {}),
        ...(fields["userData"] ? { user_data: utf8ToBase64(fields["userData"]) } : {}),
      };
      if (bootVolume) {
        server["block_device_mapping_v2"] = [
          {
            boot_index: 0,
            uuid: fields["imageRef"],
            source_type: "image",
            destination_type: "volume",
            volume_size: Number(fields["volumeSizeGb"] || 20),
            delete_on_termination: true,
          },
        ];
      } else {
        server["imageRef"] = fields["imageRef"];
      }
      const res = await post<{ server?: { id: string } }>("compute", "/servers", { server });
      const id = res?.server?.id;
      if (!id)
        throw new OpenStackApiError("Nova accepted the request but returned no server id", 502);
      if (fields["floatingNetwork"]) {
        try {
          let portId = "";
          for (let i = 0; i < 30 && !portId; i++) {
            const ports = await api.get<{ ports?: Array<{ id: string }> }>(
              "network",
              "/v2.0/ports",
              { device_id: id },
            );
            portId = ports?.ports?.[0]?.id ?? "";
            if (!portId) await new Promise((r) => setTimeout(r, 3000));
          }
          if (!portId) throw new Error("the server had no port after 90 seconds");
          await post("network", "/v2.0/floatingips", {
            floatingip: { floating_network_id: fields["floatingNetwork"], port_id: portId },
          });
        } catch (err) {
          warnings.push({
            code: "floating-ip",
            message: `Server created, but no floating IP was attached: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
      }
      return done(id);
    }
    case KEYPAIR: {
      if (!fields["name"] || !fields["publicKey"])
        throw new OpenStackApiError("A name and a public key are required.", 400);
      await post("compute", "/os-keypairs", {
        keypair: { name: fields["name"], public_key: fields["publicKey"].trim() },
      });
      return done(fields["name"]);
    }
    case VOLUME: {
      const res = await post<{ volume?: { id: string } }>("block-storage", "/volumes", {
        volume: {
          size: Number(fields["size"] || 20),
          ...(fields["name"] ? { name: fields["name"] } : {}),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          ...(fields["volumeType"] ? { volume_type: fields["volumeType"] } : {}),
          ...(fields["availabilityZone"] ? { availability_zone: fields["availabilityZone"] } : {}),
          ...(fields["source"] === "image" && fields["imageRef"]
            ? { imageRef: fields["imageRef"] }
            : {}),
          ...(fields["source"] === "snapshot" && fields["snapshotId"]
            ? { snapshot_id: fields["snapshotId"] }
            : {}),
        },
      });
      return done(res?.volume?.id ?? "");
    }
    case NETWORK: {
      const res = await post<{ network?: { id: string } }>("network", "/v2.0/networks", {
        network: {
          name: fields["name"],
          ...(fields["description"] ? { description: fields["description"] } : {}),
          ...(fields["mtu"] ? { mtu: Number(fields["mtu"]) } : {}),
        },
      });
      const id = res?.network?.id ?? "";
      if (fields["cidr"]) {
        try {
          await post("network", "/v2.0/subnets", {
            subnet: {
              network_id: id,
              cidr: fields["cidr"],
              ip_version: fields["cidr"].includes(":") ? 6 : 4,
              name: `${fields["name"]}-subnet`,
              dns_nameservers: csv(fields["dnsNameservers"]),
            },
          });
        } catch (err) {
          warnings.push({
            code: "subnet",
            message: `Network created, but the subnet failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
      }
      return done(id);
    }
    case SUBNET: {
      const networkId = fields["networkId"] || parentExt(parentResourceId);
      if (!networkId || !fields["cidr"])
        throw new OpenStackApiError("A network and a CIDR are required.", 400);
      const res = await post<{ subnet?: { id: string } }>("network", "/v2.0/subnets", {
        subnet: {
          network_id: networkId,
          cidr: fields["cidr"],
          ip_version: Number(fields["ipVersion"] || 4),
          ...(fields["name"] ? { name: fields["name"] } : {}),
          ...(fields["gatewayIp"] ? { gateway_ip: fields["gatewayIp"] } : {}),
          enable_dhcp: fields["enableDhcp"] !== "false",
          dns_nameservers: csv(fields["dnsNameservers"]),
        },
      });
      return done(res?.subnet?.id ?? "");
    }
    case ROUTER: {
      const res = await post<{ router?: { id: string } }>("network", "/v2.0/routers", {
        router: {
          name: fields["name"],
          ...(fields["description"] ? { description: fields["description"] } : {}),
          ...(fields["externalNetworkId"]
            ? { external_gateway_info: { network_id: fields["externalNetworkId"] } }
            : {}),
        },
      });
      return done(res?.router?.id ?? "");
    }
    case FLOATING_IP: {
      const res = await post<{ floatingip?: { id: string } }>("network", "/v2.0/floatingips", {
        floatingip: {
          floating_network_id: fields["networkId"],
          ...(fields["description"] ? { description: fields["description"] } : {}),
        },
      });
      return done(res?.floatingip?.id ?? "");
    }
    case SECURITY_GROUP: {
      const res = await post<{ security_group?: { id: string } }>(
        "network",
        "/v2.0/security-groups",
        {
          security_group: { name: fields["name"], description: fields["description"] ?? "" },
        },
      );
      return done(res?.security_group?.id ?? "");
    }
    case SG_RULE: {
      const sg = parentExt(parentResourceId) || fields["securityGroupId"] || "";
      if (!sg) throw new OpenStackApiError("Pick a security group.", 400);
      const res = await post<{ security_group_rule?: { id: string } }>(
        "network",
        "/v2.0/security-group-rules",
        ruleBody(sg, fields),
      );
      return done(res?.security_group_rule?.id ?? "");
    }
    case LOADBALANCER: {
      const res = await post<{ loadbalancer?: { id: string } }>(
        "load-balancer",
        "/v2/lbaas/loadbalancers",
        {
          loadbalancer: {
            name: fields["name"],
            vip_subnet_id: fields["vipSubnetId"],
            ...(fields["description"] ? { description: fields["description"] } : {}),
          },
        },
      );
      return done(res?.loadbalancer?.id ?? "");
    }
    case LB_LISTENER: {
      const lb = parentExt(parentResourceId) || fields["loadBalancerId"] || "";
      const res = await post<{ listener?: { id: string } }>(
        "load-balancer",
        "/v2/lbaas/listeners",
        {
          listener: {
            loadbalancer_id: lb,
            protocol: fields["protocol"] || "HTTP",
            protocol_port: Number(fields["port"] || 80),
            ...(fields["name"] ? { name: fields["name"] } : {}),
            ...(fields["defaultPoolId"] ? { default_pool_id: fields["defaultPoolId"] } : {}),
          },
        },
      );
      return done(res?.listener?.id ?? "");
    }
    case LB_POOL: {
      const lb = parentExt(parentResourceId) || fields["loadBalancerId"] || "";
      const res = await post<{ pool?: { id: string } }>("load-balancer", "/v2/lbaas/pools", {
        pool: {
          ...(fields["listenerId"]
            ? { listener_id: fields["listenerId"] }
            : { loadbalancer_id: lb }),
          protocol: fields["protocol"] || "HTTP",
          lb_algorithm: fields["lbAlgorithm"] || "ROUND_ROBIN",
          ...(fields["name"] ? { name: fields["name"] } : {}),
        },
      });
      return done(res?.pool?.id ?? "");
    }
    case CONTAINER: {
      if (!fields["name"]) throw new OpenStackApiError("A name is required.", 400);
      await api.request("object-store", "PUT", `/${e(fields["name"])}`, {
        headers: fields["publicRead"] === "true" ? { "X-Container-Read": ".r:*,.rlistings" } : {},
        rawBody: "",
      });
      return done(fields["name"]);
    }
    case DNS_ZONE: {
      const name = (fields["name"] ?? "").replace(/\.?$/, ".");
      const res = await post<{ id?: string }>("dns", "/v2/zones", {
        name,
        email: fields["email"],
        ...(fields["ttl"] ? { ttl: Number(fields["ttl"]) } : {}),
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      return done(res?.id ?? "");
    }
    case DNS_RECORDSET: {
      const zoneId = parentExt(parentResourceId) || fields["zoneId"] || "";
      if (!zoneId) throw new OpenStackApiError("Pick a zone.", 400);
      let name = fields["name"] ?? "";
      if (!name.endsWith(".")) {
        const zone = await api.get<{ name?: string }>("dns", `/v2/zones/${e(zoneId)}`);
        name = name === "@" || name === "" ? str(zone?.name) : `${name}.${str(zone?.name)}`;
      }
      const res = await post<{ id?: string }>("dns", `/v2/zones/${e(zoneId)}/recordsets`, {
        name,
        type: fields["type"] || "A",
        records: csv(fields["records"]),
        ...(fields["ttl"] ? { ttl: Number(fields["ttl"]) } : {}),
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      return done(`${zoneId}/${res?.id ?? ""}`);
    }
    case STACK: {
      const parameters: Record<string, string> = {};
      for (const line of (fields["parameters"] ?? "").split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) parameters[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      const res = await post<{ stack?: { id: string } }>("orchestration", "/stacks", {
        stack_name: fields["name"],
        template: fields["template"],
        parameters,
        timeout_mins: Number(fields["timeoutMins"] || 60),
      });
      return done(`${fields["name"]}/${res?.stack?.id ?? ""}`);
    }
    default:
      throw new Error(`OpenStack plugin: ${typeId} cannot be created`);
  }
}
