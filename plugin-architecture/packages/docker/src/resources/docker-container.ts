import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DockerContainerResourceType: ResourceTypeDefinition = {
  id: "docker-container",
  displayName: "Container",
  pluralDisplayName: "Containers",
  description: "A Docker container managed by the local or remote Docker daemon.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "image", label: "Image", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "ports", label: "Ports", kind: "string", required: false },
  ],
  outputs: [
    { key: "containerId", label: "Container ID", sensitive: false },
    { key: "status", label: "Status", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "container",
};
