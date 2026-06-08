import { f, o, rt } from "@infrawrench/plugin-base";

export const DockerNetworkResourceType = rt({
  name: "Network",
  id: "docker-network",
  description: "A Docker network managed by the local or remote Docker daemon.",
  fields: [
    f("name", "Name", { required: false }),
    f("driver", "Driver", { required: false }),
    f("scope", "Scope", { required: false }),
    f("subnet", "Subnet", { required: false }),
    f("internal", "Internal", { kind: "boolean", required: false }),
  ],
  outputs: [o("networkId", "Network ID")],
  supportsCreate: true,
  iconKey: "network",
});
