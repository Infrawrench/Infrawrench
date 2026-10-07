import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const VCENTER = "vsphere-vcenter";
export const DATACENTER = "vsphere-datacenter";
export const CLUSTER = "vsphere-cluster";
export const HOST = "vsphere-host";
export const VM = "vsphere-vm";
export const DATASTORE = "vsphere-datastore";
export const NETWORK = "vsphere-network";
export const RESOURCE_POOL = "vsphere-resource-pool";
export const FOLDER = "vsphere-folder";
export const LIBRARY = "vsphere-content-library";
export const LIBRARY_ITEM = "vsphere-library-item";
export const TAG_CATEGORY = "vsphere-tag-category";
export const TAG = "vsphere-tag";
export const CUSTOMIZATION_SPEC = "vsphere-customization-spec";

const ro = { required: false, editable: false } as const;

export const VcenterResourceType = rt({
  name: "vCenter Server",
  id: VCENTER,
  description: "The vCenter Server appliance: version, build and health",
  fields: [
    f("product", "Product", ro),
    f("version", "Version", ro),
    f("build", "Build", ro),
    f("releaseDate", "Release Date", ro),
    f("health", "Overall Health", {
      kind: "enum",
      enumValues: ["green", "yellow", "orange", "red", "gray", "unknown"],
      ...ro,
    }),
  ],
  outputs: [o("url", "vCenter URL")],
  supportsDelete: false,
  iconKey: "server",
});

export const DatacenterResourceType = rt({
  name: "Datacenter",
  id: DATACENTER,
  description: "A vSphere datacenter",
  fields: [f("name", "Name", ro), f("folder", "Folder", ro)],
  outputs: [o("datacenterId", "Datacenter ID")],
  supportsCreate: true,
  pinnable: false,
  iconKey: "building",
});

export const ClusterResourceType = rt({
  name: "Cluster",
  id: CLUSTER,
  description: "A vSphere cluster of ESXi hosts",
  fields: [
    f("name", "Name", ro),
    f("haEnabled", "vSphere HA", { kind: "boolean", ...ro }),
    f("drsEnabled", "DRS", { kind: "boolean", ...ro }),
    f("hostCount", "Hosts", { kind: "number", ...ro }),
    f("datacenterId", "Datacenter", ro),
    f("resourcePoolId", "Root Resource Pool", ro),
  ],
  outputs: [o("clusterId", "Cluster ID")],
  dependsOn: [{ fieldKey: "datacenterId", targetTypeId: DATACENTER, label: "in" }],
  supportsDelete: false,
  iconKey: "cluster",
  postureChecks: [
    {
      id: "vsphere-cluster-ha-off",
      title: "vSphere HA disabled",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "haEnabled", when: "falsy" }],
      reason: "vSphere HA is off, so VMs on a failed host are not restarted elsewhere.",
    },
  ],
});

export const HostResourceType = rt({
  name: "ESXi Host",
  id: HOST,
  description: "An ESXi host managed by vCenter",
  fields: [
    f("name", "Name", ro),
    f("connectionState", "Connection", {
      kind: "enum",
      enumValues: ["CONNECTED", "DISCONNECTED", "NOT_RESPONDING"],
      ...ro,
    }),
    f("powerState", "Power", {
      kind: "enum",
      enumValues: ["POWERED_ON", "POWERED_OFF", "STANDBY"],
      ...ro,
    }),
    f("clusterId", "Cluster", ro),
    f("datacenterId", "Datacenter", ro),
    f("vmCount", "VMs", { kind: "number", ...ro }),
  ],
  outputs: [o("hostname", "Hostname"), o("hostId", "Host ID")],
  dependsOn: [
    { fieldKey: "clusterId", targetTypeId: CLUSTER, label: "member of" },
    { fieldKey: "datacenterId", targetTypeId: DATACENTER, label: "in" },
  ],
  supportsDelete: true,
  iconKey: "server",
  sshEndpoint: {
    hostOutputKey: "hostname",
    runningWhen: { fieldKey: "connectionState", value: "CONNECTED" },
    defaultUsername: "root",
  },
});

export const VmResourceType = rt({
  name: "Virtual Machine",
  id: VM,
  description: "A vSphere virtual machine",
  fields: [
    f("name", "Name", ro),
    f("powerState", "Power State", {
      kind: "enum",
      enumValues: ["POWERED_ON", "POWERED_OFF", "SUSPENDED"],
      ...ro,
    }),
    f("cpuCount", "vCPUs", {
      kind: "number",
      required: false,
      description:
        "Must be a multiple of Cores per Socket. Lowering it on a running VM needs CPU hot remove",
    }),
    f("coresPerSocket", "Cores per Socket", { kind: "number", required: false }),
    f("memoryMb", "Memory (MiB)", {
      kind: "number",
      required: false,
      description: "Changing it on a running VM needs memory hot add",
    }),
    f("cpuHotAdd", "CPU Hot Add", {
      kind: "boolean",
      required: false,
      description: "Only changeable while powered off",
    }),
    f("memoryHotAdd", "Memory Hot Add", {
      kind: "boolean",
      required: false,
      description: "Only changeable while powered off",
    }),
    f("guestOs", "Guest OS", ro),
    f("hardwareVersion", "Hardware Version", ro),
    f("diskGb", "Disk Capacity (GiB)", { kind: "number", ...ro }),
    f("disks", "Disks", ro),
    f("datastores", "Datastores", ro),
    f("networkIds", "Networks", ro),
    f("hostId", "Host", ro),
    f("clusterId", "Cluster", ro),
    f("resourcePoolId", "Resource Pool", ro),
    f("tags", "Tags", ro),
    f("instanceUuid", "Instance UUID", ro),
  ],
  outputs: [
    o("ipAddress", "IP Address", { description: "Reported by VMware Tools" }),
    o("guestHostname", "Guest Hostname"),
    o("vmId", "VM ID"),
  ],
  dependsOn: [
    { fieldKey: "hostId", targetTypeId: HOST, label: "runs on" },
    { fieldKey: "clusterId", targetTypeId: CLUSTER, label: "in" },
    { fieldKey: "resourcePoolId", targetTypeId: RESOURCE_POOL, label: "in pool" },
    { fieldKey: "networkIds", targetTypeId: NETWORK, label: "connected to" },
    { fieldKey: "datastores", targetTypeId: DATASTORE, targetKey: "name", label: "stored on" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "start",
    stopActionId: "guest-shutdown",
    statusFieldKey: "powerState",
    runningValues: ["POWERED_ON"],
    stoppedValues: ["POWERED_OFF"],
  },
  sshEndpoint: {
    hostOutputKey: "ipAddress",
    runningWhen: { fieldKey: "powerState", value: "POWERED_ON" },
  },
});

export const DatastoreResourceType = rt({
  name: "Datastore",
  id: DATASTORE,
  description: "A datastore (VMFS, NFS, vSAN, vVol)",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("capacityGb", "Capacity (GiB)", { kind: "number", ...ro }),
    f("accessible", "Accessible", { kind: "boolean", ...ro }),
    f("multipleHostAccess", "Shared", { kind: "boolean", ...ro }),
    f("thinProvisioning", "Thin Provisioning", { kind: "boolean", ...ro }),
  ],
  outputs: [o("datastoreId", "Datastore ID")],
  supportsDelete: false,
  iconKey: "volume",
});

export const NetworkResourceType = rt({
  name: "Network",
  id: NETWORK,
  description: "A standard port group, distributed port group or opaque (NSX) network",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["STANDARD_PORTGROUP", "DISTRIBUTED_PORTGROUP", "OPAQUE_NETWORK"],
      ...ro,
    }),
  ],
  outputs: [o("networkId", "Network ID")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "network",
});

export const ResourcePoolResourceType = rt({
  name: "Resource Pool",
  id: RESOURCE_POOL,
  description: "A resource pool with CPU and memory reservations, limits and shares",
  fields: [
    f("name", "Name"),
    f("parentId", "Parent", ro),
    f("cpuReservationMhz", "CPU Reservation (MHz)", { kind: "number", required: false }),
    f("cpuLimitMhz", "CPU Limit (MHz)", {
      kind: "number",
      required: false,
      description: "-1 is unlimited",
    }),
    f("cpuExpandable", "CPU Expandable Reservation", { kind: "boolean", required: false }),
    f("cpuShares", "CPU Shares", {
      kind: "enum",
      enumValues: ["LOW", "NORMAL", "HIGH"],
      required: false,
    }),
    f("memoryReservationMb", "Memory Reservation (MB)", { kind: "number", required: false }),
    f("memoryLimitMb", "Memory Limit (MB)", {
      kind: "number",
      required: false,
      description: "-1 is unlimited",
    }),
    f("memoryExpandable", "Memory Expandable Reservation", { kind: "boolean", required: false }),
    f("memoryShares", "Memory Shares", {
      kind: "enum",
      enumValues: ["LOW", "NORMAL", "HIGH"],
      required: false,
    }),
    f("childCount", "Child Pools", { kind: "number", ...ro }),
  ],
  outputs: [o("resourcePoolId", "Resource Pool ID")],
  dependsOn: [{ fieldKey: "parentId", targetTypeId: RESOURCE_POOL, label: "child of" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "folder",
});

export const FolderResourceType = rt({
  name: "Folder",
  id: FOLDER,
  description: "An inventory folder",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["VIRTUAL_MACHINE", "HOST", "DATASTORE", "NETWORK", "DATACENTER"],
      ...ro,
    }),
  ],
  outputs: [o("folderId", "Folder ID")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "folder",
});

export const LibraryResourceType = rt({
  name: "Content Library",
  plural: "Content Libraries",
  id: LIBRARY,
  description: "A local or subscribed content library of VM templates, OVF packages and ISOs",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Type", { kind: "enum", enumValues: ["LOCAL", "SUBSCRIBED"], ...ro }),
    f("datastoreIds", "Storage", ro),
    f("published", "Published", { kind: "boolean", ...ro }),
    f("subscriptionUrl", "Subscription URL", ro),
    f("itemCount", "Items", { kind: "number", ...ro }),
  ],
  outputs: [o("libraryId", "Library ID")],
  dependsOn: [{ fieldKey: "datastoreIds", targetTypeId: DATASTORE, label: "stored on" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "library",
});

export const LibraryItemResourceType = rt({
  name: "Library Item",
  id: LIBRARY_ITEM,
  description: "A VM template, OVF package, ISO or file in a content library",
  parentTypeId: LIBRARY,
  showInSidebar: true,
  pinnable: false,
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Type", ro),
    f("sizeGb", "Size (GiB)", { kind: "number", ...ro }),
    f("libraryId", "Library", ro),
    f("cached", "Cached", { kind: "boolean", ...ro }),
    f("createdAt", "Created", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [o("itemId", "Item ID")],
  dependsOn: [{ fieldKey: "libraryId", targetTypeId: LIBRARY, label: "in" }],
  supportsUpdate: true,
  iconKey: "image",
});

export const TagCategoryResourceType = rt({
  name: "Tag Category",
  plural: "Tag Categories",
  id: TAG_CATEGORY,
  description: "A tag category and the object types its tags can be attached to",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("cardinality", "Cardinality", {
      kind: "enum",
      enumValues: ["SINGLE", "MULTIPLE"],
      editable: false,
      required: false,
    }),
    f("associableTypes", "Applies To", {
      required: false,
      description: "Comma-separated object types; empty means all types",
    }),
  ],
  outputs: [o("categoryId", "Category ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "tag",
});

export const TagResourceType = rt({
  name: "Tag",
  id: TAG,
  description: "A vSphere tag",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("categoryId", "Category", ro),
    f("categoryName", "Category Name", ro),
  ],
  outputs: [o("tagId", "Tag ID")],
  dependsOn: [{ fieldKey: "categoryId", targetTypeId: TAG_CATEGORY, label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "tag",
});

export const CustomizationSpecResourceType = rt({
  name: "Customization Spec",
  id: CUSTOMIZATION_SPEC,
  description: "A guest customization specification used when cloning or deploying VMs",
  fields: [
    f("name", "Name", ro),
    f("description", "Description", ro),
    f("osType", "OS Type", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [],
  pinnable: false,
  iconKey: "settings",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  VcenterResourceType,
  DatacenterResourceType,
  ClusterResourceType,
  HostResourceType,
  VmResourceType,
  DatastoreResourceType,
  NetworkResourceType,
  ResourcePoolResourceType,
  FolderResourceType,
  LibraryResourceType,
  LibraryItemResourceType,
  TagCategoryResourceType,
  TagResourceType,
  CustomizationSpecResourceType,
];
