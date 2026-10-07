/**
 * Create forms and create calls. Every id the user would otherwise have to
 * know (node, template, ISO, storage, bridge, pool, VMID) comes from a picker
 * filled by a live listing.
 */
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  ResourceCreateResult,
  ResourceInstance,
  ResourceWarning,
  SelectOption,
} from "@infrawrench/plugin-base";
import { ProxmoxApiError, type FormValue } from "./api.js";
import { seg, type ProxmoxClient } from "./client.js";
import { mapLimit, truthy } from "./mappers.js";
import {
  BACKUP_JOB,
  CT,
  FW_ALIAS,
  FW_RULE,
  HA_RESOURCE,
  HA_RULE,
  IPSET,
  POOL,
  SECURITY_GROUP,
  VM,
} from "./resources.js";
import { FIREWALL_RULE_FIELDS } from "./render.js";

const opt = (id: string, label = id, description?: string): SelectOption => ({
  id,
  label,
  ...(description ? { description } : {}),
});

const YES_NO = (def: "true" | "false") => ({
  kind: "select" as const,
  defaultValue: def,
  options: [opt("true", "Yes"), opt("false", "No")],
});

async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function bridges(client: ProxmoxClient, nodes: string[]): Promise<string[]> {
  const lists = await mapLimit(nodes, 4, (n) =>
    safely(
      () =>
        client.api.get<Array<{ iface: string }>>(`/nodes/${seg(n)}/network`, {
          type: "any_bridge",
        }),
      [] as Array<{ iface: string }>,
    ),
  );
  const set = new Set<string>();
  for (const l of lists) for (const b of l ?? []) set.add(b.iface);
  return [...set].sort();
}

async function volumes(client: ProxmoxClient, content: "iso" | "vztmpl"): Promise<ImageOption[]> {
  const stores = await safely(() => client.storagesWithContent(content), []);
  const lists = await mapLimit(stores, 4, (s) =>
    safely(() => client.storageContent(s.node, s.storage, content), []),
  );
  const seen = new Set<string>();
  const out: ImageOption[] = [];
  lists.forEach((items) => {
    for (const i of items) {
      if (seen.has(i.volid)) continue;
      seen.add(i.volid);
      const file = i.volid.split("/").pop() ?? i.volid;
      const family = /^([a-z]+)/i.exec(file)?.[1]?.toLowerCase() ?? "other";
      out.push({
        id: i.volid,
        label: file,
        description: i.volid,
        family,
        category: family.charAt(0).toUpperCase() + family.slice(1),
      });
    }
  });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

async function storagesFor(client: ProxmoxClient, content: string): Promise<string[]> {
  const s = await safely(() => client.storagesWithContent(content), []);
  return [...new Set(s.map((x) => x.storage))];
}

export async function proxmoxCreateConfig(
  client: ProxmoxClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  const api = client.api;
  switch (typeId) {
    case VM:
    case CT: {
      const isVm = typeId === VM;
      const [all, nextid, pools] = await Promise.all([
        safely(() => client.clusterResources(), []),
        safely(() => api.get<string | number>("/cluster/nextid"), ""),
        safely(() => api.get<Array<{ poolid: string }>>("/pools"), []),
      ]);
      const nodes = all
        .filter((r) => r.type === "node" && r.status === "online" && r.node)
        .map((r) => r.node as string)
        .sort();
      const templates = all
        .filter((r) => r.type === (isVm ? "qemu" : "lxc") && truthy(r.template))
        .map((r) => opt(String(r.vmid), `${r.name ?? r.vmid} (${r.vmid})`, `on ${r.node}`));
      const [bridgeList, media, diskStores] = await Promise.all([
        bridges(client, nodes),
        volumes(client, isVm ? "iso" : "vztmpl"),
        storagesFor(client, isVm ? "images" : "rootdir"),
      ]);
      const poolOpts = [opt("", "None"), ...(pools ?? []).map((p) => opt(p.poolid))];
      const sourceKey = isVm ? "iso" : "ostemplate";
      const fields: CreateFieldConfig[] = [
        {
          key: "source",
          label: "Create from",
          kind: "select",
          required: true,
          defaultValue: templates.length ? "template" : sourceKey,
          options: [
            opt("template", isVm ? "Clone a VM template" : "Clone a container template"),
            opt(sourceKey, isVm ? "Blank VM booting an ISO" : "OS template (vztmpl)"),
          ],
        },
        {
          key: "template",
          label: "Template",
          kind: "select",
          required: true,
          options: templates,
          showWhen: { fieldKey: "source", fieldValue: "template" },
          description: templates.length
            ? ""
            : "No templates in this cluster yet. Convert a stopped guest to a template first.",
        },
        {
          key: "full",
          label: "Clone Mode",
          kind: "select",
          required: true,
          defaultValue: "false",
          options: [
            opt("false", "Linked clone", "Fast; shares the template's base disks"),
            opt("true", "Full clone", "Independent copy of every disk"),
          ],
          showWhen: { fieldKey: "source", fieldValue: "template" },
        },
        {
          key: "node",
          label: "Node",
          kind: "select",
          required: true,
          options: nodes.map((n) => opt(n)),
          ...(nodes[0] ? { defaultValue: nodes[0] } : {}),
          description: "Clones from a template on local storage must stay on the template's node",
        },
        {
          key: "vmid",
          label: "VMID",
          kind: "number",
          required: true,
          ...(nextid !== "" ? { defaultValue: String(nextid) } : {}),
          minValue: 100,
          description: "Next free ID, prefilled",
        },
        {
          key: "name",
          label: isVm ? "Name" : "Hostname",
          kind: "text",
          required: true,
          placeholder: isVm ? "web01" : "ct01",
        },
        {
          key: sourceKey,
          label: isVm ? "ISO Image" : "OS Template",
          kind: "image-picker",
          required: true,
          images: media,
          showWhen: { fieldKey: "source", fieldValue: sourceKey },
          description: media.length
            ? ""
            : `No ${isVm ? "ISO images" : "container templates"} found. Use "Download from URL" on a storage first.`,
        },
        {
          key: "diskStorage",
          label: "Disk Storage",
          kind: "select",
          required: false,
          options: [...(isVm ? [] : []), ...diskStores.map((s) => opt(s))],
          ...(diskStores[0] ? { defaultValue: diskStores[0] } : {}),
          description: "For a template clone, only used by a full clone",
        },
        {
          key: "diskGb",
          label: isVm ? "Disk Size" : "Root Disk Size",
          kind: "disk-slider",
          required: true,
          minGb: isVm ? 4 : 2,
          maxGb: 2048,
          defaultGb: isVm ? 32 : 8,
          stepGb: 1,
          showWhen: { fieldKey: "source", fieldValue: sourceKey },
        },
        {
          key: "cores",
          label: "CPU Cores",
          kind: "number",
          required: true,
          defaultValue: "2",
          minValue: 1,
          maxValue: 512,
        },
        {
          key: "memoryMb",
          label: "Memory (MiB)",
          kind: "number",
          required: true,
          defaultValue: isVm ? "2048" : "1024",
          minValue: 16,
          stepValue: 256,
        },
        ...(isVm
          ? []
          : [
              {
                key: "swapMb",
                label: "Swap (MiB)",
                kind: "number" as const,
                required: false,
                defaultValue: "512",
                minValue: 0,
              },
            ]),
        {
          key: "bridge",
          label: "Network Bridge",
          kind: "select",
          required: true,
          options: bridgeList.map((b) => opt(b)),
          ...(bridgeList.includes("vmbr0")
            ? { defaultValue: "vmbr0" }
            : bridgeList[0]
              ? { defaultValue: bridgeList[0] }
              : {}),
          showWhen: { fieldKey: "source", fieldValue: sourceKey },
        },
        {
          key: "vlan",
          label: "VLAN Tag",
          kind: "number",
          required: false,
          minValue: 1,
          maxValue: 4094,
          showWhen: { fieldKey: "source", fieldValue: sourceKey },
        },
        ...(isVm
          ? [
              {
                key: "ostype",
                label: "Guest OS",
                kind: "select" as const,
                required: true,
                defaultValue: "l26",
                options: [
                  opt("l26", "Linux 6.x/2.6 kernel"),
                  opt("win11", "Windows 11/2022/2025"),
                  opt("win10", "Windows 10/2016/2019"),
                  opt("other", "Other"),
                ],
                showWhen: { fieldKey: "source", fieldValue: sourceKey },
              },
              {
                key: "ciuser",
                label: "Cloud-init User",
                kind: "text" as const,
                required: false,
                placeholder: "ubuntu",
                showWhen: { fieldKey: "source", fieldValue: "template" },
                description: "Only for templates with a cloud-init drive",
              },
            ]
          : [
              {
                key: "password",
                label: "Root Password",
                kind: "password" as const,
                required: false,
                showWhen: { fieldKey: "source", fieldValue: sourceKey },
              },
              {
                key: "unprivileged",
                label: "Unprivileged",
                required: false,
                ...YES_NO("true"),
                showWhen: { fieldKey: "source", fieldValue: sourceKey },
              },
              {
                key: "nesting",
                label: "Nesting",
                required: false,
                ...YES_NO("true"),
                description: "Needed by systemd in recent distributions",
                showWhen: { fieldKey: "source", fieldValue: sourceKey },
              },
            ]),
        {
          key: "sshPublicKey",
          label: "SSH Key",
          kind: "ssh-key-picker",
          required: false,
          description: isVm
            ? "Injected by cloud-init (template clones)"
            : "Added to root's authorized_keys",
          ...(isVm ? { showWhen: { fieldKey: "source", fieldValue: "template" } } : {}),
        },
        {
          key: "ipMode",
          label: "IPv4",
          kind: "select",
          required: false,
          defaultValue: "dhcp",
          options: [opt("dhcp", "DHCP"), opt("static", "Static")],
          ...(isVm ? { showWhen: { fieldKey: "source", fieldValue: "template" } } : {}),
        },
        {
          key: "ipCidr",
          label: "IPv4 Address (CIDR)",
          kind: "text",
          required: false,
          placeholder: "192.0.2.10/24",
          showWhen: { fieldKey: "ipMode", fieldValue: "static" },
        },
        {
          key: "gateway",
          label: "Gateway",
          kind: "text",
          required: false,
          placeholder: "192.0.2.1",
          showWhen: { fieldKey: "ipMode", fieldValue: "static" },
        },
        {
          key: "pool",
          label: "Pool",
          kind: "select",
          required: false,
          defaultValue: "",
          options: poolOpts,
        },
        { key: "onboot", label: "Start at Boot", required: false, ...YES_NO("false") },
        { key: "start", label: "Start after creation", required: false, ...YES_NO("true") },
      ];
      return { fields };
    }
    case BACKUP_JOB: {
      const [stores, pools, all] = await Promise.all([
        storagesFor(client, "backup"),
        safely(() => api.get<Array<{ poolid: string }>>("/pools"), []),
        safely(() => client.clusterResources(), []),
      ]);
      const nodes = all
        .filter((r) => r.type === "node" && r.node)
        .map((r) => r.node as string)
        .sort();
      return {
        fields: [
          {
            key: "schedule",
            label: "Schedule",
            kind: "select",
            required: true,
            defaultValue: "21:00",
            options: [
              opt("21:00", "Every day 21:00"),
              opt("2,22:30", "Every day 02:30 and 22:30"),
              opt("mon..fri 00:00", "Weekdays at midnight"),
              opt("sat 02:00", "Saturdays 02:00"),
              opt("sun 01:00", "Sundays 01:00"),
              opt("*/3:00", "Every three hours"),
              opt("monthly", "First of the month"),
            ],
            description: "Edit the job afterwards for any systemd calendar event",
          },
          {
            key: "storage",
            label: "Storage",
            kind: "select",
            required: true,
            options: stores.map((s) => opt(s)),
            ...(stores[0] ? { defaultValue: stores[0] } : {}),
          },
          {
            key: "scope",
            label: "Guests",
            kind: "select",
            required: true,
            defaultValue: "all",
            options: [
              opt("all", "All guests"),
              opt("selection", "Selected VMIDs"),
              opt("pool", "A pool"),
            ],
          },
          {
            key: "selection",
            label: "VMIDs",
            kind: "string-list",
            required: false,
            showWhen: { fieldKey: "scope", fieldValue: "selection" },
          },
          {
            key: "exclude",
            label: "Exclude VMIDs",
            kind: "string-list",
            required: false,
            showWhen: { fieldKey: "scope", fieldValue: "all" },
          },
          {
            key: "pool",
            label: "Pool",
            kind: "select",
            required: false,
            options: (pools ?? []).map((p) => opt(p.poolid)),
            showWhen: { fieldKey: "scope", fieldValue: "pool" },
          },
          {
            key: "node",
            label: "Only on Node",
            kind: "select",
            required: false,
            defaultValue: "",
            options: [opt("", "Any node"), ...nodes.map((n) => opt(n))],
          },
          {
            key: "mode",
            label: "Mode",
            kind: "select",
            required: true,
            defaultValue: "snapshot",
            options: [opt("snapshot", "Snapshot"), opt("suspend", "Suspend"), opt("stop", "Stop")],
          },
          {
            key: "compress",
            label: "Compression",
            kind: "select",
            required: true,
            defaultValue: "zstd",
            options: [
              opt("zstd", "ZSTD"),
              opt("lzo", "LZO"),
              opt("gzip", "GZIP"),
              opt("0", "None"),
            ],
          },
          {
            key: "pruneBackups",
            label: "Retention",
            kind: "text",
            required: false,
            placeholder: "keep-daily=7,keep-weekly=4",
            description: "Empty uses the storage's retention",
          },
          {
            key: "notesTemplate",
            label: "Notes Template",
            kind: "text",
            required: false,
            defaultValue: "{{guestname}}",
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
          { key: "enabled", label: "Enabled", required: false, ...YES_NO("true") },
        ],
      };
    }
    case POOL:
      return {
        fields: [
          {
            key: "poolid",
            label: "Pool ID",
            kind: "text",
            required: true,
            placeholder: "production",
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    case HA_RESOURCE: {
      const [all, existing] = await Promise.all([
        safely(() => client.clusterResources(), []),
        safely(() => api.get<Array<{ sid: string }>>("/cluster/ha/resources"), []),
      ]);
      const taken = new Set((existing ?? []).map((e) => e.sid));
      const guests = all
        .filter((r) => (r.type === "qemu" || r.type === "lxc") && !truthy(r.template))
        .map((r) => ({ sid: `${r.type === "qemu" ? "vm" : "ct"}:${r.vmid}`, r }))
        .filter((g) => !taken.has(g.sid))
        .map((g) =>
          opt(
            g.sid,
            `${g.r.name ?? g.r.vmid} (${g.r.vmid})`,
            `${g.r.type === "qemu" ? "VM" : "Container"} on ${g.r.node}`,
          ),
        );
      return {
        fields: [
          { key: "sid", label: "Guest", kind: "select", required: true, options: guests },
          {
            key: "state",
            label: "Requested State",
            kind: "select",
            required: true,
            defaultValue: "started",
            options: [
              opt("started", "Started"),
              opt("stopped", "Stopped"),
              opt("disabled", "Disabled"),
              opt("ignored", "Ignored"),
            ],
          },
          {
            key: "maxRestart",
            label: "Max Restarts",
            kind: "number",
            required: false,
            defaultValue: "1",
            minValue: 0,
          },
          {
            key: "maxRelocate",
            label: "Max Relocations",
            kind: "number",
            required: false,
            defaultValue: "1",
            minValue: 0,
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    }
    case HA_RULE: {
      const all = await safely(() => client.clusterResources(), []);
      const nodes = all
        .filter((r) => r.type === "node" && r.node)
        .map((r) => r.node as string)
        .sort();
      const ha = await safely(() => api.get<Array<{ sid: string }>>("/cluster/ha/resources"), []);
      return {
        fields: [
          {
            key: "rule",
            label: "Rule ID",
            kind: "text",
            required: true,
            placeholder: "web-on-fast-nodes",
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "node-affinity",
            options: [
              opt("node-affinity", "Node affinity", "Prefer or require specific nodes"),
              opt("resource-affinity", "Resource affinity", "Keep resources together or apart"),
            ],
          },
          {
            key: "resources",
            label: "HA Resources",
            kind: "string-list",
            required: true,
            description: `HA resource IDs${
              (ha ?? []).length
                ? `, e.g. ${(ha ?? [])
                    .slice(0, 3)
                    .map((h) => h.sid)
                    .join(", ")}`
                : " like vm:100"
            }`,
          },
          {
            key: "nodes",
            label: "Nodes",
            kind: "string-list",
            required: false,
            description: `node or node:priority. Nodes: ${nodes.join(", ")}`,
            showWhen: { fieldKey: "type", fieldValue: "node-affinity" },
          },
          {
            key: "affinity",
            label: "Affinity",
            kind: "select",
            required: true,
            defaultValue: "positive",
            options: [
              opt("positive", "Positive (together / on these nodes)"),
              opt("negative", "Negative (apart / not on these nodes)"),
            ],
          },
          {
            key: "strict",
            label: "Strict",
            required: false,
            ...YES_NO("false"),
            showWhen: { fieldKey: "type", fieldValue: "node-affinity" },
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    }
    case FW_RULE:
      return { fields: FIREWALL_RULE_FIELDS };
    case SECURITY_GROUP:
      return {
        fields: [
          {
            key: "group",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "webserver",
            description: "Letters, digits, - and _; must start with a letter",
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    case FW_ALIAS:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "office" },
          {
            key: "cidr",
            label: "Address / CIDR",
            kind: "text",
            required: true,
            placeholder: "198.51.100.0/24",
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    case IPSET:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "trusted" },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    default:
      throw new Error(`Proxmox plugin: ${typeId} cannot be created`);
  }
}

const csv = (v: string | undefined) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");

function ipConfig(fields: Record<string, string>): string {
  if (fields["ipMode"] === "static" && fields["ipCidr"]) {
    return `ip=${fields["ipCidr"]}${fields["gateway"] ? `,gw=${fields["gateway"]}` : ""}`;
  }
  return "ip=dhcp";
}

export async function proxmoxCreateResource(
  client: ProxmoxClient,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance | ResourceCreateResult> {
  const api = client.api;
  const warnings: ResourceWarning[] = [];
  const done = async (externalId: string): Promise<ResourceCreateResult> => {
    client.invalidate();
    const resource = await client
      .getResource(typeId, `${accountId}:${typeId}:${externalId}`, accountId)
      .catch(() =>
        client.instance(accountId, typeId, externalId, fields["name"] || externalId, {}),
      );
    return { resource, warnings };
  };

  switch (typeId) {
    case VM:
    case CT: {
      const isVm = typeId === VM;
      const kind = isVm ? "qemu" : "lxc";
      const vmid = Number(fields["vmid"] || (await api.get<string | number>("/cluster/nextid")));
      const node = fields["node"] ?? "";
      const name = fields["name"] ?? "";
      const start = fields["start"] !== "false";
      const sshKey = (fields["sshPublicKey"] ?? "").trim();

      if (fields["source"] === "template") {
        const tmpl = await client.locateGuest(fields["template"] ?? "");
        const full = fields["full"] === "true";
        const upid = await api.post<string>(`${client.guestPath(tmpl)}/clone`, {
          newid: vmid,
          [isVm ? "name" : "hostname"]: name || undefined,
          full,
          storage: full && fields["diskStorage"] ? fields["diskStorage"] : undefined,
          target: node && node !== tmpl.node ? node : undefined,
          pool: fields["pool"] || undefined,
        });
        const finished = await api.waitForTask(tmpl.node, upid, { timeoutMs: 170_000 });
        const targetNode = node || tmpl.node;
        const config: Record<string, FormValue> = {
          cores: fields["cores"] || undefined,
          memory: fields["memoryMb"] || undefined,
          onboot: fields["onboot"] === "true" ? true : undefined,
        };
        if (isVm) {
          if (fields["ciuser"]) config["ciuser"] = fields["ciuser"];
          // `sshkeys` is itself declared urlencoded, on top of the form encoding.
          if (sshKey) config["sshkeys"] = encodeURIComponent(sshKey);
          if (fields["ipMode"] === "static" || fields["ciuser"] || sshKey)
            config["ipconfig0"] = ipConfig(fields);
        } else if (fields["ipMode"] === "static") {
          warnings.push({
            code: "ct-ip",
            message:
              "Static addressing is not applied to a container clone; edit its network in Proxmox VE.",
          });
        }
        if (!finished) {
          warnings.push({
            code: "clone-running",
            message:
              "The clone is still running in Proxmox VE. CPU, memory and cloud-init settings were not applied and it was not started; edit it once the clone task finishes.",
          });
          return done(String(vmid));
        }
        const path = `/nodes/${seg(targetNode)}/${kind}/${vmid}`;
        try {
          if (Object.values(config).some((v) => v !== undefined))
            await api.put(`${path}/config`, config);
          if (start) await api.post(`${path}/status/start`);
        } catch (e) {
          warnings.push({
            code: "post-clone",
            message: `Cloned, but configuring it failed: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          });
        }
        return done(String(vmid));
      }

      if (!node) throw new ProxmoxApiError("Pick a node.", 400);
      const storage = fields["diskStorage"];
      if (!storage) throw new ProxmoxApiError("Pick a storage for the disk.", 400);
      const size = Number(fields["diskGb"] || (isVm ? 32 : 8));
      const vlan = fields["vlan"] ? `,tag=${fields["vlan"]}` : "";
      let upid: string;
      if (isVm) {
        const iso = fields["iso"];
        upid = await api.post<string>(`/nodes/${seg(node)}/qemu`, {
          vmid,
          name: name || undefined,
          cores: fields["cores"] || 2,
          sockets: 1,
          memory: fields["memoryMb"] || 2048,
          ostype: fields["ostype"] || "l26",
          scsihw: "virtio-scsi-single",
          scsi0: `${storage}:${size},iothread=1`,
          ide2: iso ? `${iso},media=cdrom` : undefined,
          net0: `virtio,bridge=${fields["bridge"] || "vmbr0"}${vlan}`,
          boot: `order=scsi0${iso ? ";ide2" : ""};net0`,
          agent: "1",
          pool: fields["pool"] || undefined,
          onboot: fields["onboot"] === "true" ? true : undefined,
          start,
        });
      } else {
        if (!fields["ostemplate"]) throw new ProxmoxApiError("Pick an OS template.", 400);
        const net = `name=eth0,bridge=${fields["bridge"] || "vmbr0"}${vlan},${ipConfig(fields)}`;
        upid = await api.post<string>(`/nodes/${seg(node)}/lxc`, {
          vmid,
          hostname: name || undefined,
          ostemplate: fields["ostemplate"],
          rootfs: `${storage}:${size}`,
          cores: fields["cores"] || undefined,
          memory: fields["memoryMb"] || 512,
          swap: fields["swapMb"] || 512,
          net0: net,
          password: fields["password"] || undefined,
          "ssh-public-keys": sshKey || undefined,
          unprivileged: fields["unprivileged"] !== "false",
          features: fields["nesting"] !== "false" ? "nesting=1" : undefined,
          pool: fields["pool"] || undefined,
          onboot: fields["onboot"] === "true" ? true : undefined,
          start,
        });
      }
      const ok = await api.waitForTask(node, upid, { timeoutMs: 170_000 });
      if (!ok) {
        warnings.push({
          code: "create-running",
          message: "Proxmox VE is still creating the guest; it will appear once the task finishes.",
        });
      }
      return done(String(vmid));
    }
    case BACKUP_JOB: {
      const scope = fields["scope"] || "all";
      const res = await api.post<unknown>("/cluster/backup", {
        schedule: fields["schedule"] || "21:00",
        storage: fields["storage"],
        all: scope === "all" ? true : undefined,
        exclude: scope === "all" && csv(fields["exclude"]) ? csv(fields["exclude"]) : undefined,
        vmid: scope === "selection" ? csv(fields["selection"]) : undefined,
        pool: scope === "pool" ? fields["pool"] : undefined,
        node: fields["node"] || undefined,
        mode: fields["mode"] || "snapshot",
        compress: fields["compress"] || "zstd",
        "prune-backups": fields["pruneBackups"] || undefined,
        "notes-template": fields["notesTemplate"] || undefined,
        comment: fields["comment"] || undefined,
        enabled: fields["enabled"] !== "false",
      });
      void res;
      // The create call returns nothing; find the job we just made by its comment/schedule.
      client.invalidate();
      const jobs = await client.listResources(BACKUP_JOB, accountId);
      const match = [...jobs]
        .reverse()
        .find(
          (j) =>
            j.fields["schedule"] === (fields["schedule"] || "21:00") &&
            j.fields["storage"] === fields["storage"] &&
            (!fields["comment"] || j.fields["comment"] === fields["comment"]),
        );
      if (!match)
        throw new ProxmoxApiError("Backup job was created but could not be read back.", 500);
      return { resource: match, warnings };
    }
    case POOL:
      if (!fields["poolid"]) throw new ProxmoxApiError("A pool ID is required.", 400);
      await api.post("/pools", {
        poolid: fields["poolid"],
        comment: fields["comment"] || undefined,
      });
      return done(fields["poolid"]);
    case HA_RESOURCE:
      if (!fields["sid"]) throw new ProxmoxApiError("Pick a guest.", 400);
      await api.post("/cluster/ha/resources", {
        sid: fields["sid"],
        state: fields["state"] || "started",
        max_restart: fields["maxRestart"] || undefined,
        max_relocate: fields["maxRelocate"] || undefined,
        comment: fields["comment"] || undefined,
      });
      return done(fields["sid"]);
    case HA_RULE: {
      const type = fields["type"] || "node-affinity";
      if (!fields["rule"]) throw new ProxmoxApiError("A rule ID is required.", 400);
      await api.post("/cluster/ha/rules", {
        rule: fields["rule"],
        type,
        resources: csv(fields["resources"]),
        nodes: type === "node-affinity" ? csv(fields["nodes"]) : undefined,
        affinity: fields["affinity"] || "positive",
        strict: type === "node-affinity" && fields["strict"] === "true" ? true : undefined,
        comment: fields["comment"] || undefined,
      });
      return done(fields["rule"]);
    }
    case FW_RULE: {
      const params: Record<string, FormValue> = {
        type: fields["type"] || "in",
        action: fields["action"] || "ACCEPT",
        enable: 1,
        pos: 0,
      };
      for (const k of ["macro", "proto", "dport", "source", "comment"])
        if (fields[k]) params[k] = fields[k];
      await api.post("/cluster/firewall/rules", params);
      return done("0");
    }
    case SECURITY_GROUP:
      if (!fields["group"]) throw new ProxmoxApiError("A name is required.", 400);
      await api.post("/cluster/firewall/groups", {
        group: fields["group"],
        comment: fields["comment"] || undefined,
      });
      return done(fields["group"]);
    case FW_ALIAS:
      if (!fields["name"] || !fields["cidr"])
        throw new ProxmoxApiError("A name and an address are required.", 400);
      await api.post("/cluster/firewall/aliases", {
        name: fields["name"],
        cidr: fields["cidr"],
        comment: fields["comment"] || undefined,
      });
      return done(fields["name"]);
    case IPSET:
      if (!fields["name"]) throw new ProxmoxApiError("A name is required.", 400);
      await api.post("/cluster/firewall/ipset", {
        name: fields["name"],
        comment: fields["comment"] || undefined,
      });
      return done(fields["name"]);
    default:
      throw new Error(`Proxmox plugin: ${typeId} cannot be created`);
  }
}
