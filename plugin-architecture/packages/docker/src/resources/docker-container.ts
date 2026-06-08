import { f, o, rt } from "@infrawrench/plugin-base";

export const DockerContainerResourceType = rt({
  name: "Container",
  id: "docker-container",
  description: "A Docker container managed by the local or remote Docker daemon.",
  fields: [
    f("name", "Name", { required: false }),
    f("image", "Image", { required: false }),
    f("status", "Status", { required: false }),
    f("ports", "Ports", { required: false }),
  ],
  outputs: [o("containerId", "Container ID"), o("status", "Status")],
  supportsCreate: true,
  iconKey: "container",
});
