import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_ZONES as ZONES } from "../locations.js";

export const InstanceResourceType = rt({
  id: "instance",
  name: "Instance",
  plural: "Instances",
  description: "A Scaleway virtual machine",
  fields: [
    f("name", "Name"),
    f("zone", "Zone", { kind: "enum", enumValues: ZONES, editable: false }),
    f("commercialType", "Commercial Type", {
      description:
        "Instance type, e.g. DEV1-S, POP2-2C-8G, PRO2-S. Changing it requires the instance to be stopped",
    }),
    f("image", "Image", { description: "Image ID or name", editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      enumValues: ["running", "stopped", "stopped in place", "starting", "stopping", "locked"],
      editable: false,
    }),
    f("protected", "Delete Protection", { kind: "boolean", required: false }),
    f("securityGroupId", "Security Group", { required: false, editable: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated" }),
  ],
  outputs: [o("publicIp", "Public IP"), o("privateIp", "Private IP")],
  iconKey: "instance",
  // Sleep/wake schedules: serverAction poweron / poweroff. A powered-off
  // instance stops compute billing (volumes and reserved IPs keep billing).
  lifecycle: {
    startActionId: "poweron",
    stopActionId: "poweroff",
    statusFieldKey: "state",
    runningValues: ["running", "starting"],
    stoppedValues: ["stopped", "stopped in place", "stopping"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "running" },
    defaultUsername: "root",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: {
      // The agents flow submits only these defaults; without a zone the
      // create call omits it and placement becomes nondeterministic.
      zone: "fr-par-1",
      commercialType: "DEV1-M",
      // Image label understood by createServer (and used as the image-picker
      // fallback id): display names like "Ubuntu 24.04 Noble Numbat" are not
      // valid image ids/labels for the API.
      image: "ubuntu_noble",
    },
    linuxImageDefaults: { image: "ubuntu_noble" },
    hiddenFieldKeys: ["sshPublicKey"],
  },
  supportsCreate: true,
  // Edit = `PATCH /servers/{id}`: name, commercial type (stopped only),
  // delete protection and tags.
  supportsUpdate: true,
  supportsMetrics: true,
  rightsizing: {
    sizeFieldKey: "commercialType",
    regionFieldKey: "zone",
    cpuMetric: { seriesLabel: "CPU Usage" },
    priceCurrency: "EUR",
    sizeFamilyPattern: "^([A-Z0-9]+)-",
    resizeNote:
      "Scaleway only changes an Instance's type while it is stopped, and not while it is in a placement group.",
  },
});
