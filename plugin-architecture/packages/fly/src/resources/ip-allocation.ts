import { f, o, rt } from "@infrawrench/plugin-base";

export const IpAllocationResourceType = rt({
  name: "IP Allocation",
  id: "ip-allocation",
  description: "A public, private (Flycast), or egress IP address assigned to a Fly.io app",
  parentTypeId: "app",
  fields: [
    f("address", "Address", { showcase: true }),
    f("appName", "App"),
    f("type", "Type", {
      showcase: true,
      required: false,
      description: "v4, shared_v4, v6, private_v6 (Flycast), or egress",
    }),
    f("region", "Region", { showcase: true, required: false }),
    f("network", "Network", { required: false }),
    f("serviceName", "Service", { required: false }),
    f("shared", "Shared", { kind: "boolean", required: false }),
    f("egress", "Egress", { kind: "boolean", required: false }),
    f("private", "Private", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("address", "Address")],
  dependsOn: [{ fieldKey: "appName", targetTypeId: "app", label: "in app" }],
  iconKey: "network",
  supportsCreate: true,
});
