import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ResourceCreateResult,
  ResourceInstance,
  SelectOption,
} from "@infrawrench/plugin-base";
import { VsphereApiError } from "./api.js";
import { deployLibraryItem, mapLimit, placementOf, type VsphereClient } from "./client.js";
import { DATACENTER, LIBRARY, RESOURCE_POOL, TAG, TAG_CATEGORY, VM } from "./resources.js";

const GIB = 1024 ** 3;

const o = (id: string, label = id, description?: string): SelectOption => ({
  id,
  label,
  ...(description ? { description } : {}),
});

async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Common `guest_OS` identifiers (Vcenter Vm GuestOS enum, vSphere 9.1). */
export const GUEST_OS: SelectOption[] = [
  o("UBUNTU_64", "Ubuntu Linux (64-bit)"),
  o("DEBIAN_13_64", "Debian 13 (64-bit)"),
  o("DEBIAN_12_64", "Debian 12 (64-bit)"),
  o("RHEL_9_64", "Red Hat Enterprise Linux 9"),
  o("RHEL_8_64", "Red Hat Enterprise Linux 8"),
  o("ROCKYLINUX_64", "Rocky Linux"),
  o("ALMALINUX_64", "AlmaLinux"),
  o("ORACLE_LINUX_9_64", "Oracle Linux 9"),
  o("SLES_16_64", "SUSE Linux Enterprise 16"),
  o("SLES_15_64", "SUSE Linux Enterprise 15"),
  o("FEDORA_64", "Fedora (64-bit)"),
  o("VMWARE_PHOTON_64", "VMware Photon OS"),
  o("OTHER_6X_LINUX_64", "Other 6.x Linux (64-bit)"),
  o("WINDOWS_SERVER_2025", "Windows Server 2025"),
  o("WINDOWS_SERVER_2021", "Windows Server 2022"),
  o("WINDOWS_SERVER_2019", "Windows Server 2019"),
  o("WINDOWS_11_64", "Windows 11"),
  o("FREEBSD_14_64", "FreeBSD 14 (64-bit)"),
  o("OTHER_64", "Other (64-bit)"),
];

const ASSOCIABLE_TYPES = [
  "VirtualMachine",
  "HostSystem",
  "ClusterComputeResource",
  "Datastore",
  "Network",
  "DistributedVirtualPortgroup",
  "ResourcePool",
  "Folder",
  "Datacenter",
  "com.vmware.content.Library",
  "com.vmware.content.library.Item",
];

export async function vsphereCreateConfig(
  client: VsphereClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case VM: {
      const [clusters, hosts, pools, datastores, networks, folders, libs, vms, specs] =
        await Promise.all([
          safely(() => client.clusters(), []),
          safely(() => client.hosts(), []),
          safely(() => client.resourcePools(), []),
          safely(() => client.datastores(), []),
          safely(() => client.networks(), []),
          safely(() => client.folders({ type: "VIRTUAL_MACHINE" }), []),
          safely(() => client.libraries(), []),
          safely(() => client.vms(), []),
          safely(
            () => client.api.get<Array<{ name: string }>>("/vcenter/guest/customization-specs"),
            [],
          ),
        ]);
      const items = (
        await mapLimit(libs, 3, (l) => safely(() => client.libraryItems(l.id), []))
      ).flat();
      const byType = (t: string) =>
        items.filter((i) => (i.type ?? "").toLowerCase() === t).map((i) => o(i.id, i.name ?? i.id));
      const templates = byType("vm-template");
      const ovfs = byType("ovf");
      const isos = byType("iso");
      const ds = datastores.map((d) =>
        o(
          d.datastore,
          d.name,
          d.capacity
            ? `${Math.round(((d.free_space ?? 0) / GIB) * 10) / 10} GiB free of ${Math.round((d.capacity / GIB) * 10) / 10}`
            : d.type,
        ),
      );
      const optional = (
        key: string,
        label: string,
        opts: SelectOption[],
        showWhen?: CreateFieldConfig["showWhen"],
        empty = "Let vCenter choose",
      ): CreateFieldConfig => ({
        key,
        label,
        kind: "select",
        required: false,
        defaultValue: "",
        options: [o("", empty), ...opts],
        ...(showWhen ? { showWhen } : {}),
      });
      const notBlank = { fieldKey: "source", fieldValuesNot: ["blank"] };
      const fields: CreateFieldConfig[] = [
        {
          key: "source",
          label: "Create from",
          kind: "select",
          required: true,
          defaultValue: templates.length ? "template" : "blank",
          options: [
            o("template", "Content library VM template"),
            o("ovf", "Content library OVF package"),
            o("clone", "Clone an existing VM"),
            o("blank", "New blank VM"),
          ],
        },
        {
          key: "template",
          label: "VM Template",
          kind: "select",
          required: true,
          options: templates,
          showWhen: { fieldKey: "source", fieldValue: "template" },
        },
        {
          key: "ovf",
          label: "OVF Package",
          kind: "select",
          required: true,
          options: ovfs,
          showWhen: { fieldKey: "source", fieldValue: "ovf" },
        },
        {
          key: "sourceVm",
          label: "Source VM",
          kind: "select",
          required: true,
          options: vms.map((v) => o(v.vm, v.name, v.power_state)),
          showWhen: { fieldKey: "source", fieldValue: "clone" },
        },
        { key: "name", label: "VM Name", kind: "text", required: true, placeholder: "web01" },
        optional(
          "cluster",
          "Cluster",
          clusters.map((c) => o(c.cluster, c.name)),
        ),
        optional(
          "host",
          "Host",
          hosts.map((h) => o(h.host, h.name, h.connection_state)),
        ),
        optional(
          "resourcePool",
          "Resource Pool",
          pools.map((p) => o(p.resource_pool, p.name)),
        ),
        optional("datastore", "Datastore", ds),
        optional(
          "folder",
          "Folder",
          folders.map((fo) => o(fo.folder, fo.name)),
        ),
        {
          key: "guestOs",
          label: "Guest OS",
          kind: "select",
          required: true,
          defaultValue: "UBUNTU_64",
          options: GUEST_OS,
          showWhen: { fieldKey: "source", fieldValue: "blank" },
        },
        {
          key: "cpuCount",
          label: "vCPUs",
          kind: "number",
          required: false,
          defaultValue: "2",
          minValue: 1,
          showWhen: { fieldKey: "source", fieldValues: ["blank", "template"] },
        },
        {
          key: "memoryMb",
          label: "Memory (MiB)",
          kind: "number",
          required: false,
          defaultValue: "4096",
          minValue: 4,
          stepValue: 512,
          showWhen: { fieldKey: "source", fieldValues: ["blank", "template"] },
        },
        {
          key: "diskGb",
          label: "Disk",
          kind: "disk-slider",
          required: true,
          minGb: 1,
          maxGb: 4096,
          defaultGb: 40,
          stepGb: 1,
          showWhen: { fieldKey: "source", fieldValue: "blank" },
        },
        {
          key: "network",
          label: "Network",
          kind: "select",
          required: false,
          options: networks.map((n) => o(n.network, n.name, n.type)),
          ...(networks[0] ? { defaultValue: networks[0].network } : {}),
          showWhen: { fieldKey: "source", fieldValue: "blank" },
        },
        optional(
          "iso",
          "Installation ISO",
          isos,
          { fieldKey: "source", fieldValue: "blank" },
          "None",
        ),
        optional(
          "spec",
          "Guest Customization",
          (specs ?? []).map((s) => o(s.name)),
          notBlank,
          "None",
        ),
        {
          key: "powerOn",
          label: "Power on",
          kind: "select",
          required: false,
          defaultValue: "true",
          options: [o("true", "Yes"), o("false", "No")],
        },
      ];
      return { fields };
    }
    case RESOURCE_POOL: {
      const [pools, clusters] = await Promise.all([
        safely(() => client.resourcePools(), []),
        safely(() => client.clusters(), []),
      ]);
      const shares = [o("NORMAL", "Normal"), o("HIGH", "High"), o("LOW", "Low")];
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "parent",
            label: "Parent",
            kind: "select",
            required: true,
            options: pools.map((p) =>
              o(
                p.resource_pool,
                p.name,
                clusters.find((c) => c.name === p.name) ? "cluster root" : p.resource_pool,
              ),
            ),
            description: "A cluster's root pool is usually named Resources",
          },
          {
            key: "cpuReservationMhz",
            label: "CPU Reservation (MHz)",
            kind: "number",
            required: false,
            defaultValue: "0",
            minValue: 0,
          },
          {
            key: "cpuLimitMhz",
            label: "CPU Limit (MHz)",
            kind: "number",
            required: false,
            defaultValue: "-1",
            description: "-1 is unlimited",
          },
          {
            key: "cpuShares",
            label: "CPU Shares",
            kind: "select",
            required: false,
            defaultValue: "NORMAL",
            options: shares,
          },
          {
            key: "memoryReservationMb",
            label: "Memory Reservation (MB)",
            kind: "number",
            required: false,
            defaultValue: "0",
            minValue: 0,
          },
          {
            key: "memoryLimitMb",
            label: "Memory Limit (MB)",
            kind: "number",
            required: false,
            defaultValue: "-1",
          },
          {
            key: "memoryShares",
            label: "Memory Shares",
            kind: "select",
            required: false,
            defaultValue: "NORMAL",
            options: shares,
          },
        ],
      };
    }
    case DATACENTER: {
      const folders = await safely(() => client.folders({ type: "DATACENTER" }), []);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "folder",
            label: "Folder",
            kind: "select",
            required: true,
            options: folders.map((fo) => o(fo.folder, fo.name)),
            ...(folders[0] ? { defaultValue: folders[0].folder } : {}),
          },
        ],
      };
    }
    case LIBRARY: {
      const datastores = await safely(() => client.datastores(), []);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "datastore",
            label: "Datastore",
            kind: "select",
            required: true,
            options: datastores.map((d) => o(d.datastore, d.name, d.type)),
          },
          {
            key: "subscriptionUrl",
            label: "Subscribe to URL",
            kind: "text",
            required: false,
            placeholder: "https://other-vcenter/cls/vcsp/lib/<id>/lib.json",
            description: "Leave empty for a local library; set to subscribe to a published library",
          },
        ],
      };
    }
    case TAG_CATEGORY:
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "cardinality",
            label: "Tags per object",
            kind: "select",
            required: true,
            defaultValue: "SINGLE",
            options: [o("SINGLE", "One tag"), o("MULTIPLE", "Many tags")],
          },
          {
            key: "associableTypes",
            label: "Applies to",
            kind: "string-list",
            required: false,
            description: `Object types, empty for all: ${ASSOCIABLE_TYPES.join(", ")}`,
          },
        ],
      };
    case TAG: {
      const ids = await safely(() => client.cached<string[]>("/cis/tagging/category"), []);
      const cats = await mapLimit(ids ?? [], 8, async (id) => ({
        id,
        name:
          (
            await safely(
              () =>
                client.cached<{ name?: string }>(`/cis/tagging/category/${encodeURIComponent(id)}`),
              undefined,
            )
          )?.name ?? id,
      }));
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "categoryId",
            label: "Category",
            kind: "select",
            required: true,
            options: cats.map((c) => o(c.id, c.name)),
          },
        ],
      };
    }
    default:
      throw new Error(`vSphere plugin: ${typeId} cannot be created`);
  }
}

export async function vsphereCreateResource(
  client: VsphereClient,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance | ResourceCreateResult> {
  const api = client.api;
  const done = async (id: string) => {
    client.invalidate();
    return client.getResource(typeId, `${accountId}:${typeId}:${id}`, accountId).catch(() =>
      client.instance(accountId, typeId, id, fields["name"] ?? id, {
        name: fields["name"] ?? "",
      }),
    );
  };
  switch (typeId) {
    case VM: {
      const source = fields["source"] ?? "blank";
      if (!fields["name"]) throw new VsphereApiError("A VM name is required.", 400);
      if (source === "template" || source === "ovf") {
        const item = source === "template" ? fields["template"] : fields["ovf"];
        if (!item) throw new VsphereApiError("Pick a library item.", 400);
        return done(
          await deployLibraryItem(
            client,
            item,
            source === "template" ? "vm-template" : "ovf",
            fields,
          ),
        );
      }
      const placement = placementOf(fields);
      if (source === "clone") {
        if (!fields["sourceVm"]) throw new VsphereApiError("Pick the VM to clone.", 400);
        const id = await api.post<string>(
          "/vcenter/vm",
          {
            source: fields["sourceVm"],
            name: fields["name"],
            ...(Object.keys(placement).length ? { placement } : {}),
            power_on: fields["powerOn"] !== "false",
            ...(fields["spec"] ? { guest_customization_spec: { name: fields["spec"] } } : {}),
          },
          { action: "clone" },
        );
        return done(id);
      }
      if (!placement["datastore"]) throw new VsphereApiError("Pick a datastore for a new VM.", 400);
      if (!placement["folder"]) {
        const vmFolders = await safely(() => client.folders({ type: "VIRTUAL_MACHINE" }), []);
        if (vmFolders[0]) placement["folder"] = vmFolders[0].folder;
      }
      if (!placement["resource_pool"] && !placement["host"] && !placement["cluster"]) {
        throw new VsphereApiError("Pick a cluster, host or resource pool for a new VM.", 400);
      }
      const id = await api.post<string>("/vcenter/vm", {
        name: fields["name"],
        guest_OS: fields["guestOs"] || "OTHER_64",
        placement,
        cpu: { count: Number(fields["cpuCount"] || 2) },
        memory: { size_MiB: Number(fields["memoryMb"] || 4096) },
        disks: [{ new_vmdk: { capacity: Math.round(Number(fields["diskGb"] || 40) * GIB) } }],
        ...(fields["network"]
          ? {
              nics: [
                {
                  start_connected: true,
                  backing: {
                    type: networkBackingType(
                      await safely(() => client.networks(), []),
                      fields["network"],
                    ),
                    network: fields["network"],
                  },
                },
              ],
            }
          : {}),
      });
      const warnings = [];
      if (fields["iso"]) {
        try {
          await api.post("/vcenter/iso/image", undefined, {
            action: "mount",
            library_item: fields["iso"],
            vm: id,
          });
        } catch (e) {
          warnings.push({
            code: "iso",
            message: `VM created but the ISO could not be mounted: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          });
        }
      }
      if (fields["powerOn"] !== "false") {
        try {
          await api.post(`/vcenter/vm/${encodeURIComponent(id)}/power`, undefined, {
            action: "start",
          });
        } catch (e) {
          warnings.push({
            code: "power",
            message: `VM created but did not power on: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          });
        }
      }
      return { resource: await done(id), warnings };
    }
    case RESOURCE_POOL: {
      if (!fields["name"] || !fields["parent"])
        throw new VsphereApiError("A name and a parent pool are required.", 400);
      const alloc = (p: "cpu" | "memory", u: "Mhz" | "Mb") => ({
        reservation: Number(fields[`${p}Reservation${u}`] || 0),
        limit: Number(fields[`${p}Limit${u}`] || -1),
        expandable_reservation: true,
        shares: { level: fields[`${p}Shares`] || "NORMAL" },
      });
      const id = await api.post<string>("/vcenter/resource-pool", {
        name: fields["name"],
        parent: fields["parent"],
        cpu_allocation: alloc("cpu", "Mhz"),
        memory_allocation: alloc("memory", "Mb"),
      });
      return done(id);
    }
    case DATACENTER: {
      if (!fields["name"]) throw new VsphereApiError("A name is required.", 400);
      return done(
        await api.post<string>("/vcenter/datacenter", {
          name: fields["name"],
          ...(fields["folder"] ? { folder: fields["folder"] } : {}),
        }),
      );
    }
    case LIBRARY: {
      if (!fields["name"] || !fields["datastore"])
        throw new VsphereApiError("A name and a datastore are required.", 400);
      const subscribed = !!fields["subscriptionUrl"];
      const body = {
        name: fields["name"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
        storage_backings: [{ type: "DATASTORE", datastore_id: fields["datastore"] }],
        type: subscribed ? "SUBSCRIBED" : "LOCAL",
        ...(subscribed
          ? {
              subscription_info: {
                subscription_url: fields["subscriptionUrl"],
                automatic_sync_enabled: true,
                on_demand: true,
                authentication_method: "NONE",
              },
            }
          : {}),
      };
      return done(
        await api.post<string>(
          `/content/${subscribed ? "subscribed-library" : "local-library"}`,
          body,
        ),
      );
    }
    case TAG_CATEGORY: {
      if (!fields["name"]) throw new VsphereApiError("A name is required.", 400);
      const types = (fields["associableTypes"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return done(
        await api.post<string>("/cis/tagging/category", {
          name: fields["name"],
          description: fields["description"] ?? "",
          cardinality: fields["cardinality"] || "SINGLE",
          associable_types: types,
        }),
      );
    }
    case TAG: {
      if (!fields["name"] || !fields["categoryId"])
        throw new VsphereApiError("A name and a category are required.", 400);
      return done(
        await api.post<string>("/cis/tagging/tag", {
          name: fields["name"],
          description: fields["description"] ?? "",
          category_id: fields["categoryId"],
        }),
      );
    }
    default:
      throw new Error(`vSphere plugin: ${typeId} cannot be created`);
  }
}

/** NIC backing type matching the picked network's type. */
export function networkBackingType(
  networks: Array<{ network: string; type: string }>,
  id: string,
): string {
  return networks.find((n) => n.network === id)?.type ?? "STANDARD_PORTGROUP";
}
