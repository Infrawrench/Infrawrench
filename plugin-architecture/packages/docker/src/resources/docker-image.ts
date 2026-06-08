import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DockerImageResourceType: ResourceTypeDefinition = {
  id: "docker-image",
  displayName: "Image",
  pluralDisplayName: "Images",
  description: "A Docker image available to the local or remote Docker daemon.",
  fields: [
    { key: "tags", label: "Tags", kind: "string", required: false },
    { key: "size", label: "Size", kind: "string", required: false },
    { key: "containers", label: "Containers", kind: "number", required: false },
  ],
  outputs: [{ key: "imageId", label: "Image ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "container",
};
